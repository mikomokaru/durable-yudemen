// tests/core/operationScenes.ts — 連続処理（開始・発火・完了）の harness（startable-placement design「Testing Strategy」）。
//
// engine の唯一の遷移 `decide` が Broadcast した snapshot を、client の唯一の遷移 `decideView` に通し、そこから群・
// 連鎖・釜ごとの提案（`liftGroups` → `visibleGroups` → `slotSuggestions`）を導く。観測事実 8 の操作列——「表示された
// 先頭から開始する」「茹で上がりで発火する」「茹で上がりの後に釜番号順で Complete する」——を操作として書ける形にし、
// 各遷移の直後に **今割り当てられる Startable_Slot が先頭品目に足りるのに提案が空** を検査する述語を一つ置く
// （性質 4.2）。`tests/client/liftGroups.crosslayer.example` の `step` / `viewOf` / `suggestionsAt` と同じ部品を、
// 場面を跨いで使える形へ持ち上げたもの。
//
// 純粋である。時計は呼び手が秒で進め（`at`）、engine と client は `now` を引数で受けるだけ——Date.now() も乱数も
// 読まない。同じ操作列からは同じ trace が出る。snapshot は一切手書きしない（engine が実際に出したものだけを読む）。

import { decide } from "../../src/engine/decide";
import { committedSchedule } from "../../src/engine/commit";
import { adjustedEndTime } from "../../src/engine/project";
import { EMPTY_SHOWN_PLAN } from "../../src/engine/stability";
import { advanceLifts, initialLifts, liftCap, loadWith, type Lift } from "../../src/engine/lift";
import type { Event } from "../../src/engine/event";
import type { SettleParams } from "../../src/engine/settle";
import type { TimerState } from "../../src/engine/state";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import { decideView, EMPTY_VIEW, type ClientView } from "../../src/client/connection";
import {
  liftGroups,
  slotSuggestions,
  visibleGroups,
  type GroupItem,
  type LiftGroup,
  type SlotSuggestion,
} from "../../src/client/components/liftGroups";
import type { ServerMessage } from "../../src/domain/messages";
import { compareArrival, itemKeyOf, liveOrders, type PendingOrder } from "../../src/domain/order";
import { occupiedSlotsOf, SLOTS_PER_UNIT, slotOf, type NoodlePreset } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import { configResidualDefaults } from "../storeConfigDefaults";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

// ── 時計 ──────────────────────────────────────────────────────────────────────────────────────

/** 場面の基準時刻。期待値はすべてここからの秒で読む。 */
export const T0 = 1_700_000_000_000;
export const SECOND = 1000;

/** T0 から offsetSeconds 秒後の絶対時刻。 */
export function at(offsetSeconds: number): EpochMillis {
  return (T0 + offsetSeconds * SECOND) as EpochMillis;
}

/** 絶対時刻を T0 からの秒へ戻す（期待値を秒で書くため）。 */
export function seconds(time: number): number {
  return (time - T0) / SECOND;
}

// ── 店 ────────────────────────────────────────────────────────────────────────────────────────

export type Snapshot = Extract<ServerMessage, { readonly type: "snapshot" }>;
type ConfigMessage = Extract<ServerMessage, { readonly type: "config" }>;

/** engine が受ける値の束と、client が受ける店舗設定。釜の数・腕・許容・麺種は両側で同じ値（片側だけ違えば等号は嘘になる）。 */
export interface Kitchen {
  readonly params: SettleParams;
  readonly config: ConfigMessage;
  /** 釜の数（unitCount × SLOTS_PER_UNIT）。解放表の長さと同じ。 */
  readonly slotCount: number;
}

/** 茹で加減に依らず同じ秒（場面の関心事は茹で秒の差だけ）。 */
export function every(boilSeconds: number): NoodlePreset["boilSeconds"] {
  return { extraHard: boilSeconds, hard: boilSeconds, normal: boilSeconds, soft: boilSeconds };
}

