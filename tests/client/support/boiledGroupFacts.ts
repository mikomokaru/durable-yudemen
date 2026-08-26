// tests/client/support/boiledGroupFacts.ts — 一括完了の盤面から事実を読み取る述語を共有する。
//
// 同じ読み取りを二つのファイルが要する。性質の検査（boiledGroup.property.test.ts）は言明の前提と期待値を
// 導くために、カバレッジの検査（boiledGroupGenerators.smoke.test.ts）は生成器がその次元を踏んだかを
// 分類するために、いずれも「対象は誰か」「担当スロットを駆動するか」「その順で最後に駆動するのは誰か」を
// 問う。二つのファイルへ同じ .find・同じ担当判定・同じ最後勝ちの走査を書けば、同じ概念が二箇所で
// 定義される。ゆえに読み取りはここ一箇所に置く。
//
// **畳み込み（LocalComplete の適用）はここに置かない。** カバレッジの検査は畳み込みの結果について何も
// 主張しないため、畳み込みは性質の検査の側だけに要る。共有の口を広げれば、その境界が曖昧になる。

import { assignedTimers } from "../../../src/client/assignment";
import type { ClientTimer, ClientView } from "../../../src/client/connection";

/** 対象 Timer をビューから引く（不在なら undefined）。boiledGroup の関門と同じ引き方を二度書かない。 */
export function findTarget(view: ClientView, timerId: string): ClientTimer | undefined {
  return view.timers.find((timer) => timer.id === timerId);
}

/**
 * その Timer が担当ユニットのいずれかのスロットを駆動するか（unit u は slot 6u..6u+5）。
 * 判定は assignment.ts の担当射影（any-overlap）へ委ね、担当判定を二度書かない。
 */
export function drivesAssignedSlot(timer: ClientTimer, units: readonly number[]): boolean {
  return assignedTimers([timer], units).length === 1;
}

/**
 * 与えた反映順で、そのスロットを駆動する最後のメンバー（誰も駆動しなければ undefined）。
 * 要件8.4 の競合規則そのものの形で書く——Map の上書き手順を写さない。
 */
export function lastDriverOf(order: readonly ClientTimer[], slotId: string): ClientTimer | undefined {
  return order.reduce<ClientTimer | undefined>(
    (last, member) => (member.slotIds.includes(slotId) ? member : last),
    undefined,
  );
}
