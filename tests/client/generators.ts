// tests/client/generators.ts — offline-degradation 純粋層の Property テストが共有する fast-check 生成器の土台。
//
// 検証対象の純粋関数（decideView / mode / dueLocalTimers / serializeView / parsePersistedView）とその入力型は
// すでに src/client/ に在る。**型は実装の公開型をそのまま import する**（ClientView / ClientTimer / ClientEvent /
// Connectivity / TimerOrigin / SyncPhase / UnreachableReason は src/client/connection.ts、PersistedView は
// src/client/persistence.ts、TimerFact / NonEmptyArray は src/domain/timer.ts）。同じ概念をテスト側で二度
// 定義しない——かつてここには公開型が生まれる前の暫定ローカル型が置かれており、公開型が育つ間に取り残されて
// 「6 フィールドの ClientView」「7 系統の ClientEvent」という古い形を語り続けていた（重複は必ず二つの真実になる）。
//
// ビューは EMPTY_VIEW を基点に差分を上書きして組む。公開型にフィールドが増えたとき、生成器は既定値で
// 追随して壊れず、意味のある次元だけを明示的に上書きする形が残る。
//
// ワイヤ型（TimerFact / ServerMessage / PendingOrder / CookRecommendation）は src/domain/ の既存定義を
// そのまま用いる（要件12.2: ワイヤ形式は不変）。core（src/engine/）には一切依存しない。
//
// 入力空間の方針（design.md「生成器の前提」・要件13.3）— 次を構造的にサンプリングできること:
//   - server / local 混在の Timer（起源タグ TimerOrigin = "server" | "local" 両方）
//   - endTime == correctedNow 境界（および直前・直後）
//   - 範囲外 boilSeconds（0・負・1801 以上・非整数）
//   - 処理済み id の重複（processedIds が timers の id と重なる／無関係 id を含む）
//   - cancel 済み server の snapshot 復活（processedIds 登録済み id が snapshot/Reconcile に再出現）
//   - 直前結果（lastResults）の空 / 占有スロット上 / 空きスロット上（占有クリアと差分記録の双方を踏む）
//   - 到達不能理由 unreachableReason の 3 値（offline / noAccess / signInRequired）
//   - 不正 / 不在の永続ブロブ（壊れた JSON・未知 version・型不一致・空文字・null）

import * as fc from "fast-check";
import {
  PREP_LEAD_MS,
  type CookRecommendation,
  type ServerMessage,
} from "../../src/domain/messages";
import type { PendingOrder } from "../../src/domain/order";
import type { TimerFact, NonEmptyArray } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";
import { EMPTY_VIEW } from "../../src/client/connection";
import type {
  ClientEvent,
  ClientTimer,
  ClientView,
  Connectivity,
  SyncPhase,
  TimerOrigin,
  UnreachableReason,
} from "../../src/client/connection";
import type { PersistedView } from "../../src/client/persistence";
import {
  DEFAULT_ARMS,
  DEFAULT_TOLERANCE_RATIO,
  DEFAULT_ORDER_SYNC_WEIGHT,
  DEFAULT_TABLE_SYNC_WEIGHT,
  DEFAULT_AFFINITY_WEIGHT,
  DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
  DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
  DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  DEFAULT_SLOT_OFFSETS,
  DEFAULT_FIRMNESS_CODES,
  DEFAULT_MENU_ITEMS,
  DEFAULT_NOODLE_PRESETS,
  SLOT_SPAN_MAX,
  SLOT_SPAN_MIN,
  SLOTS_PER_UNIT,
  defaultUnitOrigins,
} from "../../src/domain/store";
import type { NoodlePreset } from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";

// ── 共有プール（id / slotId / noodleType の小さなプールで衝突・重複・復活を意図的に誘発する） ───────

/** Timer id の小さなプール。timers / processedIds / イベント timerId / snapshot 間で衝突と復活を誘発する。 */
const TIMER_ID_POOL = ["t-a", "t-b", "t-c", "t-d", "t-e", "t-f"] as const;
/** processedIds に混ぜる「timers と無関係な id」プール（刈り取り検証用）。 */
const UNRELATED_ID_POOL = ["t-x", "t-y", "t-z"] as const;
/** ビューに存在しない timerId プール（非存在 id に対するイベントの不変性検証用）。 */
const ABSENT_ID_POOL = ["t-absent-1", "t-absent-2"] as const;
/** LocalStart が生成する新規 Provisional_Timer の id プール（既存 id との衝突も意図的に含める）。 */
const NEW_ID_POOL = ["t-new-1", "t-new-2", ...TIMER_ID_POOL] as const;
/** slotId プール。同一 slotId の衝突（ダブルブッキング相当）を誘発する小さめプール。 */
const SLOT_ID_POOL = ["0", "1", "2", "3"] as const;
/** 麺種プール。 */
const NOODLE_POOL = ["thin", "thick", "curly", "ramen", "soba", "udon"] as const;
/**
 * 既存の直前結果（残滓）に載せる麺種プール。NOODLE_POOL と**意図的に重ならない**名前にする——
 * 畳み込みで残滓が上書きされたのか、既存残滓が残ったのかを値で見分けられるようにする
 * （tests/client/boiledGroupGenerators.ts の STALE_NOODLE_POOL と同じ流儀）。
 */
