// engine/stability.ts — 前回配信対象として確定した提案（Shown_Plan）の形と、確定計画からの組み立て。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// **Shown_Plan は導出値ではなく履歴の事実である（plan-stability 判断 1）。** state.ts は「導出値を状態に昇格させない」
// と定めるが、それは現在の状態から毎回導ける値についての規律である。前回 `Persist` に載せた提案は、時刻が進み
// 走行中が変われば現在の状態からはもう導けない——過去の出力であって、いま計算し直した確定計画のキャッシュではない。
// ゆえに `TimerState.shownPlan` に残し、次の計画がそれと比べる（Change_Cost・`changeCost`）ときの相手にだけ使う。
// 確定計画そのものは引き続き毎回導く（AC 1.2）。
//
// 定義は「配信対象として永続確定した提案」であって「現場に見せた」ではない。Persist の後に Broadcast が続くが、
// 送信失敗や接続端末ゼロでも永続は成立するので、見せたことは保証できない（判断 1 のレビュー指摘）。

import { headsOf, liftGroupsOf, visibleGroupsOf, type LiftItem } from "../domain/lift-group";
import type { CookRecommendation } from "../domain/messages";
import { itemKeyOf, type ItemKey, type PendingOrder } from "../domain/order";
import { slotOf, type NoodlePreset } from "../domain/store";
import type { NonEmptyArray } from "../domain/timer";
import { boilMillisOf, joinWindowMillis } from "./boil";
import type { ScheduleParams } from "./objective";
import { recommend } from "./recommend";
import type { CookSchedule } from "./schedule";
import type { Timer } from "./timer";
import type { EpochMillis, SlotId } from "./types";

/**
 * ShownItem — 前回配信対象として確定した提案の 1 品目。
 *
 * 持つのは `Placement` の配置（`slotIds` / `startAt` / `serveAt` / `anchor`）と、群の所属だけである。
 *
 * **群の識別子（`CookRecommendation.group`）は持たない。** 識別子は snapshot 内で閉じ（lift-group-planning 判断 19）、
 * snapshot を跨いで文字列を比べる意味が無い。まとまりは「同じ群に在った相手の鍵」（`mates`）で持ち、次の計画で
 * 同じ 2 品目が別の群になったかを鍵の対応で読む（AC 1.5）。代表品目の鍵ではなく相手の鍵の列にするのは、代表が
 * 開始済みになると所属が壊れるためである（design 未決 1 の決定）。
 *
 * **Head の旗も持たない。** Head は時刻と走行中に依存するので、比較の時点で旧 Shown_Plan からも新しい計画からも
 * 同じ now・同じ Timer 集合で導く（判断 8）。ここに残すのは配置という履歴であり、いま守る対象はそこから導く。
 */
export interface ShownItem {
  /** POS 側の識別子。itemIndex との組で 1 品目を指す（Placement / PendingOrder と同じ鍵）。 */
  readonly externalOrderId: string;
  /** 同一オーダー内の品目連番。 */
  readonly itemIndex: number;
  /** 提案した釜（Placement.slotIds）。 */
  readonly slotIds: NonEmptyArray<SlotId>;
  /** 提案した開始時刻（Placement.startAt）。 */
  readonly startAt: EpochMillis;
  /** 提案した提供時刻（Placement.serveAt・上げ窓による延期後の値。錨とは違う）。 */
  readonly serveAt: EpochMillis;
  /** 合流先の走行中の実効 endTime（Placement.anchor）。合流でなければ null。 */
  readonly anchor: EpochMillis | null;
  /** 同じ群に在った品目の鍵（externalOrderId + itemIndex）。自分は含まない。対称に持つ。 */
  readonly mates: readonly ItemKey[];
}

/** Shown_Plan — 前回配信対象として確定した提案の全品目。空は「比較の相手なし」（Change_Cost 0）。 */
export type ShownPlan = readonly ShownItem[];

/** 比較の相手が無い Shown_Plan（初期状態・v11 以前からの移行）。 */
export const EMPTY_SHOWN_PLAN: ShownPlan = [];

