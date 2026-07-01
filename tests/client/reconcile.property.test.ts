// tests/client/reconcile.property.test.ts — snapshot-broadcast の Property 3〜7。
//
// 検証対象は client の純粋な畳み込み reconcileServerConfirmed（差分による一様残滓）と、その入口である
// decideServerMessage（decideView 経由）の offset 再確立。いずれも WS・DOM・時計・localStorage に触れない
// 純粋関数であり、時刻・受信時刻はすべて引数として運ぶ（workerd 固有機能に依存しない）。
//
// 生成器は本ファイルで完結させ、実 ClientView（lastResults / unitCount / noodlePresets を含む完全形）を
// 生成する。Property 7 だけは snapshot / config / error の三種別を分布する既存 genServerMessage を再利用する。
//
// スロットの前提（現実の不変点）: 1 スロットは高々 1 本の Timer に駆動される（ダブルブッキングしない）。
// 各 Timer 集合内のスロットは互いに素になるよう生成する。これにより「消えた Timer と再占有されない slotId」の
// 対応が一意に定まり、Property 3 の残滓の主張が曖昧にならない（集合間の重なりは occupied にのみ寄与する）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  reconcileServerConfirmed,
  decideView,
  type ClientView,
  type ClientTimer,
} from "../../src/client/connection";
import { clockOffset } from "../../src/client/clock";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import type { TimerFact } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";
import { nonEmpty } from "../nonEmpty";
import { genServerMessage } from "./generators";

// ── 共有プール（衝突・復活・再占有を意図的に誘発する小さなプール） ─────────────────────────────────

/** server-confirmed の id プール（直前ビュー・新 snapshot が共有し、生存/消滅/新出現を誘発する）。 */
const SERVER_ID_POOL = ["s-a", "s-b", "s-c", "s-d", "s-e"] as const;
/** provisional（origin==="local"）専用の id プール。server 側と id 空間を分ける。 */
const LOCAL_ID_POOL = ["l-a", "l-b", "l-c"] as const;
/** processedIds に混ぜる「timers と無関係な id」プール（刈り取り検証用）。 */
const UNRELATED_ID_POOL = ["u-x", "u-y", "u-z"] as const;
/** slotId プール。集合内は互いに素に割り当て、集合間の重なり（占有）は誘発する。 */
const SLOT_POOL = ["0", "1", "2", "3", "4", "5", "6", "7"] as const;
/** 麺種プール。 */
const NOODLE_POOL = ["thin", "thick", "curly", "ramen", "soba", "udon"] as const;

const FIRMNESS_POOL: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

// ── スカラ生成器 ───────────────────────────────────────────────────────────────────────────────

/** endTime / startTime。小さめ範囲で衝突を誘発する（残滓導出は時刻フィールドに依存しない）。 */
const genTime: fc.Arbitrary<number> = fc.integer({ min: -5_000, max: 5_000 });
/** 受信時刻 / serverTime / 残滓記録時刻 at。 */
const genAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10_000_000 });
/** クロックオフセット。負・0・正をまたぐ。 */
const genOffset: fc.Arbitrary<number> = fc.oneof(fc.constant(0), fc.integer({ min: -200_000, max: 200_000 }));
const genFirmness: fc.Arbitrary<Firmness> = fc.constantFrom(...FIRMNESS_POOL);

// ── Timer 集合生成器（集合内スロット互いに素・id 一意） ────────────────────────────────────────────

/**
 * 指定 id プールから、スロットが互いに素な TimerFact 集合を生成する（1 スロット高々 1 本の不変点）。
 * 一意な id 群を引き、共有スロット列の重ならない区間を各 Timer へ割り当てる（多スロット Timer も踏む）。
 */
