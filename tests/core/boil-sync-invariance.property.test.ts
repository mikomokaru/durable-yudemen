// tests/core/boil-sync-invariance.property.test.ts — Property 14（Boil_Sync の不変）。
//
// 主張は「`synchronize` の入出力が本機能の導入前後で一致する」。導入前のコードは残っていないので、
// **スケジューリング状態をどう振っても Boil_Sync の入力と出力が変わらない**形で立てる。これが「一致」の
// 検査可能な言い換えである——導入によって増えたのは待ち行列・採用済み計画・推奨だけなので、それらを
// 任意に振って Boil_Sync の結果が動かなければ、Boil_Sync は導入前と同じものを計算している。
//
// 3 つを見る。
//   (1) 同じ Timer 集合・同じイベントに対し、スケジューリング状態を持つ世界と持たない世界で
//       確定後の Timer 集合が一致する（Boil_Sync の出力が一致）。
//   (2) オーダーの到着・取り消しは Boil_Sync の**入力**を動かさない（Timer の不変アンカー
//       ——id / startTime / endTime / seq / boiledAt ——が保たれ、動くのは adjustment だけ）。
//   (3) そのときの確定 Timer 集合は、`synchronize` を running へ直接当てた結果に一致する
//       （settle が Boil_Sync 以外の計算で Timer を触っていない）。
//
// (2)(3) をオーダー系イベントに絞るのは、そこが本機能で新しく増えた経路であり、Boil_Sync へ余計な計算が
// 混ざるならそこに現れるためである（Timer を動かす既存イベントの振る舞いは既存テストが押さえている）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Effect } from "../../src/engine/effect";
import { synchronize } from "../../src/engine/sync";
import type { Timer } from "../../src/engine/timer";
import { genScheduledScene, type ScheduledScene } from "./schedulingScenes";

/** Effect 列の Alarm。DO は同時に 1 Alarm ゆえ、列に現れるのは高々 1 件である。 */
function alarmOf(effects: readonly Effect[]): Effect | null {
  const alarms = effects.filter(
    (effect) => effect.type === "SetAlarm" || effect.type === "ClearAlarm",
  );
  expect(alarms.length).toBeLessThanOrEqual(1);
  return alarms[0] ?? null;
}

/** Timer の不変アンカー（adjustment を除いた事実）。オーダー系イベントはこれを一切動かさない。 */
function anchorOf(timer: Timer): unknown {
  const { adjustment: _adjustment, ...anchor } = timer;
  return anchor;
}

/**
 * Boil_Sync を running へ直接当てた結果（本機能の導入前に settle が行っていた計算そのまま）。
 *
 * running のみ再同期し boiled は据え置く。実装（settle）を呼ばずにテスト側で組むのは、同じ関数の
 * 戻り値を二度確かめるだけになるのを避けるためである。
 */
function resynchronized(
  timers: readonly Timer[],
  params: { arms: number; toleranceRatio: number },
): readonly Timer[] {
  const synced = synchronize(
    timers.filter((timer) => timer.boiledAt === null),
    params,
  );
  const syncedById = new Map<string, Timer>(synced.map((timer) => [timer.id as string, timer]));
  return timers.map((timer) =>
    timer.boiledAt === null ? (syncedById.get(timer.id as string) ?? timer) : timer,
  );
}

describe("engine/settle — Boil_Sync の不変", () => {
  // Feature: online-cook-scheduling, Property: 14 — Boil_Sync の不変
  // **Validates: Requirements 9.2, 9.4**
  it("Property 14: スケジューリング状態を振っても Boil_Sync の入出力は変わらない", () => {
    fc.assert(
      fc.property(genScheduledScene, (scene: ScheduledScene) => {
        const planned = decide(scene.state, scene.event, scene.params);
        const bare = decide(scene.bare, scene.event, scene.params);

        // 拒否事由は Timer 側だけで決まる（推奨との不一致を拒否事由にしない・AC 8.3）。ゆえに 2 つの
        // 世界は必ず同じ可否へ落ちる。
        expect(planned.ok).toBe(bare.ok);
        if (!planned.ok || !bare.ok) return;

        // (1) 確定後の Timer 集合が一致する（Boil_Sync の出力はスケジューリング状態に依存しない）。
        expect(planned.state.timers).toEqual(bare.state.timers);

        // Alarm も一致する（走行中の実効最早だけで決まるため、待ち行列も推奨も寄与しない）。
        const alarm = alarmOf(planned.effects);
        const bareAlarm = alarmOf(bare.effects);
        // 一方が no-op（確定変化なし＝空列）なら Alarm も張り直されない。両方が列を出したときに突き合わせる。
        if (alarm !== null && bareAlarm !== null) expect(alarm).toEqual(bareAlarm);

        if (scene.event.type !== "OrderArrived" && scene.event.type !== "OrderCancelled") return;

        // (2) オーダー系イベントは Boil_Sync の入力を動かさない。件数・不変アンカーがそのまま残る。
        expect(planned.state.timers.length).toBe(scene.state.timers.length);
        expect(planned.state.timers.map(anchorOf)).toEqual(scene.state.timers.map(anchorOf));

        // (3) 確定 Timer 集合は synchronize を running へ直接当てた結果に一致する。
        expect(planned.state.timers).toEqual(resynchronized(scene.state.timers, scene.params));
      }),
      { numRuns: 300 },
    );
  });
});