/**
 * shownPlanOf — 確定計画と、それに対する `recommend` の出力から Shown_Plan を組む。
 *
 * **両方を取るのは、どちらか一方では埋まらない項目があるためである。** `serveAt` と `anchor` は配置（`Placement`）が持ち、
 * ワイヤの `CookRecommendation` は `serveAt` を運ばない。群の所属は `recommend` が付ける `group` にだけ在り、配置から
 * 群を引き直せば群の識別が二箇所に書かれる。`settle` は `committedSchedule` の結果と `recommend(committed)` の両方を
 * 持っているので、そこで組む（design Data Models の入力契約）。
 *
 * `mates` は同じ `group` の他の品目の鍵を、推奨の並び（計画順）で持つ。自分は含まない。順は決定的で、同じ入力から
 * 同じ Shown_Plan が出る（永続の往復と no-op の判定に揺れを持ち込まない）。
 *
 * 推奨は確定計画の全配置に付く（recommend.ts）ので、推奨を持たない配置は起きない。起きても落とさず、まとまりの
 * 無い単独の品目として残す——履歴の欠けは費用 0 に倒れるだけで、品目を失わせる理由にならない。
 */
export function shownPlanOf(
  schedule: CookSchedule,
  recommendations: readonly CookRecommendation[],
): ShownPlan {
  const groupByKey = new Map<ItemKey, string>();
  const membersByGroup = new Map<string, ItemKey[]>();
  for (const recommendation of recommendations) {
    const key = itemKeyOf(recommendation);
    groupByKey.set(key, recommendation.group);
    const members = membersByGroup.get(recommendation.group);
    if (members === undefined) membersByGroup.set(recommendation.group, [key]);
    else members.push(key);
  }
  return schedule.slices.flatMap((slice) =>
    slice.placements.map((placement) => {
      const key = itemKeyOf(placement);
      const group = groupByKey.get(key);
      const members = group === undefined ? [] : (membersByGroup.get(group) ?? []);
      return {
        externalOrderId: placement.externalOrderId,
        itemIndex: placement.itemIndex,
        slotIds: placement.slotIds,
        startAt: placement.startAt,
        serveAt: placement.serveAt,
        anchor: placement.anchor,
        mates: members.filter((mate) => mate !== key),
      };
    }),
  );
}

/**
 * ChangeContext — 変更費用の比較の文脈。
 *
 * `shown` は旧 Shown_Plan（遷移前の状態が持つもの・AC 1.7）。`running` は**遷移後（再同期後）の Timer 集合**、`now` は
 * 比較の時点である（判断 8）。Head は時刻と走行中に依存するので、旧 Shown_Plan からも新しい計画からも同じ now・
 * 同じ Timer 集合で導く。遷移前の集合を使えば、遷移で始まった品目の釜を旧 Shown_Plan の他の品目がまだ使えると見て、
 * 偽の先頭変更が生まれる。
 *
 * `pending` と `presets` は Head の共有導出（`LiftItem`）が要る——到着時刻（同値の順）と茹で秒は推奨も Shown_Plan も
 * 持たず、Pending_Order 集合と麺種プリセットから引く（design Component 2 の入力契約）。
 */
export interface ChangeContext {
  /** 旧 Shown_Plan（遷移前の状態が持つ）。空は比較の相手なし（費用 0）。 */
  readonly shown: ShownPlan;
  /** 遷移後（再同期後）の Timer 集合。running / boiled とも占有釜として読む。 */
  readonly running: readonly Timer[];
  /** 比較の時点。 */
  readonly now: EpochMillis;
  /** 品目の到着時刻（同値の順）と麺種・茹で加減（茹で秒）を引く。 */
  readonly pending: readonly PendingOrder[];
  /** 茹で秒の出所。 */
  readonly presets: readonly NoodlePreset[];
}

/** 時刻の単位（ミリ秒）と上げの間隔（秒）の換算。窓の数と減衰の距離はミリ秒で数え、費用は秒で返す。 */
const MILLIS_PER_SECOND = 1000;

/** 旧 Shown_Plan を推奨と見なすために振る、比較の内側で閉じる仮の群の識別子。外に出ない。 */
const SHOWN_GROUP_PREFIX = "shown\u0000";

