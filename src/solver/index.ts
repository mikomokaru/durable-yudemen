// solver/index.ts — Solver_Worker のエントリ（要件12）。DO ではない別 Worker の端。
//
// 役目は 3 つだけである。受理を即座に返す・計算を ctx.waitUntil で抱える・完了したら店舗 DO の
// deliverPlan を呼ぶ。DO ではないため hibernation 規律に触れない——「抱えると漏れる」が禁じているのは
// 寝られるはずの DO が待ちを抱えることで、ここは待つために起きている Worker である。
//
// **この段の計画生成は経路確認用の最小実装である。** 返すのは DO 自身の自前解と同値の計画で、
// Acceptance_Gate の改善判定（同値は棄却）に必ず落ちる。落ちることが正しい振る舞いであり、経路が
// 通っていることと、棄却が無害であることの両方を同時に示す。最適化アルゴリズム本体は本 spec の
// スコープ外（tasks.md「スコープの境界」）。
//
// **本来この Worker は engine を import しない**（design「依存方向は solver → domain」）。骨格の計画生成が
// 自前解と同値であることを保証する最短の形が `baselineSchedule` を呼ぶことなので、この段だけ engine を
// 借りる。探索本体を入れる段でこの import は外れる——外部の採点は近似でよく（採否は engine の admit が
// engine 自身の採点で決める）、engine の内部形に縛られたままでは Rust → WASM への差し替えが engine の型に
// 引きずられるためである（design「意図的な重複」）。

import { baselineSchedule, initialRelease, type CookSchedule } from "../engine/schedule";
import type { EpochMillis } from "../engine/types";
import { SLOTS_PER_UNIT } from "../domain/store";
import type { PlanRequest } from "./request";
import type { StoreTimerDO } from "../shell/store-timer-do";

/**
 * 自前の打ち切り予算（ミリ秒・AC 12.4）。`limits.cpu_ms` は既定のまま据え置く。
 *
 * 実効の壁は CPU 時間ではなく invocation 終了後の `ctx.waitUntil` に掛かる 30 秒の上限であり、
 * `limits.cpu_ms` を上げてもこの壁は伸びない。予算を自前で持てば、壁に当たって切られるのではなく
 * 計算側が自分の意思で最良解を返して終える（時間打ち切りによる非決定性は AC 12.7 で許容されている）。
 * 5 秒は 30 秒の壁に対して十分な余裕を残す値——往路の 202 応答・デシリアライズ・復路の RPC がこの外側に乗る。
 */
const SOLVE_BUDGET_MS = 5_000;

/** Solver_Worker が要する env の最小面。復路 RPC のための DO バインディングただ一つ（AC 12.1）。 */
interface SolverEnv {
  /** 店舗 DO の名前空間。`idFromName(storeId)` で引いた stub の `deliverPlan` が復路である。 */
  readonly STORE_TIMER_DO: DurableObjectNamespace<StoreTimerDO>;
}

/**
 * Solver_Worker 本体。
 *
 * **受理応答（202）を即返す**（AC 12.2）。呼び出し元（店舗 DO の shell）はこの応答だけを await し、計算完了を
 * 待たない——待てば DO が計算の間ずっと起きたままになる。計算は `ctx.waitUntil` が invocation の外側で抱える。
 */
export default {
  async fetch(request: Request, env: SolverEnv, ctx: ExecutionContext): Promise<Response> {
    // **予算の起点は受理の時点に置く。** デシリアライズもこの内側に入れることで、予算が「要求が届いてから
    // 何秒で答えるか」を表す。ボディを読んだ後に起点を採ると、大きな入力の読み取り時間が予算の外へ逃げる。
    const deadline = Date.now() + SOLVE_BUDGET_MS;

    if (request.method !== "POST") {
      return new Response("Expected POST", { status: 405 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Malformed request", { status: 400 });
    }
    // 到達＝自分自身の shell が Service binding 経由で組んだ健全な要求ゆえ、形の再検証はしない
    // （store-timer-do.ts の applyProjection と同じ判断）。ただし storeId だけは見る——復路の宛先が
    // この 1 値だけで決まるため、欠けていれば計算しても届け先が無い。
    const plan = body as PlanRequest;
    if (typeof plan.storeId !== "string" || plan.storeId.length === 0) {
      return new Response("Malformed request", { status: 400 });
    }

    ctx.waitUntil(deliver(plan, env, deadline));
    return new Response(null, { status: 202 });
  },
} satisfies ExportedHandler<SolverEnv>;

/**
 * 計画を求め、復路 RPC で店舗 DO へ届ける（AC 12.3）。
 *
 * 復路の失敗（DO 側の一時障害・ネットワーク）は握って落とす。DO 側は in-flight を追跡せず応答監視の Alarm も
 * 張らないため（AC 10.4）、届かなかった要求は「何も起きない」に収束し、次の状態変化での要求生成が回収する
 * （AC 10.1 / 10.2）。ここで再試行を抱えれば、無害な失敗のために Worker が待ちを持つことになる。
 */
async function deliver(request: PlanRequest, env: SolverEnv, deadline: number): Promise<void> {
  const plan = searchPlan(request, deadline);
  if (plan === null) return;
  // 宛先は storeId ただ一つ（design「復路」）。locationHint は与えない——要求を出した DO は既に存在しており、
  // hint は新規作成時の配置にしか効かない（既存 DO へは意味を持たない値を渡さない）。
  const store = env.STORE_TIMER_DO.get(env.STORE_TIMER_DO.idFromName(request.storeId));
  try {
    await store.deliverPlan(plan);
  } catch {
    // 復路の不到達は無害。DO 側は状態を変えず、Committed_Plan は自前解だけで成立し続ける（AC 10.1）。
  }
}

/**
 * 予算の内側で最良の計画を求める。予算が尽きていれば null（送るものが無い）。
 *
 * **この段の候補は 1 つだけである**（自前解と同値）。予算を「候補を作る前に問う」形に置くのは、探索本体を
 * 入れる段が同じ問いを候補ごとに繰り返す形へそのまま広がるためで、いま無いループを先回りで置かない。
 *
 * `now` は自分の時計から採る。往路のボディは `now` を運ばない——Input_Fingerprint が `now` を畳まないのと
 * 同じ理由（時間の経過は状態変化ごとの再評価が扱うもので、外部へ問い直す入力ではない）。
 */
function searchPlan(request: PlanRequest, deadline: number): CookSchedule | null {
  if (Date.now() >= deadline) return null;
  const now = Date.now() as EpochMillis;
  // 置ける場所の全体＝ユニット数 × ユニットあたりの slot 数。ユニット原点の数が unitCount を表す
  // （domain/store.ts の合成座標の規約）。
  const release = initialRelease(
    request.running,
    now,
    request.params.unitOrigins.length * SLOTS_PER_UNIT,
  );
  return baselineSchedule(request.pending, release, request.noodlePresets, request.params);
}