export function kitchenOf(options: {
  readonly unitCount: number;
  readonly arms: number;
  readonly toleranceRatio: number;
  readonly liftIntervalSeconds?: number;
  readonly presets: NonEmptyArray<NoodlePreset>;
}): Kitchen {
  const sync = { arms: options.arms, toleranceRatio: options.toleranceRatio } as const;
  const base = settleParams(sync, options.unitCount);
  const params: SettleParams = {
    ...base,
    liftIntervalSeconds: options.liftIntervalSeconds ?? base.liftIntervalSeconds,
    noodlePresets: options.presets,
  };
  const config: ConfigMessage = {
    type: "config",
    serverTime: T0,
    unitCount: options.unitCount,
    ...sync,
    noodlePresets: options.presets,
    ...configResidualDefaults(options.unitCount),
    liftIntervalSeconds: params.liftIntervalSeconds,
  };
  return { params, config, slotCount: options.unitCount * SLOTS_PER_UNIT };
}

// ── 遷移 ──────────────────────────────────────────────────────────────────────────────────────

/** 遷移の結果——次の状態と、その遷移が Broadcast した snapshot（client が受け取るもの）、遷移の時刻、次の Alarm。 */
export interface Step {
  readonly state: TimerState;
  readonly snapshot: Snapshot;
  readonly now: EpochMillis;
  /** 遷移が張った Alarm（実効最早の茹で上がり）。走行中が無ければ null。「茹で上がりで発火する」操作の時刻。 */
  readonly alarmAt: EpochMillis | null;
}

/**
 * engine の遷移を一つ踏み、Broadcast された snapshot を取り出す。拒否や no-op（snapshot 無し）はこの検査の
 * 前提違反なので throw する——場面が engine の実際の挙動から外れたことをそこで知る。
 */
export function step(kitchen: Kitchen, state: TimerState, event: Event): Step {
  const outcome = decide(state, event, kitchen.params);
  if (!outcome.ok) throw new Error(`engine rejected ${event.type}: ${outcome.rejection.code}`);
  const broadcast = outcome.effects.find((effect) => effect.type === "Broadcast");
  if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") {
    throw new Error(`no snapshot was broadcast after ${event.type}`);
  }
  const alarm = outcome.effects.find((effect) => effect.type === "SetAlarm");
  return {
    state: outcome.state,
    snapshot: broadcast.message,
    now: event.now,
    alarmAt: alarm?.type === "SetAlarm" ? alarm.at : null,
  };
}

/** 遷移を順に踏み、最後の状態だけを返す（途中の snapshot は読まない）。 */
export function advance(kitchen: Kitchen, state: TimerState, events: readonly Event[]): TimerState {
  return events.reduce((current, event) => step(kitchen, current, event).state, state);
}

// ── イベント ──────────────────────────────────────────────────────────────────────────────────

export function order(
  externalOrderId: string,
  overrides: Partial<PendingOrder> & {
    readonly noodleType: string;
    readonly tableId: string | null;
  },
): PendingOrder {
  return {
    externalOrderId,
    itemIndex: 0,
    firmness: "normal",
    arrivalTime: T0,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    ...overrides,
  };
}

/** 品目の名（externalOrderId#itemIndex）。期待値と Timer id の両方に使う。 */
export function nameOf(item: {
  readonly externalOrderId: string;
  readonly itemIndex: number;
}): string {
  return `${item.externalOrderId}#${item.itemIndex}`;
}

/** 品目から始めた Timer の id。`completeOn` はこの id を持つ Timer を釜番号から引く。 */
export function timerIdOf(item: {
  readonly externalOrderId: string;
  readonly itemIndex: number;
}): TimerId {
  return `timer-${nameOf(item)}` as TimerId;
}

export function arrive(orders: readonly PendingOrder[], now: EpochMillis): Event {
  return { type: "OrderArrived", arrival: nonEmpty(orders), now };
}

/** 品目を指す開始。釜は現場が押した釜——推奨と一致しなくても engine は通す（観測事実 12）。 */
export function startItem(item: PendingOrder, slots: readonly string[], now: EpochMillis): Event {
  return {
    type: "StartOrderItem",
    slotIds: [...slots],
    externalOrderId: item.externalOrderId,
    itemIndex: item.itemIndex,
    newTimerId: timerIdOf(item),
    now,
  };
}

