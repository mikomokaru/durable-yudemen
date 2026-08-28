// tests/client/boiledGroupGenerators.ts — sync-set-batch-complete（同時上がり群の一括消し込み）の
// Property テストが共有する fast-check 生成器。
//
// 既存 tests/client/generators.ts の genClientView / genCorrectedNow を再利用し、本機能に要る次元だけを
// 足す（同じ生成器を二度定義しない）。genClientTimer は genClientView 経由で再利用する——Timer の
// id / 麺種 / 硬さ / startTime / origin はそこから来て、本ファイルは endTime / slotIds だけを差し替える。
// 足す次元は次の 2 つに尽きる（genClientView は src/client/connection.ts の公開型 ClientView をそのまま
// 生成するため、型を写し替える補完は要らない）。
//
//   1. 群が実際に立つ入力 — endTime を少数の候補から引いて同値衝突を意図的に多く生み、slotIds を
//      担当ユニット境界（unit u = slot 6u..6u+5）をまたぐプールから引く。
//   2. 反映順 — 群の並びの置換（permutation）。Property 8 は「反映順で最後のメンバーが勝つ」を検査する。
//
// design.md「生成器の前提」が要求する入力空間を構造的にサンプリングできること:
//   - 同一 endTime の boiled 複数件（群が 2 件以上に立つ）と、endTime === correctedNow の境界（boiled 側）
//   - 担当ユニット内・外の両方を駆動する slotIds と、同一スロットを複数メンバーが駆動する退化入力
//   - 群外 Timer が群メンバーと同一スロットを駆動する盤面（除去してもスロットが空かない）
//   - 対象 timerId の三種（ビュー内 boiled / ビュー内 running / 不在）
//   - origin の server / local 混在、processedIds の 空 / 一部一致 / 無関係
//   - lastResults の 空 / 既存残滓あり（既存残滓の上書きを Property 8 が検査する）
//
// 純粋層の生成器ゆえ時刻はすべて引数値として吐く（Date.now のスタブも vi.useFakeTimers() も用いない）。

import * as fc from "fast-check";
import { genClientView, genCorrectedNow } from "./generators";
import type { ClientTimer, ClientView } from "../../src/client/connection";
import type { NonEmptyArray } from "../../src/domain/timer";
import { boiledGroup } from "../../src/client/boiledGroup";
import { DEFAULT_NOODLE_PRESETS, DEFAULT_UNIT_COUNT } from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";

// 担当ユニット集合は audioGenerators の genUnits を再利用する（同一概念を二度定義しない）。
// unit u は slot 6u..6u+5 を占めるため、units に 0 だけを与えれば slot 6 以降は担当外に転ぶ。
export { genUnits } from "./audioGenerators";

/** 直前結果（残滓）の写像型。connection.ts の ClientView から引く（形を二度書かない）。 */
type LastResults = ClientView["lastResults"];

// ── プール ────────────────────────────────────────────────────────────────────────────────────

/**
 * endTime の候補プール。**少数の候補から引くことで同値衝突を意図的に多く生む**。
 * 群は実効 endTime の等値で立つため、候補が広いと群が常に 1 件へ退化して要件2.1 / 8.4 が未検証になる。
 */
const END_TIME_POOL = [-1_000, 0, 1_000, 2_000] as const;

/**
 * slotId プール。unit 0（slot 0..5）に "0" / "3"、unit 1（slot 6..11）に "6" / "9" が属する。
 * 担当ユニット内・外の双方を踏み（要件4.1 / 4.2）、4 件の小さめプールゆえ **同一スロットを複数の
 * Timer が駆動する退化入力**（要件8.4 / 8.8 の前提）と、群外 Timer による占有（要件2.6）も密に生じる。
 */
const SLOT_ID_POOL = ["0", "3", "6", "9"] as const;

/** ビューに存在しない timerId プール（対象不在の窓・要件1.2）。generators.ts のどのプールとも衝突しない。 */
const ABSENT_ID_POOL = ["t-absent-1", "t-absent-2"] as const;

/**
 * 既存残滓の麺種プール。generators.ts の麺種プールと**意図的に重ならない**名前にする——
 * 一括完了で残滓が上書きされたのか、既存残滓が残ったのかを Property 8 が値で見分けられるようにする。
 */
const STALE_NOODLE_POOL = ["stale-thin", "stale-thick"] as const;

// ── スカラ生成器 ───────────────────────────────────────────────────────────────────────────────

