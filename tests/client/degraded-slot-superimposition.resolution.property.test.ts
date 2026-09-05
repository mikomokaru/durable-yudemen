// tests/client/degraded-slot-superimposition.resolution.property.test.ts
// degraded-slot-superimposition の Property 3 / 6 / 7 — 占有解決（統一規則）を reconcileServerConfirmed 越しに検べる。
//
// 検証対象は client の純粋な畳み込み reconcileServerConfirmed である。解決規則そのもの（resolveSlotOccupancy）は
// 非公開ゆえ、公開されている畳み込みを唯一の入口として観測する（design.md 判断 8「別モジュールに出さない理由」）。
// WS・DOM・時計・localStorage に触れず、時刻はすべて引数として運ぶ（Date.now のスタブも偽時計も用いない）。
//
// **なぜ補正後時刻を生成の起点に据えるか。** 解決が使う時刻は correctedNow(view.offset, at) ＝ at + offset である。
// running / boiled の切り分けは endTime とこの値の比較だけで決まるため、境界（endTime === correctedNow）を狙うには
// この合成値を直接押さえる必要がある。ゆえに correctedNowMs と offset を生成し、at = correctedNowMs - offset を導く。
// offset を 0 以外にも振ることで「補正が効いていること」も同時に踏む。
//
// **なぜ集合内のスロット重なりを許すか。** reconcile.property.test.ts の genTimerFacts は各集合内のスロットを
// 互いに素に保つ（残滓の対応を一意にするため）。本ファイルは逆に、同一起源同士の重なり（1 スロットに server 2 本）を
// 意図的に生む——複数主張者は規則の入力として実在し、server 起源同士の争いは規則の外（限界 4）だからである。
// その領域では per-slot の生存者を主張せず、「反対起源と重なっていない Timer は落ちない」だけを主張する。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  reconcileServerConfirmed,
  type ClientTimer,
  type ClientView,
} from "../../src/client/connection";
import {
  DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  DEFAULT_NOODLE_PRESETS,
  DEFAULT_SLOT_OFFSETS,
  defaultUnitOrigins,
} from "../../src/domain/store";
import type { TimerFact } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";
import { nonEmpty } from "../nonEmpty";

// ── 共有プール（重なりと running / boiled の組み合わせを意図的に誘発する小さなプール） ──────────────────

/** server-confirmed の id プール（直前ビューと新 snapshot が共有し、生存 / 消滅 / 新出現を誘発する）。 */
const SERVER_ID_POOL = ["s-a", "s-b", "s-c"] as const;
/** provisional（origin==="local"）専用の id プール。server 側と id 空間を分ける。 */
const LOCAL_ID_POOL = ["l-a", "l-b"] as const;
/** processedIds に混ぜる「timers と無関係な id」プール（刈り取りの検証用）。 */
const UNRELATED_ID_POOL = ["u-x", "u-y"] as const;
/** slotId プール。小さく取り、集合内・集合間ともに重なりを誘発する。 */
const SLOT_POOL = ["0", "1", "2", "3"] as const;
const NOODLE_POOL = ["thin", "thick", "curly", "ramen"] as const;
const FIRMNESS_POOL: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

// ── 時刻（境界を必ず踏む） ─────────────────────────────────────────────────────────────────────────

/** 時刻の基準点。endTime と補正後現在時刻をこの近傍に集め、境界の衝突確率を高く保つ。 */
const ANCHOR = 1_000_000;
/** endTime の候補。ANCHOR ちょうど（境界）・その ±1（境界の直前直後）・大きく前後、の五点。 */
const END_TIME_POOL = [ANCHOR - 2_000, ANCHOR - 1, ANCHOR, ANCHOR + 1, ANCHOR + 2_000] as const;
/**
 * 補正後現在時刻。候補の大半を END_TIME_POOL と共有させ、境界（endTime === correctedNow）を高頻度で踏む。
 * 境界の外（どの endTime とも一致しない値）も混ぜ、境界だけに寄らないようにする。
 */
const genCorrectedNowMs: fc.Arbitrary<number> = fc.constantFrom(
  ...END_TIME_POOL,
  ANCHOR - 3_000,
  ANCHOR + 3_000,
);
/** クロックオフセット。0 と非 0 の双方を踏む（補正が効いていることを同時に検べる）。 */
const genOffset: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -200_000, max: 200_000 }),
);