/** 茹で上がりの発火（実効 endTime ≤ now の走行中を boiled へ）。 */
export function fire(now: EpochMillis): Event {
  return { type: "AlarmFired", now };
}

/** 釜 slot に載る Timer の Complete。載っていなければ null（呼び手の場面の前提違反）。 */
export function completeOn(state: TimerState, slot: number, now: EpochMillis): Event | null {
  const timer = state.timers.find((candidate) =>
    candidate.slotIds.some((id) => slotOf(id) === slot),
  );
  return timer === undefined ? null : { type: "Complete", timerId: timer.id, now };
}

// ── client 側 ─────────────────────────────────────────────────────────────────────────────────

/** 設定を受けて live になった端末が snapshot を受け取ったビュー。receivedAt = serverTime ゆえ offset は 0。 */
export function viewOf(kitchen: Kitchen, snapshot: Snapshot): ClientView {
  const live = decideView(EMPTY_VIEW, { kind: "Connectivity", status: "up" });
  const configured = decideView(live, { kind: "Server", message: kitchen.config, receivedAt: T0 });
  return decideView(configured, {
    kind: "Server",
    message: snapshot,
    receivedAt: snapshot.serverTime,
  });
}

/** snapshot から導いた群（最早 startAt 順・同値は先頭品目の到着順）。 */
export function groupsOf(
  kitchen: Kitchen,
  snapshot: Snapshot,
  corrected: number,
): readonly LiftGroup[] {
  return liftGroups(viewOf(kitchen, snapshot), corrected);
}

/** 群の要約——錨（秒・合流していなければ null）・品目の名（群の中の順）・started。 */
export function groupSummaryOf(kitchen: Kitchen, snapshot: Snapshot, corrected: number) {
  return groupsOf(kitchen, snapshot, corrected).map((group) => ({
    anchor: group.anchor === null ? null : seconds(group.anchor),
    items: group.items.map((item) => nameOf(item.order)),
    started: group.started,
  }));
}

/** 釜ごとの提案（表示できる群 → 全釜 idle → 先頭 arms 本）。 */
export function suggestionsOf(
  kitchen: Kitchen,
  snapshot: Snapshot,
  corrected: number,
): ReadonlyMap<number, readonly SlotSuggestion[]> {
  const view = viewOf(kitchen, snapshot);
  return slotSuggestions(visibleGroups(liftGroups(view, corrected)), view, corrected);
}

/**
 * 釜ごとの提案の要約——釜番号の昇順に `[釜, ["名 now" | "名 queued", …]]`（now は先頭・queued は後続）。
 * 空の Map は `[]`（提案が一つも出ていない）。
 */
export function suggestionSummaryOf(kitchen: Kitchen, snapshot: Snapshot, corrected: number) {
  return [...suggestionsOf(kitchen, snapshot, corrected)]
    .sort(([slot], [other]) => slot - other)
    .map(([slot, list]) => [slot, list.map(phraseOf)] as const);
}

function phraseOf(suggestion: SlotSuggestion): string {
  const name = nameOf(suggestion.item.order);
  return suggestion.role === "head" ? `${name} now` : `${name} queued`;
}

/**
 * 表示された先頭（濃・押せる）の品目を表示の順（startAt 昇順・同値は到着順）に。複数釜の提案は各釜に同じ提案として
 * 現れるので、品目の鍵で一つに畳む。
 */
export function displayedHeadsOf(
  kitchen: Kitchen,
  snapshot: Snapshot,
  corrected: number,
): readonly GroupItem[] {
  const seen = new Set<string>();
  const heads: GroupItem[] = [];
  for (const list of suggestionsOf(kitchen, snapshot, corrected).values()) {
    for (const suggestion of list) {
      if (suggestion.role !== "head") continue;
      const key = itemKeyOf(suggestion.item.order);
      if (seen.has(key)) continue;
      seen.add(key);
      heads.push(suggestion.item);
    }
  }
  return heads.sort(byDisplayOrder);
}

