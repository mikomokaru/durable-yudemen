import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  TrialLedger,
  TrialBudgetExceeded,
} from "../experiments/cpsat-workers/transport/ledger.mjs";

const trial = {
  code: "a".repeat(64),
  codec: "b".repeat(64),
  profile: "c".repeat(64),
  wasm: "d".repeat(64),
  glue: "e".repeat(64),
  notBefore: 1_000,
  expiresAt: 2_000,
  stores: [{ ref: "f".repeat(64) }, { ref: "0".repeat(64) }],
};
const limits = { dispatch: 128, operation: 512, connection: 32, concurrent: 4, openConnections: 4 };
const opened: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  // Sequential by intent: closing handles in parallel races the same journal.
  // oxlint-disable-next-line no-await-in-loop
  while (opened.length) await opened.pop()?.close();
});

async function ledgerAt(path: string, overrides: Record<string, unknown> = {}, useLimits = limits) {
  const ledger = await TrialLedger.open(path, { ...trial, ...overrides }, useLimits);
  opened.push(ledger);
  return ledger;
}

async function journal() {
  const directory = await mkdtemp(resolve(tmpdir(), "cpsat-ledger-"));
  return resolve(directory, "trial.jsonl");
}

it("spends the budget before the work and keeps it spent across a restart", async () => {
  const path = await journal();
  const first = await ledgerAt(path);
  const id = await first.reserve("dispatch");
  // The reservation is durable before the caller performs the send it covers.
  expect(await readFile(path, "utf8")).toContain('"t":"reserve"');
  expect(first.totals.inFlight).toBe(1);
  await first.close();
  opened.pop();

  // The crashed process settles nothing. Its slot is free; its budget is not.
  const second = await ledgerAt(path);
  expect(second.totals).toMatchObject({
    dispatch: 1,
    inFlight: 0,
    unsettledFromEarlierRuns: { dispatch: 1, operation: 0 },
  });
  await expect(second.settle(id, "accepted")).rejects.toThrow(/Unknown or already settled/);
});

it("returns the in-flight slot on settle but never the reservation", async () => {
  const ledger = await ledgerAt(await journal());
  const id = await ledger.reserve("dispatch");
  await ledger.settle(id, "accepted");
  expect(ledger.totals).toMatchObject({ dispatch: 1, inFlight: 0 });
  await expect(ledger.settle(id, "accepted")).rejects.toThrow(/Unknown or already settled/);
});

it("bounds concurrency per process and the total across processes", async () => {
  const path = await journal();
  const ledger = await ledgerAt(path);
  const ids: string[] = [];
  // Sequential by intent: each reservation must observe the previous one to
  // exercise the concurrency bound at all.
  for (let index = 0; index < limits.concurrent; index += 1)
    // oxlint-disable-next-line no-await-in-loop
    ids.push(await ledger.reserve("dispatch"));
  await expect(ledger.reserve("dispatch")).rejects.toThrow(TrialBudgetExceeded);
  // Not an expected full condition. The driver contracts to keep at most four
  // pieces of external work outstanding between reserve and settle, so
  // exceeding it is a broken contract and the trial stops — unlike
  // open-connection-limit, which is simply full.
  await ledger.settle(ids[0]!, "accepted");
  await expect(ledger.reserve("dispatch")).rejects.toMatchObject({ reason: "concurrent-limit" });
  expect(ledger.totals.stopped).toMatchObject({ reason: "concurrent-limit" });
});

it("stops at the dispatch and operation limits", async () => {
  const tight = await TrialLedger.open(await journal(), trial, {
    dispatch: 2,
    operation: 512,
    connection: 32,
    concurrent: 4,
    openConnections: 4,
  });
  opened.push(tight);
  await tight.settle(await tight.reserve("dispatch"), "accepted");
  await tight.settle(await tight.reserve("dispatch"), "accepted");
  await expect(tight.reserve("dispatch")).rejects.toMatchObject({ reason: "dispatch-limit" });

  const ops = await TrialLedger.open(await journal(), trial, {
    dispatch: 128,
    operation: 1,
    connection: 32,
    concurrent: 4,
    openConnections: 4,
  });
  opened.push(ops);
  await ops.settle(await ops.reserve("operation"), "done");
  await expect(ops.reserve("operation")).rejects.toMatchObject({ reason: "operation-limit" });
});

it("replays the dispatch allowance an operation charged, so a restart cannot refund it", async () => {
  const path = await journal();
  const first = await TrialLedger.open(path, trial, {
    dispatch: 2,
    operation: 512,
    connection: 32,
    concurrent: 4,
    openConnections: 4,
  });
  opened.push(first);
  await first.settle(await first.reserve("operation"), "done");
  await first.settle(await first.reserve("operation"), "done");
  expect(first.totals).toMatchObject({ operation: 2, dispatch: 2 });
  await first.close();
  opened.pop();

  const second = await TrialLedger.open(path, trial, {
    dispatch: 2,
    operation: 512,
    connection: 32,
    concurrent: 4,
    openConnections: 4,
  });
  opened.push(second);
  // Without replaying the allowance the restart would show dispatch 0 and let
  // two more operations through — a silent doubling of the trial's sends.
  expect(second.totals).toMatchObject({ operation: 2, dispatch: 2 });
  await expect(second.reserve("operation")).rejects.toMatchObject({
    reason: "dispatch-allowance",
  });
});

