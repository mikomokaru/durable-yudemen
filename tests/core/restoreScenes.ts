// tests/core/restoreScenes.ts — plan-stability の調査（実占有での性質 5.6）が共有する「前回の提案の復元」の試作。
//
// ここに置くのは、前回配信対象として確定した提案（Shown_Plan）を**再生成せず復元**して保持候補にし、
// 確定計画の合成（`commit.ts` の `livePrefix`）と同じハード制約の述語で現在の入力に対して検証し、新しく組んだ候補と
// 総費用（業務費用 ＋ 変更費用・`scoreSchedule`）で比べる規則（規則 B）の試作である。述語（`tableKeyOf` / `cannotStart` /
// `feasibleRelease` / 置ける品目 `placeableTargets`）は src の公開関数を呼ぶ（task 3′.1 / 3′.2 で写しを撤去）。復元と
// 選択の規則そのものは task 3′.3 が `retain` として src に移す。

import {
  advanceRelease,
  baselineSchedule,
  cannotStart,
  feasibleRelease,
  initialRelease,
  isStale,
  keepsAnchor,
  placeableTargets,
  tableKeyOf,
  type CookSchedule,
  type Placement,
  type PlanSlice,
  type SlotRelease,
} from "../../src/engine/schedule";
import { scoreSchedule, type ScheduleParams } from "../../src/engine/objective";
import {
  advanceLifts,
  initialLifts,
  liftsOf,
  withinLiftCap,
  type LiftTable,
} from "../../src/engine/lift";
import { tableMembers, type TableMembers } from "../../src/engine/project";
import { recommend } from "../../src/engine/recommend";
import {
  changeCost,
  shownPlanOf,
  type ChangeContext,
  type ShownPlan,
} from "../../src/engine/stability";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis } from "../../src/engine/types";
import { itemKeyOf, type PendingOrder } from "../../src/domain/order";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  occupiedSlotsOf,
  type NoodlePreset,
} from "../../src/domain/store";
import { NOW, timerOn, toPending, type OrderSpec, type RunningSpec } from "./scheduleScenes";

// ────────────────────────────────────────────────────────────────────────────
// 場面（素データを保持して反例を印字できる形）
// ────────────────────────────────────────────────────────────────────────────

export interface RawScene {
  readonly unitCount: number;
  readonly params: ScheduleParams;
  readonly running: readonly RunningSpec[];
  readonly orders: readonly OrderSpec[];
}

export interface Scene {
  readonly pending: readonly PendingOrder[];
  readonly release: SlotRelease;
  readonly members: TableMembers;
  readonly lifts: LiftTable;
  readonly running: readonly Timer[];
  readonly occupied: ReadonlySet<number>;
  readonly slotCount: number;
  readonly params: ScheduleParams;
  readonly now: EpochMillis;
}

/** 素データから場面を組む。`now` は既定 NOW（時刻を進めた場面は `withNow`）。 */
export function sceneOf(raw: RawScene, now: EpochMillis = NOW): Scene {
  const slotCount = raw.unitCount * SLOTS_PER_UNIT;
  const timers = raw.running.map(timerOn);
  return sceneFrom(toPending(raw.orders), timers, slotCount, raw.params, now);
}

/** 待ち行列・Timer・釜数・パラメータ・now から場面を組む（摂動した場面もここから）。 */
export function sceneFrom(
  pending: readonly PendingOrder[],
  timers: readonly Timer[],
  slotCount: number,
  params: ScheduleParams,
  now: EpochMillis,
): Scene {
  return {
    pending,
    release: initialRelease(timers, now, slotCount),
    members: tableMembers(timers),
    lifts: initialLifts(timers),
    running: timers,
    occupied: occupiedSlotsOf(timers),
    slotCount,
    params,
    now,
  };
}

