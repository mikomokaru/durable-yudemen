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
import type { CookRecommendation, ServerMessage } from "../../src/domain/messages";
import type { PendingOrder } from "../../src/domain/order";
import type { TimerFact, NonEmptyArray, OrderItemOrigin } from "../../src/domain/timer";
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
});

/** 開始推奨の全量（空・複数の双方）。 */
const genRecommendations: fc.Arbitrary<readonly CookRecommendation[]> = fc.array(
  genRecommendation,
  { maxLength: 3 },
);

// ── Timer / View 生成器 ────────────────────────────────────────────────────────────────────────

/**
 * Timer の由来。null（アドホック）と、待ち行列と同じプールから引く品目参照（卓あり / 卓なし）を分布する。
 * 同じプールを使うのは、走行中 Timer と未着手の品目が同じ卓を持つ盤面（群の開始の判定・lift-group-display
 * 判断 16）を密に生むためである。
 */
export const genOrderItemOrigin: fc.Arbitrary<OrderItemOrigin | null> = fc.option(
  fc.record({
    externalOrderId: fc.constantFrom(...EXTERNAL_ORDER_ID_POOL),
    itemIndex: fc.integer({ min: 0, max: 2 }),
    tableId: fc.oneof(fc.constant<string | null>(null), fc.constantFrom(...TABLE_ID_POOL)),
  }),
  { nil: null },
);

/** 一件の ClientTimer。id はプールから引く（ビュー単位で一意化する）。server / local 混在。 */
export const genClientTimer: fc.Arbitrary<ClientTimer> = fc.record({
  id: fc.constantFrom(...TIMER_ID_POOL),
  slotIds: genSlotIds,
  noodleType: fc.constantFrom(...NOODLE_POOL),
  firmness: genFirmness,
  startTime: genEndTime,
  endTime: genEndTime,
  orderItem: genOrderItemOrigin,
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
  orderItem: genOrderItemOrigin,
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