const RESIDUAL_NOODLE_POOL = ["last-thin", "last-thick"] as const;
/** 外部オーダー識別子のプール（待ち行列と推奨が同じ品目を指す組を誘発する小さめプール）。 */
const EXTERNAL_ORDER_ID_POOL = ["o-1", "o-2", "o-3"] as const;
/** 卓 id プール。null（単独グループ）も混ぜる。 */
const TABLE_ID_POOL = ["tb-1", "tb-2"] as const;

const FIRMNESS_POOL: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

/** 非空のスロット集合（NonEmptyArray<string>）。SLOT_ID_POOL の非空部分集合で多スロット・overlap を誘発する。 */
const genSlotIds: fc.Arbitrary<NonEmptyArray<string>> = fc
  .subarray([...SLOT_ID_POOL], { minLength: 1 })
  .map((slots) => nonEmpty(slots));

// ── スカラ生成器 ───────────────────────────────────────────────────────────────────────────────

/** endTime は過去・現在・未来を広く分布。小さめ範囲で同一 endTime の衝突を誘発する。 */
const genEndTime: fc.Arbitrary<number> = fc.integer({ min: -5_000, max: 5_000 });

/** クロックオフセット。負・0・正をまたぐ。 */
const genOffset: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -200_000, max: 200_000 }),
);

/** 受信時刻 / serverTime / 除去時刻のエポックミリ秒。既存残滓の at（負）と重ならない非負域から引く。 */
const genReceivedAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10_000_000 });

/** 起源タグ。server / local 双方。 */
const genTimerOrigin: fc.Arbitrary<TimerOrigin> = fc.constantFrom<TimerOrigin>("server", "local");

/** Connectivity の二値。 */
export const genConnectivity: fc.Arbitrary<Connectivity> = fc.constantFrom<Connectivity>(
  "up",
  "down",
);

/** 到達不能理由の 3 値（down 時のみ意味を持つ独立軸・要件15.7 / 15.12）。 */
export const genUnreachableReason: fc.Arbitrary<UnreachableReason> =
  fc.constantFrom<UnreachableReason>("offline", "noAccess", "signInRequired");

/** 同期フェーズ。 */
const genSyncPhase: fc.Arbitrary<SyncPhase> = fc.constantFrom<SyncPhase>(
  "connecting",
  "synced",
  "syncFailed",
);

/** 茹で加減。 */
const genFirmness: fc.Arbitrary<Firmness> = fc.constantFrom(...FIRMNESS_POOL);

/** 直近エラー。null と具体エラーの双方。 */
const genError: fc.Arbitrary<ClientView["error"]> = fc.oneof(
  fc.constant<ClientView["error"]>(null),
  fc.record({ code: fc.string({ maxLength: 8 }), message: fc.string({ maxLength: 16 }) }),
);

/**
 * 茹で時間（秒）。範囲内（1..1800）と範囲外（0・負・1801 以上・非整数）の双方を生成する（要件6.5）。
 * 非整数は整数 + 0.5 で確実に作り、boilSeconds が整数 1..1800 を外れる入力を必ず踏ませる。
 */
export const genBoilSeconds: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 1800 }), // 範囲内
  fc.constant(0), // 下限直下
  fc.integer({ min: -3600, max: -1 }), // 負
  fc.integer({ min: 1801, max: 7200 }), // 上限超過
  fc.integer({ min: 0, max: 1800 }).map((n) => n + 0.5), // 非整数
);

// ── サーバ権威の店舗設定（ビューが写して持つ事実） ────────────────────────────────────────────────

/** 既定と異なる麺種プリセット（config 受信で確定が置き換わることを見分けられるようにする）。 */
const ALT_NOODLE_PRESETS: NonEmptyArray<NoodlePreset> = [
  { noodleType: "thin", boilSeconds: { extraHard: 40, hard: 50, normal: 60, soft: 70 } },
  { noodleType: "thick", boilSeconds: { extraHard: 100, hard: 110, normal: 120, soft: 140 } },
];

/** 麺種プリセット。既定と別値の二択（開始 UI の選択肢の元。畳み込みの主張には関与しない）。 */
const genNoodlePresets: fc.Arbitrary<NonEmptyArray<NoodlePreset>> = fc.constantFrom<
  NonEmptyArray<NoodlePreset>
>(DEFAULT_NOODLE_PRESETS, ALT_NOODLE_PRESETS);

/** ユニット総数（担当範囲のクランプ元）。 */
const genUnitCount: fc.Arbitrary<number> = fc.integer({ min: 1, max: 4 });

