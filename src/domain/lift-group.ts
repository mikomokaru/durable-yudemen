// domain/lift-group.ts — 同時に上げる群（Lift_Group）の連鎖と Head の共有導出。
//
// 表示（client の liftGroups.ts・lift-group-display 判断 19・21）と採点（engine の Change_Cost・plan-stability
// 判断 8）が**同じ関数**で「表示できる群」と「先頭 arms 本」を導く。定義を二箇所に持てば、表示が濃く出す品目と
// 計画が守る品目が食い違い、守ったつもりの先頭が現場では薄いままになる。ゆえに domain に一つだけ置く。
//
// 入力は推奨（`group` / `anchor` は engine の recommend が付ける）と、それが指す品目・茹で秒（LiftItem）、占有
// されている釜の集合、判定の時点の now、腕の本数 arms。ビューにも状態にも依らない純粋関数で、同じ入力からは
// 同じ結果に達する（lift-group-display AC 1.10）。担当範囲では絞らない——群・開始・連鎖・全釜 idle は店舗全体で
// 判定する（AC 1.6 / 2.12）。

import { PREP_LEAD_MS, type CookRecommendation } from "./messages";
import { compareArrival, itemKeyOf, type ItemKey, type PendingOrder } from "./order";
import { slotOf } from "./store";
import { isNonEmpty, type NonEmptyArray } from "./timer";

/**
 * 群の 1 品目——推奨と、それが指す品目、開始に用いる茹で秒が揃った形。
 *
 * 茹で秒は Pending_Order も推奨も持たない導出値（麺種プリセットから noodleType × firmness で引く）ゆえ、
 * 引けた事実として同乗させる。上がる時刻は `startAt + boilSeconds × 1000` で導ける（ここでは持たない）。
 * 群の所属と錨は `recommendation.group` / `recommendation.anchor` で、client も engine もここから読む。
 */
export interface LiftItem {
  readonly recommendation: CookRecommendation;
  readonly order: PendingOrder;
  readonly boilSeconds: number;
}

/**
 * 同時に上げる群（Lift_Group）——`CookRecommendation.group` が等しい推奨の集合（lift-group-display 判断 20）。
 *
 * 品目の型を引数に取るのは、client が品目にカードの読む提案（QueueSuggestion）を重ねたまま群を運ぶためで、
 * 群の形そのものは domain の一つである。
 */
export interface LiftGroupOf<T extends LiftItem = LiftItem> {
  /** engine が付けた群の識別子（snapshot 内で閉じる）。 */
  readonly group: string;
  /** 合流した走行中の錨の実効 endTime。合流していなければ null（engine が付ける）。 */
  readonly anchor: number | null;
  /** startAt 昇順・同値は到着順（compareArrival）。 */
  readonly items: NonEmptyArray<T>;
  /**
   * 群の最初の 1 本が始まった事実（Group_Started・判断 16 / 20）——`anchor` が非 null で、かつ `anchor > now`。
   * 錨の Timer が茹で上がると開始済みでなくなる（茹で上がり後は保持しない）。
   */
  readonly started: boolean;
}

/**
 * 推奨の全量から群を導く。最早 startAt 順・同値は先頭品目の到着順（lift-group-display AC 1.4）。
 *
 * 群の鍵は `recommendation.group`（engine が付けた識別子）そのもので、卓も serveAt も見ない（AC 1.2）。
 * started は `anchor` が now より後であること（AC 1.7）。boiled（anchor ≤ now）を数えないのは、茹で上がりの
 * 発火で計画が残りを新しい群に組み直す——判定側が発火の snapshot より先に同じ結論に達するだけで、届いた
 * snapshot と食い違わない（判断 16）。同じ群の推奨は同じ `anchor` を運ぶ（engine の射影がそう定める）ので、
 * 先頭品目の値で足りる。
 */