function genTimerFacts(idPool: readonly string[]): fc.Arbitrary<readonly TimerFact[]> {
  return fc
    .uniqueArray(fc.constantFrom(...idPool), { maxLength: idPool.length })
    .chain((ids) => {
      if (ids.length === 0) return fc.constant<readonly TimerFact[]>([]);
      return fc
        .record({
          // 各 Timer のスロット数（1〜2）。互いに素な区間として共有スロット列から切り出す。
          counts: fc.array(fc.integer({ min: 1, max: 2 }), { minLength: ids.length, maxLength: ids.length }),
          // 集合全体で使う互いに素なスロット列（各 Timer に十分な数を確保）。
          slots: fc.uniqueArray(fc.constantFrom(...SLOT_POOL), {
            minLength: Math.min(ids.length * 2, SLOT_POOL.length),
            maxLength: SLOT_POOL.length,
          }),
          noodles: fc.array(fc.constantFrom(...NOODLE_POOL), { minLength: ids.length, maxLength: ids.length }),
          firmnesses: fc.array(genFirmness, { minLength: ids.length, maxLength: ids.length }),
          startTimes: fc.array(genTime, { minLength: ids.length, maxLength: ids.length }),
          endTimes: fc.array(genTime, { minLength: ids.length, maxLength: ids.length }),
        })
        .map(({ counts, slots, noodles, firmnesses, startTimes, endTimes }): readonly TimerFact[] => {
          const facts: TimerFact[] = [];
          let idx = 0;
          for (let i = 0; i < ids.length; i++) {
            const remaining = slots.length - idx;
            if (remaining <= 0) break; // スロットを使い切ったら以降の Timer は作らない
            const count = Math.min(counts[i]!, remaining);
            const slotSlice = slots.slice(idx, idx + count);
            idx += count;
            facts.push({
              id: ids[i]!,
              slotIds: nonEmpty(slotSlice),
              noodleType: noodles[i]!,
              firmness: firmnesses[i]!,
              startTime: startTimes[i]!,
              endTime: endTimes[i]!,
            });
          }
          return facts;
        });
    });
}

/** 新 snapshot の全量 serverTimers（server-confirmed の id 空間を共有し、生存/新出現を誘発する）。 */
const genServerTimers: fc.Arbitrary<readonly TimerFact[]> = genTimerFacts(SERVER_ID_POOL);

// ── 残滓（lastResults）生成器 ──────────────────────────────────────────────────────────────────

/** 既存の直前結果。占有/非占有どちらのスロットにも載りうる（占有クリアと差分記録の双方を踏む）。 */
const genLastResults: fc.Arbitrary<ReadonlyMap<string, { readonly noodleType: string; readonly at: number }>> = fc
  .array(fc.record({ slot: fc.constantFrom(...SLOT_POOL), noodleType: fc.constantFrom(...NOODLE_POOL), at: genAt }), {
    maxLength: SLOT_POOL.length,
  })
  .map((entries) => new Map(entries.map((e) => [e.slot, { noodleType: e.noodleType, at: e.at }])));

// ── 完全な ClientView 生成器 ───────────────────────────────────────────────────────────────────

/**
 * 実 ClientView を生成する。server-confirmed（互いに素スロット）＋ provisional（別 id 空間・互いに素スロット）を
 * 混在させ、processedIds は timers の id・無関係 id を混ぜる（刈り取り検証）。lastResults は占有/非占有双方を含む。
 */
