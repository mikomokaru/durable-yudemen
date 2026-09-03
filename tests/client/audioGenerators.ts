// tests/client/audioGenerators.ts — audio-cues 純粋層（src/client/audioCue.ts）の Property テストが共有する生成器。
//
// 既存 tests/client/generators.ts の genClientView / genClientTimer を再利用し、音声キュー判定の入力空間
// （boiled 集合導出・Pre_Alert 閾値クロス・Done_Cue 周期到来）に合わせて拡張する。設計 design.md
// 「生成器の前提（すべてのプロパティが共有する入力空間）」を満たすよう、次を構造的にサンプリングできること:
//   - 担当内/担当外をまたぐ slotIds（units の変化で同じ slotIds が被担当/非担当の双方に転ぶ）
//   - 過去/現在/未来に広がる endTime と、負/0/正の offset
//   - 境界 endTime == correctedNow（remaining = 0）と remaining == 閾値（60s）、およびその ±1
//   - 同一 timerId の重複出現（複数 boiled スロット）
//   - PreAlertWatch を畳み込む単調増加 now 列（開始・閾値クロス・boiled 化・done/cancel 除去を踏む）
//
// 検証対象の純粋関数は ClientView（src/client/connection.ts の公開型）を受ける assignedSlotDisplays を
// 組み合わせる。genClientView がその公開型をそのまま生成するため、本ファイルは boiled 導出に効かない次元を
// 既定へ固定するだけに留める（型の写し替えは要らない）。

import * as fc from "fast-check";
import { genClientView, genClientTimer } from "./generators";
import type { ClientTimer, ClientView } from "../../src/client/connection";
import type { SlotDisplay } from "../../src/client/components/slotDisplay";
import type { TimerFact, NonEmptyArray } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";
import { DONE_CUE_INTERVAL_MS } from "../../src/client/audioCue";
import type { PreAlertWatch } from "../../src/client/audioCue";
import { DEFAULT_NOODLE_PRESETS, DEFAULT_UNIT_COUNT } from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";

// ── 共有プール ──────────────────────────────────────────────────────────────────────────────────

/** timerId プール（boiled 表示・PreAlertWatch・TimerFact 間で衝突と重複を誘発する小さめプール）。 */
const TIMER_ID_POOL = ["t-a", "t-b", "t-c", "t-d"] as const;
/** ビューに存在しない timerId プール（PreAlertWatch に混ぜて記録破棄＝刈り取りを誘発する）。 */
const ABSENT_ID_POOL = ["t-absent-1", "t-absent-2"] as const;
/** slotId プール。unit 0(=slot 0..5) / unit 1(=slot 6..11) / unit 2(=slot 12..17) を跨ぐ。 */
const SLOT_ID_POOL = ["0", "3", "6", "9", "12", "15"] as const;
const NOODLE_POOL = ["thin", "thick", "curly", "ramen", "soba", "udon"] as const;
const FIRMNESS_POOL: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

/** クロックオフセット。負・0・正をまたぐ。 */
const genOffsetValue: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -200_000, max: 200_000 }),
);

/** 非空のスロット集合（NonEmptyArray<string>）。担当内外を跨ぐ小さめプールの非空部分集合。 */
const genSlotIds: fc.Arbitrary<NonEmptyArray<string>> = fc
  .subarray([...SLOT_ID_POOL], { minLength: 1 })
  .map((slots) => nonEmpty(slots));

// ── 担当ユニット集合 ───────────────────────────────────────────────────────────────────────────

/**
 * 担当ユニット集合 — 空・単一・複数・総数超の窓を含む。0..4 の小さめ非負整数。
 * units が 0 を含むか否かで同じ slotIds が被担当/非担当に転ぶため、担当内外の双方を構造的に踏む。
 */
export const genUnits: fc.Arbitrary<readonly number[]> = fc.uniqueArray(
  fc.integer({ min: 0, max: 4 }),
  {
    maxLength: 5,
  },
);

// ── ClientView 生成器（音声キューの入力空間へ絞った差分） ────────────────────────────────────────

/**
 * 音声キュー判定の入力となる ClientView。generators.ts の genClientView（公開型 ClientView をそのまま生成する）
 * を土台に、boiled 導出に効かない次元だけを既定へ固定して生成の分散を本質（timers / offset / now / units）へ集める。
 *
 * 固定するのは待ち行列・推奨・残滓・ユニット総数・麺種プリセット。いずれも assignedSlotDisplays の boiled 導出に
 * 現れないため、振らせても検証の強さは増えず探索空間だけが広がる。
 */