/** 場面の自前解（`baselineSchedule`）。`changeContext` は前回の提案の文脈、null は前回なし。 */
export function planOf(scene: Scene, changeContext: ChangeContext | null): CookSchedule {
  return baselineSchedule(
    scene.pending,
    scene.release,
    scene.members,
    scene.lifts,
    DEFAULT_NOODLE_PRESETS,
    scene.params,
    scene.now,
    scene.occupied,
    changeContext,
  );
}

/** 前回の計画を Shown_Plan にした変更費用の文脈（比較の時点は場面の now・Timer 集合は場面の走行中）。 */
export function contextOf(scene: Scene, previous: CookSchedule): ChangeContext {
  return contextWith(scene, shownPlanOf(previous, recommend(previous)));
}

export function contextWith(scene: Scene, shown: ShownPlan): ChangeContext {
  return {
    shown,
    running: scene.running,
    now: scene.now,
    pending: scene.pending,
    presets: DEFAULT_NOODLE_PRESETS,
  };
}

/** 総費用（業務費用 ＋ 変更費用）。`changeContext` が null なら業務費用そのもの。 */
export function totalOf(
  scene: Scene,
  schedule: CookSchedule,
  changeContext: ChangeContext | null,
): number {
  return scoreSchedule(
    schedule.slices,
    scene.pending,
    { members: scene.members, lifts: scene.lifts, change: changeContext },
    scene.params,
  ).total;
}

export function changeOf(
  scene: Scene,
  schedule: CookSchedule,
  changeContext: ChangeContext,
): number {
  return changeCost(
    { schedule, recommendations: recommend(schedule) },
    changeContext,
    scene.params,
  );
}

/** 計画の同一性（配置の値と一片の並び）。 */
export function samePlan(a: CookSchedule, b: CookSchedule): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ────────────────────────────────────────────────────────────────────────────
// 復元（Shown_Plan → CookSchedule の形）と検証（livePrefix と同じ述語）
// ────────────────────────────────────────────────────────────────────────────

/**
 * Shown_Plan を一片の列に組む。一片の順は Shown_Plan での初出順（`shownPlanOf` は計画順に平坦化するので計画順が残る）。
 * 計画対象（置ける品目）に無い品目（開始済み・キャンセル・期限切れ・置けない）は落とす——落ちた卓は `isStale` で
 * 丸ごと再生成に回る。`mates` は読まない（群は `recommend` が一片の index と錨・提供時刻から付け直す）。一片の鍵は
 * 計画と同じ `tableKeyOf`（schedule.ts が公開）。
 */
export function restoreSlices(
  shown: ShownPlan,
  targets: readonly PendingOrder[],
  retimeBefore: EpochMillis | null = null,
): readonly PlanSlice[] {
  const byKey = new Map(targets.map((order) => [itemKeyOf(order), order]));
  const slices = new Map<string, Placement[]>();
  for (const item of shown) {
    const order = byKey.get(itemKeyOf(item));
    if (order === undefined) continue;
    const key = tableKeyOf(order);
    // 過去開始（`startAt < now`）の「今」の提案を now に置き直す変種（retime）。提供時刻は茹で時間を保って追随、錨は保つ。
    const lapsed = retimeBefore !== null && item.startAt < retimeBefore;
    const startAt = lapsed ? retimeBefore : item.startAt;
    const serveAt = lapsed
      ? ((retimeBefore + (item.serveAt - item.startAt)) as EpochMillis)
      : item.serveAt;
    const placement: Placement = {
      externalOrderId: item.externalOrderId,
      itemIndex: item.itemIndex,
      slotIds: item.slotIds,
      startAt,
      serveAt,
      anchor: item.anchor,
    };
    const slice = slices.get(key);
    if (slice === undefined) slices.set(key, [placement]);
    else slice.push(placement);
  }
  return [...slices].map(([tableKey, placements]) => ({ tableKey, placements }));
}

export type Reason = "stale" | "cannotStart" | "release" | "anchor" | "liftCap";

