// tests/client/audioCue.property.test.ts — audio-cues 純粋判定（src/client/audioCue.ts）の Correctness Properties P1〜P5。
//
// audioCue.ts は WS も DOM も時計も AudioContext も持たない決定的な純粋関数群（時刻・観測位相は引数）。
// よって Workers pool 不要のプレーン Vitest ＋ fast-check（v4）で、生成器が吐く大量の入力に対し不変条件を機械検証する。
// boiled / remaining は既存の純粋導出（slotDisplay.ts / clock.ts / assignment.ts）をそのまま組み合わせ二重定義しない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PRE_ALERT_THRESHOLD_MS,
  EMPTY_PRE_ALERT_WATCH,
  boiledTimerIds,
  dueDoneCue,
  advancePreAlert,
} from "../../src/client/audioCue";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import { assignedTimers } from "../../src/client/assignment";
import { remainingMs } from "../../src/client/clock";
import {
  genAudioCase,
  genEvalCase,
  genPreAlertFold,
  genPreAlertSteps,
  genDoneCueCase,
} from "./audioGenerators";

/** Set を昇順配列にして比較を安定させる小さなヘルパ。 */
function sorted(ids: ReadonlySet<string>): string[] {
  return [...ids].sort();
}

describe("client/audioCue 純粋判定", () => {
  // Feature: audio-cues, Property 1: 純粋判定は入力 view を変更せずデータのみを決定的に返す（SSOT 非書き戻し）
  // 任意の view・担当ユニット・now・観測位相について、boiledTimerIds / dueDoneCue / advancePreAlert を評価しても
  // 入力 ClientView（timers / offset / processedIds）は一切変わらず、二度評価は完全に等しい出力を返す。
  it("Property 1: 入力 view 不変かつ二度評価が等しい（決定的・書き戻しなし）", () => {
    fc.assert(
      fc.property(genEvalCase, ({ view, units, now, watch, lastRingAt }) => {
        const timersRef = view.timers;
        const timersSnapshot = JSON.stringify(view.timers);
        const offsetBefore = view.offset;
        const processedBefore = sorted(view.processedIds);

        const evalOnce = () => {
          const displays = assignedSlotDisplays(view, units, now);
          const boiled = boiledTimerIds(displays);
          const due = dueDoneCue(boiled, now, lastRingAt);
          const assigned = assignedTimers(view.timers, units);
          const adv = advancePreAlert(watch, assigned, view.offset, now);
          return { boiled, due, fire: adv.fire, armed: adv.next.armed, alerted: adv.next.alerted };
        };

        const a = evalOnce();
        const b = evalOnce();

        // 二度評価は完全に等しい（決定的・Date.now/AudioContext/WS/DOM/localStorage に依存しない）。
        expect(sorted(a.boiled)).toEqual(sorted(b.boiled));
        expect(a.due).toBe(b.due);
        expect([...a.fire]).toEqual([...b.fire]);
        expect(sorted(a.armed)).toEqual(sorted(b.armed));
        expect(sorted(a.alerted)).toEqual(sorted(b.alerted));

        // 入力 ClientView は一切変更されない（参照同一・内容・offset・processedIds）。
        expect(view.timers).toBe(timersRef);
        expect(JSON.stringify(view.timers)).toBe(timersSnapshot);
        expect(view.offset).toBe(offsetBefore);
        expect(sorted(view.processedIds)).toEqual(processedBefore);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: audio-cues, Property 2: Pre_Alert は閾値クロスで各 timerId につきちょうど 1 回だけ発火する（once-only と資格）
  // 単調増加 now 列で advancePreAlert を畳み込むと、閾値超で観測後に ≤ 閾値へ達した timerId だけが fire にちょうど 1 回現れる。
  // 出現時に既に ≤ 閾値だった timerId は一度も発火せず、同時クロスは全件発火する（now 単調 ⇒ remaining 単調非増）。
  it("Property 2: 閾値クロスで各 timerId はちょうど 1 回発火（資格と once-only）", () => {
    fc.assert(
      fc.property(genPreAlertFold, ({ assigned, offset, stream }) => {
        const threshold = PRE_ALERT_THRESHOLD_MS;
        let watch = EMPTY_PRE_ALERT_WATCH;
        const fireCount = new Map<string, number>();
        for (const now of stream) {
          const { fire, next } = advancePreAlert(watch, assigned, offset, now);
          for (const id of fire) fireCount.set(id, (fireCount.get(id) ?? 0) + 1);
          watch = next;
        }

        // now 単調増加 ⇒ remaining 単調非増。先頭で閾値超かつ末尾で ≤ 閾値の timerId だけが、ちょうど 1 回発火する。
        const first = stream[0]!;
        const last = stream[stream.length - 1]!;
        for (const timer of assigned) {
          const remainingFirst = remainingMs(timer.endTime, offset, first);
          const remainingLast = remainingMs(timer.endTime, offset, last);
          const shouldFire = remainingFirst > threshold && remainingLast <= threshold;
          expect(fireCount.get(timer.id) ?? 0).toBe(shouldFire ? 1 : 0);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: audio-cues, Property 3: Pre_Alert の発火と記録は担当 Timer に限られ、消えた Timer の記録は破棄される
  // 担当集合がステップごとに変動する畳み込みで、fire は常に当該ステップの assigned の id のみを含み、
  // assigned に居ない id は次位相（armed / alerted）から脱落する（記録は当該 assigned の id に有界）。
  it("Property 3: fire と次位相は当該ステップの担当 id のみを含む（記録の有界性）", () => {
    fc.assert(
      fc.property(genPreAlertSteps, ({ offset, steps }) => {
        let watch = EMPTY_PRE_ALERT_WATCH;
        for (const step of steps) {
          const { fire, next } = advancePreAlert(watch, step.assigned, offset, step.now);
          const presentIds = new Set(step.assigned.map((t) => t.id));
          // fire は当該 assigned の id のみ（担当外を含まない）。
          for (const id of fire) expect(presentIds.has(id)).toBe(true);
          // 次位相は当該 assigned の id のみ（消えた id は破棄・有界）。
          for (const id of next.armed) expect(presentIds.has(id)).toBe(true);
          for (const id of next.alerted) expect(presentIds.has(id)).toBe(true);
          watch = next;
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: audio-cues, Property 4: Done_Cue の鳴動可否は boiled 集合の非空性と周期経過のみで決まる（件数・重複・done 回数・processedIds 非依存）
  // dueDoneCue(boiledTimerIds(displays), now, lastRingAt) は (a) 空→常に false (b) 非空かつ null→true
  // (c) 非空かつ now-lastRingAt ≥ interval ⇔ true。boiled の濃度・同一 timerId の重複出現に不変。
  it("Property 4: Done_Cue 判定は boiled 非空性と周期のみ（濃度・重複に不変）", () => {
    fc.assert(
      fc.property(genDoneCueCase, ({ displays, now, lastRingAt, interval }) => {
        const boiled = boiledTimerIds(displays);
        const result = dueDoneCue(boiled, now, lastRingAt, interval);

        if (boiled.size === 0) {
          expect(result).toBe(false); // (a) 空 → 常に false
        } else if (lastRingAt === null) {
          expect(result).toBe(true); // (b) 非空かつ未鳴動 → 即時 true
        } else {
          expect(result).toBe(now - lastRingAt >= interval); // (c) 非空 → 周期経過 ⇔ true
        }

        // 重複出現・濃度に不変: displays を複製しても boiled 集合は等しく、判定も変わらない（Set で dedup）。
        const doubled = [...displays, ...displays];
        const boiledDoubled = boiledTimerIds(doubled);
        expect(sorted(boiledDoubled)).toEqual(sorted(boiled));
        expect(dueDoneCue(boiledDoubled, now, lastRingAt, interval)).toBe(result);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: audio-cues, Property 5: boiled 集合は担当かつ remaining ≤ 0 の Timer のみを含む（視覚正本との一致）
  // boiledTimerIds(assignedSlotDisplays(view, units, now)) の各 id は担当範囲に属し remaining = 0。
  // 走行中（remaining > 0）・担当外・view から除去済みの Timer は決して含まれない。音声設定や Audio_Session 状態は入力に取らない。
  it("Property 5: boiled は担当かつ remaining = 0 のみ（走行中・担当外・除去済みを含まない）", () => {
    fc.assert(
      fc.property(genAudioCase, ({ view, units, now }) => {
        const displays = assignedSlotDisplays(view, units, now);
        const boiled = boiledTimerIds(displays);
        const assigned = assignedTimers(view.timers, units);
        const assignedIds = new Set(assigned.map((t) => t.id));

        for (const id of boiled) {
          // (a) 担当範囲に属する。
          expect(assignedIds.has(id)).toBe(true);
          // (b) remaining = 0（boiled は endTime ≤ 補正後現在時刻の導出）。
          const timer = view.timers.find((t) => t.id === id);
          expect(timer).toBeDefined();
          expect(remainingMs(timer!.endTime, view.offset, now)).toBe(0);
        }

        // 走行中（remaining > 0）・担当外の Timer は boiled に現れない（除去済みは view.timers に無く自明）。
        for (const timer of view.timers) {
          if (remainingMs(timer.endTime, view.offset, now) > 0) {
            expect(boiled.has(timer.id)).toBe(false);
          }
          if (!assignedIds.has(timer.id)) {
            expect(boiled.has(timer.id)).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