/** 表示の順（`liftGroupsOf` の compareItems と同じ）。 */
function byDisplayOrder(a: GroupItem, b: GroupItem): number {
  return a.suggestion.startAt - b.suggestion.startAt || compareArrival(a.order, b.order);
}

/**
 * snapshot が運ぶ推奨——名・釜・startAt（秒）・錨（秒・合流していなければ null）。engine がどこへ置き、どの錨に
 * 合流させたかを読む（計画順のまま）。
 */
export function planOf(snapshot: Snapshot) {
  return snapshot.recommendations.map(
    (each) =>
      [
        nameOf(each),
        [...each.slotIds],
        seconds(each.startAt),
        each.anchor === null ? null : seconds(each.anchor),
      ] as const,
  );
}

/** snapshot が運ぶ Timer の要約——釜（昇順）ごとの品目の名と実効 endTime（秒）。 */
export function timersOf(snapshot: Snapshot) {
  return [...snapshot.timers]
    .map((timer) => ({
      slots: [...timer.slotIds].map(slotOf).sort((a, b) => a - b),
      id: timer.id,
      endAt: seconds(timer.endTime),
    }))
    .sort((a, b) => a.slots[0]! - b.slots[0]!);
}

// ── 操作 ──────────────────────────────────────────────────────────────────────────────────────

/**
 * 表示された先頭を、提案された釜で `now` に始める（先頭が複数なら表示の順に `count` 本まで）。先頭が無ければ何も
 * 踏まず null——「押せる提案が無い」を場面が読めるようにする。
 */
export function startHeads(
  kitchen: Kitchen,
  current: Step,
  now: EpochMillis,
  count = 1,
): Step | null {
  const heads = displayedHeadsOf(kitchen, current.snapshot, now).slice(0, count);
  if (heads.length === 0) return null;
  let next = current;
  for (const head of heads) {
    next = step(kitchen, next.state, startItem(head.order, head.suggestion.slotIds, now));
  }
  return next;
}

/** 走行中（boiled でない）の実効最早の茹で上がり。無ければ null。`Step.alarmAt` と同じ値を状態から引き直す。 */
export function nextBoilEndOf(state: TimerState): EpochMillis | null {
  let earliest: EpochMillis | null = null;
  for (const timer of state.timers) {
    if (timer.boiledAt !== null) continue;
    const end = adjustedEndTime(timer);
    if (earliest === null || end < earliest) earliest = end;
  }
  return earliest;
}

/** boiled（Complete 待ち）の釜番号（昇順）。 */
export function boiledSlotsOf(state: TimerState): readonly number[] {
  return [
    ...new Set(
      state.timers
        .filter((timer) => timer.boiledAt !== null)
        .flatMap((timer) => timer.slotIds.map(slotOf)),
    ),
  ].sort((a, b) => a - b);
}

// ── 性質 4.2 の述語 ───────────────────────────────────────────────────────────────────────────

/**
 * 空白（Startable_Gap）——遷移の直後、表示の先頭品目が Startable_Slot に合法に「今」置けるのに、押せる提案が一つも
 * 無い状態。null は空白なし（例外に当たる場合を含む）。
 */
export interface StartableGap {
  /** 遷移の時刻（秒）。 */
  readonly at: number;
  /** 表示の順で最初の「今」の品目（`startAt ≤ now`）。 */
  readonly head: string;
  /** その品目が置かれている釜。 */
  readonly placedOn: readonly number[];
  /** 今割り当てられる釜（Timer が無く・採用済み接頭辞の予約も無い）。slotSpan に足りている。 */
  readonly startable: readonly number[];
  /** Timer の載る釜（running / boiled とも）。 */
  readonly occupied: readonly number[];
  /** その時点の群（名の列）。 */
  readonly groups: readonly (readonly string[])[];
}

