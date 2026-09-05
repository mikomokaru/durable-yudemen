// tests/client/degraded-slot-superimposition.gate.property.test.ts
//
// 何を守っているか — 占有ゲート（修正(1)）の**両面**である。ゲートは `decideLocalStart` の先頭に置かれた
// 唯一の関門であり、狭すぎれば重ね合わせ（1 釜 2 本）を通し、広すぎれば現場の正常な start を黙って飲む。
// 片面だけを検査すると、もう一方の誤りが検査をすり抜ける。ゆえに両面を同じファイルへ置く。
//
//   Property 1（拒否の面）— 要求スロットのいずれかが在席済みなら、ビューは参照同一で返る。
//   Property 2（通過の面）— 共有 slotId が 1 つも無いなら、従来どおり provisional が 1 本注入され残滓が解ける。
//
// 検証対象は `decideView` の LocalStart 分岐（`decideLocalStart`）ただ一つ。WS・DOM・時計・localStorage に
// 触れない純粋関数であり、時刻・生成 id はすべてイベントの引数として生成器から運ぶ（`Date.now` のスタブ・
// `vi.useFakeTimers()` は用いない・tests/client/README.md）。
//
// なぜ Property 1 が `toBe`（参照同一）なのか — 端（`openTimerConnection.update`）は `next === view` のとき
// `persistence.save` も `notify` も呼ばない。拒否が永続化と再描画を起こさない性質は、この参照同一の 1 点に
// 依存している。`toEqual` は値の一致しか語らず、スプレッドで作り直された「同値だが別物」を通してしまう。
//
// 生成器は本ファイルで完結させ、実 ClientView（`lastResults` / `unitCount` / `noodlePresets` を含む完全形）を
// 生成する（`reconcile.property.test.ts` と同じ方針）。スロットプールは小さく取り、重なりと多スロット Timer の
// **部分重なり**（要求が多スロット Timer の一部の釜だけを掴む形）を意図的に誘発する。
//
// 参照: .kiro/specs/degraded-slot-superimposition/design.md
//   Property 1（Requirements 2.1, 2.2）/ Property 2（Requirements 3.1）
// 範囲外 `boilSeconds` の再検証は offline-degradation Property 3 が担い、ここでは重複させない
// （Property 1 では範囲内・範囲外の双方を流すが、それは「ゲートが範囲検査より前に効く」ことの確認であって
// 範囲検査そのものの主張ではない）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideView,
  type ClientEvent,
  type ClientTimer,
  type ClientView,
  type TimerOrigin,
} from "../../src/client/connection";
import type { Firmness } from "../../src/domain/firmness";
import {
  DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  DEFAULT_NOODLE_PRESETS,
  DEFAULT_SLOT_OFFSETS,
  defaultUnitOrigins,
} from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";
import { genBoilSeconds } from "./generators";

/** LocalStart イベントの形（`decideView` の判別共用体から取り出す。第二の定義を作らない）。 */
type LocalStart = Extract<ClientEvent, { kind: "LocalStart" }>;

/** 主張の単位 — 「このビューへ、このイベントを畳む」の組。 */
interface GateCase {
  readonly view: ClientView;
  readonly event: LocalStart;
}

/**
 * 要求スロットのいずれかが在席 Timer と共有されているか（any-overlap）。
 *
 * `src/client/connection.ts` の `occupiesAny` は非公開ゆえ、生成器の前提を固めるためにここへ写す。
 * 実装を呼べれば重複は避けられるが、公開シンボルを増やすことになる——テストのために境界を広げない。
 * 判定は集合の等値ではなく交わりの有無（1 Timer が複数スロットを駆動しうるため）。
 */
function sharesSlot(timers: readonly ClientTimer[], slotIds: readonly string[]): boolean {
  return timers.some((timer) => timer.slotIds.some((slotId) => slotIds.includes(slotId)));
}

// ── プールとスカラ生成器（小さく取り、重なりを誘発する） ────────────────────────────────────────