const genView: fc.Arbitrary<ClientView> = genTimerFacts(SERVER_ID_POOL).chain((serverFacts) =>
  genTimerFacts(LOCAL_ID_POOL).chain((localFacts) => {
    const allIds = [...serverFacts.map((t) => t.id), ...localFacts.map((t) => t.id), ...UNRELATED_ID_POOL];
    return fc
      .record({
        offset: genOffset,
        lastResults: genLastResults,
        processed: fc.uniqueArray(fc.constantFrom(...allIds), { maxLength: allIds.length }),
        connectivity: fc.constantFrom<ClientView["connectivity"]>("up", "down"),
        sync: fc.constantFrom<ClientView["sync"]>("connecting", "synced", "syncFailed"),
        error: fc.oneof(
          fc.constant<ClientView["error"]>(null),
          fc.record({ code: fc.string({ maxLength: 8 }), message: fc.string({ maxLength: 16 }) }),
        ),
        unitCount: fc.integer({ min: 1, max: 4 }),
      })
      .map((r): ClientView => {
        const timers: readonly ClientTimer[] = [
          ...serverFacts.map((t) => ({ ...t, origin: "server" as const })),
          ...localFacts.map((t) => ({ ...t, origin: "local" as const })),
        ];
        return {
          timers,
          offset: r.offset,
          processedIds: new Set(r.processed),
          lastResults: r.lastResults,
          connectivity: r.connectivity,
          sync: r.sync,
          error: r.error,
          unitCount: r.unitCount,
          noodlePresets: DEFAULT_NOODLE_PRESETS,
        };
      });
  }),
);

// ── ヘルパ ─────────────────────────────────────────────────────────────────────────────────────

/** 占有スロット集合 = 新 serverTimers のスロット ∪ 保持 provisional のスロット（reconcile と同一定義）。 */
function occupiedSlots(view: ClientView, serverTimers: readonly TimerFact[]): Set<string> {
  const occupied = new Set<string>();
  for (const t of serverTimers) for (const s of t.slotIds) occupied.add(s);
  for (const t of view.timers) if (t.origin === "local") for (const s of t.slotIds) occupied.add(s);
  return occupied;
}