// ── 待ち行列 / 推奨（サーバだけが確定させる事実。ビューは写しを持つ） ──────────────────────────────

/** 未着手オーダー 1 件。id プールが小さいため、推奨と同じ品目を指す組が密に生じる。 */
const genPendingOrder: fc.Arbitrary<PendingOrder> = fc.record({
  externalOrderId: fc.constantFrom(...EXTERNAL_ORDER_ID_POOL),
  itemIndex: fc.integer({ min: 0, max: 2 }),
  noodleType: fc.constantFrom(...NOODLE_POOL),
  firmness: genFirmness,
  tableId: fc.oneof(fc.constant<string | null>(null), fc.constantFrom(...TABLE_ID_POOL)),
  arrivalTime: genReceivedAt,
  slotSpan: fc.integer({ min: SLOT_SPAN_MIN, max: SLOT_SPAN_MAX }),
  // POS 申告の商品名。null と非空文字列の双方を分布する（要件 6.5）。
  itemName: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  sizeName: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: null }),
});

/** 未着手オーダーの全量（空・複数の双方）。(externalOrderId, itemIndex) の組で一意化する。 */
const genPendingOrders: fc.Arbitrary<readonly PendingOrder[]> = fc.uniqueArray(genPendingOrder, {
  selector: (order) => `${order.externalOrderId}#${order.itemIndex}`,
  maxLength: 4,
});

/** 開始推奨 1 件（Committed_Plan からの導出値の写し）。slotIds はワイヤでも非空（型で強制）。 */
const genRecommendation: fc.Arbitrary<CookRecommendation> = fc.record({
  externalOrderId: fc.constantFrom(...EXTERNAL_ORDER_ID_POOL),
  itemIndex: fc.integer({ min: 0, max: 2 }),
  slotIds: genSlotIds,
  startAt: genReceivedAt,
  group: fc.constantFrom("g-1", "g-2", "g-3"),
  anchor: fc.option(genReceivedAt, { nil: null }),
});

/** 開始推奨の全量（空・複数の双方）。 */
const genRecommendations: fc.Arbitrary<readonly CookRecommendation[]> = fc.array(
  genRecommendation,
  { maxLength: 3 },
);

// ── Timer / View 生成器 ────────────────────────────────────────────────────────────────────────

/** 一件の ClientTimer。id はプールから引く（ビュー単位で一意化する）。server / local 混在。 */
export const genClientTimer: fc.Arbitrary<ClientTimer> = fc.record({
  id: fc.constantFrom(...TIMER_ID_POOL),
  slotIds: genSlotIds,
  noodleType: fc.constantFrom(...NOODLE_POOL),
  firmness: genFirmness,
  startTime: genEndTime,
  endTime: genEndTime,
  origin: genTimerOrigin,
});

/**
 * processedIds — 一部は timers の id と一致（重複・抑止検証）、一部は無関係 id（刈り取り検証）。
 * 空集合も含む。timerIds が空のときは無関係 id のみ。
 */
function genProcessedIds(timerIds: readonly string[]): fc.Arbitrary<ReadonlySet<string>> {
  const fromTimers = timerIds.length === 0 ? fc.constant<string[]>([]) : fc.subarray([...timerIds]);
  const unrelated = fc.subarray([...UNRELATED_ID_POOL]);
  return fc
    .tuple(fromTimers, unrelated)
    .map(([a, b]): ReadonlySet<string> => new Set<string>([...a, ...b]));
}

/**
 * 直前結果（残滓）— 空と「既存残滓が在る状態」の双方。キーは SLOT_ID_POOL ゆえ timers の駆動スロットと
 * 重なる場合（占有クリアの対象）と重ならない場合（差分記録の対象）の双方を踏む。
 *
 * 記録時刻 at は負域から引く。イベントが運ぶ除去時刻（genReceivedAt は非負）と重ならないため、
 * 残滓が上書きされたか既存のまま残ったかを at でも見分けられる。
 */
const genLastResults: fc.Arbitrary<ClientView["lastResults"]> = fc.oneof(
  fc.constant<ClientView["lastResults"]>(new Map()),
  fc
    .uniqueArray(
      fc.tuple(
        fc.constantFrom(...SLOT_ID_POOL),
        fc.record({
          noodleType: fc.constantFrom(...RESIDUAL_NOODLE_POOL),
          at: fc.integer({ min: -1_000_000, max: -1 }),
        }),
      ),
      { selector: ([slotId]) => slotId, minLength: 1, maxLength: SLOT_ID_POOL.length },
    )
    .map((entries): ClientView["lastResults"] => new Map(entries)),
);

