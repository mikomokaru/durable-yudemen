// client/boiledGroup.ts — 同時上がり群（Boiled_Group）の再構成。純粋・決定的。
// 押下のたびに view.timers と補正後現在時刻から導き直す導出値であり、ClientView のフィールドにしない
// （導出値を状態に昇格させない・要件9.4）。
//
// 型限定 import ゆえ実行時の循環は生じない。

import type { ClientTimer, ClientView } from "./connection";

/**
 * 同時上がり群（Boiled_Group）の再構成（要件1 / 1.2 / 1.4 / 3.2）。
 *
 * boiled の検査を対象について一度しか行わないのは、correctedNow を固定すれば boiled が endTime のみの
 * 関数だからである。対象と実効 endTime が等しいメンバーは、対象が boiled であるとき必ず boiled であり、
 * メンバーごとの検査は同じ真実の二度書きになる（要件1.6 / 3.1 はこの構造から導かれる）。述語 endTime <=
 * correctedNow は dueLocalTimers と同一である——同じ endTime に対して「鳴った」と「上げられる」がずれない。
 *
 * 等値のみで集め、許容窓を持ち込まない。同期が endTime をそろえるのは「一致させる」ことであり、
 * 一致していないものは同期の対象外だったという事実の表明である。窓で拾えばその事実を曇らせる。
 *
 * 担当射影は掛けない。同時に上がった以上、担当ユニット外のスロットを駆動するメンバーも群の一員である
 * （要件4.1 / 4.2）。操作口が担当スロットに限られること（要件4.3）とは別の関心事。
 *
 * 並び順は view.timers の並びを保つ（新しい順序規律を作らない）。degraded / provisional 経路の反映順は
 * この並びで決まる（要件8.5）。
 *
 * correctedNow は端が now() + view.offset で採って渡す。
 */
export function boiledGroup(
  view: ClientView,
  timerId: string,
  correctedNow: number,
): readonly ClientTimer[] {
  const target = view.timers.find((timer) => timer.id === timerId);
  if (target === undefined || target.endTime > correctedNow) return [];
  return view.timers.filter((timer) => timer.endTime === target.endTime);
}
