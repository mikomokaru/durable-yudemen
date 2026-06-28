// tests/core/generators.ts — core の Property テストが共有する fast-check 生成器。
// すべての生成器は不正状態を構築不能にする smart constructor（createTimer）を経由し、
// 型の不変条件（endTime 必須・slotId 必須）を生成器自身が尊重する。
//
// 入力空間の方針（design.md「生成器の前提」）:
// - endTime は 0 以上の整数。小さめの範囲に寄せて同一 endTime の衝突（タイブレーク検証）を誘発する。
// - 状態は 0〜100 件。空・単一・上限 100 件・同一 endTime 多数を境界として含む。
// - now は状態中の endTime 群に対し、過去/未来/ε 近傍（endTime == now + ε 境界）をまたぐ。

import * as fc from "fast-check";
import { createTimer } from "../../src/engine/timer";
import { EPSILON_MS, MAX_TIMERS } from "../../src/engine/types";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { Timer } from "../../src/engine/timer";
import type { TimerState } from "../../src/engine/state";

/** 一件の Timer を組み立てるための素データ（id・seq はビルド時に決定的に付与する）。 */
interface TimerSpec {
  readonly endTime: number;
  readonly slotId: string;
  readonly noodleType: string;
}

/** endTime は衝突を誘発する小さめ範囲。slotId は 0 始まりスロット番号と任意文字列を混ぜる。 */
const genTimerSpec: fc.Arbitrary<TimerSpec> = fc.record({
  endTime: fc.integer({ min: 0, max: 2000 }),
  slotId: fc.oneof(fc.integer({ min: 0, max: 17 }).map(String), fc.string({ minLength: 1, maxLength: 6 })),
  noodleType: fc.constantFrom("thin", "thick", "curly", "ramen", "soba", "udon"),
});

/** 素データ列から TimerState を組み立てる。id は一意・seq は登録順（index）で決定的に付与。 */
function buildState(specs: readonly TimerSpec[], extraSeq: number): TimerState {
  const timers: readonly Timer[] = specs.map((spec, index) =>
    createTimer({
      id: `timer-${index}` as TimerId,
      slotId: spec.slotId as SlotId,
      noodleType: spec.noodleType as NoodleType,
      endTime: spec.endTime as EpochMillis,
      seq: index,
    }),
  );
  // nextSeq は既存 seq（0..length-1）と整合し、かつ未使用の余白を持ちうる。
  return { timers, nextSeq: specs.length + extraSeq };
}

/** 0〜maxLength 件の TimerState を生成する。 */
function genStateBounded(maxLength: number): fc.Arbitrary<TimerState> {
  return fc
    .tuple(fc.array(genTimerSpec, { maxLength }), fc.nat({ max: 1000 }))
    .map(([specs, extra]) => buildState(specs, extra));
}

/** 0〜100 件の TimerState（空・単一・上限・同一 endTime 多数を境界として含む）。 */
export const genState: fc.Arbitrary<TimerState> = genStateBounded(MAX_TIMERS);

/** ちょうど指定件数の TimerState。容量上限（100 件）の境界検証に用いる。 */
export function genStateExact(length: number): fc.Arbitrary<TimerState> {
  return fc
    .tuple(fc.array(genTimerSpec, { minLength: length, maxLength: length }), fc.nat({ max: 1000 }))
    .map(([specs, extra]) => buildState(specs, extra));
}

/** Timer 集合（nextAlarmEffect 等、状態ではなく集合を入力に取る関数向け）。 */
export const genTimers: fc.Arbitrary<readonly Timer[]> = genState.map((state) => state.timers);

/**
 * 状態中の endTime 群に対し相対的に now を配置する。ε 境界（endTime == now + ε）を必ずサンプリングし、
 * Property 4（残存最早 > now+ε）・Property 5（冪等性）の境界を踏む。空状態は広域のみ。
 */
export function nowArbFor(state: TimerState): fc.Arbitrary<EpochMillis> {
  const broad = fc.integer({ min: -1000, max: 7000 }).map((n) => n as EpochMillis);
  if (state.timers.length === 0) return broad;
  const endTimes = state.timers.map((t) => t.endTime as number);
  const pick = fc.constantFrom(...endTimes);
  return fc.oneof(
    broad,
    pick.map((e) => e as EpochMillis), // now == endTime → due
    pick.map((e) => (e - EPSILON_MS) as EpochMillis), // endTime == now + ε（境界・due）
    pick.map((e) => (e - EPSILON_MS - 1) as EpochMillis), // endTime == now + ε + 1（残存・境界外）
    pick.map((e) => (e - EPSILON_MS + 1) as EpochMillis), // due 側境界
  );
}

/** 状態と、その状態に対して境界を踏む now の組。 */
export const genStateAndNow: fc.Arbitrary<{ state: TimerState; now: EpochMillis }> = genState.chain((state) =>
  nowArbFor(state).map((now) => ({ state, now })),
);

/** 0 以上のエポックミリ秒（イベントの now として与える）。 */
export const genNow: fc.Arbitrary<EpochMillis> = fc.integer({ min: 0, max: 5_000_000 }).map((n) => n as EpochMillis);