/** lastResults を key 昇順のエントリ配列へ（順序非依存の比較用）。 */
function sortedResults(
  m: ReadonlyMap<string, { readonly noodleType: string; readonly at: number }>,
): readonly (readonly [string, { readonly noodleType: string; readonly at: number }])[] {
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Firmness を一つ回す（Property 5 の非本質フィールド摂動）。 */
function rotateFirmness(f: Firmness): Firmness {
  const i = FIRMNESS_POOL.indexOf(f);
  return FIRMNESS_POOL[(i + 1) % FIRMNESS_POOL.length]!;
}

/**
 * 残滓導出に効かない非本質フィールド（firmness / startTime / endTime）を摂動し、TimerFact に存在しない
 * 追加フィールドを付与する。id / slotIds / noodleType / origin は不変に保つ。
 */
function polluteFact<T extends TimerFact>(t: T, delta: number): T {
  return {
    ...t,
    firmness: rotateFirmness(t.firmness),
    startTime: t.startTime + delta,
    endTime: t.endTime + delta,
    // TimerFact に無い追加フィールド（純粋差分がこれらに依存しないことを示す）。
    residualIrrelevantTag: "pollute",
    residualIrrelevantCount: delta,
  } as unknown as T;
}

const NUM_RUNS = 200;

describe("client/connection reconcileServerConfirmed — snapshot-broadcast Property 3〜7", () => {
  // Feature: snapshot-broadcast, Property 3: 残滓の一様性
  // 連続 2 snapshot 間で消えた任意の Timer t（理由を問わない）について、再占有されない各 slotId に
  // lastResults[slotId].noodleType === t.noodleType かつ .at === at。**Validates: Requirements 4.2, 5.1**
  it("Property 3: 残滓の一様性 — 消えた Timer の麺種が再占有されない各 slotId に一様に残る", () => {
    fc.assert(
      fc.property(genView, genServerTimers, genAt, (view, serverTimers, at) => {
        const result = reconcileServerConfirmed(view, serverTimers, at);
        const newIds = new Set(serverTimers.map((t) => t.id));
        const occupied = occupiedSlots(view, serverTimers);

        // 直前 server-confirmed に在り新 serverTimers に無い Timer（消えた Timer）。
        for (const t of view.timers) {
          if (t.origin !== "server" || newIds.has(t.id)) continue;
          for (const slotId of t.slotIds) {
            if (occupied.has(slotId)) continue; // 再占有スロットは残滓を持たない（Property 4 の領域）
            const entry = result.lastResults.get(slotId);
            expect(entry).toBeDefined();
            expect(entry!.noodleType).toBe(t.noodleType);
            expect(entry!.at).toBe(at);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: snapshot-broadcast, Property 4: 残滓のクリア
  // 新 snapshot（＋保持 provisional）が占有する任意の slotId に lastResults エントリは存在しない。
  // **Validates: Requirements 4.3, 5.3**
  it("Property 4: 残滓のクリア — 占有される slotId には残滓が存在しない", () => {
    fc.assert(
      fc.property(genView, genServerTimers, genAt, (view, serverTimers, at) => {
        const result = reconcileServerConfirmed(view, serverTimers, at);
        for (const slotId of occupiedSlots(view, serverTimers)) {
          expect(result.lastResults.has(slotId)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: snapshot-broadcast, Property 5: 純粋差分（新フィールド不要）
  // reconcileServerConfirmed の残滓（lastResults）と processedIds は (直前 server-confirmed, 新 serverTimers, at)
  // のみの関数であり、TimerFact の追加フィールドや非本質フィールド（firmness/startTime/endTime）に依存しない。
  // **Validates: Requirements 4.6**
  it("Property 5: 純粋差分 — 残滓と processedIds は TimerFact の追加/非本質フィールドに依存しない", () => {
    fc.assert(
      fc.property(genView, genServerTimers, genAt, fc.integer({ min: -1_000, max: 1_000 }), (view, serverTimers, at, delta) => {
        const baseline = reconcileServerConfirmed(view, serverTimers, at);

        // id / slotIds / noodleType / origin を保ったまま、非本質フィールドを摂動し追加フィールドを付与する。
        const pollutedView: ClientView = {
          ...view,
          timers: view.timers.map((t) => polluteFact(t, delta)),
        };
        const pollutedServerTimers = serverTimers.map((t) => polluteFact(t, delta));
        const polluted = reconcileServerConfirmed(pollutedView, pollutedServerTimers, at);

        // 残滓（キー・麺種・記録時刻）は不変。
        expect(sortedResults(polluted.lastResults)).toEqual(sortedResults(baseline.lastResults));
        // processedIds の刈り取り結果も不変。
        expect([...polluted.processedIds].sort()).toEqual([...baseline.processedIds].sort());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: snapshot-broadcast, Property 6: 冪等性
  // 同一 serverTimers を二度適用すると timers・processedIds は不変、lastResults はキー集合不変（at 更新のみ）で
  // 新規残滓を生じない。**Validates: Requirements 4.5**
  it("Property 6: 冪等性 — 同一 serverTimers の二度適用で timers・processedIds・残滓が不変", () => {
    fc.assert(
      fc.property(genView, genServerTimers, genAt, (view, serverTimers, at) => {
        const once = reconcileServerConfirmed(view, serverTimers, at);
        const twice = reconcileServerConfirmed(once, serverTimers, at);

        // timers（順序含む）は不変。
        expect(twice.timers).toEqual(once.timers);
        // processedIds は不変。
        expect([...twice.processedIds].sort()).toEqual([...once.processedIds].sort());
        // lastResults はキー集合不変・新規残滓なし・値（麺種/at）も不変。
        expect([...twice.lastResults.keys()].sort()).toEqual([...once.lastResults.keys()].sort());
        expect(sortedResults(twice.lastResults)).toEqual(sortedResults(once.lastResults));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: snapshot-broadcast, Property 7: offset 再確立
  // snapshot / config / error の受信ごとに offset = clockOffset(serverTime, receivedAt) が更新される。
  // decideServerMessage は decideView の Server 分岐から呼ばれる唯一の入口。**Validates: Requirements 2.5**
  it("Property 7: offset 再確立 — snapshot/config/error のいずれの受信でも offset が更新される", () => {
    fc.assert(
      fc.property(genView, genServerMessage, genAt, (view, message, receivedAt) => {
        const result = decideView(view, { kind: "Server", message, receivedAt });
        expect(result.offset).toBe(clockOffset(message.serverTime, receivedAt));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
