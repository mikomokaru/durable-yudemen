// engine/pending.ts — Order_Item 集合の 2 つの変換（到着の upsert・注文単位の除去）と集合の同一性。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// 到着の意味論は **upsert ひとつ**で足りる。同一 External_Order_Id の再送は冪等（AC 1.3）であり、
// 内容の変更（modification）は「注文属性の更新」として同じ規則から出る（AC 1.8・order-lifecycle Requirement 2）。
// 独立の変更イベントを立てない——立てれば「初回か再送か変更か」を外部の主張に委ねることになり、
// 到着の冪等性が外部の申告の正しさに依存してしまう。こちらの集合と突き合わせて決めるほうが真である。
//
// **品目は開始で消費されない（order-lifecycle 判断 1）。** かつてここに在った「人の開始による消費」（consumeOrder）と
// 「生きた Timer を持つ品目は置換の結果から除く」規則は撤去した。前者は品目を事実として残すモデルと相容れず、後者は
// A を調理中に同じ注文 {A, B} が再送されるだけで正本が {B} に置き換わり、A の参照先が消える（判断 8）。
//
// 2 つの関数はいずれも「変わらないなら入力の配列インスタンスをそのまま返す」。settle の確定結果の
// 同一性判定が空振りの Persist / Broadcast を落とす前段として、ここで no-op を構造的に見えるように
// しておく（呼び出し側が差分を再計算しなくても === で分かる）。

import { itemKeyOf, itemStatusOf, type ItemKey, type OrderItem } from "../domain/order";
import type { NonEmptyArray } from "../domain/timer";
import type { Timer } from "./timer";

/**
 * 到着の upsert（AC 1.2 / 1.3 / 1.8・order-lifecycle Requirement 2）。
 *
 * arrival は Order_Ingress が受理した到着そのまま——`toOrderItems` の出力（`NonEmptyArray<OrderItem>`）を
 * 形を変えずに受ける。到着を包む別型を立てない：品目は既に externalOrderId と受理時刻を持っており、
 * 包み直しても検査は一切増えず、境界で角度を変える手続きだけが増える。空の到着は型で排除する
 * （「品目のない到着」は注文の消滅を意味するが、それを表明する経路は removeOrder ただ一つである）。
 *
 * 規則は一つに揃える（判断 8）——**同じ品目の後着は、状態にかかわらず POS 由来の注文属性だけを更新する。**
 *   1. 同じ鍵（externalOrderId + itemIndex）の品目が在れば、`noodleType` / `firmness` / `tableId` / `slotSpan` /
 *      `itemName` / `sizeName` を到着の値で更新し、厨房の事実（`completedAt` / `interruptedAt`）は保つ（AC 2.1 / 2.2）。
 *      生きた Timer には触れない——`OrderItem` は最新の注文情報、`Timer` はその調理を開始した時点の情報である
 *      （判断 7）。POS の後着で、いま茹でている麺の条件は書き換えない。`done` の品目は再送で `unstarted` に戻らない。
 *   2. **arrivalTime は既存を引き継ぐ。** 既に同一 externalOrderId が集合に在れば、その最早の arrivalTime を
 *      全品目へ与える。変更で待ち時間の起点をリセットしない（AC 1.8 / 2.3）。既存が無ければ到着の受理時刻を使う。
 *   3. 到着に無い同じ注文の品目は、`itemStatusOf(item, timers) === "unstarted"` なら除き、`cooking` / `done` なら残す
 *      （AC 2.5）。前提（POS の取消は発生しない）の外でも、参照整合と履歴を壊さない。Timer 集合を受けるのはこの判定の
 *      ため——`completedAt = null` の品目は Timer が在れば cooking、無ければ unstarted で、品目だけでは区別できない。
 *   4. 集合に無かった品目は `completedAt: null, interruptedAt: null` で加わる（AC 2.4）。v12 由来で参照先の無い Timer が
 *      残る中で POS がその品目を再送すれば、状態は `itemStatusOf` が cooking と導く——実際の入力で参照先が補われる。
 *   5. 結果が現在の集合と同一なら、現在の集合（同じ配列インスタンス）を返す（冪等）。
 *
 * 「同一」は全フィールドの一致で判定する。規則 2 が既存の arrivalTime を引き継いだ後だから、これは
 * 「受理時刻を除く内容の一致」と同義になる——除外を判定側に書かずに済む。
 *
 * 置換は**位置を保つ**（既存の品目は元の位置のまま更新し、新しい品目は当該注文の末尾に置く）。集合の並びは
 * 計画の入力としては無意味（baselineSchedule が arrivalTime 昇順へ整列し直す）だが、並びが揺れると内容の同じ
 * 再送が差分に見えて空振りの Persist / Broadcast を呼ぶ。
 */