/**
 * changeCost — 新しい計画が旧 Shown_Plan からどれだけ違うかを秒相当の整数で数える（Requirement 2・判断 2・3・7・8）。
 *
 * 数えるのは**対応する品目**（鍵が旧 Shown_Plan と `next` の両方に在り、`changeContext.pending` にも在る品目）の間だけである
 * （AC 2.1）。開始済み・キャンセル済みで消えた品目は `pending` に無く、新規に増えた品目は旧 Shown_Plan に無いので、
 * どちらも自然に対応から外れる（AC 2.3）。`next` から欠けた品目にも費用を定めない——欠落は費用ではなく既存の
 * ハード制約（`isStale`・合成の尾部）が閉じる（AC 2.4）。定めれば「消失 2L 対 分割 3L」のような逃げ道の算術が生まれる。
 *
 * 4 種の費用（AC 2.2）。重みは秒相当で `liftIntervalSeconds`（L）から導き、新しい設定は足さない（判断 7）。
 *   (a) 先頭の変更（2L）——比較の時点の now と遷移後の Timer 集合で導いた旧 Shown_Plan の Head に在る品目が、同じ
 *       now・同じ Timer 集合で導いた新しい計画の Head に無い。導出は表示と同じ `headsOf`（domain/lift-group.ts）。
 *       同じ計画なら両側の Head は一致し費用 0（anchor の失効で後続群が隠れる場合を含む・性質 5.1）。
 *   (b) 釜の変更（L）——`slotIds` が変わった。釜番号の集合で比べる（並びと表記の違いは変更ではない）。
 *   (c) まとまりの変更（組ごとに L）——2 つの検査に分ける。(c-1) 旧 Shown_Plan で同じ群だった 2 品目が新しい計画で
 *       別の群になった（同じ群だった組にだけ効く）。(c-2) 対応する 2 品目の `startAt` の順が逆転した（群を問わず
 *       全対応の組・別群の A@10 秒・B@11 秒が A@11 秒・B@10 秒に変われば、時刻の移動が h_i の内側でも付く）。
 *   (d) 時刻の移動——`startAt` が h_i（合流の窓・`joinWindowMillis`）を超えて動いた分について、跨いだ上げの間隔の数
 *       × L × 1 / (k + 1)。k は旧 `startAt` が今から何個目の間隔か（遠いほど軽い・整数化ゆえ単調非増加・性質 5.4）。
 *       h_i の内側の数秒の調整は数えない。
 *
 * **単位。** `startAt` / `now` はミリ秒、L は秒。窓の数と減衰の距離は L × 1000（ミリ秒）で数え、費用への換算には秒の L を
 * 使う。45 秒の移動は L = 45 で 45（1 窓 × 45 秒）であって 45000 ではない。
 *
 * 整数で閉じる（AC 2.6）——全項が整数の和・積・床である。店舗全体の項ゆえ `scoreSchedule` は `total` にだけ足す（AC 2.5）。
 */
export function changeCost(
  next: {
    readonly schedule: CookSchedule;
    readonly recommendations: readonly CookRecommendation[];
  },
  changeContext: ChangeContext,
  params: ScheduleParams,
): number {
  if (changeContext.shown.length === 0) return 0;
  const pendingByKey = new Map(changeContext.pending.map((order) => [itemKeyOf(order), order]));
  const oldItems = shownItemsOf(changeContext.shown, pendingByKey, changeContext.presets);
  const newItems = nextItemsOf(next, pendingByKey, changeContext.presets);
  return costBetween(oldItems, newItems, newItems, changeContext, params);
}

/**
 * partialChangeCost — 計画の**途中**に対する変更費用（plan-stability design Component 5・AC 3.2）。
 *
 * 自前解は列（同じ時刻に上げたい品目の並び）ごとに pack / split / 前回のまとまりを保つ分割の候補を作り、局所費用で
 * 比べる。その局所費用に足すのがこれで、`partial` は「手前の一片 ＋ いま置いている群（末尾の一片・先に置いた配置と
 * 列の候補配置）」である。**4 種すべて**を数える——(b)(c)(d) は置いた品目の間で（列の外の置いた品目との組も含む。
 * 列に依らない組の費用は候補の間で定数なので、比較には効かず、引かなくてよい）。
 *
 * **(a) 先頭の変更は、まだ置いていない品目を Shown_Plan の配置で補った計画から Head を導く（レビュー指摘）。** Head は
 * 群の連鎖と先頭 arms 本の順位で決まるので、置いた分だけの計画で導くと、後の一片が持つ群が連鎖から欠けて先頭が
 * 変わる（同じ計画を続けて置いても先頭が消えたように見え、保つべき候補に偽の 2L が付く）。列の外の品目は「現在の
 * 確定分」——手前で置いた配置はそのまま、まだ置いていない品目は前回確定した配置——で埋める。補った品目の群は
 * `recommend` と同じ規則（同じ卓・同じ錨か同じ提供時刻）で振り、いま置いている卓の品目は末尾の一片の群に合流する。
 * 補いは Head の導出にだけ使い、(b)(c)(d) の対応には入れない（置く前の品目の費用を先取りしない）。
 *
 * 局所探索であり、列の候補の範囲でだけ「利益が上回れば変わる」（性質 5.7）。
 */