/** 場面の置ける品目（`placeableTargets`・plan-stability Requirement 7）。復元・検証・再生成が同じ集合を読む。 */
export function targetsOf(scene: Scene): readonly PendingOrder[] {
  return placeableTargets(scene.pending, scene.now, DEFAULT_NOODLE_PRESETS, scene.params);
}

/**
 * 一片が現在の入力に対してどのハード制約で落ちるか（null は落ちない）。`release` / `lifts` は一片を置く前の表。
 * 述語は合成（`livePrefix`）・ゲート（`prune`）と同じ src の公開関数で、`targets` は置ける品目（`placeableTargets`）。
 * 理由の順（stale → cannotStart → release → anchor → liftCap）は、ゲートが落とす順ではなく調査の分類のため。
 */
export function reasonOf(
  slice: PlanSlice,
  targets: readonly PendingOrder[],
  now: EpochMillis,
  occupied: ReadonlySet<number>,
  release: SlotRelease,
  lifts: LiftTable,
  members: TableMembers,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): Reason | null {
  if (isStale(slice, targets)) return "stale";
  if (cannotStart(slice, now, occupied)) return "cannotStart";
  if (feasibleRelease(slice.placements, release, targets, presets) === null) return "release";
  const siblings = members.get(slice.tableKey) ?? null;
  if (!keepsAnchor(slice.placements, release, lifts, siblings, targets, presets, params))
    return "anchor";
  if (!withinLiftCap(lifts, liftsOf(slice.placements), params)) return "liftCap";
  return null;
}

/** 計画の一片を計画順に検証し、落ちる一片とその理由を返す（D の検査）。 */
export function violationsOf(
  scene: Scene,
  schedule: CookSchedule,
): readonly { readonly tableKey: string; readonly reason: Reason }[] {
  const targets = targetsOf(scene);
  const found: { tableKey: string; reason: Reason }[] = [];
  let free = scene.release;
  let ends = scene.lifts;
  for (const slice of schedule.slices) {
    const reason = reasonOf(
      slice,
      targets,
      scene.now,
      scene.occupied,
      free,
      ends,
      scene.members,
      DEFAULT_NOODLE_PRESETS,
      scene.params,
    );
    if (reason !== null) found.push({ tableKey: slice.tableKey, reason });
    free = advanceRelease(free, slice.placements);
    ends = advanceLifts(ends, liftsOf(slice.placements));
  }
  return found;
}

export interface Restored {
  readonly kept: readonly PlanSlice[];
  readonly dropped: readonly { readonly slice: PlanSlice; readonly reason: Reason }[];
  readonly release: SlotRelease;
  readonly lifts: LiftTable;
}

/** 復元の検証の仕方。stop＝最初の不正で止める（接頭辞・合成と同じ）、skip＝不正な一片を飛ばす、inplace＝不正な一片の卓をその場で組み直す。 */
export type RestoreMode = "skip" | "stop" | "inplace";

/**
 * Shown_Plan を復元して `livePrefix` と同じ述語で検証する。飛ばした（止めた）一片の品目は呼び手が尾部で置き直す。
 * inplace は不正な一片の卓の**現在の品目**を、その位置で `regenerate`（進めた表の上の自前解）に置かせ、続きを検証する。
 */