/**
 * ClientView — 実装の公開型（src/client/connection.ts）そのもの。EMPTY_VIEW を基点に、意味のある次元だけを
 * 上書きして組む。
 *
 * timers は 0〜プール件数の ClientTimer（id をビュー内で一意化・server/local 混在）で、空ビュー・provisional
 * のみ・server のみ・両混在を境界として含む（要件13.3）。offset は負/0/正、processedIds は空/timers と一致/
 * 無関係、lastResults は空/占有スロット上/空きスロット上、connectivity は up/down、unreachableReason は 3 値、
 * pendingOrders / recommendations は空/複数、unitCount / noodlePresets はサーバ権威の写しとして 2 種以上を踏む。
 * レイアウト（unitOrigins / slotOffsets）と許容距離は既定に固定する（振らせても畳み込みの主張は強まらない）が、
 * unitOrigins だけは生成した unitCount と整合させる（config の生成器と同じ規律・要素数が unitCount に依存する）。
 */
export const genClientView: fc.Arbitrary<ClientView> = fc
  .uniqueArray(genClientTimer, { selector: (t) => t.id, maxLength: TIMER_ID_POOL.length })
  .chain((timers) =>
    fc
      .record({
        offset: genOffset,
        processedIds: genProcessedIds(timers.map((t) => t.id)),
        lastResults: genLastResults,
        pendingOrders: genPendingOrders,
        recommendations: genRecommendations,
        connectivity: genConnectivity,
        unreachableReason: genUnreachableReason,
        sync: genSyncPhase,
        error: genError,
        unitCount: genUnitCount,
        noodlePresets: genNoodlePresets,
      })
      // EMPTY_VIEW を基点にするのは、公開型がフィールドを増やしたとき生成器を壊さず既定値で追随させるため。
      .map((rest): ClientView => ({
        ...EMPTY_VIEW,
        ...rest,
        timers,
        unitOrigins: defaultUnitOrigins(rest.unitCount),
      })),
  );

/**
 * 補正後現在時刻 correctedNow — ビュー中の endTime 群に対し、すべて過去 / すべて未来 / 一部が前後、の
 * 三領域をまたぐ。endTime == correctedNow 境界（および ±1）を必ずサンプリングする（要件13.3）。空ビューは広域のみ。
 */
export function genCorrectedNow(view: ClientView): fc.Arbitrary<number> {
  const broad = fc.integer({ min: -10_000, max: 10_000 });
  if (view.timers.length === 0) return broad;
  const endTimes = view.timers.map((t) => t.endTime);
  const pick = fc.constantFrom(...endTimes);
  return fc.oneof(
    broad,
    pick, // correctedNow == endTime（境界・due）
    pick.map((e) => e - 1), // endTime をわずかに超えない（残存）
    pick.map((e) => e + 1), // endTime をわずかに過ぎた（due）
    fc.constant(Math.min(...endTimes) - 1000), // すべて未来
    fc.constant(Math.max(...endTimes) + 1000), // すべて過去
  );
}

// ── ワイヤ / サーバメッセージ生成器（既存ワイヤ型のみ・要件12.2） ────────────────────────────────────

/** TimerFact。id はプールから引き、snapshot/Reconcile での server-confirmed 復活を誘発する。 */
const genWireTimer: fc.Arbitrary<TimerFact> = fc.record({
  id: fc.constantFrom(...TIMER_ID_POOL),
  slotIds: genSlotIds,
  noodleType: fc.constantFrom(...NOODLE_POOL),
  firmness: genFirmness,
  startTime: genEndTime,
  endTime: genEndTime,
});

/** TimerFact 集合（id 一意・全置換 snapshot / Reconcile の入力）。空集合も含む。 */
const genWireTimers: fc.Arbitrary<readonly TimerFact[]> = fc.uniqueArray(genWireTimer, {
  selector: (t) => t.id,
  maxLength: TIMER_ID_POOL.length,
});

/** ServerMessage — 種別を分布（snapshot / config / error のみ）。すべて serverTime を伴う。
 *
 * 意味論メッセージ（started / cancelled / boiled / completed / adjusted）は snapshot 単一表現へ畳まれ撤去済み。
 * 状態変化は snapshot（server-confirmed の全量 TimerFact 列）だけで伝わる。 */