/**
 * 性質 4.2 の述語——遷移の直後に「今割り当てられる Startable_Slot が表示の先頭品目に足りるのに提案が空」か。
 *
 * 判定の対象は **表示の先頭品目**：snapshot の推奨から導いた群の品目のうち `startAt ≤ now` のもの（1 段目が「今」に
 * 選んだ品目）を表示の順（`startAt` 昇順・同値は到着順）に並べた最初の品目。群は先頭品目のこの順で並ぶので、それは
 * 最初の群の先頭であり、連鎖に依らず常に表示できる群に在る——押せない理由は「全釜 idle」（釜に Timer が在る）
 * だけである。「今」の品目が一つも無ければ何も主張しない（全員が待つ計画・将来品目の繰上げはスコープ外）。
 *
 * **今割り当てられる釜**は、Timer が無く（`occupiedSlotsOf` の補集合＝Startable_Slot）、かつ採用済み接頭辞の将来配置が
 * 予約していない釜——接頭辞の配置は推奨にそのまま現れるので、採用済み一片の配置と一致する他品目の推奨が先頭品目の
 * 茹で時間帯と重なる釜を予約とみなす（要件 判断 9 (a)・性質 4.1 の除外）。解放表を組み直さず、事実（Timer の有無）と
 * 予約（接頭辞）だけで近似する。
 *
 * **例外（空白と数えない）**：(a) 今割り当てられる釜が先頭品目の slotSpan に足りない（空き釜不足・予約による排他の
 * 待ち）。(b) 先頭品目の上がりを含む窓の負荷が、走行中と他の推奨の上がりを足して arms + HELPER_ARMS を超える（上げ窓が
 * 「今」を許さない——ラジアルからの開始は上限を検査しないので在りうる）。合流の契約は、先頭品目が計画で既に「今」
 * （`startAt ≤ now`）に置かれている事実そのものが「合流の契約がこの時刻を許した」ことなので、釜を Startable_Slot へ
 * 移しても錨は変わらず、ここで別に検査するものは無い。遷移なしの時刻経過（判断 9 (b)）は、この述語を遷移の直後
 * （`Step.now`）にだけ当てることで対象外にする。
 *
 * 「提案が空」は「押せる（head）提案が一つも無い」で読む。先頭品目は最初の群の先頭ゆえ、表示できれば必ず head に
 * なる（arms ≥ 1）——head が無いことは「表示できる今の品目が無い」と同値で、薄い（queued）後続だけが残る状態も空白
 * である。
 */
export function startableGapOf(kitchen: Kitchen, current: Step): StartableGap | null {
  const now = current.now;
  const view = viewOf(kitchen, current.snapshot);
  const groups = liftGroups(view, now);
  const items = groups.flatMap((group) => group.items);
  const nowItems = items.filter((item) => item.suggestion.startAt <= now).sort(byDisplayOrder);
  const head = nowItems[0];
  if (head === undefined) return null;

  const occupied = occupiedSlotsOf(current.snapshot.timers);
  const reserved = reservedSlotsOf(current, head);
  const startable: number[] = [];
  for (let slot = 0; slot < kitchen.slotCount; slot++) {
    if (!occupied.has(slot) && !reserved.has(slot)) startable.push(slot);
  }
  // (a) 空き釜不足（予約による排他を含む）。
  if (startable.length < head.order.slotSpan) return null;
  // (b) 上げ窓。先頭品目の上がりを含む窓の負荷（走行中 ＋ 他の推奨の上がり ＋ 先頭品目）が上限を超えれば待ち。
  const others: Lift[] = items
    .filter((item) => item !== head)
    .map((item) => ({
      at: item.suggestion.serveAt as EpochMillis,
      span: item.suggestion.slotIds.length,
    }));
  const lifts = advanceLifts(initialLifts(current.state.timers), others);
  const load = loadWith(
    lifts,
    head.suggestion.serveAt as EpochMillis,
    head.suggestion.slotIds.length,
    kitchen.params,
  );
  if (load > liftCap(kitchen.params)) return null;

  const bySlot = slotSuggestions(visibleGroups(groups), view, now);
  const hasHead = [...bySlot.values()].some((list) => list.some((s) => s.role === "head"));
  if (hasHead) return null;
  return {
    at: seconds(now),
    head: nameOf(head.order),
    placedOn: head.suggestion.slotIds.map(slotOf),
    startable,
    occupied: [...occupied].sort((a, b) => a - b),
    groups: groups.map((group) => group.items.map((item) => nameOf(item.order))),
  };
}

