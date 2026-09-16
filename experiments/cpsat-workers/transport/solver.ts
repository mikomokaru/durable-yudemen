// Task 2's fixed-input transport instrument, not the online cooking planner.
import createRuntime, { type CpsatPocRuntime } from "../vendor/cpsat_workers_poc_runtime.js";
import wasmModule from "../vendor/cpsat_workers_poc_runtime.wasm";
import { isRecord } from "../../../src/domain/predicate";
import { parseCpsatObservation, type CpsatObservation } from "../../../src/cpsat/observation";
import { observeCpsat } from "../../../src/cpsat/observe";
import fixtures from "./fixtures.json";
import type { CpsatQueueMessage } from "./queue";
import manifest from "./manifest.json";

let instanceId: string | undefined;
let loaded: Promise<CpsatPocRuntime> | undefined;
let busy = false;
let acceptedCount = 0;
let initializationCount = 0;
let clockReads = 0;

async function runtime(): Promise<CpsatPocRuntime> {
  if (loaded === undefined) {
    initializationCount += 1;
    loaded = createRuntime({
      instantiateWasm(imports, receive) {
        const clocks = WebAssembly.Module.imports(wasmModule)
          .filter((entry) => /clock|time|date|now/i.test(entry.name))
          .map((entry) => `${entry.module}.${entry.name}`)
          .sort();
        if (
          JSON.stringify(clocks) !==
          JSON.stringify(["env.emscripten_get_now", "wasi_snapshot_preview1.clock_time_get"])
        )
          throw new Error("Clock imports changed");
        let memory: WebAssembly.Memory | undefined;
        if (imports.env === undefined || imports.wasi_snapshot_preview1 === undefined)
          throw new Error("Clock imports missing");
        imports.env.emscripten_get_now = () => {
          clockReads += 1;
          return 1000;
        };
        imports.wasi_snapshot_preview1.clock_time_get = (
          id: number,
          _precision: bigint,
          ptr: number,
        ) => {
          if (id < 0 || id > 3) return 28;
          if (memory === undefined) throw new Error("Clock called before memory export");
          clockReads += 1;
          new DataView(memory.buffer).setBigUint64(
            ptr,
            id === 0 ? 1_700_000_000_000_000_000n : 1_000_000_000n,
            true,
          );
          return 0;
        };
        const instance = new WebAssembly.Instance(wasmModule, imports);
        if (!(instance.exports.memory instanceof WebAssembly.Memory))
          throw new Error("Memory export missing");
        memory = instance.exports.memory;
        receive(instance, wasmModule);
        return instance.exports;
      },
    }).catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
  }
  return loaded;
}

// Independent of protobuf and of the native solution vector. Check every
// domain, edge and objective, including any incumbent returned at cutoff.
function validResult(result: unknown, fixture: (typeof fixtures.fixtures)[number]): boolean {
  if (
    !isRecord(result) ||
    result.case !== "model" ||
    result.modelVariables !== fixture.variables ||
    result.modelConstraints !== fixture.constraints ||
    result.requestedDeterministicLimit !== fixture.budget ||
    result.wallTimeLimitEnabled !== false ||
    result.solverWallTimeMs !== 0 ||
    !Array.isArray(result.solution) ||
    ![
      result.bestBound,
      result.deterministicTime,
      result.branches,
      result.conflicts,
      result.booleans,
    ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
  )
    return false;
  const solution: unknown[] = result.solution;
  if (fixture.name === "small")
    return (
      result.status === "OPTIMAL" &&
      result.objective === 5 &&
      result.bestBound === 5 &&
      JSON.stringify(solution) === "[2,1,0]"
    );
  // This fixed stress case must actually consume its work budget. UNKNOWN is
  // not a solution and must never be counted as successful planning.
  if (
    typeof result.deterministicTime !== "number" ||
    result.deterministicTime < fixture.budget ||
    result.deterministicTime > fixture.budget + 0.02
  )
    return false;
  if (result.status === "UNKNOWN") return result.objective === null && solution.length === 0;
  if (
    result.status !== "FEASIBLE" ||
    solution.length !== 500 ||
    !solution.every((v) => v === 0 || v === 1)
  )
    return false;
  let sum = 0;
  let random = 0x12345678;
  let edges = 0;
  for (let left = 0; left < 500; left += 1) {
    sum += Number(solution[left]);
    for (let right = left + 1; right < 500; right += 1) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      if (random % 1000 >= 180) continue;
      edges += 1;
      if (Number(solution[left]) + Number(solution[right]) > 1) return false;
    }
  }
  return (
    edges === 22495 &&
    sum === result.objective &&
    typeof result.bestBound === "number" &&
    result.bestBound >= sum
  );
}

