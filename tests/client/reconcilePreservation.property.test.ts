// offline-degradation Property 8 の残余 — decideView({ kind: "Reconcile" }) を入口にした保存性。
//
// **なぜ入口を変えて書くか。** 既存の主張（degraded-slot-superimposition.resolution.property.test.ts の
// Property 6 / 7・convergence.property.test.ts・reconcile.property.test.ts）はすべて reconcileServerConfirmed の
// 直呼びである。decideView の Reconcile 分岐が同じ規律を通ることはどこにも書かれておらず、分岐が別の
// 畳み込みへ差し替わっても既存はすべて緑のままになる。ゆえにここでは唯一の入口を decideView に据え、
// 「入口が変わっても保存性が成り立つこと」と要件12.4（snapshot が正本・provisional は競合源にならない）だけを
// 主張する。規律の中身（残滓の差分導出・冪等性・単調減少）は既存が押さえているので繰り返さない。
//
// **書かれた前提（争いが無い入力）は生成器で満たす。** スロットプールを分割点で二分し、snapshot 側と
// provisional 側へ互いに素なプールを与える（resolution.property.test.ts の genUncontestedScene と同じ流儀）。
// 争いのある入力では占有解決により provisional / server-confirmed が落ちうるため、その主張は
// degraded-slot-superimposition の Property 3〜6 に委ねて重複させない。
//
// 時刻はすべて引数として運ぶ（Date.now のスタブも偽時計も用いない・要件13.4）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMPTY_VIEW,
  decideView,
  dueLocalTimers,
  type ClientTimer,
  type ClientView,
} from "../../src/client/connection";
import type { TimerFact } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";
import { nonEmpty } from "../nonEmpty";

// ── 共有プール（復活・刈り取り・全置換を意図的に誘発する小さなプール） ───────────────────────────────

/** server-confirmed の id プール。直前ビューと新 snapshot が共有し、生存 / 消滅 / 復活を誘発する。 */
const SNAPSHOT_ID_POOL = ["s-a", "s-b", "s-c"] as const;
/** provisional（origin==="local"）専用の id プール。server 側と id 空間を分ける。 */
const PROVISIONAL_ID_POOL = ["l-a", "l-b"] as const;
/** processedIds に混ぜる「どちらにも属さない id」プール（刈り取りの有界性の検証用）。 */
const UNRELATED_ID_POOL = ["u-x", "u-y"] as const;
/** slotId プール。分割点で二分し、争いが無い前提（互いに素）を構造で作る。 */
const SLOT_POOL = ["0", "1", "2", "3"] as const;
const NOODLE_POOL = ["thin", "thick", "curly"] as const;
const FIRMNESS_POOL: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

/** 時刻の基準点。endTime をこの近傍に集め、境界（endTime === correctedNow）も踏ませる。 */
const ANCHOR = 1_000_000;
const END_TIME_POOL = [ANCHOR - 2_000, ANCHOR - 1, ANCHOR, ANCHOR + 1, ANCHOR + 2_000] as const;

/** クロックオフセット。0 と非 0 の双方（Reconcile が offset を凍結しても補正は残る）。 */
const genOffset: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -200_000, max: 200_000 }),
);
/** 受信時刻（残滓記録時刻 at として運ばれる）。 */
const genReceivedAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: ANCHOR });

// ── Timer 集合生成器 ──────────────────────────────────────────────────────────────────────────────

/**
 * 指定 id プール・slot プールから TimerFact 集合を生成する。id は一意で、各 Timer のスロットは
 * 1〜2 個（多スロット Timer を踏む）。集合内の重なりは許す（起源をまたぐ争いだけを排すれば前提は満たされる）。
 */