export const genAudioView: fc.Arbitrary<ClientView> = genClientView.map((view): ClientView => ({
  ...view,
  pendingOrders: [],
  recommendations: [],
  unreachableReason: "offline",
  lastResults: new Map(),
  unitCount: DEFAULT_UNIT_COUNT,
  noodlePresets: DEFAULT_NOODLE_PRESETS,
}));

/**
 * 現在時刻 now — view.offset と endTime 群に対し remaining の境界を踏む。
 * remaining = max(0, endTime - (now + offset)) ゆえ、now = endTime - offset で remaining = 0（boiled 境界）、
 * now = endTime - offset - 60000 で remaining = 閾値。すべて過去（全 boiled）/すべて未来（全 running）も含める。
 */
function genNowForView(view: ClientView): fc.Arbitrary<number> {
  const offset = view.offset;
  const broad = fc.integer({ min: -300_000, max: 300_000 });
  if (view.timers.length === 0) return broad;
  const ends = view.timers.map((t) => t.endTime);
  const pick = fc.constantFrom(...ends);
  return fc.oneof(
    broad,
    pick.map((e) => e - offset), // remaining = 0（境界・boiled）
    pick.map((e) => e - offset + 1), // 過去へ 1（boiled）
    pick.map((e) => e - offset - 1), // remaining = 1（running）
    pick.map((e) => e - offset - 60_000), // remaining = 閾値（60s）
    pick.map((e) => e - offset - 60_001), // 閾値直上
    pick.map((e) => e - offset - 59_999), // 閾値直下
    fc.constant(Math.max(...ends) - offset + 1000), // すべて過去 → 全 boiled
    fc.constant(Math.min(...ends) - offset - 120_000), // すべて未来 → 全 running
  );
}

/** view + 担当ユニット + 境界を踏む now の組（P1 / P5 が共有する基本ケース）。 */
export const genAudioCase: fc.Arbitrary<{
  view: ClientView;
  units: readonly number[];
  now: number;
}> = fc
  .record({ view: genAudioView, units: genUnits })
  .chain(({ view, units }) => genNowForView(view).map((now) => ({ view, units, now })));

// ── PreAlertWatch / lastRingAt 生成器 ──────────────────────────────────────────────────────────

const genIdSet: fc.Arbitrary<ReadonlySet<string>> = fc
  .subarray([...TIMER_ID_POOL, ...ABSENT_ID_POOL])
  .map((ids) => new Set<string>(ids));

/** 任意の観測位相。armed / alerted は重なりうる（advancePreAlert は alerted を優先するため不変性は崩れない）。 */
export const genPreAlertWatch: fc.Arbitrary<PreAlertWatch> = fc.record({
  armed: genIdSet,
  alerted: genIdSet,
});

/** 前回 Done_Cue 鳴動時刻。null（未鳴動）と具体値の双方。 */
export const genLastRingAt: fc.Arbitrary<number | null> = fc.option(
  fc.integer({ min: -300_000, max: 300_000 }),
  {
    nil: null,
  },
);

/** P1 の評価ケース — 基本ケースに観測位相・前回鳴動時刻・interval を足す。 */
export const genEvalCase: fc.Arbitrary<{
  view: ClientView;
  units: readonly number[];
  now: number;
  watch: PreAlertWatch;
  lastRingAt: number | null;
}> = genAudioCase.chain((base) =>
  fc
    .record({ watch: genPreAlertWatch, lastRingAt: genLastRingAt })
    .map(({ watch, lastRingAt }) => ({
      view: base.view,
      units: base.units,
      now: base.now,
      watch,
      lastRingAt,
    })),
);

// ── 担当 Timer 群（advancePreAlert の直接入力・id 一意） ─────────────────────────────────────────

/** id 一意な担当 Timer 群（TimerFact）。genClientTimer を再利用し、id 一意化のみ追加で課す。 */
export const genAssignedTimers: fc.Arbitrary<readonly ClientTimer[]> = fc.uniqueArray(
  genClientTimer,
  {
    selector: (t) => t.id,
    maxLength: TIMER_ID_POOL.length,
  },
);

/**
 * 単調増加 now 列 — 与えた Timer 群と offset に対し、remaining が 閾値超 → 0 まで降りるよう範囲を張る。
 * 昇順ソート済み。Pre_Alert の armed → 発火、boiled 化（remaining 0）までを列として踏む。
 */