/** 実効 endTime。候補プールから引く（同値衝突を密にする）。 */
const genClusteredEndTime: fc.Arbitrary<number> = fc.constantFrom(...END_TIME_POOL);

/** 非空のスロット集合。担当ユニット境界をまたぐ小さめプールの非空部分集合。 */
const genSpanningSlotIds = fc.subarray([...SLOT_ID_POOL], { minLength: 1 }).map((slots) => nonEmpty(slots));

/** 本 spec が genClientTimer から差し替える 2 面（群が立つ盤面を密にするための次元）。 */
interface ClusteredFacet {
  readonly endTime: number;
  readonly slotIds: NonEmptyArray<string>;
}

const genClusteredFacet: fc.Arbitrary<ClusteredFacet> = fc.record({
  endTime: genClusteredEndTime,
  slotIds: genSpanningSlotIds,
});

/**
 * genClientTimer が吐いた Timer の endTime / slotIds だけを差し替える。
 * TimerFact のフィールドを列挙せず spread で写す——芯（TimerFact）が育っても生成器が自動追従する。
 */
function withClusteredFacet(timer: ClientTimer, facet: ClusteredFacet): ClientTimer {
  return { ...timer, ...facet };
}

/**
 * 対象が boiled であることを保証する超過分（correctedNow − endTime）。
 * 0 を必ず含める——`endTime === correctedNow` は boiled 側の境界（述語は `endTime <= correctedNow`）。
 */
const genOverdue: fc.Arbitrary<number> = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5_000 }));

/**
 * 残滓の記録時刻 at（LocalComplete が運ぶ）。既存残滓の at（負）と重ならない非負域から引く——
 * 上書きが起きたかを at でも見分けられる。
 */
export const genRecordedAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: 1_000_000 });

// ── lastResults（既存残滓） ────────────────────────────────────────────────────────────────────

/**
 * 直前結果（残滓）— 空と「既存残滓が在る状態」の双方（要件8.4）。
 * 空 Map 固定にすると既存残滓の上書きが起きず、Property 8 の検査が弱くなる。
 */
const genLastResults: fc.Arbitrary<LastResults> = fc.oneof(
  fc.constant<LastResults>(new Map()),
  fc
    .uniqueArray(
      fc.tuple(
        fc.constantFrom(...SLOT_ID_POOL),
        fc.record({
          noodleType: fc.constantFrom(...STALE_NOODLE_POOL),
          at: fc.integer({ min: -1_000_000, max: -1 }), // 記録時刻（非負）と重ならない域
        }),
      ),
      { selector: ([slotId]) => slotId, minLength: 1, maxLength: SLOT_ID_POOL.length },
    )
    .map((entries): LastResults => new Map(entries)),
);

// ── ClientView 生成器（群が立つ盤面へ絞った差分） ───────────────────────────────────────────────

/**
 * genClientView の Timer 列の endTime / slotIds だけを差し替える（id は保つ）。
 *
 * id を保つのは processedIds の意味を壊さないため——genClientView の processedIds は自身の Timer id と
 * 一部一致するよう作られており、id を差し替えるとその次元（要件5.4 の処理済み記録）が失われる。
 */
function genClusteredTimers(timers: readonly ClientTimer[]): fc.Arbitrary<ClientTimer[]> {
  if (timers.length === 0) return fc.constant<ClientTimer[]>([]);
  return fc.tuple(...timers.map((timer) => genClusteredFacet.map((facet) => withClusteredFacet(timer, facet))));
}

/**
 * 一括消し込みの入力となる ClientView（src/client/connection.ts の公開型）。
 *
 * genClientView を土台に、群が立つ盤面へ効く次元（timers の endTime / slotIds・lastResults）だけを差し替え、
 * 群の再構成にも LocalComplete の畳み込みにも影響しない次元（pendingOrders / recommendations /
 * unreachableReason / unitCount / noodlePresets）は既定へ固定して生成の分散を本質へ集める
 * （audioGenerators.ts の genAudioView と同形）。lastResults は Property 8 の検査対象ゆえ本ファイルの
 * genLastResults で上書きする——群のスロットプールに合わせた既存残滓を密に載せるため。
 */
export const genBatchView: fc.Arbitrary<ClientView> = genClientView.chain((view) =>
  fc
    .record({ timers: genClusteredTimers(view.timers), lastResults: genLastResults })
    .map(
      ({ timers, lastResults }): ClientView => ({
        ...view,
        timers,
        pendingOrders: [],
        recommendations: [],
        lastResults,
        unreachableReason: "offline",
        unitCount: DEFAULT_UNIT_COUNT,
        noodlePresets: DEFAULT_NOODLE_PRESETS,
      }),
    ),
);