export const genServerMessage: fc.Arbitrary<ServerMessage> = fc.oneof(
  fc.record({
    type: fc.constant("snapshot" as const),
    serverTime: genReceivedAt,
    timers: genWireTimers,
    pendingOrders: genPendingOrders,
    recommendations: genRecommendations,
  }),
  // 計画の重み・許容幅（秒）は client の畳み込みが読まない（採点はサーバ側の計算・ビューへ写されない）。
  // レイアウト（unitOrigins / slotOffsets）と許容距離は釜の組が釜の距離を測るために読むので config case が
  // ビューへ写す（lift-group-display AC 4.7）が、写す事実そのものは畳み込みの主張を強めないため、要らない
  // 次元へ生成の分散を広げず既定値で固定する（unitOrigins だけは生成した unitCount と整合させる）。
  genUnitCount.chain((unitCount) =>
    fc.record({
      type: fc.constant("config" as const),
      serverTime: genReceivedAt,
      unitCount: fc.constant(unitCount),
      noodlePresets: genNoodlePresets,
      arms: fc.constant(DEFAULT_ARMS),
      toleranceRatio: fc.constant(DEFAULT_TOLERANCE_RATIO),
      orderSyncWeight: fc.constant(DEFAULT_ORDER_SYNC_WEIGHT),
      tableSyncWeight: fc.constant(DEFAULT_TABLE_SYNC_WEIGHT),
      affinityWeight: fc.constant(DEFAULT_AFFINITY_WEIGHT),
      orderSyncToleranceSeconds: fc.constant(DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS),
      tableSyncToleranceSeconds: fc.constant(DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS),
      affinityToleranceDistance: fc.constant(DEFAULT_AFFINITY_TOLERANCE_DISTANCE),
      unitOrigins: fc.constant(defaultUnitOrigins(unitCount)),
      slotOffsets: fc.constant(DEFAULT_SLOT_OFFSETS),
      // POS の対応表 2 枚は client 側の読み手が無い（本 spec の範囲外）。要らない次元へ生成の分散を
      // 広げず既定（空の表）で固定する。
      firmnessCodes: fc.constant(DEFAULT_FIRMNESS_CODES),
      menuItems: fc.constant(DEFAULT_MENU_ITEMS),
    }),
  ),
  fc.record({
    type: fc.constant("error" as const),
    serverTime: genReceivedAt,
    code: fc.string({ maxLength: 8 }),
    message: fc.string({ maxLength: 16 }),
  }),
);

// ── イベント生成器 ─────────────────────────────────────────────────────────────────────────────

/** イベント対象 timerId — ビューに存在（server / local）と非存在の双方。 */
function genEventTimerId(view: ClientView): fc.Arbitrary<string> {
  const existing =
    view.timers.length > 0
      ? fc.constantFrom(...view.timers.map((t) => t.id))
      : fc.constantFrom(...TIMER_ID_POOL);
  return fc.oneof(existing, fc.constantFrom(...ABSENT_ID_POOL));
}

/**
 * タグ付きイベント 1 件 — 公開型 ClientEvent の 9 系統すべてを分布する（要件4.2 の網羅分岐に対応）。
 *
 * LocalStart の correctedNow はビュー endTime に対する境界を踏み、boilSeconds は範囲内/外双方。
 * LocalCancel / LocalComplete / LocalDone の timerId は存在 / 非存在双方で、LocalCancel / LocalComplete は
 * 除去時刻 now（残滓の提示時間窓の起点）を運ぶ。Classify は到達不能理由の 3 値を踏む。
 * Reconcile は server-confirmed 全量に加え、待ち行列と推奨も運ぶ（snapshot と同じ全置換）。
 */
export function genEvent(view: ClientView): fc.Arbitrary<ClientEvent> {
  const localStart = genCorrectedNow(view).chain((correctedNow) =>
    fc.record({
      kind: fc.constant("LocalStart" as const),
      slotIds: genSlotIds,
      noodleType: fc.constantFrom(...NOODLE_POOL),
      boilSeconds: genBoilSeconds,
      newTimerId: fc.constantFrom(...NEW_ID_POOL),
      correctedNow: fc.constant(correctedNow),
    }),
  );
  return fc.oneof(
    fc.record({
      kind: fc.constant("Server" as const),
      message: genServerMessage,
      receivedAt: genReceivedAt,
    }),
    localStart,
    fc.record({
      kind: fc.constant("LocalCancel" as const),
      timerId: genEventTimerId(view),
      now: genReceivedAt,
    }),
    fc.record({
      kind: fc.constant("LocalComplete" as const),
      timerId: genEventTimerId(view),
      now: genReceivedAt,
    }),
    fc.record({ kind: fc.constant("Connectivity" as const), status: genConnectivity }),
    fc.record({ kind: fc.constant("Classify" as const), reason: genUnreachableReason }),
    fc.record({ kind: fc.constant("LocalDone" as const), timerId: genEventTimerId(view) }),
    fc.record({ kind: fc.constant("Tick" as const) }),
    fc.record({
      kind: fc.constant("Reconcile" as const),
      timers: genWireTimers,
      pendingOrders: genPendingOrders,
      recommendations: genRecommendations,
      receivedAt: genReceivedAt,
    }),
  );
}

/**
 * イベント列 — 初期ビューに対するイベントの列。LocalDone と Server snapshot の混在・Connectivity の up/down
 * 往復と Classify の分類・LocalStart → LocalCancel / LocalComplete の対などを、9 系統の混合列として構造的に
 * 踏む（要件13.3）。
 */
export function genEventStream(view: ClientView): fc.Arbitrary<readonly ClientEvent[]> {
  return fc.array(genEvent(view), { maxLength: 30 });
}

// ── 永続ブロブ生成器 ───────────────────────────────────────────────────────────────────────────

