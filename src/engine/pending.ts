// engine/pending.ts — Pending_Order 集合の 3 つの変換（到着の upsert・キャンセル・人の開始による消費）。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// 到着の意味論は **upsert ひとつ**で足りる。同一 External_Order_Id の再送は冪等（AC 1.3）であり、
// 内容の変更（modification）は「キャンセル＋新規到着」への正規化として同じ規則から出る（AC 1.8）。
// 独立の変更イベントを立てない——立てれば「初回か再送か変更か」を外部の主張に委ねることになり、
// 到着の冪等性が外部の申告の正しさに依存してしまう。こちらの集合と突き合わせて決めるほうが真である。
//
// 3 つの関数はいずれも「変わらないなら入力の配列インスタンスをそのまま返す」。settle の確定結果の
// 同一性判定が空振りの Persist / Broadcast を落とす前段として、ここで no-op を構造的に見えるように
// しておく（呼び出し側が差分を再計算しなくても === で分かる）。

import type { PendingOrder } from "../domain/order";
import type { NonEmptyArray } from "../domain/timer";
import type { Timer } from "./timer";

/**
 * 到着の upsert（AC 1.2 / 1.3 / 1.8）。
 *
 * arrival は Order_Ingress が受理した到着そのまま——`toPendingOrders` の出力（`NonEmptyArray<PendingOrder>`）を
 * 形を変えずに受ける。到着を包む別型を立てない：品目は既に externalOrderId と受理時刻を持っており、
 * 包み直しても検査は一切増えず、境界で角度を変える手続きだけが増える。空の到着は型で排除する
 * （「品目のない到着」は注文の消滅を意味するが、それを表明する経路は removeOrder ただ一つである）。
 *
 * 規則は 4 つ。
 *   1. 到着に現れた externalOrderId の品目群を、到着の内容で**置換**する（差分適用ではない）。
 *      到着に含まれない品目は当該注文から消える——modification の「キャンセル＋新規到着」の正規化。
 *   2. **arrivalTime は既存を引き継ぐ。** 既に同一 externalOrderId が集合に在れば、その最早の
 *      arrivalTime を全品目へ与える。変更で待ち時間の起点をリセットしない（AC 1.8）。既存が無ければ
 *      到着の受理時刻を使う。
 *   3. **生きた Timer を持つ品目は置換の結果から除く**（running を受け取る理由・AC 1.3 / 8.4）。
 *      一部品目が既に開始された注文について POS が全品目を含む内容を再送すると、除外しなければ
 *      開始済み品目が待ち行列へ復活して二重調理になる。
 *   4. 結果が現在の集合と同一なら、現在の集合（同じ配列インスタンス）を返す（冪等）。
 *
 * 「同一」は arrivalTime を含む全フィールドの一致で判定する。規則 2 が既存の arrivalTime を引き継いだ
 * 後だから、これは「受理時刻を除く内容の一致」と同義になる——除外を判定側に書かずに済む。
 *
 * 置換は**位置を保つ**（当該注文の最初の品目が居た位置へ新しい品目群を置く）。集合の並びは計画の
 * 入力としては無意味（baselineSchedule が arrivalTime 昇順へ整列し直す）だが、並びが揺れると
 * 内容の同じ再送が差分に見えて空振りの Persist / Broadcast を呼ぶ。
 *
 * **受容する限界:** 保護されるのは Timer が生きている間（running / boiled）だけである。明示完了で
 * Timer が除かれた後に同一 externalOrderId の modification が届くと、提供済みの品目が待ち行列へ
 * 復活しうる。完全に塞ぐには「完了済み品目の台帳」が要り、それは導出できない事実を無際限に抱える
 * 状態になる。台帳を持たない判断をここで明示する（design.md の限界注記）。同じ理由で、当該注文の
 * 品目がすべて消えている（開始済み・キャンセル済み）ときは引き継ぐ arrivalTime が無く、到着の受理
 * 時刻が起点になる。
 */
export function upsertOrder(
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  arrival: NonEmptyArray<PendingOrder>,
): readonly PendingOrder[] {
  const replacements = replacementsOf(pending, running, arrival);
  const placed = new Set<string>();
  const next: PendingOrder[] = [];

  for (const order of pending) {
    const group = replacements.get(order.externalOrderId);
    // 到着に現れない注文はそのまま残る（到着は自分の注文についてしか語らない）。
    if (group === undefined) {
      next.push(order);
      continue;
    }
    if (placed.has(order.externalOrderId)) continue; // 置換済み——旧品目は落とす。
    placed.add(order.externalOrderId);
    next.push(...group);
  }
  // 集合に無かった注文（初回到着）は末尾へ。到着に現れた順で並べる。
  for (const [externalOrderId, group] of replacements) {
    if (placed.has(externalOrderId)) continue;
    next.push(...group);
  }

  return isSamePending(pending, next) ? pending : next;
}

/**
 * キャンセル（AC 1.5 / 1.6）。当該 External_Order_Id の**全品目**を集合から除く。
 *
 * 対応する Pending_Order が無ければ集合を変えない（no-op）——未到達・既に除去済み・既に開始済みの
 * 3 つを区別しない。**Timer には触らない。** 開始済み Timer の自動キャンセルは行わない（AC 1.6）：
 * 釜の中の麺を外部システムの都合で消せば、現場が「無くなった理由」を確かめる手段を持たない。
 * 現場の判断に委ねる。
 */