it("charges an operation for the dispatch its Effect will cause", async () => {
  const ledger = await ledgerAt(await journal());
  const id = await ledger.reserve("operation");
  // The Effect-induced send is paid for before the operation happens, because
  // the driver never calls it and cannot reserve it afterwards.
  expect(ledger.totals).toMatchObject({ operation: 1, dispatch: 1 });
  await ledger.settle(id, "done");
  expect(ledger.totals).toMatchObject({ operation: 1, dispatch: 1, inFlight: 0 });
});

it("treats an unreserved observed dispatch as a stop condition", async () => {
  const ledger = await ledgerAt(await journal());
  await ledger.settle(await ledger.reserve("operation"), "done");
  const first = await ledger.recordObservedDispatch("req-1");
  // The same send seen twice is one send.
  expect(await ledger.recordObservedDispatch("req-1")).toBe(first);
  expect(ledger.totals.observedDispatches).toBe(1);
  // A second distinct send from one operation falsifies the allowance. This is
  // a disagreement between reservation and observation, not exhaustion: the
  // totals are far from their limits and the trial still stops for inspection.
  await expect(ledger.recordObservedDispatch("req-2")).rejects.toMatchObject({
    reason: "unreserved-dispatch",
  });
  await expect(ledger.reserve("operation")).rejects.toMatchObject({
    reason: "unreserved-dispatch",
  });
});

it("refuses a journal written for another campaign", async () => {
  const path = await journal();
  const ledger = await ledgerAt(path);
  await ledger.settle(await ledger.reserve("dispatch"), "accepted");
  await ledger.close();
  opened.pop();
  // A different profile is a different trial; inheriting its budget would make
  // both numbers meaningless.
  await expect(ledgerAt(path, { profile: "9".repeat(64) })).rejects.toThrow(/different trial/);
});

it("carries the budget across sessions with different windows", async () => {
  const path = await journal();
  const first = await ledgerAt(path, { notBefore: 1_000, expiresAt: 2_000 });
  await first.settle(await first.reserve("dispatch"), "sent");
  await first.close();
  opened.pop();

  // A later session opens a new window against the same campaign. The window is
  // not identity: treating it as such would refuse this journal, start a fresh
  // one, and reset the totals to zero.
  const second = await ledgerAt(path, { notBefore: 50_000, expiresAt: 60_000 });
  expect(second.totals).toMatchObject({ dispatch: 1, windows: 2 });
});

it("refuses to continue on a torn journal instead of fusing the next record onto it", async () => {
  const path = await journal();
  const first = await ledgerAt(path);
  await first.settle(await first.reserve("dispatch"), "sent");
  await first.close();
  opened.pop();
  await writeFile(path, `${await readFile(path, "utf8")}{"t":"reser`);
  // Appending after the wreckage would fuse the next reservation onto it, and
  // that reservation would then vanish on the following restart.
  await expect(ledgerAt(path)).rejects.toThrow(/torn record/);

  await writeFile(path, `not json\n${await readFile(path, "utf8")}`);
  await expect(ledgerAt(path)).rejects.toThrow(/Corrupt ledger line 1/);
});

it("keeps a contract-violation stop across a restart, with the sends it saw", async () => {
  const path = await journal();
  const first = await ledgerAt(path);
  const operation = await first.reserve("operation");
  await first.settle(operation, "done");
  await first.recordObservedDispatch("req-1", operation);
  await expect(first.recordObservedDispatch("req-2", operation)).rejects.toMatchObject({
    reason: "allowance-exceeded",
  });
  await first.close();
  opened.pop();

  const second = await ledgerAt(path);
  // Restarting must not clear the inconsistency or forget which sends produced it.
  expect(second.totals.stopped).toMatchObject({ reason: "allowance-exceeded" });
  expect(second.totals.observedDispatches).toBe(2);
  await expect(second.reserve("operation")).rejects.toMatchObject({
    reason: "allowance-exceeded",
  });
});

it("refuses a second writer on one journal", async () => {
  const path = await journal();
  const first = await ledgerAt(path);
  // #tail orders writes inside one instance; two instances would each check the
  // budget against their own counters and both pass.
  await expect(ledgerAt(path)).rejects.toThrow(/locked by another writer/);
  await first.close();
  opened.pop();
  // The lock is released on close, so a later single writer is fine.
  const second = await ledgerAt(path);
  expect(second.totals.dispatch).toBe(0);
});