function genMonotonicNowStream(
  timers: readonly TimerFact[],
  offset: number,
): fc.Arbitrary<readonly number[]> {
  if (timers.length === 0) {
    return fc
      .array(fc.integer({ min: -100_000, max: 100_000 }), { minLength: 1, maxLength: 8 })
      .map((xs) => [...xs].sort((a, b) => a - b));
  }
  const ends = timers.map((t) => t.endTime);
  const lo = Math.min(...ends) - offset - 120_000; // remaining > 閾値（armed 成立）
  const hi = Math.max(...ends) - offset + 60_000; // remaining = 0（boiled 化）
  return fc
    .array(fc.integer({ min: lo, max: hi }), { minLength: 1, maxLength: 10 })
    .map((xs) => [...xs].sort((a, b) => a - b));
}

/** P2 の畳み込みケース — 固定の担当 Timer 群・offset・単調増加 now 列。 */
export const genPreAlertFold: fc.Arbitrary<{
  assigned: readonly ClientTimer[];
  offset: number;
  stream: readonly number[];
}> = fc
  .record({ assigned: genAssignedTimers, offset: genOffsetValue })
  .chain(({ assigned, offset }) =>
    genMonotonicNowStream(assigned, offset).map((stream) => ({ assigned, offset, stream })),
  );

/**
 * P3 のステップ列 — 担当集合がステップごとに変動する（部分集合・空を含む）。
 * 各ステップで assigned から消えた timerId が次位相から脱落することを検証するための入力。
 */
export const genPreAlertSteps: fc.Arbitrary<{
  offset: number;
  steps: readonly { assigned: readonly ClientTimer[]; now: number }[];
}> = genAssignedTimers.chain((pool) =>
  fc.record({
    offset: genOffsetValue,
    steps: fc.array(
      fc.record({
        assigned: fc.subarray([...pool]), // 部分集合（空を含む）。id 一意性は pool から継承
        now: fc.integer({ min: -200_000, max: 200_000 }),
      }),
      { minLength: 1, maxLength: 8 },
    ),
  }),
);

// ── SlotDisplay[] 生成器（dueDoneCue / boiledTimerIds の直接入力・P4） ─────────────────────────────

/** TimerFact 一件。id は小さなプールから引き、boiled 表示の重複出現（複数 boiled スロット）を誘発する。 */
const genTimerFact: fc.Arbitrary<TimerFact> = fc.record({
  id: fc.constantFrom(...TIMER_ID_POOL),
  slotIds: genSlotIds,
  noodleType: fc.constantFrom(...NOODLE_POOL),
  firmness: fc.constantFrom(...FIRMNESS_POOL),
  startTime: fc.integer({ min: -5_000, max: 5_000 }),
  endTime: fc.integer({ min: -5_000, max: 5_000 }),
});

const genSlot: fc.Arbitrary<number> = fc.integer({ min: 0, max: 20 });

const genBoiledDisplay: fc.Arbitrary<SlotDisplay> = fc.record({
  kind: fc.constant("boiled" as const),
  slot: genSlot,
  timer: genTimerFact,
  overdueMs: fc.integer({ min: 0, max: 100_000 }),
});

const genRunningDisplay: fc.Arbitrary<SlotDisplay> = fc.record({
  kind: fc.constant("running" as const),
  slot: genSlot,
  timer: genTimerFact,
  remainingMs: fc.integer({ min: 1, max: 1_800_000 }),
  unconfirmed: fc.boolean(),
});

const genIdleDisplay: fc.Arbitrary<SlotDisplay> = fc.record({
  kind: fc.constant("idle" as const),
  slot: genSlot,
  next: fc.constant(null),
});
const genUnreceivedDisplay: fc.Arbitrary<SlotDisplay> = fc.record({
  kind: fc.constant("unreceived" as const),
  slot: genSlot,
});

const genDisplay: fc.Arbitrary<SlotDisplay> = fc.oneof(
  genBoiledDisplay,
  genRunningDisplay,
  genIdleDisplay,
  genUnreceivedDisplay,
);

/** SlotDisplay[] — running/boiled/idle/unreceived が混在。boiled の重複 timerId・複数件同時 boiled を含む。 */
export const genDisplays: fc.Arbitrary<readonly SlotDisplay[]> = fc.array(genDisplay, {
  maxLength: 12,
});

/** P4 の Done_Cue ケース — 表示集合・now・前回鳴動時刻・interval（既定 5s と任意値）。 */
export const genDoneCueCase: fc.Arbitrary<{
  displays: readonly SlotDisplay[];
  now: number;
  lastRingAt: number | null;
  interval: number;
}> = fc.record({
  displays: genDisplays,
  now: fc.integer({ min: -300_000, max: 300_000 }),
  lastRingAt: genLastRingAt,
  interval: fc.oneof(fc.constant(DONE_CUE_INTERVAL_MS), fc.integer({ min: 1, max: 20_000 })),
});
