import { open, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

// Durable trial ledger for the local driver.
//
// The solver's in-isolate counter is per-isolate only: it resets on eviction,
// cold start and redeploy. The aggregate trial budget therefore lives here, in
// an append-only journal that survives driver restarts.
//
// Two rules give the budget its meaning.
//
//   1. A reservation is written and flushed BEFORE the work it authorises. A
//      crash between the write and the send must overcount, never undercount:
//      an unsettled reservation stays spent forever. Reserving afterwards would
//      silently refund every crash.
//   2. Dispatches the driver does not initiate are still spent. An operation
//      causes an Effect, which causes a dispatch the driver never calls. Each
//      operation therefore reserves its worst-case dispatch allowance up front,
//      and observed dispatches are reconciled against those reservations.
//
// Rule 2's allowance is an assumption ("one operation yields at most one
// dispatch"). `recordObservedDispatch` makes it falsifiable: an observed
// dispatch with no matching reservation is a stop condition, not a rounding
// error.

/** @typedef {"dispatch" | "operation" | "connection"} Kind */

// `connection` exists so a WebSocket cannot enter without passing the ledger.
// It is charged an allowance by default: a connection that wakes a hibernated
// or evicted Durable Object runs the constructor's Reconcile through
// runEffects, which can emit a plan request. Only a caller that can show the
// object is already warm may pass 0, and this harness cannot show that in
// general. The allowance is per reservation, not per kind.
const KINDS = /** @type {const} */ (["dispatch", "operation", "connection"]);

// Stops replay can reconstruct from the journal alone: the budget totals and
// the observations are both on disk. `concurrent-limit` is not here — it is a
// statement about work in flight inside one process, which leaves no trace a
// later replay could re-derive. A trial stopped for a reason on neither list
// must not resume automatically.
const REDERIVABLE_STOPS = new Set([
  "allowance-exceeded",
  "unreserved-dispatch",
  "dispatch-limit",
  "operation-limit",
  "connection-limit",
  "dispatch-allowance",
]);

/**
 * Trial identity: the approved campaign, not one session of it.
 *
 * The time window is deliberately absent. A trial runs over several windows —
 * one to check the transport, another to measure — and the budget is the
 * campaign's, not each window's. Including the window would make every new one
 * a different trial, so the journal would be refused, a fresh one started, and
 * the totals silently reset to zero. Each session records its own window as a
 * fact instead, so the journal still shows what the budget was spent across.
 */
function trialFingerprint(trial) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        trial.code,
        trial.codec,
        trial.profile,
        trial.wasm,
        trial.glue,
        [...trial.stores].map((store) => store.ref).sort(),
      ]),
    )
    .digest("hex");
}

