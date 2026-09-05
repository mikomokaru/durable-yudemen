// client/components/liftGroups.ts — 同時に上げる群と、そこから釜に出す提案を導く純粋関数。
// WS も DOM も触れない。受信ビュー（推奨・待ち行列・Timer の全量）と補正後現在時刻から、描画のたびに導く
// （保持は全量・表示は導出／slotDisplay.ts と同じ規律）。群も先頭もビューに保持しない（lift-group-display AC 1.5）。
//
// 判定はすべて snapshot と Corrected_Now の関数である。端末ごとの履歴・過去の描画・推奨の消失を読まない
// （AC 1.7 / 1.10）——途中接続した端末も、接続し続けた端末も、同じ snapshot からは同じ群・同じ先頭・同じ提案に
// 達する。担当範囲で絞るのは表示（assignedSlotDisplays）だけで、群・開始・連鎖・全釜 idle は店舗全体で判定する
// （AC 1.1 / 1.6 / 2.12）。

import { PREP_LEAD_MS } from "../../domain/messages";
import type { PendingOrder } from "../../domain/order";
import { SLOTS_PER_UNIT, slotDistance, slotOf } from "../../domain/store";
import { isNonEmpty, type NonEmptyArray } from "../../domain/timer";
import { mode, type ClientView } from "../connection";
import { compareArrival, suggestedItemOf, type QueueSuggestion } from "./queueDisplay";

/**
 * 群の 1 品目。開始に要る事実（品目・推奨・茹で秒・serveAt）が揃った形。
 *
 * 注文への参照は `order` ただ一つ——`suggestion` は釜と時刻だけを持ち、注文を指さない（同じ注文を二箇所で
 * 指せば別の注文を指す状態が表現できてしまう）。開始は `order` から鍵を取り、`suggestion.slotIds` 全体で要求する
 * （AC 3.1）。
 */
export interface GroupItem {
  readonly order: PendingOrder;
  readonly suggestion: QueueSuggestion;
}

/**
 * 同時に上げる群（Lift_Group）——`CookRecommendation.group` が等しい推奨の集合（判断 20）。
 *
 * 群の所属は engine が確定計画（自前解・採用済み外部解とも）から決め、snapshot 内の識別子で運ぶ
 * （lift-group-planning 判断 19・ADR-0008）。client は卓・serveAt・許容幅のいずれからも群を逆算しない
 * ——揃っていないものを揃っていると言う経路を持たない。
 */
export interface LiftGroup {
  /** engine が付けた群の識別子（snapshot 内で閉じる）。 */
  readonly group: string;
  /** 合流した走行中の錨の実効 endTime。合流していなければ null（engine が付ける）。 */
  readonly anchor: number | null;
  /** startAt 昇順・同値は到着順（compareArrival）。 */
  readonly items: NonEmptyArray<GroupItem>;
  /**
   * 群の最初の 1 本が始まった事実（Group_Started・判断 16 / 20）——`anchor` が非 null で、かつ `anchor > corrected`。
   * 錨の Timer が茹で上がると開始済みでなくなる（茹で上がり後は保持しない）。boolean ではなく錨の時刻を
   * 運ぶのは、次の snapshot が届く前に終了時刻を跨いだときの失効を client が読めるようにするためである。
   */
  readonly started: boolean;
}

/**
 * 受信した推奨の全量から群を導く。最早 startAt 順・同値は先頭品目の到着順（AC 1.4）。
 *
 * 開始できない推奨（品目が待ち行列に無い・麺種がプリセットに無い）は群に入れない（AC 1.3）。群の鍵は
 * `recommendation.group`（engine が付けた識別子）そのもので、client は卓も serveAt も見ない（AC 1.2）。
 *
 * started は `anchor`（合流した走行中の錨の実効 endTime）が corrected より後であること（AC 1.7）。boiled
 * （anchor ≤ corrected）を数えないのは、茹で上がりの発火で計画が残りを新しい群に組み直す——client が発火の
 * snapshot より先に同じ結論に達するだけで、届いた snapshot と食い違わない（判断 16）。同じ群の推奨は同じ
 * `anchor` を運ぶ（engine の射影がそう定める）ので、先頭品目の値で足りる。
 */