it("catches an extra send per operation even when unused allowance covers the total", async () => {
  const ledger = await ledgerAt(await journal());
  // Two warm connections reserve allowances they never use. The total bound has
  // three spare sends, so it cannot see the operation producing two.
  await ledger.settle(await ledger.reserve("connection"), "open");
  await ledger.settle(await ledger.reserve("connection"), "open");
  const operation = await ledger.reserve("operation");
  await ledger.settle(operation, "done");
  await ledger.recordObservedDispatch("req-1", operation);
  await expect(ledger.recordObservedDispatch("req-2", operation)).rejects.toMatchObject({
    reason: "allowance-exceeded",
  });
  // The loose check would have allowed it: observed 2 against reserved 3.
  expect(ledger.totals).toMatchObject({ dispatch: 3, observedDispatches: 2 });
});

it("reports how many sends only the loose total bound covered", async () => {
  const ledger = await ledgerAt(await journal());
  const operation = await ledger.reserve("operation");
  await ledger.settle(operation, "done");
  await ledger.settle(await ledger.reserve("dispatch"), "sent");
  await ledger.recordObservedDispatch("req-attributed", operation);
  await ledger.recordObservedDispatch("req-loose");
  expect(ledger.totals).toMatchObject({ observedDispatches: 2, unattributedDispatches: 1 });
});

it("attributes a direct send to itself, so a second one for the same reservation stops", async () => {
  const ledger = await ledgerAt(await journal());
  // A dispatch reservation is one send. Attributing two to it means the driver
  // sent twice for one reservation.
  const id = await ledger.reserve("dispatch");
  await ledger.settle(id, "sent");
  await ledger.recordObservedDispatch("req-1", id);
  await expect(ledger.recordObservedDispatch("req-2", id)).rejects.toMatchObject({
    reason: "allowance-exceeded",
    detail: { expected: 1, attributed: 2 },
  });
});

it("re-derives a violation on restart even when the stop row was never written", async () => {
  const path = await journal();
  const first = await ledgerAt(path);
  const operation = await first.reserve("operation");
  await first.settle(operation, "done");
  await first.recordObservedDispatch("req-1", operation);
  await expect(first.recordObservedDispatch("req-2", operation)).rejects.toMatchObject({
    reason: "allowance-exceeded",
  });
  await first.close();
  opened.pop();

  // Simulate the stop append failing: the observations are on disk, the stop
  // row is not. A ledger that trusted the row would restart unstopped.
  const text = await readFile(path, "utf8");
  await writeFile(
    path,
    text
      .split("\n")
      .filter((line) => line.length > 0 && !line.includes('"t":"stop"'))
      .join("\n") + "\n",
  );
  expect(await readFile(path, "utf8")).not.toContain('"t":"stop"');

  const second = await ledgerAt(path);
  expect(second.totals.stopped).toMatchObject({
    reason: "allowance-exceeded",
    detail: { rederived: true },
  });
  await expect(second.reserve("operation")).rejects.toMatchObject({
    reason: "allowance-exceeded",
  });
});

it("keeps the slot when a close was requested but never confirmed", async () => {
  const ledger = await ledgerAt(await journal(), {}, { ...limits, openConnections: 1 });
  const id = await ledger.reserve("connection");
  await ledger.settle(id, "open");
  // A teardown that stopped waiting is not evidence the socket went away.
  await ledger.releaseConnection(id, "close-unconfirmed");
  expect(ledger.totals).toMatchObject({ openConnections: 1, unconfirmedConnections: 1 });
  await expect(ledger.reserve("connection")).rejects.toMatchObject({
    reason: "open-connection-limit",
  });
  // A later confirmation does return it.
  await ledger.releaseConnection(id, "closed");
  expect(ledger.totals).toMatchObject({ openConnections: 0, unconfirmedConnections: 0 });
  await ledger.settle(await ledger.reserve("connection"), "open");
  expect(ledger.totals).toMatchObject({ openConnections: 1, connection: 2 });
});

it("keeps the lock when the stop is one replay cannot re-derive", async () => {
  const path = await journal();
  const ledger = await ledgerAt(path);
  for (let index = 0; index < limits.concurrent; index += 1)
    // oxlint-disable-next-line no-await-in-loop
    await ledger.reserve("dispatch");
  await expect(ledger.reserve("dispatch")).rejects.toMatchObject({ reason: "concurrent-limit" });
  // Nothing on disk describes work that was in flight inside this process, so
  // a later replay cannot reach this verdict. Releasing the lock would say the
  // journal is safe to pick up, and the next open would resume unstopped.
  expect(ledger.totals.stopIsRederivable).toBe(false);
  await ledger.close();
  opened.pop();
  await expect(ledgerAt(path)).rejects.toThrow(/locked by another writer/);
});

it("releases the lock when the stop can be re-derived", async () => {
  const path = await journal();
  const ledger = await ledgerAt(path);
  const operation = await ledger.reserve("operation");
  await ledger.settle(operation, "done");
  await ledger.recordObservedDispatch("req-1", operation);
  await expect(ledger.recordObservedDispatch("req-2", operation)).rejects.toMatchObject({
    reason: "allowance-exceeded",
  });
  expect(ledger.totals.stopIsRederivable).toBe(true);
  await ledger.close();
  opened.pop();
  // Reopening is allowed, and replay reaches the same verdict on its own.
  const second = await ledgerAt(path);
  expect(second.totals.stopped).toMatchObject({ reason: "allowance-exceeded" });
});
