// client/components/liftGroups.ts — 同時に上げる群と、そこから釜に出す提案を導く純粋関数。
// WS も DOM も触れない。受信ビュー（推奨・待ち行列・Timer の全量）と補正後現在時刻から、描画のたびに導く
// （保持は全量・表示は導出／slotDisplay.ts と同じ規律）。群も先頭もビューに保持しない（lift-group-display AC 1.5）。
//
// 群の連鎖と Head の導出そのもの（liftGroupsOf / visibleGroupsOf / headsOf）は domain/lift-group.ts に在り、
// engine の採点と共有する（plan-stability Component 1）。ここに残るのは ClientView からの取り出し——推奨から
// 開始できる品目を組む（suggestedItemOf）、店舗全体の占有釜を集める（occupiedSlots）、live でなければ黙る
// （mode）——と、導いた先頭・後続を釜ごとに並べ直すことだけである。
//
// 判定はすべて snapshot と Corrected_Now の関数である。端末ごとの履歴・過去の描画・推奨の消失を読まない
// （AC 1.7 / 1.10）——途中接続した端末も、接続し続けた端末も、同じ snapshot からは同じ群・同じ先頭・同じ提案に
// 達する。担当範囲で絞るのは表示（assignedSlotDisplays）だけで、群・開始・連鎖・全釜 idle は店舗全体で判定する
// （AC 1.1 / 1.6 / 2.12）。

import {
  displayableItemsOf,
  headsOf,
  liftGroupsOf,
  visibleGroupsOf,
  type LiftGroupOf,
} from "../../domain/lift-group";
import { itemKeyOf } from "../../domain/order";
import type { PendingOrder } from "../../domain/order";
import { SLOTS_PER_UNIT, occupiedSlotsOf, slotDistance, slotOf } from "../../domain/store";
import type { NonEmptyArray } from "../../domain/timer";
import { mode, type ClientView } from "../connection";
import { suggestedItemOf, type QueueSuggestion, type SuggestedItem } from "./queueDisplay";

/**
 * 釜カードと開始の経路が読む品目の形。開始に要る事実（品目・推奨・茹で秒・serveAt）が揃っている。
 *
 * 注文への参照は `order` ただ一つ——`suggestion` は釜と時刻だけを持ち、注文を指さない（同じ注文を二箇所で
 * 指せば別の注文を指す状態が表現できてしまう）。開始は `order` から鍵を取り、`suggestion.slotIds` 全体で要求する
 * （AC 3.1）。群の品目（SuggestedItem）はこの形を満たす——domain の LiftItem に提案を重ねたものである。
 */
export interface GroupItem {
  readonly order: PendingOrder;
  readonly suggestion: QueueSuggestion;
}

/**
 * 同時に上げる群（Lift_Group）——`CookRecommendation.group` が等しい推奨の集合（判断 20）。
 *
 * 形は domain の LiftGroupOf で、品目は提案を重ねた SuggestedItem。群の所属は engine が確定計画（自前解・
 * 採用済み外部解とも）から決め、snapshot 内の識別子で運ぶ（lift-group-planning 判断 19・ADR-0008）。client は
 * 卓・serveAt・許容幅のいずれからも群を逆算しない——揃っていないものを揃っていると言う経路を持たない。
 */
export type LiftGroup = LiftGroupOf<SuggestedItem>;

/**
 * 受信した推奨の全量から群を導く。最早 startAt 順・同値は先頭品目の到着順（AC 1.4）。
 *
 * 開始できない推奨（品目が待ち行列に無い・寿命を過ぎた・麺種がプリセットに無い）は群に入れない（AC 1.3）。
 * 束ね方・並び・started（`anchor > corrected`・AC 1.7）は domain の liftGroupsOf が定める。
 *
 * `corrected` は補正済み現在時刻で、境界（SlotBoard）が 1 回計算した値をそのまま suggestedItemOf へ渡す
 * （pending-order-expiry design Component 5）——品目が生きているかの判定はレール（orderQueueEntries）と同じ
 * `livePending` を同じ時刻で読み、左レールと釜の提案が別の集合を見ない。
 */
export function liftGroups(view: ClientView, corrected: number): readonly LiftGroup[] {
  const items: SuggestedItem[] = [];
  for (const recommendation of view.recommendations) {
    const item = suggestedItemOf(view, recommendation, corrected);
    if (item !== null) items.push(item);
  }
  return liftGroupsOf(items, corrected);
}

/**
 * 表示できる群（Visible_Groups）——先頭の群と、それより前の群がすべて started の群（判断 19・AC 1.8）。
 * 連鎖の規則は domain の visibleGroupsOf。
 */
export function visibleGroups(groups: readonly LiftGroup[]): readonly LiftGroup[] {
  return visibleGroupsOf(groups);
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
 * 釜ごとの提案。live でなければ空（AC 2.13 / 6.11）。
 *
 * 表示できる品目（全釜 idle・Prep_Lead）と先頭（startAt が来たものの時刻順で先頭 arms 本）は domain の
 * displayableItemsOf / headsOf が店舗全体で導く。「idle」は「その釜を駆動する Timer が無い」——running / boiled
 * を問わず、担当外を含む店舗全体の Timer で判定する（AC 2.7）。engine は開始時に釜の占有を検査しない
 * （観測事実 12）ので、一部の釜が埋まった複数釜の提案をどの釜にも出さないことが、走行中の釜へ重ねて開始する
 * 事故への唯一の防御である。
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
  // 表示できる品目は（群の順, 群の中の順）で届く。先頭の鍵は同じ occupied・同じ時刻から導く。
  const shown = displayableItemsOf(visible, occupied, corrected);
  const heads = new Set(headsOf(visible, occupied, corrected, view.arms));
  for (const item of shown) {
    const suggestion: SlotSuggestion = heads.has(itemKeyOf(item.order))
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
 * （connection.ts の occupiesAny と同じ判断）。述語そのものは domain の occupiedSlotsOf で、engine の確定計画の
 * 合成と同じ関数を読む（startable-placement 判断 1）——ここは view から Timer を取り出すだけの薄い包み。
 */
function occupiedSlots(view: ClientView): ReadonlySet<number> {
  return occupiedSlotsOf(view.timers);
}