export function restoredPrefix(
  shown: ShownPlan,
  targets: readonly PendingOrder[],
  now: EpochMillis,
  release: SlotRelease,
  lifts: LiftTable,
  members: TableMembers,
  occupied: ReadonlySet<number>,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
  mode: RestoreMode,
  retime = false,
  regenerate: (
    items: readonly PendingOrder[],
    release: SlotRelease,
    lifts: LiftTable,
  ) => CookSchedule = () => ({ slices: [] }),
): Restored {
  const kept: PlanSlice[] = [];
  const dropped: { slice: PlanSlice; reason: Reason }[] = [];
  let free = release;
  let ends = lifts;
  let stopped = false;
  for (const slice of restoreSlices(shown, targets, retime ? now : null)) {
    const reason = stopped
      ? "stale"
      : reasonOf(slice, targets, now, occupied, free, ends, members, presets, params);
    if (reason !== null) {
      dropped.push({ slice, reason });
      if (mode === "stop") stopped = true;
      if (mode !== "inplace") continue;
      const items = targets.filter((order) => tableKeyOf(order) === slice.tableKey);
      for (const placed of regenerate(items, free, ends).slices) {
        kept.push(placed);
        free = advanceRelease(free, placed.placements);
        ends = advanceLifts(ends, liftsOf(placed.placements));
      }
      continue;
    }
    kept.push(slice);
    free = advanceRelease(free, slice.placements);
    ends = advanceLifts(ends, liftsOf(slice.placements));
  }
  return { kept, dropped, release: free, lifts: ends };
}

// ────────────────────────────────────────────────────────────────────────────
// 規則 B：復元候補 R と新規候補 F を総費用で比べる（同点は R）
// ────────────────────────────────────────────────────────────────────────────

export interface RuleOptions {
  /** 復元の検証：最初の不正で止める（stop）か、飛ばして続ける（skip）か、その場で組み直す（inplace）か。 */
  readonly mode: RestoreMode;
  /** 新規候補 F を前回の文脈つき（現行の baselineSchedule の出力）で組むか、前回なしで組むか。 */
  readonly freshWithContext: boolean;
  /** 復元候補 R の尾部（復元できなかった品目）を前回の文脈つきで組むか。 */
  readonly tailWithContext: boolean;
  /** 過去開始の「今」の提案を now に置き直してから検証するか（既定 false）。 */
  readonly retime?: boolean;
}

export const RULE_B: RuleOptions = {
  mode: "inplace",
  freshWithContext: true,
  tailWithContext: true,
};

export interface Selection {
  readonly plan: CookSchedule;
  readonly restored: CookSchedule;
  readonly fresh: CookSchedule;
  readonly chosen: "R" | "F";
  readonly dropped: readonly { readonly tableKey: string; readonly reason: Reason }[];
  readonly totalR: number;
  readonly totalF: number;
}

export function select(
  scene: Scene,
  changeContext: ChangeContext,
  options: RuleOptions,
): Selection {
  const { release, members, lifts, occupied, params, now } = scene;
  const targets = targetsOf(scene);
  const r = restoredPrefix(
    changeContext.shown,
    targets,
    now,
    release,
    lifts,
    members,
    occupied,
    DEFAULT_NOODLE_PRESETS,
    params,
    options.mode,
    options.retime ?? false,
    (items, free, ends) =>
      baselineSchedule(
        items,
        free,
        members,
        ends,
        DEFAULT_NOODLE_PRESETS,
        params,
        now,
        occupied,
        options.tailWithContext ? changeContext : null,
      ),
  );
  const placed = new Set(
    r.kept.flatMap((slice) => slice.placements.map((placement) => itemKeyOf(placement))),
  );
  const remaining = targets.filter((order) => !placed.has(itemKeyOf(order)));
  const tail = baselineSchedule(
    remaining,
    r.release,
    members,
    r.lifts,
    DEFAULT_NOODLE_PRESETS,
    params,
    now,
    occupied,
    options.tailWithContext ? changeContext : null,
  );
  const restored: CookSchedule = { slices: [...r.kept, ...tail.slices] };
  const fresh = planOf(scene, options.freshWithContext ? changeContext : null);
  const totalR = totalOf(scene, restored, changeContext);
  const totalF = totalOf(scene, fresh, changeContext);
  const chosen = totalR <= totalF ? "R" : "F";
  return {
    plan: chosen === "R" ? restored : fresh,
    restored,
    fresh,
    chosen,
    dropped: r.dropped.map((entry) => ({ tableKey: entry.slice.tableKey, reason: entry.reason })),
    totalR,
    totalF,
  };
}