export function upsertOrder(
  items: readonly OrderItem[],
  timers: readonly Timer[],
  arrival: NonEmptyArray<OrderItem>,
): readonly OrderItem[] {
  const arrivals = arrivalsOf(arrival);
  const placed = new Set<ItemKey>();
  const next: OrderItem[] = [];

  for (const item of items) {
    const group = arrivals.get(item.externalOrderId);
    // 到着に現れない注文はそのまま残る（到着は自分の注文についてしか語らない）。
    if (group === undefined) {
      next.push(item);
      continue;
    }
    const key = itemKeyOf(item);
    const arrived = group.get(key);
    if (arrived === undefined) {
      // 到着に無い品目——未調理なら消え、調理中・調理済みは残る（AC 2.5）。
      if (itemStatusOf(item, timers) !== "unstarted") next.push(item);
      continue;
    }
    placed.add(key);
    next.push(withOrderAttributes(item, arrived));
  }
  // 新しく現れた品目は当該注文の末尾へ（注文が集合に無ければ集合の末尾へ）。到着に現れた順で並べる。
  for (const [externalOrderId, group] of arrivals) {
    const origin = earliestArrival(items, externalOrderId);
    const fresh: OrderItem[] = [];
    for (const [key, arrived] of group) {
      if (placed.has(key)) continue;
      fresh.push(origin === null ? arrived : { ...arrived, arrivalTime: origin });
    }
    if (fresh.length === 0) continue;
    const last = lastIndexOfOrder(next, externalOrderId);
    next.splice(last + 1, 0, ...fresh);
  }

  return isSameOrderItems(items, next) ? items : next;
}

/**
 * 注文単位の除去（AC 1.5 / 1.6・0 件の後着・`OrderCancelled`）。当該 External_Order_Id の**未調理の品目**を集合から除く。
 *
 * `cooking` / `done` の品目は残す（order-lifecycle AC 2.5）——参照整合（生きた Timer の参照先を消さない）と履歴のため。
 * 対応する未調理の品目が無ければ集合を変えない（no-op）——未到達・既に除去済み・全品目が調理中の
 * 3 つを区別しない。**Timer には触らない。** 開始済み Timer の自動キャンセルは行わない（AC 1.6）：
 * 釜の中の麺を外部システムの都合で消せば、現場が「無くなった理由」を確かめる手段を持たない。
 * 現場の判断に委ねる。
 */
export function removeOrder(
  items: readonly OrderItem[],
  timers: readonly Timer[],
  externalOrderId: string,
): readonly OrderItem[] {
  const next = items.filter(
    (item) =>
      item.externalOrderId !== externalOrderId || itemStatusOf(item, timers) !== "unstarted",
  );
  return next.length === items.length ? items : next;
}

/**
 * 到着を「externalOrderId → (鍵 → 品目)」へ畳む。挿入順は到着に現れた順（Map が保つ）。
 *
 * 同一 (externalOrderId, itemIndex) の重複は初出だけを採る。重複の排除がここに居るのは、toOrderItems が
 * 「集合としての一意性は upsertOrder の関心事」として残した一点だからである（品目単位の妥当性と集合の一意性は
 * 別の問い）。群は品目が 1 つも残らなくても作る——群の不在（到着が触れていない）とは違う。
 */
