// tests/client/degraded-slot-superimposition.display.property.test.ts — Property 4（解決後は隠れが存在しない）。
//
// 観測点が他の Property 群と違う。3.2 / 3.3 / 3.4 は reconcileServerConfirmed 単体（真理値表・保存・刈り取り）を
// 見るが、ここは**遷移の結果 × 表示導出の突き合わせ**である——`reconcileServerConfirmed` の結果ビューを
// `assignedSlotDisplays` に通し、「在席しているのに表示されない Timer」が 1 本も無いことを主張する。ゆえに
// 別ファイルへ置く（`tests/client/reconcile.property.test.ts` にも置かない——あちらは snapshot-broadcast の
// Property 群の場所である）。
//
// 表示規則は変えていない（`design.md`「変更しないもの」）。走行中（remaining > 0）を先に絞り、その区分内で
// 最早 `endTime`——走行中が無いときだけ boiled の最早 `endTime` を採る。**「最早 endTime が勝つ」ではない。**
// 本 Property が主張するのは規則の中身ではなく、**在席が高々 1 本になったので隠れる相手が存在しない**ことである。
//
// ── 書かれた前提（premise。暗黙の生成器都合にしない） ────────────────────────────────────────
//
// 入力は **server 起源同士のスロット重なりを含まない**。統一規則が解くのは server 側 × local 側の争いだけで、
// server 起源 2 本の同一スロット在席は規則の外にあって解決後も残る（限界 4）。engine は start 時に釜の占有を
// 検査しないため snapshot はこの形を運べる（`tests/client/complete.example.test.ts` の `timerAt("A","0")` /
// `timerAt("B","0")` が実例）。**この前提を落とすと、テストは意図した実装に対して失敗する。**
// 生成器は既存 `genTimerFacts`（reconcile.property.test.ts）と同じ規律で**各集合内のスロットを互いに素**に保ち、
// 重なりを集合間だけに誘発する。local 起源同士も同じ理由で互いに素に保つ（規則は local × local も解かない）。
// 前提が生成器の内側で守られていることは、Property 本体でも `hasSlotOverlapWithin` で検査に固定する。
//
// ── 除外は 2 つ。両方を明示的に扱う（どちらも既知の限界ゆえ、暗黙にすると限界が検査から消えて読めなくなる） ──
//
//   限界 1: **両側 running の残余** — 規則が決着させないため 1 スロットに 2 本が残る。当該スロットは主張から
//           除く（`contestedSlots` が解決**前**の集合から同定する。規則が「決着させなかったスロット」を語るのは
//           解決前の主張であって、解決後の生存者ではない）。
//   限界 4: **server 起源同士のスロット重なり** — 上の書かれた前提で入力から排除する。
//
// 担当射影の扱い: `slotsOfUnits` が実際に覆うスロットだけを生成に用いる。覆っていないスロットの Timer を混ぜると
// `assignedTimers` の射影が黙って落とし、それを「隠れ」と読み違える（射影による不在と、表示規則による隠れは別概念）。
// この制約も Property 本体で検査に固定する。
//
// 純粋層ゆえ `Date.now` のスタブ・`vi.useFakeTimers()` は用いない。時刻（`at`）とオフセット（`offset`）は
// すべて生成器から引数として渡す。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  reconcileServerConfirmed,
  type ClientTimer,
  type ClientView,
} from "../../src/client/connection";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import { correctedNow, remainingMs } from "../../src/client/clock";
import { slotsOfUnits } from "../../src/client/assignment";
import { DEFAULT_NOODLE_PRESETS, slotOf } from "../../src/domain/store";
import type { TimerFact } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";
import { nonEmpty } from "../nonEmpty";

// ── プール（衝突・部分重なり・running/boiled の組み合わせを意図的に誘発する小さなプール） ──────────

/** 直前ビューの server-confirmed 用 id プール。新 serverTimers と id 空間を共有し生存/消滅を誘発する。 */
const SERVER_ID_POOL = ["s-a", "s-b", "s-c"] as const;
/** provisional（origin==="local"）専用の id プール。server 側と id 空間を分ける。 */
const LOCAL_ID_POOL = ["l-a", "l-b", "l-c"] as const;
const NOODLE_POOL = ["Thin", "Medium", "Thick"] as const;
const FIRMNESS_POOL: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

/**
 * 生成に使うスロット数。集合間の重なりを高い確率で誘発するため、id 数（3）に対して狭く取る。
 *
 * 広く取れば重なりが稀になり、除外すべき contested にも到達しなくなる（争いを踏まない検査は限界 1 を語れない）。
 */