/**
 * 採用済み接頭辞の将来配置が予約している釜——採用済み一片の配置と一致する（同じ品目・同じ釜・同じ startAt）他品目の
 * 推奨のうち、先頭品目の茹で時間帯 [now, now + boil) と重なるもの。合成が接頭辞に残した一片はそのまま推奨に現れる
 * ので、一致する推奨は接頭辞の配置である（尾部の自前解が偶然同じ配置を出しても、予約と読んで安全側に倒れる）。
 */
function reservedSlotsOf(current: Step, head: GroupItem): ReadonlySet<number> {
  const reserved = new Set<number>();
  const headKey = itemKeyOf(head.order);
  const from = current.now;
  const until = from + head.suggestion.boilSeconds * SECOND;
  const accepted = current.state.acceptedSlices.flatMap((slice) => slice.placements);
  for (const recommendation of current.snapshot.recommendations) {
    if (itemKeyOf(recommendation) === headKey) continue;
    const placement = accepted.find(
      (candidate) =>
        itemKeyOf(candidate) === itemKeyOf(recommendation) &&
        candidate.startAt === recommendation.startAt &&
        candidate.slotIds.length === recommendation.slotIds.length &&
        candidate.slotIds.every((id, index) => id === recommendation.slotIds[index]),
    );
    if (placement === undefined) continue;
    if (placement.serveAt <= from || placement.startAt >= until) continue;
    for (const id of placement.slotIds) reserved.add(slotOf(id));
  }
  return reserved;
}

// ── 連続処理の駆動 ───────────────────────────────────────────────────────────────────────────

/** trace の 1 行——踏んだ操作・遷移の結果・その直後の空白（無ければ null）。 */
export interface Transition {
  readonly at: number;
  readonly operation: string;
  readonly step: Step;
  readonly gap: StartableGap | null;
}

export interface OperationPolicy {
  /** 時計の刻み（秒）。各刻みで「Complete → 開始」の順に操作を踏む。発火は刻みに依らず茹で上がりの時刻に踏む。 */
  readonly tickSeconds: number;
  /** 茹で上がり（boiledAt）から Complete までの猶予（秒）。 */
  readonly completeDelaySeconds: number;
  /** Complete する釜の順（猶予を過ぎた boiled の釜のうち、番号の小さい順か大きい順か）。1 刻みに 1 釜。 */
  readonly completeOrder: "ascending" | "descending";
  /** 1 刻みに始める先頭の本数（表示の順）。 */
  readonly startsPerTick: number;
  /** 最初の刻み（秒）。`from` の時刻以上。 */
  readonly fromSeconds: number;
  /** 最後の刻み（秒）。 */
  readonly untilSeconds: number;
  /**
   * 各遷移の前に前回の提案（Shown_Plan）を忘れる——履歴の無い場面（観測事実 8「plan-stability の履歴は必要条件ではない」を
   * 両側で踏む）。既定は忘れない（engine が Persist した Shown_Plan をそのまま次の遷移が読む）。
   */
  readonly forgetShownPlan?: boolean;
  /**
   * 各遷移の後に、その時点の確定計画をそのまま採用済み一片に見立てる——採用済み接頭辞の在る場面。外部ソルバが自前解と同じ
   * 計画を届けて採用された形で、`schedulingScenes` が採用済み計画を持つ状態を組むのと同じ見立て。次の遷移の合成は
   * その一片を接頭辞として維持し（陳腐化・開始できない配置・錨・上限で切れるまで）、尾部を置き直す。既定は採用しない。
   */
  readonly adoptCommitted?: boolean;
}