// ── 押下 1 回分の入力（view × 対象 timerId × 補正後現在時刻） ────────────────────────────────────

/** 一括完了の指示 1 回分。boiledGroup の 3 引数をそのまま束ねる。 */
export interface BatchCase {
  readonly view: ClientView;
  readonly timerId: string;
  readonly correctedNow: number;
}

/**
 * 対象 timerId — ビュー内の Timer と不在 id の双方。ビュー内を重く引くのは群が立つ盤面を密に踏むため。
 * correctedNow が endTime 群をまたぐ（genCorrectedNow）ので、ビュー内の対象は boiled / running の双方に転ぶ
 * ——三種（boiled / running / 不在）はこの二軸の積として分布する（要件1.2 の窓）。
 */
function genTargetTimerId(view: ClientView): fc.Arbitrary<string> {
  const absent = fc.constantFrom(...ABSENT_ID_POOL);
  if (view.timers.length === 0) return absent;
  const inView = fc.constantFrom(...view.timers.map((timer) => timer.id));
  return fc.oneof({ arbitrary: inView, weight: 4 }, { arbitrary: absent, weight: 1 });
}

/**
 * 一般ケース — 対象は boiled / running / 不在の三種に分布する（Property 1〜5 / 9 の入力）。
 * correctedNow は既存 genCorrectedNow を再利用し、endTime との一致（境界）と ±1 を必ず踏む。
 */
export const genBatchCase: fc.Arbitrary<BatchCase> = genBatchView.chain((view) =>
  genCorrectedNow(view).chain((correctedNow) =>
    genTargetTimerId(view).map((timerId) => ({ view, timerId, correctedNow })),
  ),
);

/**
 * 対象が必ず boiled のケース — 群が必ず非空になる（Property 6〜8 の入力）。
 *
 * correctedNow を対象の endTime から `+ genOverdue` で導くことで boiled を構成的に保証する
 * （filter で捨てない）。超過 0 は `endTime === correctedNow` の境界を踏む。
 */
export const genBoiledCase: fc.Arbitrary<BatchCase> = genBatchView
  .filter((view) => view.timers.length > 0)
  .chain((view) =>
    fc
      .constantFrom(...view.timers)
      .chain((target) =>
        genOverdue.map((overdue) => ({ view, timerId: target.id, correctedNow: target.endTime + overdue })),
      ),
  );

// ── 反映順（群の並びの置換） ────────────────────────────────────────────────────────────────────

/** 反映順を伴う群のケース（Property 8 の入力）。group は元の並び、reflected はその置換。 */
export interface ReflectionOrderCase extends BatchCase {
  /** boiledGroup が返す並び（＝view.timers の並び）。非空。 */
  readonly group: readonly ClientTimer[];
  /** 反映順（group の全要素の置換）。degraded / provisional 経路の畳み込み順として与える。 */
  readonly reflected: readonly ClientTimer[];
  /** 残滓の記録時刻（LocalComplete が運ぶ now）。 */
  readonly at: number;
}

/**
 * 反映順つきの群 — 群を一度立ててから、その全要素の置換を束ねる（design.md「反映順の生成」）。
 *
 * **fast-check 4.8.0 に fc.shuffle は無い。** 全要素の置換は shuffledSubarray に元配列を渡し、
 * minLength / maxLength を要素数へ固定して得る（固定しないと長さが縮んでメンバーが落ちる）。
 * 既存前例（tests/registry/compose.property.test.ts の genComposeInput ほか）と同形。
 * 元の並びも fc.constant で一緒に運ぶ——Property 8 は「群の全メンバー」と「反映順」の両方を要する。
 */
export const genReflectionOrderCase: fc.Arbitrary<ReflectionOrderCase> = genBoiledCase.chain((base) => {
  const group = boiledGroup(base.view, base.timerId, base.correctedNow);
  return fc
    .record({
      group: fc.constant(group),
      reflected: fc.shuffledSubarray([...group], { minLength: group.length, maxLength: group.length }),
      at: genRecordedAt,
    })
    .map(
      (order): ReflectionOrderCase => ({
        view: base.view,
        timerId: base.timerId,
        correctedNow: base.correctedNow,
        group: order.group,
        reflected: order.reflected,
        at: order.at,
      }),
    );
});