// ── Timer 集合生成器 ──────────────────────────────────────────────────────────────────────────────

/**
 * 指定 id プール・slot プールから TimerFact 集合を生成する。id は一意、各 Timer のスロットは 1〜2 個
 * （多スロット Timer を踏む）。**集合内の重なりは許す**——複数主張者を作るために必要である。
 */
function genFacts(
  idPool: readonly string[],
  slotPool: readonly string[],
): fc.Arbitrary<readonly TimerFact[]> {
  const genFact: fc.Arbitrary<TimerFact> = fc.record({
    id: fc.constant(""), // id は下で一意プールから差し込む
    slotIds: fc
      .uniqueArray(fc.constantFrom(...slotPool), { minLength: 1, maxLength: 2 })
      .map(nonEmpty),
    noodleType: fc.constantFrom(...NOODLE_POOL),
    firmness: fc.constantFrom(...FIRMNESS_POOL),
    startTime: fc.integer({ min: ANCHOR - 10_000, max: ANCHOR }),
    endTime: fc.constantFrom(...END_TIME_POOL),
    orderItem: fc.constant(null),
  });
  return fc
    .uniqueArray(fc.constantFrom(...idPool), { maxLength: idPool.length })
    .chain((ids) =>
      fc
        .array(genFact, { minLength: ids.length, maxLength: ids.length })
        .map((facts): readonly TimerFact[] => facts.map((fact, i) => ({ ...fact, id: ids[i]! }))),
    );
}

/** 既存の直前結果（残滓）。占有 / 非占有どちらのスロットにも載りうる。 */
const genLastResults: fc.Arbitrary<
  ReadonlyMap<string, { readonly noodleType: string; readonly at: number }>
> = fc
  .array(
    fc.record({
      slot: fc.constantFrom(...SLOT_POOL),
      noodleType: fc.constantFrom(...NOODLE_POOL),
      at: fc.integer({ min: 0, max: ANCHOR }),
    }),
    { maxLength: SLOT_POOL.length },
  )
  .map((entries) => new Map(entries.map((e) => [e.slot, { noodleType: e.noodleType, at: e.at }])));

// ── 場面（view / serverTimers / at / 補正後現在時刻の組） ────────────────────────────────────────────

interface Scene {
  /** 適用先ビュー（直前 server-confirmed ＋ 保持 provisional を含む完全形）。 */
  readonly view: ClientView;
  /** 新 snapshot の全量。解決の server 側はこちら（全置換ゆえ直前 server は解決に関与しない）。 */
  readonly serverTimers: readonly TimerFact[];
  /** 残滓記録時刻。解決が使う補正後時刻は at + view.offset である。 */
  readonly at: number;
  /** 解決が使う補正後現在時刻（生成の起点）。 */
  readonly correctedNowMs: number;
}

/**
 * 場面を生成する。server 側と local 側で別々の slot プールを与えられる——同一プールを渡せば争いが起き、
 * 互いに素なプールを渡せば争いが起きない（Property 6 の前提をこの引数で表明する）。
 */
