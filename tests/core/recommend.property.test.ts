// tests/core/recommend.property.test.ts — 推奨（src/engine/recommend.ts）が Alarm に影響しないことの property test。
//
// **対象は recommend 単体ではない。** Alarm を決めているのは alarm.ts の nextAlarmEffect ただ一つで、
// それを Effect 列へ積むのは settle である。「推奨は Alarm を張らない」は recommend の中を覗いても
// 確かめられない主張——推奨が Alarm に触れないことは、推奨を含む世界と含まない世界で decide が同じ
// Alarm を出すことでしか示せない。ゆえに主張は decide の出力に対して立てる。
//
// 場面の作り方:
//   1. 開始済み Timer（running / boiled）と待ち行列を持つ世界を作り、自前解を採用済み計画に見立てる。
//      推奨が実在する状態（Pending_Order と採用済み PlanSlice が非空）をこれで確立する。
//   2. 同じ Timer 集合のまま、待ち行列と採用済み計画だけを空にした世界を並べて作る（推奨が 1 件も無い世界）。
//   3. 両方に同じイベントを流し、Alarm の Effect が一致すること・かつ走行中 Timer の実効 endTime の最早に
//      一致することを見る。
//
// **主張の立て方についての申し送り。** ここで振るのは Timer 集合を動かすイベント（開始・キャンセル・完了・
// 調整・発火・整合）だけで、オーダー到着・取り消しは流さない。到着側から Alarm が動かないことは Property 14
// （boil-sync-invariance.property.test.ts）が受け持つ——あちらは同じ Timer 集合に対してスケジューリング状態を
// 振り、Alarm と Timer 側の確定結果が一致することを見る。同じ主張を二箇所で立てない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { committedSchedule } from "../../src/engine/commit";
import { decide } from "../../src/engine/decide";
import { recommend } from "../../src/engine/recommend";
import { baselineSchedule, initialRelease } from "../../src/engine/schedule";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Effect } from "../../src/engine/effect";
import type { Event } from "../../src/engine/event";
import type { ScheduleParams } from "../../src/engine/objective";
import { tableMembers } from "../../src/engine/project";
import type { SettleParams } from "../../src/engine/settle";
import type { SyncParams } from "../../src/engine/sync";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { Firmness } from "../../src/domain/firmness";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
} from "../../src/domain/store";
import {
  KNOWN_NOODLE_TYPES,
  NOW,
  genOrderSpec,
  genParams,
  genRunning,
  timerOn,
  toPending,
} from "./scheduleScenes";

/** Boil_Sync のパラメータ（既定域内）。推奨とは無関係の値であることがこの property の前提でもある。 */
const SYNC_PARAMS: SyncParams = { arms: 2, toleranceRatio: 10 };

/** decide へ渡す束。場面が振った採点パラメータをそのまま載せる（推奨の導出と同じ値で計算させる）。 */
function paramsOf(scene: AlarmScene): SettleParams {
  return { ...SYNC_PARAMS, ...scene.params, noodlePresets: DEFAULT_NOODLE_PRESETS };
}

/** 推奨がある世界と、無い世界と、両者へ流す同一のイベント。 */
interface AlarmScene {
  /** 待ち行列と採用済み計画を持つ状態（推奨が実在する）。 */
  readonly planned: TimerState;
  /** 同じ Timer 集合で、待ち行列と採用済み計画だけを空にした状態（推奨が 1 件も無い）。 */
  readonly barren: TimerState;
  readonly event: Event;
  readonly now: EpochMillis;
  readonly params: ScheduleParams;
}

const genAlarmScene: fc.Arbitrary<AlarmScene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) => {
    const slotCount = unitCount * SLOTS_PER_UNIT;
    return fc.record({
      slotCount: fc.constant(slotCount),
      params: genParams(unitCount),
      // 走行中と茹で上がり済みの双方を振る。Alarm の対象は running だけなので、boiled が混じることが
      // 「最早 endTime」の期待値を素朴な最小値から分ける（boiled を数えれば過去時刻へ張ってしまう）。
      running: fc.array(genRunning(slotCount), { minLength: 1, maxLength: 5 }),
      // 待ち行列は必ず非空。麺種は既知のみ——茹で時間が引けない品目は配置されず、推奨が空の場面が
      // 混ざると「推奨がある世界」という前提が崩れる。
      orders: fc.array(genOrderSpec(KNOWN_NOODLE_TYPES), { minLength: 1, maxLength: 5 }),
      elapsed: fc.integer({ min: 0, max: 30_000 }),
    });
  })
  .chain((seed) => {
    const timers = seed.running.map(timerOn);
    const now = (NOW + seed.elapsed) as EpochMillis;
    return genEventFor(timers, now).map((event) => {
      const pending = toPending(seed.orders);
      const accepted = baselineSchedule(
        pending,
        initialRelease(timers, NOW, seed.slotCount),
        tableMembers(timers),
        DEFAULT_NOODLE_PRESETS,
        seed.params,
      ).slices;
      const planned: TimerState = {
        ...EMPTY_STATE,
        timers,
        nextSeq: timers.length,
        pendingOrders: pending,
        acceptedSlices: accepted,
      };
      return {
        planned,
        barren: { ...planned, pendingOrders: [], acceptedSlices: [] },
        event,
        now,
        params: seed.params,
      };
    });
  });