export function partialChangeCost(
  partial: CookSchedule,
  changeContext: ChangeContext,
  params: ScheduleParams,
): number {
  if (changeContext.shown.length === 0) return 0;
  const pendingByKey = new Map(changeContext.pending.map((order) => [itemKeyOf(order), order]));
  const oldItems = shownItemsOf(changeContext.shown, pendingByKey, changeContext.presets);
  const newItems = nextItemsOf(
    { schedule: partial, recommendations: recommend(partial) },
    pendingByKey,
    changeContext.presets,
  );
  const standIns = standInsOf(changeContext.shown, newItems, partial, pendingByKey, changeContext);
  return costBetween(oldItems, newItems, [...newItems, ...standIns], changeContext, params);
}

/**
 * shownHeadsOf — 旧 Shown_Plan の Head（比較の時点の now・遷移後の Timer 集合で導く・判断 8）。
 *
 * 自前解が「前回の先頭を今の窓に残す」候補（design Component 5 の局所比較）を作るために読む。`changeCost` の (a) と
 * 同じ導出（`headsOf`）で、費用の側と候補の側が同じ先頭を見る。
 */
export function shownHeadsOf(
  changeContext: ChangeContext,
  params: ScheduleParams,
): ReadonlySet<ItemKey> {
  if (changeContext.shown.length === 0) return new Set();
  const pendingByKey = new Map(changeContext.pending.map((order) => [itemKeyOf(order), order]));
  const oldItems = shownItemsOf(changeContext.shown, pendingByKey, changeContext.presets);
  const occupied = occupiedSlotsOf(changeContext.running);
  return new Set(headsOfItems(oldItems, occupied, changeContext.now, params.arms));
}

/**
 * 変更費用の本体。`headItems` は新しい計画の Head を導く品目（全体の採点では `newItems` そのもの・途中の比較では
 * 置いていない品目を補ったもの）。対応する品目は `oldItems` と `newItems` の両方に在るものだけ。
 */
function costBetween(
  oldItems: readonly LiftItem[],
  newItems: readonly LiftItem[],
  headItems: readonly LiftItem[],
  changeContext: ChangeContext,
  params: ScheduleParams,
): number {
  const newByKey = new Map(newItems.map((item) => [itemKeyOf(item.order), item]));
  const oldByKey = new Map(oldItems.map((item) => [itemKeyOf(item.order), item]));

  // 対応する品目——両側に在り、pending にも在る（LiftItem に組めた）もの。鍵の辞書順で並べ、組の走査を決定的にする。
  const pairs = [...oldByKey.keys()].filter((key) => newByKey.has(key)).sort();
  if (pairs.length === 0) return 0;

  // 両側とも同じ now・同じ Timer 集合（遷移後）・同じ占有釜で Head を導く（判断 8）。
  const occupied = occupiedSlotsOf(changeContext.running);
  const oldHead = new Set(headsOfItems(oldItems, occupied, changeContext.now, params.arms));
  const newHead = new Set(headsOfItems(headItems, occupied, changeContext.now, params.arms));

  const L = params.liftIntervalSeconds;
  const Lms = L * MILLIS_PER_SECOND;
  let cost = 0;

  for (const key of pairs) {
    const before = oldByKey.get(key)!;
    const after = newByKey.get(key)!;
    // (a) 先頭の変更。
    if (oldHead.has(key) && !newHead.has(key)) cost += 2 * L;
    // (b) 釜の変更。
    if (slotSetOf(before.recommendation.slotIds) !== slotSetOf(after.recommendation.slotIds)) {
      cost += L;
    }
    // (d) 時刻の移動。h_i は当該品目の茹で時間から（両側で同じ品目ゆえ同じ値）。
    const delta = Math.abs(after.recommendation.startAt - before.recommendation.startAt);
    if (delta > joinWindowMillis(before.boilSeconds * MILLIS_PER_SECOND, params)) {
      const windows = Math.ceil(delta / Lms);
      const far = Math.floor(Math.max(0, before.recommendation.startAt - changeContext.now) / Lms);
      cost += Math.floor((windows * L) / (far + 1));
    }
  }

  const shownByKey = new Map(changeContext.shown.map((item) => [itemKeyOf(item), item]));
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const k = pairs[i]!;
      const m = pairs[j]!;
      // (c-1) まとまりの分割——旧で同じ群だった組が、新しい計画で別の群になった。
      const wereMates =
        shownByKey.get(k)!.mates.includes(m) || shownByKey.get(m)!.mates.includes(k);
      if (
        wereMates &&
        newByKey.get(k)!.recommendation.group !== newByKey.get(m)!.recommendation.group
      ) {
        cost += L;
      }
      // (c-2) 順の逆転——群を問わず、対応する全組で `startAt` の順が入れ替わった。
      const oldOrder = Math.sign(
        oldByKey.get(k)!.recommendation.startAt - oldByKey.get(m)!.recommendation.startAt,
      );
      const newOrder = Math.sign(
        newByKey.get(k)!.recommendation.startAt - newByKey.get(m)!.recommendation.startAt,
      );
      if (oldOrder * newOrder < 0) cost += L;
    }
  }
  return cost;
}