function genScene(
  serverSlotPool: readonly string[],
  localSlotPool: readonly string[],
): fc.Arbitrary<Scene> {
  return fc
    .record({
      prevServer: genFacts(SERVER_ID_POOL, serverSlotPool),
      serverTimers: genFacts(SERVER_ID_POOL, serverSlotPool),
      provisional: genFacts(LOCAL_ID_POOL, localSlotPool),
      offset: genOffset,
      correctedNowMs: genCorrectedNowMs,
      lastResults: genLastResults,
      connectivity: fc.constantFrom<ClientView["connectivity"]>("up", "down"),
      sync: fc.constantFrom<ClientView["sync"]>("connecting", "synced", "syncFailed"),
      unitCount: fc.integer({ min: 1, max: 4 }),
    })
    .chain((drawn) => {
      const idPool = [
        ...new Set([
          ...drawn.prevServer.map((t) => t.id),
          ...drawn.serverTimers.map((t) => t.id),
          ...drawn.provisional.map((t) => t.id),
          ...UNRELATED_ID_POOL,
        ]),
      ];
      // processedIds は「全 id」と「部分集合」の双方を踏む。全 id を高頻度で引くのは、解決で落ちる Timer の
      // id が記録に在る場面（Property 7 が空虚にならない条件）を確実に作るためである。
      return fc
        .oneof(
          fc.constant<readonly string[]>(idPool),
          fc.uniqueArray(fc.constantFrom(...idPool), { maxLength: idPool.length }),
        )
        .map((processed): Scene => {
          const timers: readonly ClientTimer[] = [
            ...drawn.prevServer.map((t) => ({ ...t, origin: "server" as const })),
            ...drawn.provisional.map((t) => ({ ...t, origin: "local" as const })),
          ];
          return {
            view: {
              timers,
              pendingOrders: [],
              recommendations: [],
              offset: drawn.offset,
              processedIds: new Set(processed),
              lastResults: drawn.lastResults,
              connectivity: drawn.connectivity,
              unreachableReason: "offline",
              sync: drawn.sync,
              error: null,
              unitCount: drawn.unitCount,
              noodlePresets: DEFAULT_NOODLE_PRESETS,
              unitOrigins: defaultUnitOrigins(drawn.unitCount),
              slotOffsets: DEFAULT_SLOT_OFFSETS,
              affinityToleranceDistance: DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
            },
            serverTimers: drawn.serverTimers,
            at: drawn.correctedNowMs - drawn.offset,
            correctedNowMs: drawn.correctedNowMs,
          };
        });
    });
}

/** 争いを誘発する場面（server 側と local 側が同じ slot プールを引く）。 */
const genContestedScene: fc.Arbitrary<Scene> = genScene(SLOT_POOL, SLOT_POOL);

/**
 * 争いが起きない場面（server 側と local 側の slot プールが互いに素）。分割点も生成し、片側 1 スロット〜
 * 片側 3 スロットまでの分け方を踏む。
 */
const genUncontestedScene: fc.Arbitrary<Scene> = fc
  .integer({ min: 1, max: SLOT_POOL.length - 1 })
  .chain((split) => genScene(SLOT_POOL.slice(0, split), SLOT_POOL.slice(split)));

// ── 解決規則の観測ヘルパ（判断 2 の真理値表を、そのままの形で写す） ─────────────────────────────────

interface SlotClaim {
  readonly server: readonly ClientTimer[];
  readonly local: readonly ClientTimer[];
}

/** スロットごとの主張を起源別に束ねる（重なりは any-overlap ＝ slotIds の交わり）。 */
function claimsBySlot(timers: readonly ClientTimer[]): ReadonlyMap<string, SlotClaim> {
  const claims = new Map<string, { server: ClientTimer[]; local: ClientTimer[] }>();
  for (const timer of timers) {
    for (const slotId of timer.slotIds) {
      let claim = claims.get(slotId);
      if (claim === undefined) {
        claim = { server: [], local: [] };
        claims.set(slotId, claim);
      }
      (timer.origin === "server" ? claim.server : claim.local).push(timer);
    }
  }
  return claims;
}

/**
 * 解決前の集合 ＝ 全置換した server-confirmed ＋ 保持 provisional（design.md の (a)）。
 * 順序も含めて写す——Property 3 / 6 は結果の順序まで主張するため、比較の基準が要る。
 */
function beforeResolution(
  view: ClientView,
  serverTimers: readonly TimerFact[],
): readonly ClientTimer[] {
  return [
    ...serverTimers.map((t) => ({ ...t, origin: "server" as const })),
    ...view.timers.filter((t) => t.origin === "local"),
  ];
}

/**
 * 判断 2 の真理値表。**表が決めるのは敗者集合である**——あるスロットで負けた側の Timer を返す。
 * 争いになるのは双方が running を主張したときだけで、それ以外は自動的に決着する。
 *
 * running / boiled は endTime と補正後現在時刻の比較だけから導き、境界（endTime === correctedNow）は
 * **boiled 側**に属する（design.md Property 3 の末尾）。ここでは production のヘルパを通さず、規則の言明
 * そのものとして比較を書く——テストが実装の写しになると、規則が変わったことを検出できなくなる。
 */
