// tests/client/generators.ts — offline-degradation 純粋層の Property テストが共有する fast-check 生成器の土台。
//
// 本ファイルは「クライアント純粋層を先に検証する（PURE LAYER FIRST）」計画の足場である。
// 検証対象の純粋関数（decideView / mode / dueLocalTimers / serializeView / parsePersistedView）と
// その入力型（ClientView / ClientTimer / ClientEvent / PersistedView）は後続タスク 2.1 / 3.1 で
// src/client/connection.ts・src/client/persistence.ts に定義される。型本体がまだ無い段階でも本タスクを
// 破綻させないため、ここでは design.md「公開シンボル命名の確認 > 確定」節の確定命名に厳密に沿った
// tests 側のローカル型を置く。2.1 / 3.1 が公開型を定義した時点で、本ファイルの型定義は当該公開型の
// import へ差し替える（生成器の出力形は確定命名で固定済みのため差し替えは機械的）。
//
// ワイヤ型（TimerFact / ServerMessage）は src/domain/messages.ts の既存定義をそのまま用いる
// （要件12.2: ワイヤ形式は不変）。core（src/engine/）には一切依存しない。
//
// 入力空間の方針（design.md「生成器の前提」・要件13.3）— 次を構造的にサンプリングできること:
//   - server / local 混在の Timer（起源タグ TimerOrigin = "server" | "local" 両方）
//   - endTime == correctedNow 境界（および直前・直後）
//   - 範囲外 boilSeconds（0・負・1801 以上・非整数）
//   - 処理済み id の重複（processedIds が timers の id と重なる／無関係 id を含む）
//   - cancel 済み server の snapshot 復活（processedIds 登録済み id が snapshot/Reconcile に再出現）
//   - 不正 / 不在の永続ブロブ（壊れた JSON・未知 version・型不一致・空文字・null）

import * as fc from "fast-check";
import type { ServerMessage } from "../../src/domain/messages";
import type { TimerFact } from "../../src/domain/timer";

// ── 確定命名に沿ったローカル型（2.1 / 3.1 の公開型が定義され次第 import へ差し替える） ──────────────

/** Connectivity — 到達可能性の事実（ビューが保持する）。Mode はこれから導出する（確定: up / down）。 */
export type Connectivity = "up" | "down";

/** 起源タグ — server-confirmed と Provisional_Timer（unconfirmed）を区別する（確定: server / local）。 */
export type TimerOrigin = "server" | "local";

/** 同期フェーズ（既存 connection.ts の SyncPhase に同じ）。 */
export type SyncPhase = "connecting" | "synced" | "syncFailed";

/** クライアントが保持する Timer。TimerFact に起源タグ origin を足したもの（確定: ClientTimer）。 */
export interface ClientTimer {
  readonly id: string;
  readonly slotIds: readonly string[];
  readonly noodleType: string;
  readonly endTime: number; // エポックミリ秒（事実）。残り秒は導出（clock.ts）。
  readonly origin: TimerOrigin; // "local" = Provisional_Timer（未確定）
}

/** 受信ビュー — クライアントが保持する事実の集合。残り秒・Mode のような導出値は持たない。 */
export interface ClientView {
  readonly timers: readonly ClientTimer[]; // server-confirmed ＋ provisional（起源タグ付き）
  readonly offset: number; // クロックオフセット。degraded 中は最新値を凍結
  readonly processedIds: ReadonlySet<string>; // 茹で上がり/キャンセル処理済み（表示制御用）
  readonly connectivity: Connectivity; // 到達性の事実。Mode の導出元
  readonly sync: SyncPhase;
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** タグ付きイベント — decideView が網羅的に分岐する 7 系統（確定タグ・Reconcile は独立イベント）。 */
export type ClientEvent =
  | { readonly kind: "Server"; readonly message: ServerMessage; readonly receivedAt: number }
  | {
      readonly kind: "LocalStart";
      readonly slotIds: readonly string[];
      readonly noodleType: string;
      readonly boilSeconds: number;
      readonly newTimerId: string;
      readonly correctedNow: number;
    }
  | { readonly kind: "LocalCancel"; readonly timerId: string }
  | { readonly kind: "Connectivity"; readonly status: Connectivity }
  | { readonly kind: "LocalDone"; readonly timerId: string }
  | { readonly kind: "Tick" }
  | { readonly kind: "Reconcile"; readonly timers: readonly TimerFact[]; readonly receivedAt: number };

/** 永続ブロブの形（version 付き）。Set は配列へ、Connectivity / sync / error は永続しない（確定: ViewStore の codec 形）。 */
export interface PersistedView {
  readonly version: 1;
  readonly timers: readonly ClientTimer[]; // server-confirmed ＋ provisional（起源タグ込み）
  readonly offset: number;
  readonly processedIds: readonly string[];
}

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

// ── スカラ生成器 ───────────────────────────────────────────────────────────────────────────────

/** endTime は過去・現在・未来を広く分布。小さめ範囲で同一 endTime の衝突を誘発する。 */
const genEndTime: fc.Arbitrary<number> = fc.integer({ min: -5_000, max: 5_000 });

/** クロックオフセット。負・0・正をまたぐ。 */
const genOffset: fc.Arbitrary<number> = fc.oneof(fc.constant(0), fc.integer({ min: -200_000, max: 200_000 }));

/** 受信時刻 / serverTime のエポックミリ秒。 */
const genReceivedAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10_000_000 });

/** 起源タグ。server / local 双方。 */
const genTimerOrigin: fc.Arbitrary<TimerOrigin> = fc.constantFrom<TimerOrigin>("server", "local");