function genFacts(
  idPool: readonly string[],
  slotPool: readonly string[],
): fc.Arbitrary<readonly TimerFact[]> {
  const genFact: fc.Arbitrary<Omit<TimerFact, "id">> = fc.record({
    slotIds: fc
      .uniqueArray(fc.constantFrom(...slotPool), {
        minLength: 1,
        maxLength: Math.min(2, slotPool.length),
      })
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

// ── 場面（ビュー / snapshot / 受信時刻の組） ────────────────────────────────────────────────────────

interface UncontestedScene {
  /** 適用先ビュー（直前 server-confirmed ＋ 保持 provisional を含む完全形）。 */
  readonly view: ClientView;
  /** Reconcile が運ぶ全量スナップショット（server-confirmed の正本）。 */
  readonly snapshot: readonly TimerFact[];
  /** 受信時刻。 */
  readonly receivedAt: number;
}

/**
 * 場面を生成する。snapshot 側と provisional 側に別々の slot プールを与える——互いに素なプールを渡すことが
 * Property 8 の書かれた前提（争いが無い入力）の表明そのものである。
 */
function genScene(
  snapshotSlots: readonly string[],
  provisionalSlots: readonly string[],
): fc.Arbitrary<UncontestedScene> {
  return fc
    .record({
      prevServer: genFacts(SNAPSHOT_ID_POOL, snapshotSlots),
      snapshot: genFacts(SNAPSHOT_ID_POOL, snapshotSlots),
      provisional: genFacts(PROVISIONAL_ID_POOL, provisionalSlots),
      offset: genOffset,
      receivedAt: genReceivedAt,
    })
    .chain((drawn) => {
      const idPool = [
        ...new Set([
          ...drawn.prevServer.map((t) => t.id),
          ...drawn.snapshot.map((t) => t.id),
          ...drawn.provisional.map((t) => t.id),
          ...UNRELATED_ID_POOL,
        ]),
      ];
      // processedIds は「全 id」と「部分集合」の双方を踏む。全 id を高頻度で引くのは、cancel 済み
      // server-confirmed の復活（snapshot 再出現）と刈り取りの双方が空虚にならない場面を確実に作るためである。
      return fc
        .oneof(
          fc.constant<readonly string[]>(idPool),
          fc.uniqueArray(fc.constantFrom(...idPool), { maxLength: idPool.length }),
        )
        .map((processed): UncontestedScene => ({
          // EMPTY_VIEW を基点にするのは、公開型がフィールドを増やしたとき既定値で追随させるため
          // （Property 8 が意味を与える次元＝timers / offset / processedIds だけを上書きする）。
          view: {
            ...EMPTY_VIEW,
            timers: [
              ...drawn.prevServer.map((t): ClientTimer => ({ ...t, origin: "server" })),
              ...drawn.provisional.map((t): ClientTimer => ({ ...t, origin: "local" })),
            ],
            offset: drawn.offset,
            processedIds: new Set(processed),
          },
          snapshot: drawn.snapshot,
          receivedAt: drawn.receivedAt,
        }));
    });
}

/** 争いが無い場面（分割点で二分した互いに素なスロットプール。片側 1〜3 スロットまでの分け方を踏む）。 */
const genUncontestedScene: fc.Arbitrary<UncontestedScene> = fc
  .integer({ min: 1, max: SLOT_POOL.length - 1 })
  .chain((split) => genScene(SLOT_POOL.slice(0, split), SLOT_POOL.slice(split)));

function sortedIdsOf(timers: readonly { readonly id: string }[]): readonly string[] {
  return [...timers.map((t) => t.id)].sort();
}

const NUM_RUNS = 300;

describe("client/connection decideView(Reconcile) — offline-degradation Property 8 の残余", () => {
  // Feature: offline-degradation, Property 8: Reconcile は server-confirmed のみを置換し、provisional と
  // 抑止記録を保存する（争いが無い入力の下で）。この前提を満たす任意の ClientView と任意の全量スナップショット
  // timers（WireTimer[]）について、Reconcile（および同一規律の Server: snapshot）を適用した結果ビューは、
  // 次を同時に満たす。(a) provisional 保持 — 元ビューの origin === "local" の Timer はすべて結果ビューに
  // 同一内容で残る。(b) server 全置換 — 結果ビューの origin === "server" の Timer 集合は、入力スナップショット
  // timers とちょうど一致する（元の server-confirmed は残らず、スナップショットのものだけになる）。
  // (c) 抑止の保存 — 元ビューで processedIds に登録済みの timerId は、それがスナップショットに再出現しても
  // processedIds に残り続け、dueLocalTimers は当該 Timer を発火対象から除外する。processedIds は
  // 「スナップショットの id ∪ 保持された provisional の id」へ刈り取られ有界に保たれる。
  //
  // **Validates: Requirements 11.5, 11.6, 11.7, 12.4**
  it("Property 8: decideView(Reconcile) を入口にしても provisional・server 全置換・抑止が保存される", () => {
    let sawBothNonEmpty = false;
    let sawResurrection = false;
    let sawServerReplaced = false;
    let sawSuppressed = false;
    let sawFired = false;

    fc.assert(
      fc.property(genUncontestedScene, ({ view, snapshot, receivedAt }) => {
        const provisional = view.timers.filter((timer) => timer.origin === "local");
        const snapshotIds = new Set(snapshot.map((timer) => timer.id));

        // 前提の確認（生成器が保証するものを主張としても置く）— snapshot 側と provisional 側は
        // どの slotId も共有しない。争いがあれば占有解決で一方が落ち、(a) も (b) も成り立たない。
        const snapshotSlots = new Set(snapshot.flatMap((timer) => [...timer.slotIds]));
        for (const timer of provisional) {
          for (const slotId of timer.slotIds) expect(snapshotSlots.has(slotId)).toBe(false);
        }
        if (provisional.length > 0 && snapshot.length > 0) sawBothNonEmpty = true;

        // 入力スナップショットの写しを取る。正本が畳み込みで書き換えられないことを後で確かめる（要件12.4）。
        const snapshotBefore = snapshot.map((timer) => ({ ...timer, slotIds: [...timer.slotIds] }));

        // 唯一の入口は decideView。待ち行列と推奨は Property 8 の関心外ゆえ空で運ぶ。
        const result = decideView(view, {
          kind: "Reconcile",
          timers: snapshot,
          pendingOrders: [],
          recommendations: [],
          receivedAt,
        });

        // (a) provisional 保持 — 起源タグを含めて同一内容で残る。origin が "server" へ化けないことも
        //     ここで縛られる（未確定意図が確定事実に昇格しない・要件12.4）。
        for (const timer of provisional) {
          expect(result.timers.find((t) => t.id === timer.id)).toEqual(timer);
        }

        // (b) server 全置換 — 結果の server-confirmed 集合は入力スナップショットとちょうど一致し、
        //     各 Timer は起源タグを付けただけの写しである。
        const confirmed = result.timers.filter((timer) => timer.origin === "server");
        expect(sortedIdsOf(confirmed)).toEqual([...snapshotIds].sort());
        for (const fact of snapshot) {
          expect(confirmed.find((t) => t.id === fact.id)).toEqual({ ...fact, origin: "server" });
        }
        for (const timer of view.timers) {
          if (timer.origin !== "server" || snapshotIds.has(timer.id)) continue;
          // スナップショットに居ない直前 server-confirmed は残らない（全置換）。
          expect(result.timers.some((t) => t.id === timer.id)).toBe(false);
          sawServerReplaced = true;
        }

        // 要件12.4 — provisional は正本の競合源にならない。server-confirmed 集合へ混ざらず、
        // 入力スナップショット（正本）そのものも畳み込みで書き換えられない。
        const provisionalIds = new Set(provisional.map((timer) => timer.id));
        for (const timer of confirmed) expect(provisionalIds.has(timer.id)).toBe(false);
        expect(snapshot).toEqual(snapshotBefore);

        // (c) 抑止の保存 — スナップショットに再出現した処理済み id は残り続ける（復活キャンセルの抑止）。
        for (const id of view.processedIds) {
          if (!snapshotIds.has(id)) continue;
          expect(result.processedIds.has(id)).toBe(true);
          sawResurrection = true;
        }
        // 刈り取りは「スナップショットの id ∪ 保持 provisional の id」への限定（記録を有界に保つ）。
        const retainedIds = new Set([...snapshotIds, ...provisionalIds]);
        for (const id of result.processedIds) expect(retainedIds.has(id)).toBe(true);

        // 発火対象の導出が抑止を尊重する。処理済みなら除外され、未処理の期限到来分は返る——
        // 対で主張するのは、除外だけなら「常に空を返す dueLocalTimers」でも緑になるからである。
        const farFuture = Math.max(ANCHOR, ...result.timers.map((timer) => timer.endTime)) + 1_000;
        const dueIds = new Set(dueLocalTimers(result, farFuture).map((timer) => timer.id));
        for (const timer of result.timers) {
          const suppressed = result.processedIds.has(timer.id);
          expect(dueIds.has(timer.id)).toBe(!suppressed);
          if (suppressed) sawSuppressed = true;
          else sawFired = true;
        }
      }),
      { numRuns: NUM_RUNS },
    );

    // 前提（互いに素）を満たす生成器が、主張を空虚にしない盤面を実際に生んでいることを実測で確かめる。
    // provisional と server-confirmed の双方が非空でなければ (a) も (b) も自明に通る。
    expect(sawBothNonEmpty).toBe(true);
    expect(sawResurrection).toBe(true);
    expect(sawServerReplaced).toBe(true);
    expect(sawSuppressed).toBe(true);
    expect(sawFired).toBe(true);
  });
});