/**
 * 状態変化のイベント。Alarm を動かしうる全経路（開始・キャンセル・完了・調整・発火・整合）を振る。
 *
 * Cancel / Complete / Adjust は既存 id を選ぶ（存在しない id は拒否されて Effect が出ず、主張の対象に
 * ならない）。Start の slotIds は釜番号ではなく任意の非空文字列でよい——engine は開始時に釜の占有を
 * 検査しないため、Alarm の主張に slot の妥当性は関与しない。
 */
function genEventFor(timers: readonly Timer[], now: EpochMillis): fc.Arbitrary<Event> {
  const existingId = fc.constantFrom(...timers.map((timer) => timer.id as string));
  return fc.oneof(
    fc
      .record({
        boilSeconds: fc.integer({ min: 30, max: 600 }),
        newTimerId: fc.string({ minLength: 1, maxLength: 6 }),
      })
      .map(
        (start) =>
          ({
            type: "Start",
            slotIds: ["0"],
            noodleType: KNOWN_NOODLE_TYPES[0]!,
            boilSeconds: start.boilSeconds,
            newTimerId: `nid-${start.newTimerId}` as TimerId,
            now,
          }) satisfies Event,
      ),
    fc.constant({ type: "AlarmFired", now } satisfies Event),
    fc.constant({ type: "Reconcile", now } satisfies Event),
    existingId.map((timerId) => ({ type: "Cancel", timerId, now }) satisfies Event),
    existingId.map((timerId) => ({ type: "Complete", timerId, now }) satisfies Event),
    fc
      .record({
        timerId: existingId,
        firmness: fc.constantFrom<Firmness>("extraHard", "hard", "normal", "soft"),
      })
      .map(
        (adjust) =>
          ({
            type: "Adjust",
            timerId: adjust.timerId,
            firmness: adjust.firmness,
            boilSeconds: 180,
            now,
          }) satisfies Event,
      ),
  );
}

/** Effect 列の Alarm。DO は同時に 1 Alarm ゆえ、列に現れるのは高々 1 件である。 */
function alarmOf(effects: readonly Effect[]): Effect | null {
  const alarms = effects.filter(
    (effect) => effect.type === "SetAlarm" || effect.type === "ClearAlarm",
  );
  expect(alarms.length).toBeLessThanOrEqual(1);
  return alarms[0] ?? null;
}

/**
 * 期待する Alarm。走行中 Timer の実効 `endTime`（endTime + adjustment）の最早、走行中ゼロなら ClearAlarm。
 *
 * 実装（alarm.ts / project.ts）を呼ばずにテスト側の素朴な算術で組む。実装を呼べば同じ式を二度確かめる
 * だけになり、Alarm の時刻が推奨ではなく走行中の茹で上がりで決まるという主張が検査から消える。
 */
function expectedAlarm(state: TimerState): Effect {
  const running = state.timers.filter((timer) => timer.boiledAt === null);
  if (running.length === 0) return { type: "ClearAlarm" };
  const earliest = Math.min(
    ...running.map((timer) => (timer.endTime as number) + timer.adjustment),
  );
  return { type: "SetAlarm", at: earliest as EpochMillis };
}

/** 当該状態から導出される推奨（確定計画 → 推奨の経路は settle が通すのと同一）。 */
function recommendationsOf(state: TimerState, scene: AlarmScene) {
  const committed = committedSchedule(
    state.acceptedSlices,
    state.pendingOrders,
    state.timers,
    scene.now,
    DEFAULT_NOODLE_PRESETS,
    scene.params,
  );
  return recommend(
    committed,
    state.pendingOrders,
    state.timers,
    DEFAULT_NOODLE_PRESETS,
    scene.params,
  );
}

describe("engine/recommend — 推奨と Alarm の独立", () => {
  // Feature: online-cook-scheduling, Property: 13 — 推奨は Alarm を張らない
  // **Validates: Requirements 8.2, 11.4**
  //
  // 任意の状態変化について、Effect 列の Alarm は走行中 Timer の実効 endTime の最早に一致する。推奨開始時刻は
  // その値に一切寄与しない——推奨を持つ世界と持たない世界が同じ Alarm を出すことが、寄与の不在を示す。
  it("Property 13: Alarm は走行中の実効最早に一致し、推奨の有無で動かない", () => {
    fc.assert(
      fc.property(genAlarmScene, (scene) => {
        const outcome = decide(scene.planned, scene.event, paramsOf(scene));
        // 拒否は状態も Effect も生まないため、Alarm についての主張の対象にならない。
        if (!outcome.ok) return;

        const alarm = alarmOf(outcome.effects);
        // 確定結果が変わらない発火・整合は put も broadcast もしない（Alarm も張り直さない）。
        if (alarm === null) {
          expect(outcome.effects).toEqual([]);
          return;
        }

        // (1) Alarm の時刻は走行中 Timer の実効 endTime の最早（推奨開始時刻ではない）。
        expect(alarm).toEqual(expectedAlarm(outcome.state));

        // この場面に推奨が実在することを確かめる（前提が崩れた空虚な合格を許さない）。
        expect(recommendationsOf(outcome.state, scene).length).toBeGreaterThan(0);

        // (2) 推奨が 1 件も無い世界へ同じイベントを流しても Alarm は同一。
        const bare = decide(scene.barren, scene.event, paramsOf(scene));
        expect(bare.ok).toBe(true);
        if (!bare.ok) return;
        expect(recommendationsOf(bare.state, scene)).toEqual([]);
        expect(alarmOf(bare.effects)).toEqual(alarm);
      }),
      { numRuns: 300 },
    );
  });
});