/** 妥当な PersistedView。ClientView の永続対象フィールドのみを写し取る。 */
export const genPersistedView: fc.Arbitrary<PersistedView> = genClientView.map((view) => ({
  version: 1 as const,
  timers: view.timers,
  offset: view.offset,
  processedIds: [...view.processedIds],
}));

/** 妥当な永続ブロブ文字列（serializeView 相当の round-trip 入力）。 */
export const genValidPersistedBlob: fc.Arbitrary<string> = genPersistedView.map((p) =>
  JSON.stringify(p),
);

/** 不正な永続ブロブ文字列 — 壊れた JSON・非オブジェクト・未知 version・型不一致・空文字など。 */
export const genInvalidPersistedBlob: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""), // 空文字
  fc.constant("{"), // 壊れた JSON
  fc.constant("null"), // JSON だが null
  fc.constant("[]"), // 配列（オブジェクトでない）
  fc.constant('{"version":2,"timers":[],"offset":0,"processedIds":[]}'), // 未知 version
  fc.constant('{"version":1,"timers":"nope","offset":0,"processedIds":[]}'), // 型不一致
  fc.constant('{"offset":0}'), // フィールド欠落
  fc.string({ maxLength: 24 }), // 任意文字列（多くは不正）
);

/**
 * 永続ブロブ — 妥当 / 不正 / 不在（null）の三領域。ViewStore.load 入力（parsePersistedView の引数）に対応する。
 * 不在（キー未設定）は null で表す（要件11.2: 不在・不正は EMPTY_VIEW へ）。
 */
export const genPersistedBlob: fc.Arbitrary<string | null> = fc.oneof(
  genValidPersistedBlob,
  genInvalidPersistedBlob,
  fc.constant(null),
);

/** ビューと、その状態に対して境界を踏む correctedNow の組（純粋発火判定 dueLocalTimers 検証の足場）。 */
export const genViewAndCorrectedNow: fc.Arbitrary<{ view: ClientView; correctedNow: number }> =
  genClientView.chain((view) =>
    genCorrectedNow(view).map((correctedNow) => ({ view, correctedNow })),
  );

// ── 群を作る場面（lift-group-display） ────────────────────────────────────────────────────────
//
// 上の genClientView は畳み込み（decideView）の入力空間で、推奨の group / anchor は無作為に振られ、「同じ群の推奨は
// 同じ anchor を運ぶ」という engine の射影の不変条件を保たない。群の導出（liftGroups / slotSuggestions / pairSlots）
// の性質を問うには、engine が出す形を意図的に作る盤面が要る——batch ごとに一つの group、合流した batch は全品が
// 同じ anchor（走行中の錨の実効 endTime）を運び、その錨の Timer が走行中に在る。合流していない batch は anchor が
// null。錨が過去（anchor ≤ corrected・boiled）は corrected の側で踏む（錨の直前・ちょうど・直後を境界として引く）。

/** 群を作る場面の基準時刻（エポックミリ秒）。群の serveAt はここから先に置く。 */
export const LIFT_SCENE_ORIGIN = 1_700_000_000_000;

/** 群を作る場面の卓。null は卓なし。client は卓を群の判定に読まない（AC 1.2）ので、待ち行列の写しにだけ載る。 */
const LIFT_TABLE_POOL: readonly (string | null)[] = [null, "tb-1", "tb-2"];

/**
 * 走行中の仲間の種別。match は batch の錨（合流していなければ serveAt）に endTime が一致し、mismatch は 1 秒ずれ、
 * stray は無関係の時刻に上がる。client はどれも読まない（started は anchor だけで決まる・AC 1.7）——一致する
 * Timer が在っても anchor が null なら started でなく、Timer が無くても anchor が未来なら started である。
 */
type LiftMateKind = "match" | "mismatch" | "stray";

/** 品目の茹で秒（DEFAULT_NOODLE_PRESETS × firmness）。場面の組み立てと性質の再計算が同じ表を引く。 */
function sceneBoilSeconds(noodleType: string, firmness: Firmness): number {
  const preset = DEFAULT_NOODLE_PRESETS.find((candidate) => candidate.noodleType === noodleType);
  if (preset === undefined) throw new Error(`test generator invariant violated: ${noodleType}`);
  return preset.boilSeconds[firmness];
}

/** 群を作る場面の品目。茹で秒はプリセットから引くので、noodleType と firmness で startAt が決まる。 */
interface LiftItemSpec {
  readonly noodleType: string;
  readonly firmness: Firmness;
  readonly slotIds: NonEmptyArray<string>;
  readonly arrivalOffset: number;
}

/**
 * 合流した batch の錨——走行中の Timer として盤面に置く。skew は serveAt からのずれ（合流した品目の serveAt は
 * 錨と h_i 以内でずれうる・lift-group-planning 判断 18）で、anchor = serveAt + skew。
 */
interface LiftAnchorSpec {
  readonly skew: number;
  readonly slotIds: NonEmptyArray<string>;
  readonly boilSeconds: number;
}

