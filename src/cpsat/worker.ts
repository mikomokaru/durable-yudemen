import type { CpsatPlanRequest } from "./request";
import { matchesCpsatInput } from "./request";
import { planCpsat } from "./plan";
import { adjustedEndTime } from "../engine/project";

export default {
  async fetch(request: Request, env: CpsatPlannerEnv, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1048576) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    let plan: CpsatPlanRequest;
    try {
      // Only the app's private Service binding can reach this Worker. Runtime
      // validation below still bounds input before constructing a model.
      plan = JSON.parse(new TextDecoder().decode(bytes)) as CpsatPlanRequest;
      if (
        plan.planner !== "cpsat" ||
        !/^[a-z0-9-]{1,64}$/.test(plan.storeId) ||
        !/^[a-f0-9-]{36}$/.test(plan.requestId) ||
        !Array.isArray(plan.pending) ||
        !Array.isArray(plan.running) ||
        !(await matchesCpsatInput(plan))
      )
        return new Response(null, { status: 400 });
    } catch {
      return new Response(null, { status: 400 });
    }
    ctx.waitUntil(deliver(plan, env));
    return new Response(null, { status: 202 });
  },

  /**
   * Queue consumer。求解はこの invocation そのもので走る。
   *
   * **`fetch` と違い、`deliver` の完了まで待ってから ack する。** 応答後の延長ではないので
   * `waitUntil` に預ける理由がなく、区間の終点と ack を一致させたほうが測りやすい。
   * 効く上限は `waitUntil` の 30 秒枠ではなく consumer の CPU（`limits.cpu_ms`）である。
   *
   * **ack は明示する。** 自動 ack は handler の返却と `waitUntil` の解決で起きるため、
   * どこで確定したかが読み手から見えない。
   */
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      const plan = message.body;
      // 形の検査は `fetch` と同じ規則である。Queue 越しの値は JSON を跨いでおり、
      // 呼出元を信用する理由が `fetch` のボディより強いわけではない。
      if (
        plan?.planner !== "cpsat" ||
        !/^[a-z0-9-]{1,64}$/.test(plan.storeId) ||
        !/^[a-f0-9-]{36}$/.test(plan.requestId) ||
        !Array.isArray(plan.pending) ||
        !Array.isArray(plan.running) ||
        !(await matchesCpsatInput(plan))
      ) {
        // 形が違うものは再配送しても直らない。理由を残して ack する。
        console.error(
          JSON.stringify({
            kind: "cpsat-queue-rejected",
            messageId: message.id,
            attempts: message.attempts,
          }),
        );
        message.ack();
        continue;
      }
      // 投入から受領までを時計 1 つで残す。`message.timestamp` は Queue が付ける投入時刻で、
      // producer のホストの時計を経由しない。
      console.log(
        JSON.stringify({
          kind: "cpsat-queue-received",
          requestId: plan.requestId,
          // 官能評価では「この店舗のこの推奨が CP-SAT か」を言えないと困る。
          // requestId だけでは店舗へ辿れない。
          storeId: plan.storeId,
          attempts: message.attempts,
          enqueuedAt: message.timestamp.getTime(),
          receivedAt: Date.now(),
        }),
      );
      // oxlint-disable-next-line no-await-in-loop
      await deliver(plan, env);
      // `deliver` は自身で失敗を握って記録する（TS/native へ落とさないため）。ゆえに
      // ここまで来れば「試みは終わった」——取り逃した機会は次の状態変化の要求が回収する。
      message.ack();
    }
  },
} satisfies ExportedHandler<CpsatPlannerEnv, CpsatPlanRequest>;

/**
 * sceneOf — 失敗した局面を**組み直せるだけ**の構造を写す（2026-09-14）。
 *
 * **注文の中身は載せない。** 品名・卓・注文番号は局面の再現に要らず、載せれば記録に業務データが
 * 流れる。要るのは「釜がいくつあり、どれが埋まっていて、いつ空くか」「何を何釜で置こうとしたか」だけである。
 */
function sceneOf(request: CpsatPlanRequest) {
  const now = Date.now();
  const slotCount = request.params.unitOrigins.length * 6;
  // 走行中：釜の番号と、いま から何ミリ秒後に上がるか。**同じ釜が二度現れれば重複である**
  // （engine は開始時に占有を検査しない・ADR-0015）。
  const running = request.running.map((timer) => ({
    slots: timer.slotIds.map(Number),
    endsInMs: Number(adjustedEndTime(timer)) - now,
    boiled: timer.boiledAt !== null,
  }));
  const occupied = new Set(running.flatMap((timer) => timer.slots));
  // 対象：`slotSpan` の内訳だけ（何杯が何釜を要るか）。**中盛の修正が効いたかもここで見える。**
  const spans: Record<string, number> = {};
  for (const item of request.pending) {
    const key = String(item.slotSpan);
    spans[key] = (spans[key] ?? 0) + 1;
  }
  return {
    slotCount,
    freeSlots: slotCount - occupied.size,
    // **釜の重複**。走行中の釜の延べ数と相異なる数の差である。0 でなければ正本が壊れている。
    slotCollisions: running.reduce((sum, timer) => sum + timer.slots.length, 0) - occupied.size,
    arms: request.params.arms,
    liftWindowSeconds: request.params.liftIntervalSeconds,
    running,
    spans,
  };
}