// Bounded even without Content-Length (or with a lying one). No arbitrary
// model bytes or callback destinations are part of this private request.
async function readRequest(request: Request): Promise<CpsatObservation | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      // Streaming chunks must be consumed in order.
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseCpsatObservation(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 受理の関門。**fetch と queue の両方がここを通る**——入口ごとに規則を書けば、片方だけが
 * 緩い、という食い違いが生まれる。到達手段が違っても、期限・店舗・固定問題・同時実行・
 * 試行上限の判定は 1 か所に閉じる。
 *
 * 戻り値は理由を持つ和型である。HTTP の status を返すのは fetch の関心事であり、queue 側は
 * 同じ理由を ack / retry の判断へ写す——`busy` は一時的で再配送に値するが、`exhausted`
 * （試行上限）は再配送しても結果が変わらない。この違いは status からは読めない。
 */
type Admission =
  | {
      readonly kind: "accepted";
      readonly accepted: CpsatObservation;
      /** 受理した要求の id。`accepted.fact` の型を呼ぶ側で絞り直さずに済ませる。 */
      readonly requestId: string;
      readonly fixture: (typeof fixtures.fixtures)[number];
      readonly store: (typeof manifest.stores)[number];
    }
  | { readonly kind: "rejected"; readonly status: 400 | 503 }
  | { readonly kind: "busy"; readonly status: 429 }
  | { readonly kind: "exhausted"; readonly status: 429 };

function admit(value: unknown): Admission {
  // **形も版も窓もここで確かめる。** 呼ぶ側が確かめた前提で受けると、入口が増えたときに
  // 片方だけ検査が抜ける——実際、queue 入口を足したときに版と窓の検査が抜けていた。
  // parse を含めるのは、Queue 越しに届く値が JSON を跨いでおり、fetch のボディと
  // 同じだけ信用できないためである。
  const row = parseCpsatObservation(value);
  if (
    !row ||
    // The shared observation invariant: probe/probe/null or live/engine/non-null.
    // Merely allowing both mode labels is unsafe.
    row.mode === "fake" ||
    row.backend !== "cpsat" ||
    row.fact.type !== "cpsat.request-dispatched" ||
    row.versions.code !== manifest.code ||
    row.versions.codec !== manifest.codec ||
    row.versions.wasm !== manifest.wasm ||
    row.versions.glue !== manifest.glue ||
    row.versions.profile !== manifest.profile ||
    row.versions.missingReason !== null ||
    row.at < manifest.notBefore ||
    row.at > Date.now()
  )
    return { kind: "rejected", status: 400 };
  const requestId = row.fact.requestId;
  const store = manifest.stores.find((s) => s.ref === row.storeRef);
  const fixture = fixtures.fixtures.find(
    (f) => f.sha256 === row.versions.model && String(f.budget) === row.versions.budget,
  );
  if (!store || !fixture) return { kind: "rejected", status: 400 };
  if (Date.now() >= manifest.expiresAt) return { kind: "rejected", status: 503 };
  if (acceptedCount >= manifest.maxDispatches) return { kind: "exhausted", status: 429 };
  if (busy) return { kind: "busy", status: 429 };
  // Per-isolate bound only. The driver's persistent trial ledger must enforce
  // the aggregate 128 sends across isolates, wakeups, failures and restarts.
  busy = true;
  acceptedCount += 1;
  instanceId ??= crypto.randomUUID();
  const accepted: CpsatObservation = {
    ...row,
    instanceId,
    invocationId: crypto.randomUUID(),
    at: Date.now(),
    eventId: crypto.randomUUID(),
    parentEventId: row.eventId,
    fact: { type: "cpsat.solver-accepted", requestId },
  };
  if (!observeCpsat(accepted)) {
    busy = false;
    return { kind: "rejected", status: 503 };
  }
  return { kind: "accepted", accepted, fixture, store, requestId };
}

/**
 * consumer 側の受領記録。**`CpsatObservation` ではない**——観測スキーマの `fact` に
 * この結末を表す種別が無く、`request-suppressed` は `decisionId` を前提にしている。
 * 勝手に H1 の形へ寄せると、集計が「engine が生成した要求」と読んでしまう。
 *
 * ゆえに shim の受領ログと同じ非 H1 の行として出す。認証値・生の注文・正準入力全文は
 * 載せない。観測スキーマへ種別を足すかは src への追加変更であり、別に判断する。
 */
function receipt(message: Message<CpsatQueueMessage>, outcome: string): void {
  // **投入から受領までを、時計 1 つで測れる形で載せる。** `message.timestamp` は Queue が
  // 付ける投入時刻で、producer のホストの時計を経由しない。producer の行と consumer の行を
  // 引き算する形（時計 2 つ）より、ずれの影響が小さい。
  //
  // 受理された要求にもこの行を出す。観測スキーマの `cpsat.solver-accepted` は `requestId`
  // しか持たず、スキーマを触らずに配送遅延を残せる場所は他に無い。
  // 届いた値は壊れていることがある。型を信じず、読めた分だけを載せる。
  const row: unknown = message.body?.row;
  console.log(
    JSON.stringify({
      transport: "cpsat-queue-consumer",
      outcome,
      messageId: message.id,
      attempts: message.attempts,
      // 配送遅延の主たる測定値。`enqueuedAt` は Queue の時計、`receivedAt` は consumer の
      // 時計だが、差を取るのに producer の時計を挟まない。
      enqueuedAt: message.timestamp.getTime(),
      receivedAt: Date.now(),
      // **この受領で runtime を初期化するか。** 冷起動は系列の 1 件目にだけ起きるとは
      // 限らない——isolate が入れ替われば途中でも起きる。1 件目だけを別掲する形では
      // p50 に冷起動が混ざる経路が閉じない。`loaded` が未定義なら、この受領が
      // WASM の用意を負う。
      coldStart: loaded === undefined,
      // 既に何回初期化したか。isolate の入れ替わりを受領行から追える。
      initializations: initializationCount,
      // 届いた値が壊れていれば requestId も読めない。読めないことも記録に値する。
      requestId:
        isRecord(row) && isRecord(row.fact) && typeof row.fact.requestId === "string"
          ? row.fact.requestId
          : null,
      storeRef: isRecord(row) && typeof row.storeRef === "string" ? row.storeRef : null,
    }),
  );
}

async function deliver(
  accepted: CpsatObservation,
  fixture: (typeof fixtures.fixtures)[number],
  storeId: string,
  env: CpsatPlannerEnv,
  /** どの輸送で届いたか。`wait-until-wall-ms` の欠測理由がこれで変わる。 */
  transport: "fetch" | "queue",
): Promise<void> {
  if (accepted.fact.type !== "cpsat.solver-accepted") throw new Error("Invalid accepted event");
  const requestId = accepted.fact.requestId;
  const emit = (fact: CpsatObservation["fact"], parent = accepted.eventId): CpsatObservation => {
    const row: CpsatObservation = {
      ...accepted,
      fact,
      at: Date.now(),
      eventId: crypto.randomUUID(),
      parentEventId: parent,
    };
    if (!observeCpsat(row)) throw new Error("Observation was not recorded");
    return row;
  };
  const measure = (
    metric: Extract<CpsatObservation["fact"], { type: "cpsat.measurement" }>["metric"],
    reading: Extract<CpsatObservation["fact"], { type: "cpsat.measurement" }>["reading"],
    parent = accepted.eventId,
  ) => emit({ type: "cpsat.measurement", requestId, metric, reading }, parent);
  let started: CpsatObservation | undefined;
  let finished: CpsatObservation | undefined;
  let stage: "initialization" | "serialization" = "initialization";
  let callbackReturned = false;
  try {
    const initializedNow = loaded === undefined;
    const wasm = await runtime();
    stage = "serialization";
    const model = Uint8Array.from(atob(fixture.protoBase64), (c) => c.charCodeAt(0));
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", model)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (
      model.byteLength !== fixture.byteLength ||
      model.byteLength > 1_048_576 ||
      digest !== fixture.sha256
    )
      throw new Error("Fixed protobuf changed");
    let input = 0;
    let output = 0;
    let result: unknown;
    const readsBefore = clockReads;
    try {
      input = wasm._malloc(model.byteLength);
      if (input === 0) throw new Error("Allocation failed");
      wasm.HEAPU8.set(model, input); // Read the view after possible memory growth.
      started = emit({ type: "cpsat.solve-started", requestId });
      output = wasm._cpsat_solve(3, fixture.budget, input, model.byteLength);
      if (output === 0) throw new Error("Result allocation failed");
      result = JSON.parse(wasm.UTF8ToString(output));
    } finally {
      if (output !== 0) wasm._free(output);
      if (input !== 0) wasm._free(input);
    }
    const memoryBytes = wasm.HEAPU8.buffer.byteLength;
    if (
      !validResult(result, fixture) ||
      !isRecord(result) ||
      clockReads <= readsBefore ||
      memoryBytes > 96 * 1024 * 1024 ||
      (typeof SharedArrayBuffer !== "undefined" && wasm.HEAPU8.buffer instanceof SharedArrayBuffer)
    )
      throw new Error("Invalid fixed result or runtime");
    const status = result.status;
    if (status !== "OPTIMAL" && status !== "FEASIBLE" && status !== "UNKNOWN")
      throw new Error("Invalid fixed status");
    finished = emit({ type: "cpsat.solve-finished", requestId, status }, started.eventId);
    for (const [metric, value, source] of [
      ["cpu-limit-ms", manifest.cpuLimitMs, "configuration"],
      ["budget-deterministic", fixture.budget, "configuration"],
      ["consumed-deterministic", Number(result.deterministicTime), "solver"],
      ["wasm-bytes", memoryBytes, "wasm"],
      ["variables", fixture.variables, "model"],
      ["constraints", fixture.constraints, "model"],
      ["model-bytes", fixture.byteLength, "model"],
    ] as const)
      measure(
        metric,
        { value, source, from: "checkpoint", to: "checkpoint", bound: "exact" },
        finished.eventId,
      );
    try {
      // Deliberately no top-level slices: the old DO rejects this object.
      await env.STORE_TIMER_DO.get(env.STORE_TIMER_DO.idFromName(storeId)).deliverPlan({
        protocol: "cpsat/v1",
        storeId,
        requestId,
        result,
        observation: finished,
        runtime: {
          initializedNow,
          initializationCount,
          memoryBytes,
          clockReads: clockReads - readsBefore,
        },
      });
      callbackReturned = true;
    } finally {
      const returned = emit(
        {
          type: "cpsat.callback-returned",
          requestId,
          outcome: callbackReturned ? "delivered" : "failed",
        },
        finished.eventId,
      );
      const elapsed = returned.at - started.at;
      measure(
        "solve-callback-wall-ms",
        elapsed > 0
          ? {
              value: elapsed,
              source: "host-clock",
              from: "solve-started",
              to: "callback-returned",
              bound: "exact",
            }
          : { value: null, reason: "clock-not-advancing" },
        returned.eventId,
      );
    }
  } catch {
    // A trap or failed decode must not poison the next instance. No automatic
    // retry and no unbounded queue. A callback failure doesn't invalidate Wasm.
    if (!started) {
      loaded = undefined;
      emit({ type: "cpsat.preparation-failed", requestId, stage });
    } else if (finished === undefined) {
      loaded = undefined;
      emit({ type: "cpsat.solve-finished", requestId, status: "exception" }, started.eventId);
    }
    // Callback failure already has its own terminal row. Never emit a second
    // solve-finished for an otherwise successful solve.
    throw new Error("Fixed probe failed");
  } finally {
    try {
      // Neither Date.now nor performance.now measures Worker CPU. The response
      // sent timestamp is not exposed here. Platform export must fill these;
      // this checkpoint and its host timestamp are not a waitUntil duration.
      for (const metric of ["cpu-ms", "invocation-wall-ms", "isolate-bytes"] as const)
        measure(metric, { value: null, reason: "unavailable" });
      // `wait-until-wall-ms` は輸送で意味が変わる。fetch 経路では応答後の延長を測る
      // 欄で、値が取れないだけである。Queue 経路では求解が invocation そのもので走り、
      // 応答後の延長は存在しない——**該当しない**のであって、取得に失敗したのではない。
      // 同じ `unavailable` に丸めると、欠測と非該当が集計で混ざる（tasks 2.4）。
      measure("wait-until-wall-ms", {
        value: null,
        reason: transport === "queue" ? "not-applicable" : "unavailable",
      });
    } finally {
      busy = false;
    }
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const now = Date.now();
    // Checked-in state is inert. Only a separately reviewed, time-bounded
    // trial manifest can enable cloud dispatch; the local test substitutes one.
    if (
      !manifest.enabled ||
      !Number.isSafeInteger(manifest.notBefore) ||
      !Number.isSafeInteger(manifest.expiresAt) ||
      manifest.expiresAt - manifest.notBefore > 7_200_000 ||
      now < manifest.notBefore ||
      now >= manifest.expiresAt
    )
      return new Response(null, { status: 503 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/plan")
      return new Response(null, { status: 404 });
    const row = await readRequest(request);
    const admitted = admit(row);
    if (admitted.kind !== "accepted") return new Response(null, { status: admitted.status });
    const { accepted, fixture, store, requestId } = admitted;
    // No delay inserted to make separation look successful. Whether this 202
    // actually arrives before synchronous Wasm ends is task 2's measured gate.
    ctx.waitUntil(deliver(accepted, fixture, store.id, env, "fetch"));
    return Response.json({ accepted: true, requestId }, { status: 202 });
  },

  /**
   * Queue consumer。**求解はこの invocation そのもので走る**——応答後の延長ではないので、
   * 効く上限は `waitUntil` の 30 秒枠ではなく consumer の CPU 時間（既定 30 秒・`limits.cpu_ms`
   * で 5 分まで）である。wall clock の 15 分は設定できず、callback 待ちを含む別の上界として扱う。
   *
   * **ack は明示する**（`raw-arrival-consumer` と同じ流儀）。自動 ack は handler の返却と
   * `waitUntil` の解決で起きるため、区間の終点が読み手から見えにくい。ここでは
   * `deliverPlan` の戻りまで await してから ack する——design 第10.3節が callback を
   * 「呼出開始ではなく DO 側の処理を含む戻りまで」と定めており、区間の終点と ack を
   * 一致させると 2.4 の測定がぶれない。
   *
   * **棄却は失敗ではない。** 到着した計画を DO のゲートが採らないのは正常な結末なので ack する。
   * 再配送に値するのは例外・到達不能・一時的な同時実行の拒否だけである（R5.3・R6.7）。
   */
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      const admitted = admit(message.body?.row);
      if (admitted.kind === "busy") {
        // 一時的。ただし**即時の再配送は予算を食う**——`max_retries` は有限で、
        // busy に当たり続けた要求は一度も解かれずに DLQ へ落ちる。間を空けて返す。
        receipt(message, "busy");
        message.retry({ delaySeconds: 2 });
        continue;
      }
      if (admitted.kind !== "accepted") {
        // 期限切れ・対象外・版違い・試行上限。再配送しても結果は変わらないので ack する。
        // **ここで記録を残す。** `admit` が観測行を出すのは受理したときだけなので、
        // 記録しなければ「送ったが解かれず、理由も残らない」要求になる（R6.4）。
        receipt(message, admitted.kind === "exhausted" ? "exhausted" : "rejected");
        message.ack();
        continue;
      }
      // 受理も記録する。ここが配送遅延の測定対象であり、受理された要求に行が無ければ
      // 測る対象そのものが観測に残らない。
      receipt(message, "accepted");
      try {
        // oxlint-disable-next-line no-await-in-loop
        await deliver(admitted.accepted, admitted.fixture, admitted.store.id, env, "queue");
        message.ack();
      } catch {
        // `deliver` は自身の失敗を観測行で残す。ここで決めるのは再配送だけである。
        // 決定的な失敗と一時的な失敗を catch から見分けることはできないので、
        // **試行回数で打ち切る**——同じ理由で失敗し続ける要求が予算を使い切って
        // 無記録のまま DLQ へ落ちるのを避ける。
        if (message.attempts >= 2) {
          receipt(message, "deliver-failed");
          message.ack();
        } else {
          message.retry({ delaySeconds: 2 });
        }
      }
    }
  },
} satisfies ExportedHandler<CpsatPlannerEnv, CpsatQueueMessage>;
