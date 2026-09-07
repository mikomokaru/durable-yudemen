// tests/core/restoreScenes.ts — plan-stability の実占有での性質（5.6 / 5.10 / 5.11）と startable-placement の合法性の検査が
// 共有する場面の組み立てと、計画を合成・ゲートと同じ述語で検証する道具。
//
// 復元（`retain`）・選択（R ≤ F なら R）の規則そのものは src（`baselineSchedule` / `scheduleCandidates`）に在る——ここに
// 写しを置かない。述語（`isStale` / `cannotStart` / `feasibleRelease` / `keepsAnchor` / `withinLiftCap`）も src の公開関数を
// 呼ぶ。`violationsOf` は完成した計画を計画順に、一片を置く前の表で検証する（ゲートと同じ位置・同じ表）。

import * as fc from "fast-check";
import {
  advanceRelease,
  baselineSchedule,
  cannotStart,
  feasibleRelease,
  initialRelease,
  isStale,
  keepsAnchor,
  placeableTargets,
  scheduleCandidates,
  type CookSchedule,
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
import type { OrderItem } from "../../src/domain/order";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
  occupiedSlotsOf,
  type NoodlePreset,
} from "../../src/domain/store";
import {
  KNOWN_NOODLE_TYPES,
  NOW,
  UNKNOWN_NOODLE_TYPE,
  genOrderSpec,
  genParams,
  genRunning,
  timerOn,
  toPending,
  type OrderSpec,
  type RunningSpec,
} from "./scheduleScenes";

// ────────────────────────────────────────────────────────────────────────────
// 場面（素データを保持して反例を印字できる形）
// ────────────────────────────────────────────────────────────────────────────

export interface RawScene {
  readonly unitCount: number;
  readonly params: ScheduleParams;
  readonly running: readonly RunningSpec[];
  readonly orders: readonly OrderSpec[];
}

/**
 * 実占有の性質（5.6 / 5.10 / 5.11 / 4.8）が共有する場面の生成器。`schedule.property` と同じ形（走行中・boiled・卓・大盛・
 * 未知の麺種を振る）で、素データを保つ（反例を印字できる）。
 */
export const genRawScene: fc.Arbitrary<RawScene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) =>
    fc.record({
      unitCount: fc.constant(unitCount),
      params: genParams(unitCount),
      running: fc.array(genRunning(unitCount * SLOTS_PER_UNIT), { maxLength: 5 }),
      orders: fc.array(genOrderSpec([...KNOWN_NOODLE_TYPES, UNKNOWN_NOODLE_TYPE]), {
        maxLength: 5,
      }),
    }),
  );

export interface Scene {
  readonly pending: readonly OrderItem[];
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
  pending: readonly OrderItem[],
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

/** 場面の 2 候補（生成候補 F と保持候補 R・`scheduleCandidates`）。R は前回が無ければ null。 */
export function candidatesOf(scene: Scene, changeContext: ChangeContext | null) {
  return scheduleCandidates(
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
// 検証（合成・ゲートと同じ述語・同じ位置の表）
// ────────────────────────────────────────────────────────────────────────────

export type Reason = "stale" | "cannotStart" | "release" | "anchor" | "liftCap";

/** 場面の置ける品目（`placeableTargets`・plan-stability Requirement 7）。復元・検証・再生成が同じ集合を読む。 */
export function targetsOf(scene: Scene): readonly OrderItem[] {
  return placeableTargets(scene.pending, scene.now, DEFAULT_NOODLE_PRESETS, scene.params);
}

/**
 * 一片が現在の入力に対してどのハード制約で落ちるか（null は落ちない）。`release` / `lifts` は一片を置く前の表。
 * 述語は合成（`livePrefix`）・ゲート（`prune`）・復元（`retain`）と同じ src の公開関数で、`targets` は置ける品目
 * （`placeableTargets`）。理由の順（stale → cannotStart → release → anchor → liftCap）は調査の分類のため。`cannotStart` は
 * 保持の条件であって完成した計画の成立の条件ではない（判断 13）——空き不足で boiled の釜を待つ配置は合法。
 */
export function reasonOf(
  slice: PlanSlice,
  targets: readonly OrderItem[],
  now: EpochMillis,
  occupied: ReadonlySet<number>,
  release: SlotRelease,
  lifts: LiftTable,
  members: TableMembers,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
  physicalOnly = false,
): Reason | null {
  if (isStale(slice, targets)) return "stale";
  if (!physicalOnly && cannotStart(slice, now, occupied)) return "cannotStart";
  if (feasibleRelease(slice.placements, release, targets, presets) === null) return "release";
  const siblings = members.get(slice.tableKey) ?? null;
  if (!keepsAnchor(slice.placements, release, lifts, siblings, targets, presets, params))
    return "anchor";
  if (!withinLiftCap(lifts, liftsOf(slice.placements), params)) return "liftCap";
  return null;
}

/** 計画の一片を計画順に検証し、落ちる一片とその理由を返す（性質 5.10 / 4.8 の検査）。 */
export function violationsOf(
  scene: Scene,
  schedule: CookSchedule,
  physicalOnly = false,
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
      physicalOnly,
    );
    if (reason !== null) found.push({ tableKey: slice.tableKey, reason });
    free = advanceRelease(free, slice.placements);
    ends = advanceLifts(ends, liftsOf(slice.placements));
  }
  return found;
}

/** 物理的なハード制約の違反（`cannotStart` は保持の条件ゆえ当てない・判断 13。後の述語を隠さないよう飛ばして判定する）。 */
export function physicalViolationsOf(scene: Scene, schedule: CookSchedule) {
  return violationsOf(scene, schedule, true);
}