/** Connectivity の二値。 */
export const genConnectivity: fc.Arbitrary<Connectivity> = fc.constantFrom<Connectivity>("up", "down");

/** 同期フェーズ。 */
const genSyncPhase: fc.Arbitrary<SyncPhase> = fc.constantFrom<SyncPhase>("connecting", "synced", "syncFailed");

/** 直近エラー。null と具体エラーの双方。 */
const genError: fc.Arbitrary<{ readonly code: string; readonly message: string } | null> = fc.oneof(
  fc.constant(null),
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

// ── Timer / View 生成器 ────────────────────────────────────────────────────────────────────────

/** 一件の ClientTimer。id はプールから引く（ビュー単位で一意化する）。server / local 混在。 */
export const genClientTimer: fc.Arbitrary<ClientTimer> = fc.record({
  id: fc.constantFrom(...TIMER_ID_POOL),
  slotIds: fc.subarray([...SLOT_ID_POOL], { minLength: 1 }),
  noodleType: fc.constantFrom(...NOODLE_POOL),
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
  return fc.tuple(fromTimers, unrelated).map(([a, b]): ReadonlySet<string> => new Set<string>([...a, ...b]));
}

/**
 * ClientView — 0〜プール件数の ClientTimer（id をビュー内で一意化・server/local 混在）・offset（負/0/正）・
 * processedIds（空/timers と一致/無関係）・connectivity（up/down）・sync・error を持つ。
 * 空ビュー・provisional のみ・server のみ・両混在を境界として含む（要件13.3）。
 */
export const genClientView: fc.Arbitrary<ClientView> = fc
  .uniqueArray(genClientTimer, { selector: (t) => t.id, maxLength: TIMER_ID_POOL.length })
  .chain((timers) =>
    fc.record({
      timers: fc.constant<readonly ClientTimer[]>(timers),
      offset: genOffset,
      processedIds: genProcessedIds(timers.map((t) => t.id)),
      connectivity: genConnectivity,
      sync: genSyncPhase,
      error: genError,
    }),
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
  slotIds: fc.subarray([...SLOT_ID_POOL], { minLength: 1 }),
  noodleType: fc.constantFrom(...NOODLE_POOL),
  endTime: genEndTime,
});

/** TimerFact 集合（id 一意・全置換 snapshot / Reconcile の入力）。空集合も含む。 */
const genWireTimers: fc.Arbitrary<readonly TimerFact[]> = fc.uniqueArray(genWireTimer, {
  selector: (t) => t.id,
  maxLength: TIMER_ID_POOL.length,
});

/** ServerMessage — 5 種別（snapshot / started / cancelled / done / error）を分布。すべて serverTime を伴う。 */
export const genServerMessage: fc.Arbitrary<ServerMessage> = fc.oneof(
  fc.record({ type: fc.constant("snapshot" as const), serverTime: genReceivedAt, timers: genWireTimers }),
  fc.record({ type: fc.constant("started" as const), serverTime: genReceivedAt, timer: genWireTimer }),
  fc.record({ type: fc.constant("cancelled" as const), serverTime: genReceivedAt, timerId: fc.constantFrom(...TIMER_ID_POOL) }),
  fc.record({ type: fc.constant("done" as const), serverTime: genReceivedAt, timerId: fc.constantFrom(...TIMER_ID_POOL) }),
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
    view.timers.length > 0 ? fc.constantFrom(...view.timers.map((t) => t.id)) : fc.constantFrom(...TIMER_ID_POOL);
  return fc.oneof(existing, fc.constantFrom(...ABSENT_ID_POOL));
}

/**
 * タグ付きイベント 1 件 — 7 系統を分布する（要件4.2 の網羅分岐に対応）。
 * LocalStart の correctedNow はビュー endTime に対する境界を踏み、boilSeconds は範囲内/外双方。
 * LocalCancel / LocalDone の timerId は存在 / 非存在双方。
 */
export function genEvent(view: ClientView): fc.Arbitrary<ClientEvent> {
  const localStart = genCorrectedNow(view).chain((correctedNow) =>
    fc.record({
      kind: fc.constant("LocalStart" as const),
      slotIds: fc.subarray([...SLOT_ID_POOL], { minLength: 1 }),
      noodleType: fc.constantFrom(...NOODLE_POOL),
      boilSeconds: genBoilSeconds,
      newTimerId: fc.constantFrom(...NEW_ID_POOL),
      correctedNow: fc.constant(correctedNow),
    }),
  );
  return fc.oneof(
    fc.record({ kind: fc.constant("Server" as const), message: genServerMessage, receivedAt: genReceivedAt }),
    localStart,
    fc.record({ kind: fc.constant("LocalCancel" as const), timerId: genEventTimerId(view) }),
    fc.record({ kind: fc.constant("Connectivity" as const), status: genConnectivity }),
    fc.record({ kind: fc.constant("LocalDone" as const), timerId: genEventTimerId(view) }),
    fc.record({ kind: fc.constant("Tick" as const) }),
    fc.record({ kind: fc.constant("Reconcile" as const), timers: genWireTimers, receivedAt: genReceivedAt }),
  );
}

/**
 * イベント列 — 初期ビューに対するイベントの列。LocalDone と Server done の混在・Connectivity の up/down 往復・
 * LocalStart → LocalCancel の対などを、7 系統の混合列として構造的に踏む（要件13.3）。
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
export const genValidPersistedBlob: fc.Arbitrary<string> = genPersistedView.map((p) => JSON.stringify(p));

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
export const genViewAndCorrectedNow: fc.Arbitrary<{ view: ClientView; correctedNow: number }> = genClientView.chain(
  (view) => genCorrectedNow(view).map((correctedNow) => ({ view, correctedNow })),
);