async function deliver(request: CpsatPlanRequest, env: CpsatPlannerEnv): Promise<void> {
  try {
    const result = await planCpsat(request, Date.now());
    const store = env.STORE_TIMER_DO.get(env.STORE_TIMER_DO.idFromName(request.storeId));
    await store.deliverPlan({
      ...result.schedule,
      planner: "cpsat",
      inputKey: request.inputKey,
      requestId: request.requestId,
    });
    console.log(
      JSON.stringify({
        kind: "cpsat-plan-computed",
        requestId: request.requestId,
        storeId: request.storeId,
        // 局面の規模。釜が走っている局面で解けているかを、あとから区別できるようにする。
        running: request.running.length,
        pending: request.pending.length,
        status: result.status,
        variables: result.variables,
        memoryBytes: result.memoryBytes,
        placements: result.schedule.slices.reduce((n, slice) => n + slice.placements.length, 0),
        // 卓の数。**棄却の段を集計で分けるために要る**——`pending > 6` で卓が 1 つなら
        // その棄却は一片の完全被覆（`isStale`）であって、計画の良し悪しではない（2026-09-13）。
        slices: result.schedule.slices.length,
        // **実効値を載せる。式から計算した想定ではなく、consumer が実際に使った値である。**
        // 掃引では「摘みが届かない」事故を 3 度やった（`shape` を渡し忘れ／上限が縛らない／
        // 整理で落ちる）。いずれも結果は返るので、値を見比べない限り気づけない。**本番側で
        // それを捕まえる手段はこの 2 欄だけである**（2026-09-13）。
        budget: result.budget,
        targetLimit: result.targetLimit,
        // **受領までの見込み遅れ。** 先頭の配置がこれだけ先から始まる。0 に見えるなら
        // 計画は「今」から置いており、届いた時点で過去開始になる（2026-09-14 の採用 0）。
        deliveryLeadMs: result.deliveryLeadMs,
      }),
    );
  } catch (error) {
    // No TS/native fallback: a failed solve must not masquerade as CP-SAT.
    //
    // **理由を落とさない（2026-09-13）。** 落としていたので、測定窓の失敗 214 件が予算切れか
    // モデル上限かハード制約違反かを**分けられなかった**。失敗の種類で次の手がまるで違う
    // ——予算切れなら探索の話、モデル上限なら定式化の話、容量超過なら engine との食い違いである。
    //
    // 分類は文言で行う。`Error` の型では分けられない（すべて `Error` である）ので、投げる側の
    // 文言ただ一つを見る。**未知は `other` に落として文言をそのまま残す**——知らない失敗を
    // 既知のどれかへ黙って畳まない。
    const text = error instanceof Error ? error.message : String(error);
    const reason = text.includes("no solution")
      ? "no-solution"
      : text.includes("exceeds the bounded runtime")
        ? "model-too-large"
        : text.includes("exceeds 1 MiB")
          ? "model-too-large"
          : text.includes("lift capacity")
            ? "lift-capacity"
            : text.includes("Unsupported CP-SAT cohort size")
              ? "cohort-unsupported"
              : text.includes("No usable slots")
                ? "no-usable-slots"
                : text.includes("Invalid CP-SAT solution")
                  ? "invalid-solution"
                  : "other";
    console.error(
      JSON.stringify({
        kind: "cpsat-plan-failed",
        requestId: request.requestId,
        storeId: request.storeId,
        running: request.running.length,
        pending: request.pending.length,
        reason,
        // **局面そのものを残す（2026-09-14）。**
        //
        // 件数だけでは原因に届かなかった。本番の失敗（`status=UNKNOWN`）について、走行中の本数・
        // 空き釜の数・上がりの近接・釜の重複・満杯という 5 つの仮説をローカルで試し、**すべて外した**
        // ——合成した走行中が本番を写していなかったからである。**推測をやめて実物を写す。**
        //
        // 載せるのは**数と時刻だけ**で、注文の中身（品名・卓・注文番号）は載せない。局面を組み直すのに
        // 要るのは構造であって、誰の注文かではない。
        scene: sceneOf(request),
        // 生の文言も残す（分類が取りこぼした失敗を後から拾えるように）。秘密値は載らない
        // ——投げているのは自分のコードの固定文言と OR-Tools の診断だけである。
        detail: text.slice(0, 200),
      }),
    );
  }
}