/**
 * 観測事実 8 の操作列を駆動する。`from` の状態から `fromSeconds` 〜 `untilSeconds` の時計を刻み、各刻みで
 *   1. その刻みまでに来た茹で上がりを、その時刻で発火する（複数なら順に）
 *   2. 猶予を過ぎた boiled の釜を `completeOrder` の順に 1 釜 Complete する
 *   3. 表示された先頭を提案の釜で `startsPerTick` 本まで始める
 * を踏み、各遷移の直後の snapshot と空白（`startableGapOf`）を trace に残す。全品目が処理され走行中も無くなれば
 * 早く止まる。
 */
export function operate(
  kitchen: Kitchen,
  from: Step,
  policy: OperationPolicy,
): readonly Transition[] {
  const trace: Transition[] = [];
  let current = from;
  // 遷移に渡す状態（履歴を忘れる場面では Shown_Plan を空にする）。
  const stateOf = (before: Step): TimerState =>
    policy.forgetShownPlan === true
      ? { ...before.state, shownPlan: EMPTY_SHOWN_PLAN }
      : before.state;
  const record = (operation: string, event: Event) => {
    const next = step(kitchen, stateOf(current), event);
    current = policy.adoptCommitted === true ? adoptCommitted(kitchen, next) : next;
    trace.push({
      at: seconds(next.now),
      operation,
      step: current,
      gap: startableGapOf(kitchen, current),
    });
  };
  for (let tick = policy.fromSeconds; tick <= policy.untilSeconds; tick += policy.tickSeconds) {
    // 1. 茹で上がりの発火（刻みの間に来たものはその時刻で）。
    for (;;) {
      const due = nextBoilEndOf(current.state);
      if (due === null || seconds(due) > tick) break;
      record(`fire ${seconds(due)}`, fire(due));
    }
    const now = at(tick);
    // 2. Complete（猶予を過ぎた boiled の釜を順に 1 釜）。
    const ripe = current.state.timers
      .filter(
        (timer) =>
          timer.boiledAt !== null && seconds(timer.boiledAt) + policy.completeDelaySeconds <= tick,
      )
      .flatMap((timer) => timer.slotIds.map(slotOf))
      .sort((a, b) => (policy.completeOrder === "ascending" ? a - b : b - a));
    const target = ripe[0];
    if (target !== undefined) {
      const event = completeOn(current.state, target, now);
      if (event !== null) record(`complete slot ${target}`, event);
    }
    // 3. 開始（表示された先頭）。
    const heads = displayedHeadsOf(kitchen, current.snapshot, now).slice(0, policy.startsPerTick);
    for (const head of heads) {
      record(
        `start ${nameOf(head.order)} on ${head.suggestion.slotIds.join(",")}`,
        startItem(head.order, head.suggestion.slotIds, now),
      );
    }
    if (current.state.pendingOrders.length === 0 && current.state.timers.length === 0) break;
  }
  return trace;
}

/**
 * 遷移の直後の確定計画をそのまま採用済み一片に見立てた状態（`OperationPolicy.adoptCommitted`）。確定計画の導き方は
 * settle と同じ（採用済み一片・生きている待ち行列・Timer・旧 Shown_Plan を文脈に）。snapshot はその遷移が配信したまま。
 */
function adoptCommitted(kitchen: Kitchen, current: Step): Step {
  const { state, now } = current;
  const live = liveOrders(state.pendingOrders, now);
  const committed = committedSchedule(
    state.acceptedSlices,
    live,
    state.timers,
    now,
    kitchen.params.noodlePresets,
    kitchen.params,
    {
      shown: state.shownPlan,
      running: state.timers,
      now,
      pending: live,
      presets: kitchen.params.noodlePresets,
    },
  );
  return { ...current, state: { ...state, acceptedSlices: committed.slices } };
}

/** trace のうち空白（例外に当たらない「提案ゼロ」）だけ。 */
export function gapsOf(trace: readonly Transition[]): readonly StartableGap[] {
  return trace.flatMap((transition) => (transition.gap === null ? [] : [transition.gap]));
}