function losersAt(claim: SlotClaim, correctedNowMs: number): readonly ClientTimer[] {
  const isRunning = (timer: ClientTimer): boolean => timer.endTime > correctedNowMs;
  if (claim.server.length === 0 || claim.local.length === 0) return []; // 片側だけの在席は争いにならない
  const serverRunning = claim.server.some(isRunning);
  const localRunning = claim.local.some(isRunning);
  if (serverRunning && localRunning) return []; // 双方走行は決着しない（限界 1 の残余）
  return localRunning ? claim.server : claim.local; // 負けた側は丸ごと（判断 4）
}

/** 表の勝者集合 ＝ そのスロットの在席者から敗者を除いたもの。 */
function winnersAt(claim: SlotClaim, correctedNowMs: number): readonly ClientTimer[] {
  const loserIds = new Set(losersAt(claim, correctedNowMs).map((t) => t.id));
  return [...claim.server, ...claim.local].filter((t) => !loserIds.has(t.id));
}

/**
 * 全スロットの表を一度に評価して得る敗者 id 集合。**解決前の集合から一度に**決める（判断 5 の合流性）。
 * 逐次に落としながら再評価しない。
 */
function loserIdsOf(before: readonly ClientTimer[], correctedNowMs: number): ReadonlySet<string> {
  const losers = new Set<string>();
  for (const claim of claimsBySlot(before).values()) {
    for (const loser of losersAt(claim, correctedNowMs)) losers.add(loser.id);
  }
  return losers;
}

function idsOf(timers: readonly ClientTimer[]): readonly string[] {
  return timers.map((t) => t.id);
}

function sortedIdsOf(timers: readonly ClientTimer[]): readonly string[] {
  return [...idsOf(timers)].sort();
}

/** 真理値表の 6 行。全行を踏んだことを実行後に確認する（踏み漏らしを主張ではなく実測で防ぐ）。 */
const TABLE_ROWS = [
  "server 不在 × local 在席",
  "server 在席 × local 不在",
  "server boiled × local running",
  "server running × local boiled",
  "双方 boiled",
  "双方 running",
] as const;

/** そのスロットが表のどの行に当たるか。 */
function rowOf(claim: SlotClaim, correctedNowMs: number): (typeof TABLE_ROWS)[number] {
  const isRunning = (timer: ClientTimer): boolean => timer.endTime > correctedNowMs;
  if (claim.server.length === 0) return "server 不在 × local 在席";
  if (claim.local.length === 0) return "server 在席 × local 不在";
  const serverRunning = claim.server.some(isRunning);
  const localRunning = claim.local.some(isRunning);
  if (serverRunning && localRunning) return "双方 running";
  if (serverRunning) return "server running × local boiled";
  if (localRunning) return "server boiled × local running";
  return "双方 boiled";
}

const NUM_RUNS = 300;