/** slotId プール。小さく取ることで要求スロットと在席スロットの重なりが頻繁に起きる。 */
const SLOT_POOL = ["0", "1", "2", "3", "4", "5"] as const;
/** 麺種プール。 */
const NOODLE_POOL = ["thin", "thick", "curly", "ramen"] as const;
const FIRMNESS_POOL: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];
/**
 * 注入される provisional の id プール。在席 Timer の id 空間（`s-*` / `l-*`）と分ける。
 *
 * 衝突を避けるのは、Property 2 が「注入された 1 本」を id で同定するためである。既存 id と衝突させると
 * どちらが注入分かを語れなくなり、主張が「1 件増えた」以上を言えない。id 衝突の扱いは本 Property の関心事でない。
 */
const NEW_ID_POOL = ["new-a", "new-b"] as const;
/** `processedIds` に混ぜる「timers と無関係な id」プール（ゲートがこれらに依らないことを流す）。 */
const UNRELATED_ID_POOL = ["u-x", "u-y"] as const;

/** endTime / 補正後現在時刻。小さめ範囲に取り、running / boiled の双方を在席させる。 */
const genTime: fc.Arbitrary<number> = fc.integer({ min: -5_000, max: 5_000 });
/** クロックオフセット。負・0・正をまたぐ（ゲートは offset に依らない）。 */
const genOffset: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -200_000, max: 200_000 }),
);
/** 残滓の記録時刻。 */
const genAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10_000_000 });

/** SLOT_POOL の全要素の置換。前から順に「要求スロット」「在席スロット」へ切り分ける土台にする。 */
const genSlotOrder: fc.Arbitrary<readonly string[]> = fc.shuffledSubarray([...SLOT_POOL], {
  minLength: SLOT_POOL.length,
  maxLength: SLOT_POOL.length,
});

// ── 在席 Timer の生成（起源混在・多スロットを含む） ───────────────────────────────────────────

/** 在席 Timer 1 本ぶんの仕様。スロットの割り付けは `occupantsFrom` が置換列から行う。 */
interface OccupantSpec {
  /** 駆動する釜の数（1〜2）。2 のとき、要求が片方だけを掴む「部分重なり」が生まれる。 */
  readonly width: 1 | 2;
  readonly origin: TimerOrigin;
  readonly noodleType: string;
  readonly firmness: Firmness;
  readonly endTime: number;
}

const genOccupantSpec: fc.Arbitrary<OccupantSpec> = fc.record({
  width: fc.constantFrom<1 | 2>(1, 2),
  origin: fc.constantFrom<TimerOrigin>("server", "local"),
  noodleType: fc.constantFrom(...NOODLE_POOL),
  firmness: fc.constantFrom(...FIRMNESS_POOL),
  endTime: genTime,
});

/**
 * 仕様列を、与えられたスロット列の**互いに素な区間**へ割り付けて在席 Timer 列にする。
 *
 * 集合内のスロットを互いに素に保つのは、1 釜 ≤ 1 本という現実の不変点に合わせるためである
 * （`reconcile.property.test.ts` の `genTimerFacts` と同じ規律）。スロットを使い切ったら以降は作らない。
 * id は起源の接頭辞と通し番号で一意にする。
 */
function occupantsFrom(
  specs: readonly OccupantSpec[],
  slots: readonly string[],
): readonly ClientTimer[] {
  const timers: ClientTimer[] = [];
  let idx = 0;
  for (const spec of specs) {
    const remaining = slots.length - idx;
    if (remaining <= 0) break;
    const width = Math.min(spec.width, remaining);
    const slice = slots.slice(idx, idx + width);
    idx += width;
    timers.push({
      id: `${spec.origin === "server" ? "s" : "l"}-${timers.length}`,
      slotIds: nonEmpty(slice),
      noodleType: spec.noodleType,
      firmness: spec.firmness,
      startTime: spec.endTime - 60_000,
      endTime: spec.endTime,
      origin: spec.origin,
    });
  }
  return timers;
}

/**
 * 在席 Timer 列から実 ClientView を組む。`seedSlots` の残滓は必ず載せる。
 *
 * 残滓を強制するのは Property 2 の「解除される」主張の前提である——載っていなければ、消えたのか
 * 元から無かったのかを区別できない。
 */