export class TrialBudgetExceeded extends Error {
  constructor(reason, detail) {
    super(`Trial budget stop: ${reason}`);
    this.name = "TrialBudgetExceeded";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Append-only ledger over one journal file.
 *
 * Concurrency is bounded per living process, totals across all of them. A dead
 * process holds no in-flight slot, but its unsettled reservations stay spent.
 */
export class TrialLedger {
  #handle;
  #limits;
  #fingerprint;
  #reserved = { dispatch: 0, operation: 0, connection: 0 };
  #settled = { dispatch: 0, operation: 0, connection: 0 };
  #inFlight = new Map();
  #observed = new Map();
  #stopped = null;
  #restartedWith = { dispatch: 0, operation: 0, connection: 0 };
  // Every journal write is serialized. `reserve` reads the remaining budget,
  // awaits a durable append, then updates counters; two concurrent callers
  // would otherwise both pass the check against the same remaining slot and
  // spend it twice. Ordering the writes also keeps the journal replayable.
  #tail = Promise.resolve();
  // Sockets currently connecting or connected. Independent of #inFlight, which
  // bounds reservation work: a connection settles as soon as it is accepted,
  // long before it closes, so the two quantities are never the same set.
  #open = new Set();
  #lock;
  #lockPath;
  // Observed sends, and the reservation each was attributed to. Both are
  // replayed: an inconsistency found before a restart must not be forgotten by
  // one.
  #attribution = new Map();
  // Sends each reservation may account for. A `dispatch` reservation is one
  // send itself; every other kind may cause as many as its declared allowance.
  // Checking against this, rather than against the running total, is what
  // actually tests the one-dispatch-per-operation hypothesis.
  #allowances = new Map();
  // Connections whose close was requested but never confirmed. They still hold
  // a simultaneity slot, because nothing showed that they went away.
  #unconfirmed = new Set();
  // Every session's window, in the order they were opened.
  #windows = [];

  constructor(handle, limits, fingerprint, lock, lockPath) {
    this.#handle = handle;
    this.#limits = limits;
    this.#fingerprint = fingerprint;
    this.#lock = lock;
    this.#lockPath = lockPath;
  }

  /**
   * Open (creating if absent) and replay. A journal written for another trial
   * is refused rather than reused: inheriting a stranger's budget would make
   * both numbers meaningless.
   */
  static async open(path, trial, limits) {
    const fingerprint = trialFingerprint(trial);
    // Exclusive single writer. `#tail` orders writes inside one instance only;
    // two instances over one file would each check the budget against their own
    // replayed counters and both pass. A leftover lock is not cleaned up
    // automatically: it means a previous writer died, which is exactly the case
    // that needs a person to look before the budget is trusted again.
    const lockPath = `${path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST")
        throw new Error(
          `Ledger is locked by another writer (${lockPath}). If no writer is running, a previous one died: inspect the journal and remove the lock deliberately.`,
        );
      throw error;
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    const handle = await open(path, "a+");
    const text = await handle.readFile("utf8");
    const ledger = new TrialLedger(handle, limits, fingerprint, lock, lockPath);
    try {
      ledger.#replay(text);
      // The window is not identity, but it is a fact worth keeping: the journal
      // should show which sessions the budget was spent across.
      const window = {
        notBefore: trial.notBefore,
        expiresAt: trial.expiresAt,
        at: Date.now(),
      };
      await ledger.#append({ t: "window", ...window });
      ledger.#windows.push(window);
    } catch (error) {
      await handle.close();
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    return ledger;
  }

  #replay(text) {
    const lines = text.split("\n").filter((line) => line.length > 0);
    const open = new Map();
    for (const [index, line] of lines.entries()) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        // Refuse either way. A torn final line is the shape a crash leaves, but
        // appending after it fuses the next record onto the wreckage: that
        // record then vanishes or corrupts the line after it. Continuing on a
        // damaged journal loses reservations silently, so stop and let a person
        // decide. This is why there is no automatic truncation.
        throw new Error(
          index === lines.length - 1
            ? `Ledger ends in a torn record (line ${index + 1}); a writer died mid-append. Inspect and repair deliberately before reuse.`
            : `Corrupt ledger line ${index + 1}`,
        );
      }
      if (row.trial !== undefined && row.trial !== this.#fingerprint)
        throw new Error("Ledger belongs to a different trial");
      if (row.t === "reserve") {
        if (!KINDS.includes(row.kind)) throw new Error(`Unknown reservation kind at ${index + 1}`);
        this.#reserved[row.kind] += 1;
        // The allowance an operation charged must be replayed too. Counting the
        // operation alone would refund its Effect-induced dispatch on restart —
        // the exact leak this ledger exists to prevent.
        if (row.kind !== "dispatch") this.#reserved.dispatch += row.allowance ?? 0;
        this.#allowances.set(row.id, row.kind === "dispatch" ? 1 : (row.allowance ?? 0));
        open.set(row.id, row.kind);
      } else if (row.t === "window") {
        this.#windows.push({ notBefore: row.notBefore, expiresAt: row.expiresAt, at: row.at });
      } else if (row.t === "observed") {
        this.#observed.set(row.requestId, { requestId: row.requestId, at: row.at });
        if (row.reservation) {
          const seen = this.#attribution.get(row.reservation) ?? new Set();
          seen.add(row.requestId);
          this.#attribution.set(row.reservation, seen);
        }
      } else if (row.t === "stop") {
        // A trial stopped for a broken contract stays stopped. Forgetting it on
        // restart would let the run continue past the inconsistency it found.
        this.#stopped ??= { reason: row.reason, detail: row.detail };
      } else if (row.t === "settle") {
        const kind = open.get(row.id);
        if (kind) {
          this.#settled[kind] += 1;
          open.delete(row.id);
        }
      }
    }
    // Re-derive the inconsistencies from what was observed, rather than trusting
    // that the `stop` row was written. That append can fail, and a stop that
    // exists only in a dead process's memory is no stop at all. The observations
    // are already on disk, so the same two checks can be run again here.
    for (const [reservation, attributed] of this.#attribution) {
      const expected = this.#allowances.get(reservation);
      if (expected !== undefined && attributed.size > expected)
        this.#stopped ??= {
          reason: "allowance-exceeded",
          detail: { reservation, expected, attributed: attributed.size, rederived: true },
        };
    }
    if (this.#observed.size > this.#reserved.dispatch)
      this.#stopped ??= {
        reason: "unreserved-dispatch",
        detail: {
          observed: this.#observed.size,
          reservedDispatch: this.#reserved.dispatch,
          rederived: true,
        },
      };
    // Reservations a previous process never settled remain spent. They are not
    // in flight here — that process is gone — but the budget does not return.
    this.#restartedWith = { ...this.#reserved };
    for (const kind of KINDS) this.#restartedWith[kind] -= this.#settled[kind];
  }

  async #append(row) {
    // Flush before returning. The caller treats a resolved append as durable,
    // and only then performs the work the row authorises.
    await this.#handle.appendFile(`${JSON.stringify({ ...row, trial: this.#fingerprint })}\n`);
    await this.#handle.sync();
  }

  /** Totals include unsettled reservations from earlier processes. */
  get totals() {
    return {
      dispatch: this.#reserved.dispatch,
      operation: this.#reserved.operation,
      connection: this.#reserved.connection,
      inFlight: this.#inFlight.size,
      openConnections: this.#open.size,
      unconfirmedConnections: this.#unconfirmed.size,
      unsettledFromEarlierRuns: { ...this.#restartedWith },
      observedDispatches: this.#observed.size,
      // Sends covered only by the loose total bound, with no reservation to
      // test the per-operation hypothesis against.
      windows: this.#windows.length,
      stopIsRederivable: this.#stopped ? REDERIVABLE_STOPS.has(this.#stopped.reason) : null,
      unattributedDispatches:
        this.#observed.size - [...this.#attribution.values()].reduce((n, set) => n + set.size, 0),
      stopped: this.#stopped,
    };
  }

  /**
   * The distinction is not whether a slot returns. It is what the refusal says.
   *
   *   - `open-connection-limit` is an expected full condition. Refuse the new
   *     connection only; existing connections and the trial continue, and an
   *     explicit retry after a confirmed close is legitimate. It does not latch.
   *   - `concurrent-limit` breaks a driver contract: at most four pieces of
   *     external work may be outstanding between reserve and settle. Stop.
   *   - `unreserved-dispatch` is not exhaustion. It reports a disagreement
   *     between what was reserved and what was observed — a missed reservation,
   *     or the one-dispatch-per-operation hypothesis being false. Stop and
   *     investigate; the totals may be nowhere near their limits.
   *   - `dispatch-limit`, `operation-limit`, `connection-limit` and
   *     `dispatch-allowance` are exhaustion: the total never comes back.
   *
   * Serializing journal writes is a separate consistency mechanism and is not
   * what `concurrent` protects. If `concurrent` is ever repurposed to absorb
   * ordinary congestion, revisit this classification.
   */
  async #refuse(reason, detail, permanent = true) {
    if (permanent && !this.#stopped) {
      this.#stopped = { reason, detail };
      // Durable if it can be. A failed write is not a normal outcome: record it
      // so the report shows the journal is incomplete. Correctness does not
      // depend on it — replay re-derives both violations from the observations.
      try {
        await this.#append({ t: "stop", reason, detail });
      } catch (error) {
        this.#stopped.persisted = false;
        this.#stopped.persistError = String(error?.message ?? error);
      }
    }
    throw new TrialBudgetExceeded(reason, detail);
  }

  /** Run one journal-mutating step to completion before the next begins. */
  #serialize(step) {
    const result = this.#tail.then(step, step);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Reserve one unit and return its id. `dispatch` also takes an in-flight
   * slot that `settle` returns; `operation` reserves its worst-case dispatch
   * allowance in the same durable write, so an Effect-induced send is already
   * paid for before the operation happens.
   */
  reserve(kind, allowance = kind === "dispatch" ? 0 : 1) {
    return this.#serialize(() => this.#reserveNow(kind, allowance));
  }

  async #reserveNow(kind, allowance) {
    if (this.#stopped) await this.#refuse(this.#stopped.reason, this.#stopped.detail);
    if (!KINDS.includes(kind)) throw new Error(`Unknown reservation kind ${kind}`);
    // A dispatch reservation is the send. Charging it an allowance on top would
    // spend the budget twice for one call.
    if (kind === "dispatch" && allowance !== 0)
      throw new Error("A dispatch reservation carries no separate allowance");
    if (this.#reserved[kind] >= this.#limits[kind])
      await this.#refuse(`${kind}-limit`, {
        limit: this.#limits[kind],
        reserved: this.#reserved[kind],
      });
    if (allowance > 0 && this.#reserved.dispatch + allowance > this.#limits.dispatch)
      await this.#refuse("dispatch-allowance", {
        limit: this.#limits.dispatch,
        reserved: this.#reserved.dispatch,
      });
    // Acquired before the connection starts, and counted while connecting as
    // well as while connected. Released only on failure or confirmed close.
    if (kind === "connection" && this.#open.size >= this.#limits.openConnections)
      await this.#refuse(
        "open-connection-limit",
        { limit: this.#limits.openConnections, open: this.#open.size },
        false,
      );
    if (this.#inFlight.size >= this.#limits.concurrent)
      await this.#refuse("concurrent-limit", {
        limit: this.#limits.concurrent,
        inFlight: this.#inFlight.size,
      });
    const id = randomUUID();
    const at = Date.now();
    // One durable write covers both counters, so a crash cannot leave a
    // reservation charged without the dispatch allowance it promised.
    await this.#append({ t: "reserve", id, kind, at, allowance });
    this.#reserved[kind] += 1;
    this.#reserved.dispatch += allowance;
    this.#allowances.set(id, kind === "dispatch" ? 1 : allowance);
    this.#inFlight.set(id, kind);
    if (kind === "connection") this.#open.add(id);
    return id;
  }

  /** Release the in-flight slot. The reservation itself stays spent. */
  settle(id, outcome) {
    return this.#serialize(() => this.#settleNow(id, outcome));
  }

  async #settleNow(id, outcome) {
    const kind = this.#inFlight.get(id);
    if (!kind) throw new Error(`Unknown or already settled reservation ${id}`);
    this.#inFlight.delete(id);
    this.#settled[kind] += 1;
    await this.#append({ t: "settle", id, outcome, at: Date.now() });
  }

  /**
   * Reconcile an observed dispatch.
   *
   * Two checks, deliberately separate.
   *
   *   - **Upper bound.** Observed sends may never exceed reserved allowance in
   *     total. This is a real bound, but a loose one: allowances reserved and
   *     never used (a warm connection that woke nothing) leave slack that can
   *     absorb an extra send elsewhere.
   *   - **Per-reservation hypothesis.** When the caller knows which reservation
   *     a send came from, attribute it. A reservation that yields more sends
   *     than it declared falsifies "one dispatch per operation" directly, no
   *     matter how much slack the total has.
   *
   * Only the second actually tests the hypothesis. `totals.unattributed` says
   * how many sends were covered by the loose check alone.
   */
  recordObservedDispatch(requestId, reservation) {
    return this.#serialize(() => this.#recordObservedNow(requestId, reservation));
  }

  async #recordObservedNow(requestId, reservation) {
    const seen = this.#observed.get(requestId);
    if (seen) return seen;
    if (reservation !== undefined && !this.#allowances.has(reservation))
      throw new Error(`Unknown reservation ${reservation}`);
    const entry = { requestId, at: Date.now() };
    this.#observed.set(requestId, entry);
    if (reservation !== undefined) {
      const attributed = this.#attribution.get(reservation) ?? new Set();
      attributed.add(requestId);
      this.#attribution.set(reservation, attributed);
    }
    await this.#append({ t: "observed", requestId, reservation, at: entry.at });
    if (reservation !== undefined) {
      const attributed = this.#attribution.get(reservation);
      const expected = this.#allowances.get(reservation);
      if (attributed.size > expected)
        await this.#refuse("allowance-exceeded", {
          reservation,
          expected,
          attributed: attributed.size,
          requestId,
        });
    }
    if (this.#observed.size > this.#reserved.dispatch)
      await this.#refuse("unreserved-dispatch", {
        observed: this.#observed.size,
        reservedDispatch: this.#reserved.dispatch,
        requestId,
      });
    return entry;
  }

  /**
   * Report how a connection ended.
   *
   * `"closed"` (confirmed close) and `"failed"` (never established) return the
   * simultaneity slot. Any other outcome — a teardown that timed out waiting
   * for the close event — keeps the slot and records the connection as
   * unconfirmed. The cumulative attempt is never returned in either case.
   */
  releaseConnection(id, outcome) {
    return this.#serialize(() => this.#releaseConnectionNow(id, outcome));
  }

  async #releaseConnectionNow(id, outcome) {
    if (!this.#open.has(id)) throw new Error(`Unknown or already released connection ${id}`);
    // Only a confirmed end returns the slot. "The close was requested and we
    // stopped waiting" is not evidence the socket went away, so an unconfirmed
    // teardown keeps the slot and is recorded as such. Freeing it on a timeout
    // would let the next connection start while the old one may still be live.
    if (outcome !== "closed" && outcome !== "failed") {
      this.#unconfirmed.add(id);
      await this.#append({ t: "unconfirmed", id, outcome, at: Date.now() });
      return;
    }
    this.#open.delete(id);
    this.#unconfirmed.delete(id);
    await this.#append({ t: "release", id, outcome, at: Date.now() });
  }

  /**
   * Releasing the lock says "this journal is safe to pick up again". That is
   * only true when a later replay can reach the same verdict. Two cases cannot
   * promise it, and both keep the lock so a person has to look:
   *
   *   - the stop row could not be written, so the journal does not record it;
   *   - the stop is one replay cannot re-derive (`concurrent-limit` describes
   *     work in flight inside a process, which leaves nothing to re-derive).
   *
   * Reporting `persisted: false` alone would not have been enough: the next
   * open would still have succeeded.
   */
  async close() {
    await this.#handle.close();
    const stop = this.#stopped;
    const retain =
      stop !== undefined &&
      stop !== null &&
      (stop.persisted === false || !REDERIVABLE_STOPS.has(stop.reason));
    if (retain) {
      await this.#lock
        .writeFile(
          `\n${JSON.stringify({ retained: true, reason: stop.reason, detail: stop.detail, persisted: stop.persisted !== false })}\n`,
        )
        .catch(() => undefined);
      await this.#lock.close();
      return;
    }
    await this.#lock.close();
    await unlink(this.#lockPath).catch(() => undefined);
  }
}