/**
 * 途中の計画で、まだ置いていない品目を Shown_Plan の配置で補う（`partialChangeCost` の Head の導出にだけ使う）。
 *
 * 群は `recommend` と同じ規則で振る——同じ卓で、合流なら同じ錨、それ以外は同じ提供時刻が一つの群。いま置いている卓
 * （`partial` の末尾の一片）の品目は、その一片の群の識別子（`recommend` が付ける `index:anchor:…` / `index:serveAt`）
 * をそのまま使い、置いた品目と同じ錨・同じ提供時刻なら同じ群に入る。他の卓は卓ごとに閉じた識別子で、置いた品目の群と
 * 交わらない（一片は卓ごとゆえ、全体の計画でも交わらない）。卓を持たない品目は 1 品 1 群。
 */
function standInsOf(
  shown: ShownPlan,
  placed: readonly LiftItem[],
  partial: CookSchedule,
  pendingByKey: ReadonlyMap<ItemKey, PendingOrder>,
  changeContext: ChangeContext,
): readonly LiftItem[] {
  const placedKeys = new Set(placed.map((item) => itemKeyOf(item.order)));
  const current = partial.slices[partial.slices.length - 1];
  const currentIndex = partial.slices.length - 1;
  const items: LiftItem[] = [];
  for (const item of shown) {
    const key = itemKeyOf(item);
    if (placedKeys.has(key)) continue;
    const order = pendingByKey.get(key);
    if (order === undefined) continue;
    const boilMillis = boilMillisOf(order, changeContext.presets);
    if (boilMillis === null) continue;
    const scope =
      order.tableId === null
        ? `${SHOWN_GROUP_PREFIX}single\u0000${key}`
        : current !== undefined && current.tableKey === order.tableId
          ? `${currentIndex}`
          : `${SHOWN_GROUP_PREFIX}${order.tableId}`;
    const group =
      item.anchor !== null ? `${scope}:anchor:${item.anchor}` : `${scope}:${item.serveAt}`;
    items.push({
      recommendation: {
        externalOrderId: item.externalOrderId,
        itemIndex: item.itemIndex,
        slotIds: item.slotIds,
        startAt: item.startAt,
        group,
        anchor: item.anchor,
      },
      order,
      boilSeconds: boilMillis / MILLIS_PER_SECOND,
    });
  }
  return items;
}

/**
 * 旧 Shown_Plan を Head の共有導出に掛けられる `LiftItem` 列に組む。
 *
 * 群の識別子は持たない（AC 1.5）ので、`mates` を連結成分にして snapshot 内の仮の識別子を振る。識別子は比較の内側で
 * 閉じ、外に出ない。`pending` に無い品目（開始済み・キャンセル済み）と茹で秒の引けない品目は組めないので落とす
 * ——対応から外れるだけで、費用に倒れない（AC 2.3）。
 */
function shownItemsOf(
  shown: ShownPlan,
  pendingByKey: ReadonlyMap<ItemKey, PendingOrder>,
  presets: readonly NoodlePreset[],
): readonly LiftItem[] {
  const groupByKey = shownGroupsOf(shown);
  const items: LiftItem[] = [];
  for (const item of shown) {
    const key = itemKeyOf(item);
    const order = pendingByKey.get(key);
    if (order === undefined) continue;
    const boilMillis = boilMillisOf(order, presets);
    if (boilMillis === null) continue;
    items.push({
      recommendation: {
        externalOrderId: item.externalOrderId,
        itemIndex: item.itemIndex,
        slotIds: item.slotIds,
        startAt: item.startAt,
        group: groupByKey.get(key)!,
        anchor: item.anchor,
      },
      order,
      boilSeconds: boilMillis / MILLIS_PER_SECOND,
    });
  }
  return items;
}