function genViewWith(
  timers: readonly ClientTimer[],
  seedSlots: readonly string[],
): fc.Arbitrary<ClientView> {
  const ids = timers.map((timer) => timer.id);
  return fc
    .record({
      offset: genOffset,
      processed: ids.length === 0 ? fc.constant<readonly string[]>([]) : fc.subarray(ids),
      unrelated: fc.subarray([...UNRELATED_ID_POOL]),
      residualSlots: fc.subarray([...SLOT_POOL]),
      residualNoodle: fc.constantFrom(...NOODLE_POOL),
      residualAt: genAt,
      connectivity: fc.constantFrom<ClientView["connectivity"]>("up", "down"),
      sync: fc.constantFrom<ClientView["sync"]>("connecting", "synced", "syncFailed"),
      unitCount: fc.integer({ min: 1, max: 4 }),
    })
    .map((record): ClientView => ({
      timers,
      // 待ち行列と推奨は LocalStart の畳み込みが読まない。要らない次元へ生成の分散を広げない。
      pendingOrders: [],
      recommendations: [],
      offset: record.offset,
      processedIds: new Set<string>([...record.processed, ...record.unrelated]),
      lastResults: new Map(
        [...new Set([...seedSlots, ...record.residualSlots])].map((slotId) => [
          slotId,
          { noodleType: record.residualNoodle, at: record.residualAt },
        ]),
      ),
      connectivity: record.connectivity,
      unreachableReason: "offline",
      sync: record.sync,
      error: null,
      unitCount: record.unitCount,
      noodlePresets: DEFAULT_NOODLE_PRESETS,
      unitOrigins: defaultUnitOrigins(record.unitCount),
      slotOffsets: DEFAULT_SLOT_OFFSETS,
      affinityToleranceDistance: DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
    }));
}

// ── 二面の生成器 ───────────────────────────────────────────────────────────────────────────────

/**
 * 拒否の面 — 要求スロットが在席スロットと必ず交わる組（Property 1）。
 *
 * 在席スロットの 1 つを錨（anchor）として必ず含め、そこへ 0〜2 個の任意スロットを足す。これにより
 * 単一スロットの要求だけでなく、**多スロット要求が在席 Timer の一部の釜だけを掴む部分重なり**も踏む。
 * `boilSeconds` は範囲内・範囲外の双方を流す（ゲートが範囲検査より前に効くことの確認）。
 */
const genOccupiedRequest: fc.Arbitrary<GateCase> = genSlotOrder
  .chain((slots) =>
    fc
      .array(genOccupantSpec, { minLength: 1, maxLength: 3 })
      .map((specs) => occupantsFrom(specs, slots)),
  )
  .chain((timers) => {
    const occupied = [...new Set(timers.flatMap((timer) => timer.slotIds))];
    return fc
      .record({
        view: genViewWith(timers, []),
        anchor: fc.constantFrom(...occupied),
        extra: fc.subarray([...SLOT_POOL], { maxLength: 2 }),
        noodleType: fc.constantFrom(...NOODLE_POOL),
        boilSeconds: genBoilSeconds,
        correctedNow: genTime,
        newTimerId: fc.constantFrom(...NEW_ID_POOL),
      })
      .map((record): GateCase => ({
        view: record.view,
        event: {
          kind: "LocalStart",
          slotIds: nonEmpty([...new Set([record.anchor, ...record.extra])]),
          noodleType: record.noodleType,
          boilSeconds: record.boilSeconds,
          newTimerId: record.newTimerId,
          correctedNow: record.correctedNow,
        },
      }));
  });

/**
 * 通過の面 — 要求スロットが在席 Timer とどの slotId も共有しない組（Property 2）。
 *
 * 置換列の先頭を要求スロットへ、残りを在席 Timer へ割り付けることで互いに素を構造的に保証する
 * （filter で捨てるのではなく、構築で満たす）。`boilSeconds` は整数 1〜1800 に限る——範囲外は
 * ゲートと同じ「ビュー不変」へ落ちるため、注入の主張と混ぜられない。
 */
