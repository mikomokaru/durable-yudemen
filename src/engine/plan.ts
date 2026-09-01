// engine/plan.ts — 外部（Solver_Worker）から届いた計画の受領。Acceptance_Gate を通す純粋変換。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// **order.ts へ置かない。** あちらは冒頭が語るとおり「POS 由来のオーダー到着・取り消し」の場であり、
// 2 つの遷移を 1 ファイルに置く理由は「どちらも Timer に触れず Pending_Order 集合だけを動かす、
// 集合操作の上に一枚被せるだけの薄さ」である。受領が動かすのは採用済み計画（acceptedSlices）で、
// しかも現行 Committed_Plan の導出（commit.ts）と採否の判定（admit.ts）を通す別の関心事である。
// 同居させれば order.ts の冒頭が嘘になり、「拒否経路を持たない」というあちらの規律の理由づけも濁る。
// 遷移ごとに 1 ファイル（start / cancel / complete / adjust / fire / order）という既存の形にそのまま乗る。
//
// ここに置くのは「受領という遷移」だけである。計画の型と自前解は schedule.ts、採点は objective.ts、
// 合成は commit.ts、採否は admit.ts が持つ——判定も採点も一行も書き直さない（同じ概念は一箇所）。
//
// **engine が受け取るのは検証済みの CookSchedule ただ一つである。** 解析不能・スキーマ不正・
// Input_Fingerprint の欠落（AC 10.3）は境界で落とし、ここには型の立った計画だけが届く。生値の検証を
// engine に置かないのは既存の規律そのもので（domain の toPendingOrders・shell の parseClientMessage が
// 境界で検証し、engine は検証済みの型だけを受ける）、CookSchedule がブランド型と非空配列を含むことが
// その規律を型で要求している。届かなかった計画は状態を一切変えない——AC 10.3 の「全体棄却」は、
// 受け口が事象を起こさないという形で満たされる。型の内側で成立していない計画（釜の割り込み・
// 茹で時間と食い違う serveAt・同一 Table_Group の二重計画）は admit が落とす。

import type { TimerState } from "./state";
import type { Event } from "./event";
import type { Outcome } from "./effect";
import { admit } from "./admit";
import { committedSchedule } from "./commit";
import { settle } from "./settle";
import type { SettleParams } from "./settle";

/** PlanArrived イベントの本体。receivePlan はこの形だけを受け取る（event.ts の唯一の出所を再利用）。 */
type PlanArrivedEvent = Extract<Event, { type: "PlanArrived" }>;

/**
 * 外部計画の受領（AC 6.1 / 6.5 / 6.6 / 10.3）。
 *
 * **比較基準は現行 Committed_Plan であって Baseline_Plan ではない。** 基準を自前解に取れば、既に採用した
 * より良い計画を後着の劣る計画が上書きできてしまう（AC 6.2(d) が Committed_Plan 基準を要求する理由）。
 * その導出は `committedSchedule` ただ一つ——採用済み一片と現在の待ち行列・Timer 集合から毎回導く導出値で、
 * 状態には持たない。
 *
 * 採用があれば `acceptedSlices` を採用された接頭辞へ置き換えて `settle` に委ねる。`mayRequestPlan` は偽
 * ——受領を新たな要求の契機にしない（要求の連鎖・ループを作らない・AC 5.7）。次の状態変化が、指紋の
 * 食い違いを見て改めて要求を出す。
 *
 * **全棄却は早期に返す。** 変化なしの状態を `settle` へ渡して Effect が出ないことに委ねる形は採らない。
 * `settle` は running を全体再同期する（synchronize）ため、Timer 集合を一切動かさない受領であっても、
 * パラメータ（arms / toleranceRatio）の差し替えを跨いだ状態では再同期の結果が現在の adjustment と
 * 食い違い、棄却された受領が `Persist` と `Broadcast` を出しうる。AC 6.6（すべて棄却なら状態を変えず
 * Persist も Broadcast も行わない）は無条件の断言であり、`settle` の副次的な性質に委ねてよい主張ではない。
 * 返す状態が引数の `state` そのものであることが、「状態を変更しない」を構造で示す。
 */
export function receivePlan(
  state: TimerState,
  args: PlanArrivedEvent,
  params: SettleParams,
): Outcome {
  const committed = committedSchedule(
    state.acceptedSlices,
    state.pendingOrders,
    state.timers,
    args.now,
    params.noodlePresets,
    params,
  );
  const accepted = admit(
    args.plan,
    committed,
    state.pendingOrders,
    state.timers,
    args.now,
    params.noodlePresets,
    params,
  );
  if (accepted.length === 0) return { ok: true, state, effects: [] };

  const moved: TimerState = { ...state, acceptedSlices: accepted };
  return settle(state, moved, params, args.now, false);
}