const SLOT_POOL_SIZE = 5;

// ── スカラ生成器 ───────────────────────────────────────────────────────────────────────────────

/** 担当ユニット集合。unit u は slot 6u..6u+5 を覆う（`slotsOfUnits` が正本）。単一/複数・非 0 起点を踏む。 */
const genUnits: fc.Arbitrary<readonly number[]> = fc.constantFrom<readonly number[]>(
  [0],
  [1],
  [0, 1],
  [1, 2],
);
/** 残滓記録時刻・表示時刻に用いる生のローカル時計の読み。 */
const genAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10_000_000 });
/** クロックオフセット。負・0・正をまたぐ（補正後時刻と生の読みの取り違えを検査に露出させる）。 */
const genOffset: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -200_000, max: 200_000 }),
);
/** 同期フェーズ。在席 0 件のときの表示が idle（synced）と unreceived（未同期）へ分かれる元。 */
const genSync: fc.Arbitrary<ClientView["sync"]> = fc.constantFrom(
  "connecting",
  "synced",
  "syncFailed",
);
const genFirmness: fc.Arbitrary<Firmness> = fc.constantFrom(...FIRMNESS_POOL);

/**
 * `endTime` を補正後現在時刻からの相対で振る。running / boiled の双方と**境界（差 0）**を必ず踏む。
 *
 * 境界は boiled 側に属する（`remainingMs` が 0 を返す）。絶対時刻で振ると境界に当たる確率がほぼ 0 になるため、
 * 相対で振って 0 を定数として混ぜる。
 */
const genEndDelta: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -120_000, max: -1 }),
  fc.integer({ min: 1, max: 120_000 }),
);

// ── 生成器の補助 ───────────────────────────────────────────────────────────────────────────────

/**
 * 担当ユニット集合が実際に覆うスロットから、生成に使う slotId プールを切り出す。
 *
 * 覆われていないスロットを混ぜない理由は本ファイル冒頭のとおり——`assignedTimers` の射影が落とした不在を
 * 「隠れ」と読み違えないためである。
 */
function assignedSlotPool(units: readonly number[]): readonly string[] {
  return [...slotsOfUnits(units)]
    .sort((a, b) => a - b)
    .slice(0, SLOT_POOL_SIZE)
    .map(String);
}

/**
 * 指定 id プールから、**スロットが互いに素**な TimerFact 集合を生成する（書かれた前提の実装）。
 *
 * 一意な id 群を引き、共有スロット列の重ならない区間を各 Timer へ割り当てる（多スロット Timer の部分重なりも
 * 集合間では踏む）。`endTime` は補正後現在時刻 `correctedNowMs` からの相対で決め、running / boiled / 境界を振る。
 */
function genTimerFacts(
  idPool: readonly string[],
  slotPool: readonly string[],
  correctedNowMs: number,
): fc.Arbitrary<readonly TimerFact[]> {
  return fc.uniqueArray(fc.constantFrom(...idPool), { maxLength: idPool.length }).chain((ids) => {
    if (ids.length === 0) return fc.constant<readonly TimerFact[]>([]);
    return fc
      .record({
        // 各 Timer のスロット数（1〜2）。互いに素な区間として共有スロット列から切り出す。
        counts: fc.array(fc.integer({ min: 1, max: 2 }), {
          minLength: ids.length,
          maxLength: ids.length,
        }),
        slots: fc.uniqueArray(fc.constantFrom(...slotPool), {
          minLength: Math.min(ids.length, slotPool.length),
          maxLength: slotPool.length,
        }),
        noodles: fc.array(fc.constantFrom(...NOODLE_POOL), {
          minLength: ids.length,
          maxLength: ids.length,
        }),
        firmnesses: fc.array(genFirmness, { minLength: ids.length, maxLength: ids.length }),
        endDeltas: fc.array(genEndDelta, { minLength: ids.length, maxLength: ids.length }),
      })
      .map(({ counts, slots, noodles, firmnesses, endDeltas }): readonly TimerFact[] => {
        const facts: TimerFact[] = [];
        let idx = 0;
        for (let i = 0; i < ids.length; i++) {
          const remaining = slots.length - idx;
          if (remaining <= 0) break; // スロットを使い切ったら以降の Timer は作らない（互いに素を崩さない）
          const count = Math.min(counts[i]!, remaining);
          const slotSlice = slots.slice(idx, idx + count);
          idx += count;
          const endTime = correctedNowMs + endDeltas[i]!;
          facts.push({
            id: ids[i]!,
            slotIds: nonEmpty(slotSlice),
            noodleType: noodles[i]!,
            firmness: firmnesses[i]!,
            startTime: endTime - 60_000,
            endTime,
            orderItem: null,
          });
        }
        return facts;
      });
  });
}