/** 群を作る場面の batch（一つの群）。anchor が null なら合流していない群。 */
interface LiftBatchSpec {
  readonly tableId: string | null;
  readonly serveAt: number;
  readonly anchor: LiftAnchorSpec | null;
  readonly items: readonly LiftItemSpec[];
}

/** 走行中の仲間。batch を指し、種別で endTime の一致 / 不一致を決める。 */
interface LiftMateSpec {
  readonly batch: number;
  readonly kind: LiftMateKind;
  readonly slotIds: NonEmptyArray<string>;
  readonly boilSeconds: number;
}

/** 群を作る場面の指定。orphan は待ち行列に無い品目への推奨、retired はプリセットに無い麺種の品目。 */
interface LiftSceneSpec {
  readonly batches: readonly LiftBatchSpec[];
  readonly mates: readonly LiftMateSpec[];
  readonly orphan: boolean;
  readonly retired: boolean;
}

/** batch の錨の時刻（合流していなければ null）。 */
function anchorOf(batch: LiftBatchSpec): number | null {
  return batch.anchor === null ? null : batch.serveAt + batch.anchor.skew;
}

/** 場面の指定からビュー（live・synced）を組む。 */
function liftViewOf(
  unitCount: number,
  { batches, mates, orphan, retired }: LiftSceneSpec,
): ClientView {
  const pendingOrders: PendingOrder[] = [];
  const recommendations: CookRecommendation[] = [];
  const timers: ClientTimer[] = [];
  batches.forEach((batch, batchIndex) => {
    const group = `g${batchIndex}`;
    const anchor = anchorOf(batch);
    batch.items.forEach((item, itemIndex) => {
      const externalOrderId = `o-${batchIndex}`;
      pendingOrders.push({
        externalOrderId,
        itemIndex,
        noodleType: item.noodleType,
        firmness: item.firmness,
        tableId: batch.tableId,
        arrivalTime: LIFT_SCENE_ORIGIN - item.arrivalOffset,
        slotSpan: item.slotIds.length,
        itemName: null,
        sizeName: null,
      });
      recommendations.push({
        externalOrderId,
        itemIndex,
        slotIds: item.slotIds,
        startAt: batch.serveAt - sceneBoilSeconds(item.noodleType, item.firmness) * 1000,
        group,
        anchor,
      });
    });
    // 合流した batch の錨は走行中の Timer として盤面に在る（engine は走行中の仲間の実効 endTime を anchor に写す）。
    if (batch.anchor !== null && anchor !== null) {
      timers.push({
        id: `t-anchor-${batchIndex}`,
        slotIds: batch.anchor.slotIds,
        noodleType: "Thin",
        firmness: "normal",
        startTime: anchor - batch.anchor.boilSeconds * 1000,
        endTime: anchor,
        origin: "server",
      });
    }
  });
  if (retired) {
    pendingOrders.push({
      externalOrderId: "o-retired",
      itemIndex: 0,
      noodleType: "Retired",
      firmness: "normal",
      tableId: "tb-1",
      arrivalTime: LIFT_SCENE_ORIGIN,
      slotSpan: 1,
      itemName: null,
      sizeName: null,
    });
    recommendations.push({
      externalOrderId: "o-retired",
      itemIndex: 0,
      slotIds: nonEmpty(["0"]),
      startAt: LIFT_SCENE_ORIGIN,
      group: "g-retired",
      anchor: null,
    });
  }
  if (orphan) {
    recommendations.push({
      externalOrderId: "o-orphan",
      itemIndex: 0,
      slotIds: nonEmpty(["0"]),
      startAt: LIFT_SCENE_ORIGIN,
      group: "g-orphan",
      anchor: null,
    });
  }
  mates.forEach((mate, mateIndex) => {
    const batch = batches[mate.batch % batches.length]!;
    const endTime =
      mate.kind === "match"
        ? (anchorOf(batch) ?? batch.serveAt)
        : mate.kind === "mismatch"
          ? batch.serveAt + 1000
          : LIFT_SCENE_ORIGIN + mate.boilSeconds * 1000;
    timers.push({
      id: `t-mate-${mateIndex}`,
      slotIds: mate.slotIds,
      noodleType: "Thin",
      firmness: "normal",
      startTime: endTime - mate.boilSeconds * 1000,
      endTime,
      origin: "server",
    });
  });
  return {
    ...EMPTY_VIEW,
    connectivity: "up",
    sync: "synced",
    unitCount,
    unitOrigins: defaultUnitOrigins(unitCount),
    noodlePresets: DEFAULT_NOODLE_PRESETS,
    pendingOrders,
    recommendations,
    timers,
  };
}