function arrivalsOf(
  arrival: NonEmptyArray<OrderItem>,
): ReadonlyMap<string, ReadonlyMap<ItemKey, OrderItem>> {
  const groups = new Map<string, Map<ItemKey, OrderItem>>();
  for (const item of arrival) {
    let group = groups.get(item.externalOrderId);
    if (group === undefined) {
      group = new Map();
      groups.set(item.externalOrderId, group);
    }
    const key = itemKeyOf(item);
    if (!group.has(key)) group.set(key, item);
  }
  return groups;
}

/**
 * 既存の品目に到着の注文属性だけを写す。鍵・`arrivalTime`（引継ぎ）・厨房の事実は既存のまま（AC 2.1 / 2.2）。
 * 列挙するのは POS 由来の属性 6 つで、`OrderItem` に属性が増えたときに「どちらの側の事実か」をここで決める。
 */
function withOrderAttributes(existing: OrderItem, arrived: OrderItem): OrderItem {
  return {
    ...existing,
    noodleType: arrived.noodleType,
    firmness: arrived.firmness,
    tableId: arrived.tableId,
    slotSpan: arrived.slotSpan,
    itemName: arrived.itemName,
    sizeName: arrived.sizeName,
  };
}

/**
 * 当該注文が集合に持つ最早の arrivalTime。1 件も無ければ null（引き継ぐ起点が無い）。
 *
 * 最早を採るのは決定性のため——upsert は常に注文単位で同一の arrivalTime を与えるので実際には
 * 全品目が同値だが、最小は集合の並びに依らない。
 */
function earliestArrival(items: readonly OrderItem[], externalOrderId: string): number | null {
  let earliest: number | null = null;
  for (const item of items) {
    if (item.externalOrderId !== externalOrderId) continue;
    if (earliest === null || item.arrivalTime < earliest) earliest = item.arrivalTime;
  }
  return earliest;
}

/** 当該注文の最後の品目の位置。無ければ末尾に置くための `length - 1`。 */
function lastIndexOfOrder(items: readonly OrderItem[], externalOrderId: string): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index]!.externalOrderId === externalOrderId) return index;
  }
  return items.length - 1;
}

/**
 * 2 つの集合が同一か（並びも含む全フィールドの一致）。
 *
 * 使い手は 2 つ——upsert の冪等判定（このファイル）と、settle の確定結果の同一性判定である。
 * 「Order_Item 集合が同一とは何か」を settle 側に書き写せば、集合の同一性が二つになる。
 * 並びを含めるのは、集合が snapshot に全量で載る（並びが配信内容の一部である）ためである。
 */
export function isSameOrderItems(left: readonly OrderItem[], right: readonly OrderItem[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => isSameOrderItem(item, right[index]));
}

/**
 * 1 品目の同一性。全フィールドを突き合わせる（起点の引き継ぎは呼び出し前に済んでいる）。厨房の事実
 * （`completedAt` / `interruptedAt`）も含める——complete / cancel は Timer 集合も動かすので Timer の比較でも
 * 変化は見えるが、品目の同一性は品目の全フィールドで閉じて判定する（Timer の変化に頼らない）。注文属性だけの
 * 後着（名称・盛り・占有数）も確定変化になる。
 */
function isSameOrderItem(left: OrderItem, right: OrderItem | undefined): boolean {
  return (
    right !== undefined &&
    left.externalOrderId === right.externalOrderId &&
    left.itemIndex === right.itemIndex &&
    left.noodleType === right.noodleType &&
    left.firmness === right.firmness &&
    left.tableId === right.tableId &&
    left.arrivalTime === right.arrivalTime &&
    left.slotSpan === right.slotSpan &&
    left.itemName === right.itemName &&
    left.sizeName === right.sizeName &&
    left.completedAt === right.completedAt &&
    left.interruptedAt === right.interruptedAt
  );
}