// ── シナリオ生成器 ─────────────────────────────────────────────────────────────────────────────

/** Property 4 の入力一式。ビュー・担当ユニット集合・新 serverTimers・受信時刻を 1 つの事実として運ぶ。 */
interface DisplayScenario {
  readonly units: readonly number[];
  readonly view: ClientView;
  readonly serverTimers: readonly TimerFact[];
  /** 生のローカル時計の読み。`reconcileServerConfirmed` の `at` と表示時刻の双方に渡す。 */
  readonly at: number;
}

const genScenario: fc.Arbitrary<DisplayScenario> = fc
  .record({ units: genUnits, at: genAt, offset: genOffset, sync: genSync })
  .chain(({ units, at, offset, sync }) => {
    const slotPool = assignedSlotPool(units);
    const correctedNowMs = correctedNow(offset, at);
    return fc
      .record({
        // 直前ビューの server-confirmed。結果の server 集合は新 serverTimers で全置換されるため主張には
        // 効かないが、「populated なビューからの遷移」という実際の形を保つために生成する。
        prevServer: genTimerFacts(SERVER_ID_POOL, slotPool, correctedNowMs),
        serverTimers: genTimerFacts(SERVER_ID_POOL, slotPool, correctedNowMs),
        provisional: genTimerFacts(LOCAL_ID_POOL, slotPool, correctedNowMs),
      })
      .map(({ prevServer, serverTimers, provisional }): DisplayScenario => {
        const timers: readonly ClientTimer[] = [
          ...prevServer.map((timer) => ({ ...timer, origin: "server" as const })),
          ...provisional.map((timer) => ({ ...timer, origin: "local" as const })),
        ];
        return {
          units,
          serverTimers,
          at,
          view: {
            timers,
            // 待ち行列・推奨・残滓・処理済み記録は在席と表示の突き合わせに関与しない（表示は timers と
            // sync だけから導出される）。空に据えて、主張の対象を在席と表示に絞る。
            pendingOrders: [],
            recommendations: [],
            offset,
            processedIds: new Set<string>(),
            lastResults: new Map<string, { readonly noodleType: string; readonly at: number }>(),
            connectivity: "down",
            unreachableReason: "offline",
            sync,
            error: null,
            unitCount: 4,
            noodlePresets: DEFAULT_NOODLE_PRESETS,
          },
        };
      });
  });

// ── ヘルパ ─────────────────────────────────────────────────────────────────────────────────────

/** 集合内にスロットの重なりがあるか（書かれた前提を検査に固定するための述語）。 */
function hasSlotOverlapWithin(timers: readonly TimerFact[]): boolean {
  const seen = new Set<string>();
  for (const timer of timers) {
    for (const slotId of timer.slotIds) {
      if (seen.has(slotId)) return true;
      seen.add(slotId);
    }
  }
  return false;
}

/**
 * 統一規則が決着させなかったスロット（両側 running・限界 1）を、**解決前**の集合から同定する。
 *
 * 解決後の生存者から逆算しない。多スロット Timer は別のスロットでの敗北で丸ごと落ちうるため（判断 4 / 5）、
 * 解決後に 1 本しか居ないスロットが「決着した」のか「争いの片方が別件で落ちた」のかを区別できない。
 * 規則が何を決着させなかったかは、規則の入力（解決前の主張）だけが語れる。
 */
function contestedSlots(
  provisional: readonly ClientTimer[],
  serverTimers: readonly TimerFact[],
  correctedNowMs: number,
): ReadonlySet<number> {
  // running / boiled は endTime からの導出。判定は clock.ts の remainingMs を通し、素の比較を書き下さない
  // （補正は呼び出し元で済んでいるゆえ残りの offset は 0。境界 endTime === correctedNow は boiled 側）。
  const isRunning = (timer: TimerFact): boolean =>
    remainingMs(timer.endTime, 0, correctedNowMs) > 0;
  const serverRunning = new Set<number>();
  const localRunning = new Set<number>();
  for (const timer of serverTimers) {
    if (!isRunning(timer)) continue;
    for (const slotId of timer.slotIds) serverRunning.add(slotOf(slotId));
  }
  for (const timer of provisional) {
    if (!isRunning(timer)) continue;
    for (const slotId of timer.slotIds) localRunning.add(slotOf(slotId));
  }
  const contested = new Set<number>();
  for (const slot of serverRunning) {
    if (localRunning.has(slot)) contested.add(slot);
  }
  return contested;
}