export function liftGroupsOf<T extends LiftItem>(
  items: readonly T[],
  now: number,
): readonly LiftGroupOf<T>[] {
  const buckets = new Map<string, { anchor: number | null; items: T[] }>();
  for (const item of items) {
    const { group, anchor } = item.recommendation;
    const bucket = buckets.get(group);
    if (bucket) bucket.items.push(item);
    else buckets.set(group, { anchor, items: [item] });
  }

  const groups: LiftGroupOf<T>[] = [];
  for (const [group, bucket] of buckets) {
    const sorted = [...bucket.items].sort(compareItems);
    if (!isNonEmpty(sorted)) continue; // 束は 1 件以上で作られる。型のためだけの確認で、実行時には通らない
    const { anchor } = bucket;
    const started = anchor !== null && anchor > now;
    groups.push({ group, anchor, items: sorted, started });
  }
  return groups.sort((a, b) => compareItems(a.items[0], b.items[0]));
}

/** 群の中の並び（startAt 昇順・同値は到着順）。群どうしの並びも先頭品目のこの順序で決める。 */
function compareItems(a: LiftItem, b: LiftItem): number {
  return a.recommendation.startAt - b.recommendation.startAt || compareArrival(a.order, b.order);
}

/**
 * 表示できる群（Visible_Groups）——先頭の群と、それより前の群がすべて started の群（判断 19・AC 1.8）。
 *
 * 先頭は常に表示できる。以降は直前までがすべて started の間だけ続き、started でない群で連鎖が止まる
 * ——その群の 1 本目が始まるまで後続を解禁しない（AC 2.9 / 2.10）。
 */
export function visibleGroupsOf<T extends LiftItem>(
  groups: readonly LiftGroupOf<T>[],
): readonly LiftGroupOf<T>[] {
  const visible: LiftGroupOf<T>[] = [];
  for (const group of groups) {
    visible.push(group);
    if (!group.started) break;
  }
  return visible;
}

/**
 * 表示できる品目——表示できる群の品目のうち、全釜 idle と Prep_Lead を満たすもの。並びは（群の順, 群の中の順）。
 *
 * 「idle」は「その釜が occupied に無い」——呼び出し側が店舗全体の Timer（running / boiled とも・担当外を含む）
 * から組む（AC 2.7）。一部の釜が埋まった複数釜の推奨はどの釜にも出さない（判断 15）。Prep_Lead は
 * `now ≥ startAt − PREP_LEAD_MS`（AC 2.1）。Head も後続（member）もこの集合の中に在る。
 */
export function displayableItemsOf<T extends LiftItem>(
  visible: readonly LiftGroupOf<T>[],
  occupied: ReadonlySet<number>,
  now: number,
): readonly T[] {
  const shown: T[] = [];
  for (const group of visible) {
    for (const item of group.items) {
      const { slotIds, startAt } = item.recommendation;
      if (slotIds.some((slotId) => occupied.has(slotOf(slotId)))) continue; // 全釜 idle（AC 2.7）
      if (now < startAt - PREP_LEAD_MS) continue; // Prep_Lead（AC 2.1）
      shown.push(item);
    }
  }
  return shown;
}

/**
 * Head（先頭）——表示できる品目のうち開始推奨時刻が来たもの（`startAt ≤ now`）を時刻順（同値は群の順・品目の順）
 * に並べた先頭 `arms` 本の鍵（判断 21・plan-stability Glossary）。
 *
 * 並びは**開始推奨時刻の順**で、群の順ではない。群の順で数えると、同じ snapshot で時間が進んだだけで前の群の
 * 後の品目が後の群の先頭を押しのけ、濃さが消える（lift-group-display 6.3 の単調性に反する）。時刻順なら新たに
 * 時刻が来た品目は既存の先頭より後ろに並ぶので、先頭は始めるまで先頭のままである。arms が 0 以下なら空。
 */
export function headsOf<T extends LiftItem>(
  visible: readonly LiftGroupOf<T>[],
  occupied: ReadonlySet<number>,
  now: number,
  arms: number,
): readonly ItemKey[] {
  return displayableItemsOf(visible, occupied, now)
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => now >= item.recommendation.startAt)
    .sort(
      (a, b) => a.item.recommendation.startAt - b.item.recommendation.startAt || a.order - b.order,
    )
    .slice(0, Math.max(0, arms))
    .map(({ item }) => itemKeyOf(item.order));
}