describe("client/connection reconcileServerConfirmed — degraded-slot-superimposition Property 3 / 6 / 7", () => {
  // Feature: degraded-slot-superimposition, Property 3: 統一規則の真理値表
  // 表が決めるのは敗者集合であり、結果の timers は「いずれのスロットでも負けなかった全 Timer」に等しい。
  // 在席者がすべて単一スロットの Timer である slotId では生存者が表の勝者と一致する。多スロット Timer が
  // 絡む slotId では別スロットでの敗北により勝者が生存者に居ないことがあり（判断 5 の連鎖）、そこでは
  // 不変条件（≤ 1）だけが立つ。**Validates: Requirements 2.3**
  it("Property 3: 統一規則の真理値表 — 生存者は「いずれのスロットでも負けなかった全 Timer」", () => {
    const rowsSeen = new Set<string>();
    let sawBoundary = false;
    let sawMultiSlotTimer = false;
    let sawMultipleClaimants = false;
    let sawServerOnlyOverlap = false;
    let sawEmptiedSlot = false;

    fc.assert(
      fc.property(genContestedScene, ({ view, serverTimers, at, correctedNowMs }) => {
        const result = reconcileServerConfirmed(view, serverTimers, at);
        const before = beforeResolution(view, serverTimers);
        const beforeClaims = claimsBySlot(before);
        const afterClaims = claimsBySlot(result.timers);
        const losers = loserIdsOf(before, correctedNowMs);

        // 入力空間の踏み分けを実測する（下の expect 群で全行・境界・多スロット・複数主張者を確認する）。
        if (before.some((t) => t.endTime === correctedNowMs)) sawBoundary = true;
        if (before.some((t) => t.slotIds.length > 1)) sawMultiSlotTimer = true;

        // (1) 表の帰結そのもの — 敗者を「すべて」除き、それ以外を「すべて」残す。順序も解決前のまま。
        expect(idsOf(result.timers)).toEqual(idsOf(before.filter((t) => !losers.has(t.id))));

        for (const [slotId, claim] of beforeClaims) {
          rowsSeen.add(rowOf(claim, correctedNowMs));
          const occupants = [...claim.server, ...claim.local];
          if (
            claim.server.length + claim.local.length > 1 &&
            (claim.server.length > 1 || claim.local.length > 1)
          ) {
            sawMultipleClaimants = true;
            if (claim.local.length === 0) sawServerOnlyOverlap = true;
          }
          const survivors = afterClaims.get(slotId) ?? { server: [], local: [] };
          const surviving = [...survivors.server, ...survivors.local];

          // (2) 在席者がすべて単一スロットの Timer なら、生存者は表の勝者と厳密に一致する。単一スロットの
          //     Timer の運命はそのスロットだけで決まるため、連鎖（判断 5）が及ばない。
          if (occupants.every((t) => t.slotIds.length === 1)) {
            expect(sortedIdsOf(surviving)).toEqual(sortedIdsOf(winnersAt(claim, correctedNowMs)));
          }

          // (3) 多スロット Timer が絡む slotId では per-slot の生存者を literal に主張しない（判断 4 / 5 と
          //     矛盾する）。決着する行かつ各側の主張者が 1 本以下なら、不変条件（≤ 1）だけを主張する。
          //     連鎖で勝者まで落ち、スロットが空になることは許す。
          const decided = rowOf(claim, correctedNowMs) !== "双方 running";
          if (decided && claim.server.length <= 1 && claim.local.length <= 1) {
            expect(surviving.length).toBeLessThanOrEqual(1);
            if (surviving.length === 0 && occupants.length > 0) sawEmptiedSlot = true;
          }
        }

        // (4) 限界 4 — server 起源同士の争いは規則の外にある。反対起源と 1 スロットも共有しない server 起源
        //     Timer は決して落ちない（server 側が server 側を落とすことはない）。
        const localSlots = new Set<string>();
        for (const timer of before)
          if (timer.origin === "local") for (const slotId of timer.slotIds) localSlots.add(slotId);
        const survivingIds = new Set(idsOf(result.timers));
        for (const timer of before) {
          if (timer.origin !== "server") continue;
          if (timer.slotIds.some((slotId) => localSlots.has(slotId))) continue;
          expect(survivingIds.has(timer.id)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );

    // 6 行を全行踏んだこと・境界（endTime === correctedNow）を踏んだこと・多スロット Timer と複数主張者を
    // 生成したことを実測で確認する。踏めていなければ主張は空虚であり、それは生成器の欠陥である。
    expect([...rowsSeen].sort()).toEqual([...TABLE_ROWS].sort());
    expect(sawBoundary).toBe(true);
    expect(sawMultiSlotTimer).toBe(true);
    expect(sawMultipleClaimants).toBe(true);
    expect(sawServerOnlyOverlap).toBe(true);
    expect(sawEmptiedSlot).toBe(true);
  });

  // Feature: degraded-slot-superimposition, Property 6: 争いが無い入力では reconcile の結果が従来と一致する
  // server 集合と provisional 集合のスロットが互いに素ならば、結果は解決なしの計算と timers（順序を含む）・
  // lastResults・processedIds のすべてで一致する。**Validates: Requirements 3.3**
  it("Property 6: 争いが無い入力では reconcile の結果が従来と一致する", () => {
    fc.assert(
      fc.property(genUncontestedScene, ({ view, serverTimers, at }) => {
        const before = beforeResolution(view, serverTimers);

        // 前提（生成器が保証する）— server 側と local 側はどの slotId も共有しない。
        const serverSlots = new Set(serverTimers.flatMap((t) => [...t.slotIds]));
        for (const timer of view.timers) {
          if (timer.origin !== "local") continue;
          for (const slotId of timer.slotIds) expect(serverSlots.has(slotId)).toBe(false);
        }

        const result = reconcileServerConfirmed(view, serverTimers, at);

        // (1) timers — 何も落ちない（順序も解決前のまま）。「解決なしの計算」を production の写しで書くのでは
        //     なく、「生存者が入力の全 Timer に等しい」として表す。
        expect(idsOf(result.timers)).toEqual(idsOf(before));
        expect(result.timers).toEqual(before);

        // 占有スロット集合 ＝ 新 serverTimers のスロット ∪ 保持 provisional のスロット（(c) と同一定義）。
        const occupied = new Set<string>(serverSlots);
        for (const timer of view.timers)
          if (timer.origin === "local") for (const slotId of timer.slotIds) occupied.add(slotId);
        const newIds = new Set(serverTimers.map((t) => t.id));

        // (2) lastResults — 既存の残滓の規律がそのまま立つ。占有スロットに残滓は無く、消えた直前 server の
        //     麺種が再占有されない各スロットへ at と共に載る（同一スロットを複数の消えた Timer が主張しうる
        //     ため、麺種は当該スロットの消滅者のいずれかであることを主張する）。
        for (const slotId of occupied) expect(result.lastResults.has(slotId)).toBe(false);
        const vanishedNoodlesBySlot = new Map<string, Set<string>>();
        for (const timer of view.timers) {
          if (timer.origin !== "server" || newIds.has(timer.id)) continue;
          for (const slotId of timer.slotIds) {
            if (occupied.has(slotId)) continue;
            const noodles = vanishedNoodlesBySlot.get(slotId) ?? new Set<string>();
            noodles.add(timer.noodleType);
            vanishedNoodlesBySlot.set(slotId, noodles);
          }
        }
        for (const [slotId, noodles] of vanishedNoodlesBySlot) {
          const entry = result.lastResults.get(slotId);
          expect(entry).toBeDefined();
          expect(noodles.has(entry!.noodleType)).toBe(true);
          expect(entry!.at).toBe(at);
        }

        // (3) processedIds — 刈り取りは「新 serverTimers の id ∪ 保持 provisional の id」への限定のまま。
        //     争いが無いので解決前と解決後の集合は一致し、この結果は解決なしの計算と等しい。
        const retainedIds = new Set(newIds);
        for (const timer of view.timers) if (timer.origin === "local") retainedIds.add(timer.id);
        expect([...result.processedIds].sort()).toEqual(
          [...view.processedIds].filter((id) => retainedIds.has(id)).sort(),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: degraded-slot-superimposition, Property 7: 落とした Timer の id は処理済み記録に残る
  // 解決で落とされた server 起源 Timer の id が入力の processedIds に含まれていたなら、結果の processedIds にも
  // 含まれる。刈り取りが解決**前**の保持 id 集合で行われることの検査であり、刈り取りを解決後の集合へ移した
  // 瞬間に赤くなる（復活した Timer のローカル再発火抑止が失われる）。**Validates: Requirements 2.3, 3.3**
  it("Property 7: 落とした Timer の id は処理済み記録に残る", () => {
    let sawDroppedRecordedServerTimer = false;

    fc.assert(
      fc.property(genContestedScene, ({ view, serverTimers, at }) => {
        const result = reconcileServerConfirmed(view, serverTimers, at);
        const survivingIds = new Set(result.timers.map((t) => t.id));

        for (const timer of serverTimers) {
          if (survivingIds.has(timer.id)) continue; // 解決で落とされた server 起源 Timer だけを見る
          if (!view.processedIds.has(timer.id)) continue;
          sawDroppedRecordedServerTimer = true;
          expect(result.processedIds.has(timer.id)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );

    // 「落とされ、かつ入力の processedIds に在った server 起源 Timer」を実際に踏んだことを確認する。
    // 踏めていなければ上の主張は空虚で、刈り取り順序を壊しても赤くならない。
    expect(sawDroppedRecordedServerTimer).toBe(true);
  });
});