const genFreeRequest: fc.Arbitrary<GateCase> = genSlotOrder.chain((slots) =>
  fc
    .record({
      requestWidth: fc.integer({ min: 1, max: 3 }),
      specs: fc.array(genOccupantSpec, { maxLength: 3 }),
    })
    .chain((layout) => {
      const requestSlots = slots.slice(0, layout.requestWidth);
      const timers = occupantsFrom(layout.specs, slots.slice(layout.requestWidth));
      return fc
        .record({
          view: genViewWith(timers, requestSlots),
          noodleType: fc.constantFrom(...NOODLE_POOL),
          boilSeconds: fc.integer({ min: 1, max: 1800 }),
          correctedNow: genTime,
          newTimerId: fc.constantFrom(...NEW_ID_POOL),
        })
        .map((record): GateCase => ({
          view: record.view,
          event: {
            kind: "LocalStart",
            slotIds: nonEmpty(requestSlots),
            noodleType: record.noodleType,
            boilSeconds: record.boilSeconds,
            newTimerId: record.newTimerId,
            correctedNow: record.correctedNow,
          },
        }));
    }),
);

const NUM_RUNS = 200;

describe("client/connection decideLocalStart — 占有ゲートの両面（degraded-slot-superimposition）", () => {
  // Feature: degraded-slot-superimposition, Property 1: 占有スロットへの LocalStart はビュー不変
  // **Validates: Requirements 2.1, 2.2**
  //
  // 要求 slotIds のいずれかが在席 Timer の slotIds と共通の slotId を持つならば（起源・running / boiled を
  // 問わず）、decideView の結果は入力ビューと参照同一である。釜の排他性は接続性にも起源にも依らない物理的
  // 事実であり、茹で上がった麺も消し込むまで釜に在る。
  it("Property 1: 占有スロットへの LocalStart はビュー不変（参照同一で返る）", () => {
    fc.assert(
      fc.property(genOccupiedRequest, ({ view, event }) => {
        // 生成器の前提 — 要求と在席が必ず交わっている（交わらない領域は Property 2 が担う）。
        expect(sharesSlot(view.timers, event.slotIds)).toBe(true);

        // 主張は参照同一。これが端（openTimerConnection.update）の早期 return を通し、永続化と通知を
        // 走らせない性質そのものである。toEqual では「同値だが別物」を見逃す。
        expect(decideView(view, event)).toBe(view);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: degraded-slot-superimposition, Property 2: 空きスロットへの LocalStart は従来どおり単一の
  // provisional を注入し残滓を解除する
  // **Validates: Requirements 3.1**
  //
  // 要求 slotIds が在席 Timer とどの slotId も共有せず、boilSeconds が 1〜1800 の整数ならば、結果ビューは
  // origin === "local" の Timer をちょうど 1 件多く含み、その id は newTimerId・endTime は厳密に
  // correctedNow + boilSeconds * 1000 で、要求 slotIds の残滓は消える。
  //
  // **ゲートを広く取りすぎる誤りを捕まえるのがこのテストの役割である。** 拒否だけを検査すれば、
  // 「すべて拒否する」ゲートが緑になってしまう。
  it("Property 2: 空きスロットへの LocalStart は provisional を 1 本注入し要求スロットの残滓を解く", () => {
    fc.assert(
      fc.property(genFreeRequest, ({ view, event }) => {
        // 生成器の前提 — 共有 slotId が 1 つも無く、要求スロットには残滓が載っている。
        expect(sharesSlot(view.timers, event.slotIds)).toBe(false);
        for (const slotId of event.slotIds) expect(view.lastResults.has(slotId)).toBe(true);

        const result = decideView(view, event);

        // provisional はちょうど 1 件増え、在席していた Timer は 1 本も失われない。
        const localsBefore = view.timers.filter((timer) => timer.origin === "local");
        const localsAfter = result.timers.filter((timer) => timer.origin === "local");
        expect(localsAfter).toHaveLength(localsBefore.length + 1);
        expect(result.timers).toHaveLength(view.timers.length + 1);
        for (const timer of view.timers) expect(result.timers).toContain(timer);

        // 注入分の同定は id で行う（NEW_ID_POOL は在席 id 空間と分けてある）。
        const injected = localsAfter.find((timer) => timer.id === event.newTimerId);
        expect(injected).toBeDefined();
        expect(injected!.slotIds).toEqual([...event.slotIds]);
        // endTime は補正後現在時刻 + 茹で時間の絶対エポックミリ秒（事実）。残り秒は状態に昇格しない。
        expect(injected!.endTime).toBe(event.correctedNow + event.boilSeconds * 1000);

        // 要求スロットの残滓は解除される（新しい麺が乗った釜に、前の結果を残さない）。
        for (const slotId of event.slotIds) expect(result.lastResults.has(slotId)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