export function liftGroups(view: ClientView, corrected: number): readonly LiftGroup[] {
  const buckets = new Map<string, { anchor: number | null; items: GroupItem[] }>();
  for (const recommendation of view.recommendations) {
    const item: GroupItem | null = suggestedItemOf(view, recommendation);
    if (item === null) continue;
    const bucket = buckets.get(recommendation.group);
    if (bucket) bucket.items.push(item);
    else buckets.set(recommendation.group, { anchor: recommendation.anchor, items: [item] });
  }

  const groups: LiftGroup[] = [];
  for (const [group, bucket] of buckets) {
    const items = [...bucket.items].sort(compareItems);
    if (!isNonEmpty(items)) continue; // 束は 1 件以上で作られる。型のためだけの確認で、実行時には通らない
    const { anchor } = bucket;
    const started = anchor !== null && anchor > corrected;
    groups.push({ group, anchor, items, started });
  }
  return groups.sort((a, b) => compareItems(a.items[0], b.items[0]));
}

/** 群の中の並び（startAt 昇順・同値は到着順）。群どうしの並びも先頭品目のこの順序で決める。 */
function compareItems(a: GroupItem, b: GroupItem): number {
  return a.suggestion.startAt - b.suggestion.startAt || compareArrival(a.order, b.order);
}

/**
 * 表示できる群（Visible_Groups）——先頭の群と、それより前の群がすべて started の群（判断 19・AC 1.8）。
 *
 * 先頭は常に表示できる。以降は直前までがすべて started の間だけ続き、started でない群で連鎖が止まる
 * ——その群の 1 本目が始まるまで後続を解禁しない（AC 2.9 / 2.10）。
 */
export function visibleGroups(groups: readonly LiftGroup[]): readonly LiftGroup[] {
  const visible: LiftGroup[] = [];
  for (const group of groups) {
    visible.push(group);
    if (!group.started) break;
  }
  return visible;
}

/**
 * 釜の提案。いま押せる先頭（濃・`now`）と、押せない後続（薄）の判別共用体。
 *
 * 先頭は「開始推奨時刻が来ていて、店舗全体で先頭 arms 本」（判断 21）。後続は開始推奨時刻の 60 秒前が来た
 * 準備の合図で、startAt が過ぎても濃くならず押せない（AC 2.4）——「押せる」と「濃い」は先頭にだけ在り、
 * `member` にボタンを描く経路が構造から無い（AC 3.6）。薄いものを早く始めたければラジアルが残る。
 */
export type SlotSuggestion =
  | { readonly role: "head"; readonly item: GroupItem }
  | { readonly role: "member"; readonly item: GroupItem };

/**
 * 釜ごとの提案。live でなければ空（AC 2.13 / 6.11）。全釜 idle と Prep_Lead をここで判定する。
 *
 * 「idle」は「その釜を駆動する Timer が無い」——running / boiled を問わず、担当外を含む店舗全体の Timer で
 * 判定する（AC 2.7）。engine は開始時に釜の占有を検査しない（観測事実 12）ので、一部の釜が埋まった複数釜の
 * 提案をどの釜にも出さないことが、走行中の釜へ重ねて開始する事故への唯一の防御である。
 *
 * 各釜の配列は startAt 昇順（同値は群の順）。表示する数に上限は置かず、濃い（押せる）ものだけを店舗全体で
 * arms 本に限る（AC 2.11・判断 21）。1 件の推奨は含まれる各釜に同じ提案として現れる（AC 2.14）。degraded で空なのは
 * ここが担う（判定を一箇所に・slotDisplay は結果を載せるだけ）。
 */