const NUM_RUNS = 200;

describe("client/connection × slotDisplay — degraded-slot-superimposition Property 4", () => {
  // Feature: degraded-slot-superimposition, Property 4: 解決後は隠れが存在しない（在席と表示が一致する）
  // **Validates: Requirements 2.4, 3.5**
  //
  // 前提（書かれた premise）: 入力は server 起源同士のスロット重なりを含まない（限界 4。規則が解くのは
  // server 側 × local 側だけであり、server 起源 2 本の同一スロット在席は解決後も残る）。生成器は各集合内の
  // スロットを互いに素に保ち、重なりを集合間だけに誘発する。
  //
  // 主張: 上の前提を満たす任意のビューと任意の担当ユニット集合について、`reconcileServerConfirmed` の結果
  // ビューにおいて、**両側 running の争いを含まない**各 slotId の在席 Timer は高々 1 件であり、
  // `assignedSlotDisplays` が当該スロットに返す表示は（在席 1 件なら）その Timer を指し、（在席 0 件なら）
  // idle または unreceived になる。すなわち在席しているのに表示されない Timer が存在しない。
  it("Property 4: 解決後の各スロットは在席が高々 1 件で、表示はその在席を指す（隠れが 1 本も無い）", () => {
    fc.assert(
      fc.property(genScenario, ({ units, view, serverTimers, at }) => {
        const provisional = view.timers.filter((timer) => timer.origin === "local");

        // 書かれた前提の固定 — 生成器が premise を守っていることを主張に含める。ここが緑でないと、
        // 以下の主張は「規則の外の入力」に対する主張になってしまい、意味を失う。
        expect(hasSlotOverlapWithin(serverTimers)).toBe(false);
        expect(hasSlotOverlapWithin(provisional)).toBe(false);

        const result = reconcileServerConfirmed(view, serverTimers, at);
        const correctedNowMs = correctedNow(view.offset, at);
        // 除外（限界 1）— 規則が決着させなかったスロットは解決前の主張から同定する。
        const contested = contestedSlots(provisional, serverTimers, correctedNowMs);

        // 表示は解決結果に対して導出する。時刻は生のローカル読み `at` を渡す——`assignedSlotDisplays` は
        // 内部で correctedNow(view.offset, now) を掛けるため、解決が使った補正後時刻と同じ瞬間になる
        // （補正後時刻をそのまま渡すと offset が二重に足される）。
        const displays = assignedSlotDisplays(result, units, at, []);
        const displayedSlots = new Set(displays.map((display) => display.slot));

        // 担当射影が黙って落としていないこと — 在席する全 Timer の全スロットが表示対象に含まれる。
        // これが崩れると「射影による不在」を「表示規則による隠れ」と読み違える。
        for (const timer of result.timers) {
          for (const slotId of timer.slotIds) {
            expect(displayedSlots.has(slotOf(slotId))).toBe(true);
          }
        }

        for (const display of displays) {
          // 限界 1（両側 running の残余）— 規則が決着させないため 1 スロット 2 本が残る。主張から除く。
          if (contested.has(display.slot)) continue;

          const occupants = result.timers.filter((timer) =>
            timer.slotIds.some((slotId) => slotOf(slotId) === display.slot),
          );
          // 不変条件（1 スロット ≤ 1 タイマー）。多スロット Timer の連鎖でスロットが空になることは許す。
          expect(occupants.length).toBeLessThanOrEqual(1);

          const occupant = occupants[0];
          if (occupant === undefined) {
            // 在席 0 件 — 同期済みなら idle、未同期（connecting / syncFailed）なら unreceived。
            expect(display.kind === "idle" || display.kind === "unreceived").toBe(true);
            continue;
          }
          // 在席 1 件 — 表示はその在席を指す（running か boiled のいずれか。区分の切り分けは表示規則の
          // 関心事であり、ここが主張するのは「指す先が在席と一致する」ことだけである）。
          expect(display.kind === "running" || display.kind === "boiled").toBe(true);
          if (display.kind === "running" || display.kind === "boiled") {
            expect(display.timer.id).toBe(occupant.id);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