/**
 * 群を作る場面のビュー（live・synced）。
 *
 * batch ごとに group（`g0`, `g1`, …）・卓・serveAt を決め、1〜3 品の茹で秒から startAt を逆算する（同じ batch の
 * 品目は serveAt が揃う）。batch は合流している（全品が同じ anchor を運び、その錨の Timer が走行中に在る）か、
 * 合流していない（anchor が null）かのどちらか。錨は serveAt から少しずれうる（合流した品目は錨と h_i 以内で
 * ずれる）。別の batch が同じ卓・同じ serveAt を持っても group が違えば別の群である（AC 6.1）。加えて、待ち行列に
 * 無い品目への推奨（orphan）とプリセットに無い麺種の品目（retired）を混ぜ、群に入らない推奨（AC 1.3）を踏む。
 *
 * 走行中の仲間は batch を指して作る。match は錨（合流していなければ serveAt）に endTime が一致し、mismatch は
 * 1 秒ずれ、stray は無関係の時刻に上がる。仲間と錨の釜は推奨の釜と同じプールから引き、推奨の釜と重なる
 * （全釜 idle を破る）盤面も生む。
 */
export const genLiftView: fc.Arbitrary<ClientView> = fc
  .integer({ min: 1, max: 2 })
  .chain((unitCount) => {
    const slots = Array.from({ length: unitCount * SLOTS_PER_UNIT }, (_, slot) => String(slot));
    const genSceneSlotIds = fc
      .subarray(slots, { minLength: 1, maxLength: 2 })
      .map((chosen) => nonEmpty(chosen));
    const genItem = fc.record({
      noodleType: fc.constantFrom(...DEFAULT_NOODLE_PRESETS.map((preset) => preset.noodleType)),
      firmness: genFirmness,
      slotIds: genSceneSlotIds,
      arrivalOffset: fc.integer({ min: 0, max: 600_000 }),
    });
    const genAnchor = fc.record({
      // 錨と serveAt のずれ。0 と前後数秒（Boil_Sync の範囲）。
      skew: fc.constantFrom(0, 0, -5000, 3000),
      slotIds: genSceneSlotIds,
      boilSeconds: fc.integer({ min: 60, max: 600 }),
    });
    const genBatch = fc.record({
      tableId: fc.constantFrom(...LIFT_TABLE_POOL),
      // serveAt は基準の 2〜15 分後を 30 秒刻みで。刻みを粗くして batch どうしの serveAt の一致も生む。
      serveAt: fc.integer({ min: 4, max: 30 }).map((step) => LIFT_SCENE_ORIGIN + step * 30_000),
      anchor: fc.option(genAnchor, { nil: null }),
      items: fc.array(genItem, { minLength: 1, maxLength: 3 }),
    });
    const genMate = fc.record({
      batch: fc.nat({ max: 3 }),
      kind: fc.constantFrom<LiftMateKind>("match", "mismatch", "stray"),
      slotIds: genSceneSlotIds,
      boilSeconds: fc.integer({ min: 60, max: 600 }),
    });
    return fc
      .record({
        batches: fc.array(genBatch, { minLength: 1, maxLength: 4 }),
        mates: fc.array(genMate, { maxLength: 3 }),
        orphan: fc.boolean(),
        retired: fc.boolean(),
      })
      .map((spec) => liftViewOf(unitCount, spec));
  });

/**
 * 群を作る場面の補正後現在時刻。
 *
 * 広域（基準の 5 分前〜20 分後）に加え、提案の境界（startAt − PREP_LEAD_MS の直前・ちょうど、startAt の直前・
 * ちょうど）、錨の境界（anchor の直前・ちょうど・直後）、仲間の境界（endTime の直前・ちょうど・直後）を必ず踏む。
 * anchor 以後は群が started でなくなる（判断 16 / 20）。仲間の endTime は client の判定に現れない（跨いでも
 * 何も変わらない）が、境界として踏ませて「変わらない」を検査に載せる。
 */
export function genLiftCorrected(view: ClientView): fc.Arbitrary<number> {
  const broad = fc.integer({
    min: LIFT_SCENE_ORIGIN - 300_000,
    max: LIFT_SCENE_ORIGIN + 1_200_000,
  });
  const points = [
    ...view.recommendations.flatMap((recommendation) => [
      recommendation.startAt - PREP_LEAD_MS - 1,
      recommendation.startAt - PREP_LEAD_MS,
      recommendation.startAt - 1,
      recommendation.startAt,
      ...(recommendation.anchor === null
        ? []
        : [recommendation.anchor - 1, recommendation.anchor, recommendation.anchor + 1]),
    ]),
    ...view.timers.flatMap((timer) => [timer.endTime - 1, timer.endTime, timer.endTime + 1]),
  ];
  return points.length === 0 ? broad : fc.oneof(broad, fc.constantFrom(...points));
}

/** 群を作る場面（ビューと補正後現在時刻の組）。 */
export const genLiftScene: fc.Arbitrary<{ view: ClientView; corrected: number }> =
  genLiftView.chain((view) => genLiftCorrected(view).map((corrected) => ({ view, corrected })));