export function slotSuggestions(
  visible: readonly LiftGroup[],
  view: ClientView,
  corrected: number,
): ReadonlyMap<number, readonly SlotSuggestion[]> {
  const bySlot = new Map<number, SlotSuggestion[]>();
  if (mode(view) !== "live") return bySlot;
  const occupied = occupiedSlots(view);
  // 表示できる品目を（群の順, 群の中の順）で集める——全釜 idle と Prep_Lead を満たすもの。
  const shown: GroupItem[] = [];
  for (const group of visible) {
    for (const item of group.items) {
      const { slotIds, startAt } = item.suggestion;
      if (slotIds.some((slotId) => occupied.has(slotOf(slotId)))) continue; // 全釜 idle（AC 2.7）
      if (corrected < startAt - PREP_LEAD_MS) continue; // Prep_Lead（AC 2.1）
      shown.push(item);
    }
  }
  // 先頭（濃・押せる）は、開始推奨時刻が来たもののうち店舗全体で先頭 arms 本（判断 21）。腕で扱える分だけを
  // 「今」と言い、残りは薄い後続に留める。先頭を始めれば計画が残りを合流させ直し、次の arms 本が先頭になる。
  // 並びは**開始推奨時刻の順**（同値は群の順・品目の順＝shown の順）。群の順で数えると、同じ snapshot で時間が
  // 進んだだけで前の群の後の品目が後の群の先頭を押しのけ、濃さが消える（6.3 の単調性に反する）。時刻順なら
  // 新たに時刻が来た品目は既存の先頭より後ろに並ぶので、先頭は始めるまで先頭のままである。
  const startable = shown
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => corrected >= item.suggestion.startAt)
    .sort((a, b) => a.item.suggestion.startAt - b.item.suggestion.startAt || a.order - b.order)
    .map(({ item }) => item);
  const heads = new Set(startable.slice(0, Math.max(0, view.arms)));
  for (const item of shown) {
    const suggestion: SlotSuggestion = heads.has(item)
      ? { role: "head", item }
      : { role: "member", item };
    for (const slotId of item.suggestion.slotIds) {
      const slot = slotOf(slotId);
      const bucket = bySlot.get(slot);
      if (bucket) bucket.push(suggestion);
      else bySlot.set(slot, [suggestion]);
    }
  }
  // 挿入順は（群の順, 群の中の順）ゆえ、startAt の安定ソートで「同値は群の順」が保たれる。
  for (const bucket of bySlot.values()) {
    bucket.sort((a, b) => a.item.suggestion.startAt - b.item.suggestion.startAt);
  }
  return bySlot;
}

/**
 * 押した釜から slotSpan 個の釜を組む。許容距離の内側に足りなければ null（判断 10・AC 4.4 / 4.5）。
 *
 * 起点の釜自身も現在の店舗全体の Timer で検査する（slotSpan 1 でも）。ラジアルは idle のカードから開くが、
 * 開いたまま別端末がその釜を始めた snapshot が届きうる。engine は占有を検査しない（観測事実 12）ので、ここで
 * 落とさなければ同じ釜へ重ねて開始できる。描画ごとに view から導くため、snapshot が更新されれば行は自動的に
 * 不活性になる（AC 4.9）。
 *
 * 距離は domain の slotDistance と view のレイアウト（AC 4.7）——計画の採点と同じ座標・同じ尺度で、client が
 * 「近い」と判じた組は計画も「近い」と採点する。近い順・同距離は index 順で断つ。担当ユニットを跨いでよい
 * ——距離が近ければ同じ腕の届く釜である。
 */
export function pairSlots(
  slot: number,
  slotSpan: number,
  view: ClientView,
): NonEmptyArray<string> | null {
  const occupied = occupiedSlots(view);
  if (occupied.has(slot)) return null;
  if (slotSpan === 1) return [String(slot)];
  const near: { readonly slot: number; readonly distance: number }[] = [];
  for (let candidate = 0; candidate < view.unitCount * SLOTS_PER_UNIT; candidate++) {
    if (candidate === slot || occupied.has(candidate)) continue;
    const distance = slotDistance(slot, candidate, view.unitOrigins, view.slotOffsets);
    if (distance <= view.affinityToleranceDistance) near.push({ slot: candidate, distance });
  }
  near.sort((a, b) => a.distance - b.distance || a.slot - b.slot);
  if (near.length < slotSpan - 1) return null;
  return [String(slot), ...near.slice(0, slotSpan - 1).map((entry) => String(entry.slot))];
}

/**
 * 店舗全体で Timer が駆動する釜の集合（running / boiled とも・担当外を含む）。
 *
 * 茹で上がった麺は消し込むまで釜に入っている——釜の排他性は起源にも接続性にも依らない物理的事実
 * （connection.ts の occupiesAny と同じ判断）。
 */
function occupiedSlots(view: ClientView): ReadonlySet<number> {
  const occupied = new Set<number>();
  for (const timer of view.timers) {
    for (const slotId of timer.slotIds) occupied.add(slotOf(slotId));
  }
  return occupied;
}