/**
 * `mates` の連結成分ごとに仮の群の識別子を振る。`mates` は対称に持つ（shownPlanOf）が、永続から来た値が
 * 片側だけでも成分は繋がる（無向の到達で辿る）。識別子は成分の最初に現れた品目の鍵から作り、決定的である。
 */
function shownGroupsOf(shown: ShownPlan): ReadonlyMap<ItemKey, string> {
  const adjacency = new Map<ItemKey, Set<ItemKey>>();
  const link = (from: ItemKey, to: ItemKey) => {
    const edges = adjacency.get(from);
    if (edges === undefined) adjacency.set(from, new Set([to]));
    else edges.add(to);
  };
  for (const item of shown) {
    const key = itemKeyOf(item);
    if (!adjacency.has(key)) adjacency.set(key, new Set());
    for (const mate of item.mates) {
      link(key, mate);
      link(mate, key);
    }
  }
  const groupByKey = new Map<ItemKey, string>();
  for (const item of shown) {
    const root = itemKeyOf(item);
    if (groupByKey.has(root)) continue;
    const group = `${SHOWN_GROUP_PREFIX}${root}`;
    const stack = [root];
    while (stack.length > 0) {
      const key = stack.pop()!;
      if (groupByKey.has(key)) continue;
      groupByKey.set(key, group);
      for (const mate of adjacency.get(key) ?? []) stack.push(mate);
    }
  }
  return groupByKey;
}

/**
 * 新しい計画を `LiftItem` 列に組む。群と錨は `recommend` の出力から（群の識別を二度書かない）。
 *
 * 推奨は確定計画の全配置に付く（recommend.ts）ので、推奨を持たない配置は起きない。起きても落とさず、その配置だけの
 * 群として残す——`shownPlanOf` と同じ規律で、履歴の欠けは品目を失わせる理由にならない。
 */
function nextItemsOf(
  next: {
    readonly schedule: CookSchedule;
    readonly recommendations: readonly CookRecommendation[];
  },
  pendingByKey: ReadonlyMap<ItemKey, PendingOrder>,
  presets: readonly NoodlePreset[],
): readonly LiftItem[] {
  const recommendationByKey = new Map(
    next.recommendations.map((recommendation) => [itemKeyOf(recommendation), recommendation]),
  );
  const items: LiftItem[] = [];
  for (const slice of next.schedule.slices) {
    for (const placement of slice.placements) {
      const key = itemKeyOf(placement);
      const order = pendingByKey.get(key);
      if (order === undefined) continue;
      const boilMillis = boilMillisOf(order, presets);
      if (boilMillis === null) continue;
      const recommendation: CookRecommendation = recommendationByKey.get(key) ?? {
        externalOrderId: placement.externalOrderId,
        itemIndex: placement.itemIndex,
        slotIds: placement.slotIds,
        startAt: placement.startAt,
        group: `${SHOWN_GROUP_PREFIX}next\u0000${key}`,
        anchor: placement.anchor,
      };
      items.push({ recommendation, order, boilSeconds: boilMillis / MILLIS_PER_SECOND });
    }
  }
  return items;
}

/** Head の共有導出（Glossary Head・判断 8）。群の連鎖 → 表示できる群 → 全釜 idle・時刻が来た先頭 arms 本。 */
function headsOfItems(
  items: readonly LiftItem[],
  occupied: ReadonlySet<number>,
  now: EpochMillis,
  arms: number,
): readonly ItemKey[] {
  return headsOf(visibleGroupsOf(liftGroupsOf(items, now)), occupied, now, arms);
}

/** 店舗全体で Timer が駆動する釜の集合（running / boiled とも）。client の occupiedSlots と同じ読み方（AC 2.7）。 */
function occupiedSlotsOf(running: readonly Timer[]): ReadonlySet<number> {
  const occupied = new Set<number>();
  for (const timer of running) {
    for (const slotId of timer.slotIds) occupied.add(slotOf(slotId));
  }
  return occupied;
}

/** 釜の集合の正準表現（釜番号の昇順）。`["0","1"]` と `["1","0"]`、`"0"` と `"00"` は同じ釜の集合。 */
function slotSetOf(slotIds: readonly string[]): string {
  return [...new Set(slotIds.map(slotOf))].sort((a, b) => a - b).join(",");
}