export function removeOrder(pending: readonly PendingOrder[], externalOrderId: string): readonly PendingOrder[] {
  const next = pending.filter((order) => order.externalOrderId !== externalOrderId);
  return next.length === pending.length ? pending : next;
}

/**
 * 人の開始で当該品目を集合から除く（AC 8.4）。除くのは 1 品目だけ——同じ注文の他の品目はまだ未着手である。
 *
 * 開始そのものは既存の start 経路が担い、ここは待ち行列側の帰結だけを写す。開始が推奨と違っても
 * 拒否しない（AC 8.3）ので、この関数は推奨を一切参照しない。
 */
export function consumeOrder(
  pending: readonly PendingOrder[],
  externalOrderId: string,
  itemIndex: number,
): readonly PendingOrder[] {
  const next = pending.filter(
    (order) => order.externalOrderId !== externalOrderId || order.itemIndex !== itemIndex,
  );
  return next.length === pending.length ? pending : next;
}

/**
 * 到着を「externalOrderId → 置換後の品目群」へ畳む。挿入順は到着に現れた順（Map が保つ）。
 *
 * ここで 3 つを同時に済ませる：起点の引き継ぎ・開始済み品目の除外・同一 (externalOrderId, itemIndex) の
 * 重複の排除。重複の排除がここに居るのは、toPendingOrders が「集合としての一意性は upsertOrder の
 * 関心事」として残した一点だからである（品目単位の妥当性と集合の一意性は別の問い）。
 */
function replacementsOf(
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  arrival: NonEmptyArray<PendingOrder>,
): ReadonlyMap<string, readonly PendingOrder[]> {
  const started = startedItems(running);
  const groups = new Map<string, PendingOrder[]>();
  const seen = new Set<string>();

  for (const item of arrival) {
    // 群は品目が 1 つも残らなくても作る。「開始済みだけを含む到着」は当該注文の未着手分が
    // すべて消えたという主張であり、空の群がその置換を表す（群の不在＝到着が触れていない、とは違う）。
    let group = groups.get(item.externalOrderId);
    if (group === undefined) {
      group = [];
      groups.set(item.externalOrderId, group);
    }
    const key = itemKey(item.externalOrderId, item.itemIndex);
    if (seen.has(key)) continue; // 到着内の重複は初出だけを採る。
    seen.add(key);
    if (started.has(key)) continue; // 生きた Timer を持つ品目は復活させない。
    const origin = earliestArrival(pending, item.externalOrderId);
    group.push(origin === null ? item : { ...item, arrivalTime: origin });
  }
  return groups;
}

/** 生きた Timer（running / boiled）が占めている注文品目の鍵集合。アドホック麺茹で（orderItem === null）は無関係。 */
function startedItems(running: readonly Timer[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const timer of running) {
    if (timer.orderItem === null) continue;
    keys.add(itemKey(timer.orderItem.externalOrderId, timer.orderItem.itemIndex));
  }
  return keys;
}

/**
 * 当該注文が集合に持つ最早の arrivalTime。1 件も無ければ null（引き継ぐ起点が無い）。
 *
 * 最早を採るのは決定性のため——upsert は常に注文単位で同一の arrivalTime を与えるので実際には
 * 全品目が同値だが、最小は集合の並びに依らない。
 */
function earliestArrival(pending: readonly PendingOrder[], externalOrderId: string): number | null {
  let earliest: number | null = null;
  for (const order of pending) {
    if (order.externalOrderId !== externalOrderId) continue;
    if (earliest === null || order.arrivalTime < earliest) earliest = order.arrivalTime;
  }
  return earliest;
}

/** 品目を一意に指す鍵。externalOrderId に現れない区切り文字で結び、id の中の記号で衝突しないようにする。 */
function itemKey(externalOrderId: string, itemIndex: number): string {
  return `${externalOrderId}\u0000${itemIndex}`;
}

/**
 * 2 つの集合が同一か（並びも含む全フィールドの一致）。
 *
 * 使い手は 2 つ——upsert の冪等判定（このファイル）と、settle の確定結果の同一性判定である。
 * 「Pending_Order 集合が同一とは何か」を settle 側に書き写せば、待ち行列の同一性が二つになる。
 * 並びを含めるのは、集合が snapshot に全量で載る（並びが配信内容の一部である）ためである。
 */
export function isSamePending(left: readonly PendingOrder[], right: readonly PendingOrder[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((order, index) => isSameOrder(order, right[index]));
}

/** 1 品目の同一性。arrivalTime を含む全フィールドを突き合わせる（起点の引き継ぎは呼び出し前に済んでいる）。 */
function isSameOrder(left: PendingOrder, right: PendingOrder | undefined): boolean {
  return (
    right !== undefined &&
    left.externalOrderId === right.externalOrderId &&
    left.itemIndex === right.itemIndex &&
    left.noodleType === right.noodleType &&
    left.firmness === right.firmness &&
    left.tableId === right.tableId &&
    left.arrivalTime === right.arrivalTime
  );
}
