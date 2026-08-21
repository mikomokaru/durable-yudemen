// client/connection.ts — WebSocket 接続管理と、サーバ状態を映すビューの同期。
//
// このモジュールは二層に分かれる。設計哲学「計算と作用の分離」をそのまま構造にする。
//
//   1. decideView — 唯一の純粋な状態遷移。(ビュー, タグ付きイベント) → 新しいビュー の決定的関数。
//      WS にも DOM にも時計にも乱数にも localStorage にも触れない（時刻・生成 id・受信時刻は引数で受け取る・
//      要件4.1〜4.3）。既存の ServerMessage 畳み込みをタグ付きイベント列へ一般化したもので、snapshot 全置換・
//      offset 再確立・処理済み記録の刈り取り・通知冪等性は、すべて既存の純粋関数（clock / notification）へ
//      通してここに集約する。snapshot と Reconcile は同一規律 reconcileServerConfirmed を共有する（重複の根絶）。
//   2. openTimerConnection — 作用の端（UI が唯一対話する窓口）。UI のインテント（getView / subscribe /
//      start / cancel / close）を Mode で経路選択し、トランスポートをポートの背後に隠す。WS のライフサイクル
//      （開閉・ping/pong 生存検出・再接続・Connectivity 確定）は Connectivity_Watch（watchConnectivity）へ
//      委譲し、状態の永続化・boot 再水和は ViewStore（localStorage 裏側）へ委譲する。状態の決定は decideView に
//      委ね、自身は「世界を変える手続き」——Mode による送信/ローカル畳み込みの振り分け・down→up での Reconcile
//      契機づけ・秒読みティックとローカル茹で上がりアラート・ビュー変化のたびの永続化——だけを担う。
//
// 導出値（残り秒）は状態に昇格させない。ビューが保持する事実は endTime を含む Timer 集合・
// クロックオフセット・処理済み timerId 集合・同期フェーズだけであり、残り秒はクライアント側の
// 描画のたびに clock.ts の純粋導出で算出する（要件10.1 の思想をクライアントへ延長）。
// ティックはビューを変えない。再描画を促して remaining を導出し直させるためだけにある（要件10.5）。

import { BOIL_SECONDS_MAX, BOIL_SECONDS_MIN } from "../engine/types";
import type { CookRecommendation, ServerMessage } from "../domain/messages";
import type { PendingOrder } from "../domain/order";
import type { TimerFact, NonEmptyArray } from "../domain/timer";
import { DEFAULT_UNIT_COUNT, DEFAULT_NOODLE_PRESETS } from "../domain/store";
import type { NoodlePreset } from "../domain/store";
import { DEFAULT_FIRMNESS, type Firmness } from "../domain/firmness";
import { clockOffset } from "./clock";
import {
  isPingBlackholeActive,
  pingBlackholeDebugEnabled,
  probeReachability,
  watchConnectivity,
  withPingBlackhole,
} from "./connectivity";
import type { ConnectivityWatchFactory } from "./connectivity";

// dev/test 限定の縮退テストトグル。UI（窓口の利用者）は connectivity 層を直接 import せず、
// 唯一の窓口である本モジュール経由でのみ blackhole の有効状態を読み書きする（静的検査 c・要件4.4）。
// 本番では pingBlackholeDebugEnabled() が false を返し、これらは参照されず tree-shaking 対象になる（要件14.4）。
export { pingBlackholeDebugEnabled, isPingBlackholeActive, setPingBlackholeActive } from "./connectivity";
import { markProcessed, shouldHandleDone } from "./notification";
import { localStorageViewStore } from "./persistence";
import type { ViewStore } from "./persistence";

/** 同期フェーズ — サーバ状態への追随状況。残り秒のような導出値ではなく、接続の事実。 */
export type SyncPhase = "connecting" | "synced" | "syncFailed";

/** Connectivity — 到達可能性の事実（ビューが保持する）。Mode はこれから導出する（要件3.1）。 */
export type Connectivity = "up" | "down";

/** Mode — Connectivity からの導出値。状態として保持しない（要件3.3）。 */
export type Mode = "live" | "degraded";

/**
 * 到達不能理由 — Connectivity が down のときにのみ意味を持つ分類結果（要件15）。
 *
 * ブラウザ WebSocket API はハンドシェイクの HTTP ステータスを隠すため、権限なし（接続時拒否）は
 * close code 1006 に潰れ、純粋なオフラインと区別できない。この分類は帯域外 HTTP fetch（probeReachability）
 * が導く付加情報であって、Connectivity（二値）・Mode（導出）とは独立の別軸である（要件15.12）。
 *
 * **"offline" の意味は connectivity.ts の classifyReachability の docstring が定義の正本である**
 * （同一概念を二箇所で定義しない・signin-required-misreported-as-offline 要件3.2）。ここでは繰り返さない
 * ——かつてこの行は「回線喪失・特段の理由なし」と書き、あちらは「分類不能」と書いていた。同じ値が事実の
 * 主張と知識の不在を同時に背負い、後者の経路を通った結果が前者の顔で表示されたのが本 spec のバグである。
 * 既定値としての扱いだけをここに残す: up 時・boot 時・分類前はすべて "offline" に潰す。
 */
export type UnreachableReason = "offline" | "noAccess" | "signInRequired";

/** 起源タグ — server-confirmed と Provisional_Timer（unconfirmed）を区別する。 */
export type TimerOrigin = "server" | "local";

/**
 * クライアントが保持する Timer。TimerFact に起源タグを足したもの（ワイヤ形式は不変・要件12.2）。
 *
 * 共有芯の TimerFact を交差型で延長して導出する（id / slotId / noodleType / endTime を再宣言しない）。
 * これにより TimerFact のフィールド増減が ClientTimer へ自動追従し、二重定義によるドリフトを型で防ぐ。
 * origin === "server" は server-confirmed（正本由来）、"local" は degraded 中に生まれた
 * Provisional_Timer（未確定なローカル意図）。残り秒は持たず endTime（事実）から導出する。
 */
export type ClientTimer = TimerFact & {
  readonly origin: TimerOrigin; // "local" = Provisional_Timer（未確定）
};

/**
 * 受信ビュー — サーバ状態を映す、クライアントが保持する事実の集合。
 *
 * 残り秒は持たない（描画のたびに clock.ts で導出）。Mode も持たない（connectivity から mode() で導出）。
 * 担当スコープによる絞り込みも持たない（表示時に assignment.ts の純粋導出で射影する。保持は全量・表示は導出）。
 */
export interface ClientView {
  /** アクティブな全 Timer（全量保持・起源タグ付き）。snapshot で server-confirmed を全置換する（要件4.2 / 4.5）。 */
  readonly timers: readonly ClientTimer[];
  /**
   * 未着手オーダーの全量（計画対象の上限を超える分も含む）。snapshot の写しに留める（online-cook-scheduling AC 2.4）。
   *
   * 到着順の並び・担当範囲での絞り込みは表示時の導出であって、ここには保持しない（保持は全量・表示は導出）。
   * Timer と違い provisional の対概念を持たない——待ち行列はサーバだけが確定させる事実なので、全置換で足りる。
   */
  readonly pendingOrders: readonly PendingOrder[];
  /**
   * サーバが Committed_Plan から導いた開始推奨の写し（online-cook-scheduling AC 8.1 / 8.5）。
   *
   * client 側でも状態を増やさず表示のためだけに読む。推奨開始時刻の到来では何も起こさない
   * （自動開始しない・AC 8.2）——ゆえにここに時刻起動の仕掛けを持たない。
   */
  readonly recommendations: readonly CookRecommendation[];
  /** 最新のクロックオフセット。serverTime を伴う受信のたびに再確立する（要件10.3 / 10.6）。 */
  readonly offset: number;
  /** done / cancelled を処理済みとして記録した timerId 集合（表示制御用・SSOT のコピーではない）。 */
  readonly processedIds: ReadonlySet<string>;
  /**
   * 直前の調理結果（client 専用・ベストエフォート）。slotId → { 麺種, 記録時刻 }。除去される直前に記録し、
   * idle 表示で一定時間だけ提示する（要件13.5/13.6）。理由を問わず一様——snapshot 差分で消えた Timer・
   * degraded の LocalComplete / LocalCancel のいずれでも記録する（要件5.1/5.2）。SSOT ではなく processedIds と
   * 同じ表示制御用ローカル情報で、永続もしない（リロードで消えてよい）。
   */
  readonly lastResults: ReadonlyMap<string, { readonly noodleType: string; readonly at: number }>;
  /** 到達性の事実。Mode の導出元（要件3.1）。 */
  readonly connectivity: Connectivity;
  /** down 時のみ意味を持つ分類結果。既定 "offline"（要件15.7 / 15.12）。Connectivity(二値)・Mode(導出) とは独立の別軸。 */
  readonly unreachableReason: UnreachableReason;
  /** 同期フェーズ。 */
  readonly sync: SyncPhase;
  /** 直近のサーバエラー（拒否・失敗）。snapshot 受信で解消する。 */
  readonly error: { readonly code: string; readonly message: string } | null;
  /** 店舗のユニット総数（サーバ権威・受信した事実）。config 受信で確定する。担当範囲のクランプ元。 */
  readonly unitCount: number;
  /** 店舗が提供する麺種プリセット（サーバ権威・受信した事実）。config 受信で確定する。開始 UI の選択肢の元。 */
  readonly noodlePresets: readonly NoodlePreset[];
}

/**
 * タグ付きイベント — Client_Decide（decideView）が網羅的に分岐する判別共用体（要件4.2）。
 *
 * 時刻・生成 id・受信時刻はすべて引数として運ぶ（純粋性のため・要件4.3）。本サブタスクでは型のみ定義し、
 * 各 kind の畳み込みは後続タスク（2.3 / 2.4）で decideView に実装する。
 */
export type ClientEvent =
  | { readonly kind: "Server"; readonly message: ServerMessage; readonly receivedAt: number } // 既存 reduceView 相当
  | {
      readonly kind: "LocalStart";
      readonly slotIds: NonEmptyArray<string>;
      readonly noodleType: string;
      readonly boilSeconds: number;
      readonly newTimerId: string;
      readonly correctedNow: number;
    } // 要件6
  | { readonly kind: "LocalCancel"; readonly timerId: string; readonly now: number } // 要件7 / 5.2（除去直前の麺種を残滓化）
  | { readonly kind: "LocalComplete"; readonly timerId: string; readonly now: number } // boiled の明示消し込み（degraded）
  | { readonly kind: "Connectivity"; readonly status: Connectivity } // 要件2/3
  | { readonly kind: "Classify"; readonly reason: UnreachableReason } // 要件15。到達不能理由の分類結果を畳む。fetch は端（probeReachability）が担い、ここには結果だけが届く
  | { readonly kind: "LocalDone"; readonly timerId: string } // 要件8（茹で上がりアラート記録）
  | { readonly kind: "Tick" } // 要件5（ビュー不変）
  | {
      readonly kind: "Reconcile"; // 要件11（決定 B）
      readonly timers: readonly TimerFact[];
      // 待ち行列と推奨も運ぶ。Timer と違い provisional の対概念を持たないため snapshot と同じ全置換で足りる。
      // 運ばないと再接続後の最初の snapshot だけ待ち行列が更新されず、他端末との一致（AC 2.4）が破れる。
      readonly pendingOrders: readonly PendingOrder[];
      readonly recommendations: readonly CookRecommendation[];
      readonly receivedAt: number;
    };

/** 初期ビュー。まだ何も受信しておらず接続中。boot 時は接続未確立 = degraded 起点（要件3）。 */
export const EMPTY_VIEW: ClientView = {
  timers: [],
  pendingOrders: [],
  recommendations: [],
  offset: 0,
  processedIds: new Set<string>(),
  lastResults: new Map<string, { readonly noodleType: string; readonly at: number }>(),
  connectivity: "down",
  unreachableReason: "offline",
  sync: "connecting",
  error: null,
  unitCount: DEFAULT_UNIT_COUNT,
  noodlePresets: DEFAULT_NOODLE_PRESETS,
};

/**
 * Mode はビューの導出値。参照のたびに Connectivity から関数的に求める（要件3.1〜3.3）。
 * ClientView は Mode を独立フィールドに持たない（二つの真実の源を作らない）。
 */
export function mode(view: ClientView): Mode {
  return view.connectivity === "up" ? "live" : "degraded";
}

/**
 * 唯一の純粋な状態遷移 — (ビュー, タグ付きイベント) → 新しいビュー。
 *
 * 同じ入力に同じ出力を返し、副作用を一切持たない。時刻・生成 id・受信時刻はイベントに含まれる引数のみに
 * 由来し、Date.now() / crypto.randomUUID() / WS / DOM / localStorage を一切参照しない（要件4.1〜4.3）。
 * 判別共用体 ClientEvent を網羅的に分岐する（要件4.2）。
 *
 * Server 系（snapshot / started / cancelled / done / error）と Reconcile は server-confirmed 置換規律を共有する。
 * ローカル / 接続性 / Tick 系（LocalStart / LocalCancel / Connectivity / LocalDone / Tick）は degraded 権限経路の畳み込みで、
 * いずれも引数で運ばれた時刻・生成 id のみに由来し、暗黙の時計・乱数に触れない（要件4.3）。
 */
export function decideView(view: ClientView, event: ClientEvent): ClientView {
  switch (event.kind) {
    case "Server":
      return decideServerMessage(view, event.message, event.receivedAt);

    case "Reconcile":
      // snapshot と同一規律（server-confirmed 全置換・provisional 保持・差分残滓・processedIds 刈り取り・要件4.1〜4.7）。
      // Reconcile イベントは serverTime を運ばないため offset は凍結する（reconcileServerConfirmed は offset を
      // 触らず、接続中に確立した最新値を維持・要件5.2）。残滓記録時刻 at には受信時刻 receivedAt を渡す。
      // 待ち行列と推奨は snapshot 分岐と同じ全置換（サーバだけが確定させる事実ゆえ保持すべきローカル分が無い）。
      return {
        ...reconcileServerConfirmed(view, event.timers, event.receivedAt),
        pendingOrders: event.pendingOrders,
        recommendations: event.recommendations,
      };

    case "LocalStart":
      return decideLocalStart(view, event);

    case "LocalCancel":
      return decideLocalCancel(view, event.timerId, event.now);

    case "LocalComplete":
      // boiled の明示消し込み（degraded）。対象を除去し、ローカル再発火抑止のため処理済みに記録する。
      return decideLocalComplete(view, event.timerId, event.now);

    case "Connectivity":
      // 到達性の事実だけをセットする。offset は変えない（degraded 中の凍結を維持・要件5.2）。
      // Mode は mode(view) で導出するためここでは更新しない（導出値を状態に昇格させない・要件3.3）。
      // up 復帰時は unreachableReason を既定 "offline" へ戻す。到達不能理由は down 時のみ意味を持つ分類結果ゆえ、
      // up に古い noAccess / signInRequired を残さない——「down 時のみ意味を持つ」規律を表示側の条件分岐ではなく
      // 構造（一方向の流れ）で担保する（要件15.12）。down のときは変えない（次の Classify が上書きするまで直前値を保つ）。
      return {
        ...view,
        connectivity: event.status,
        unreachableReason: event.status === "up" ? "offline" : view.unreachableReason,
      };

    case "Classify":
      // 到達不能理由の分類結果を畳むだけ（純粋・他フィールド不変）。fetch / HTTP ステータス判定 / DOM / 時計に
      // 一切触れない——それらは端（probeReachability）の責務で、ここには結果 reason だけが届く（要件15.7 / 15.8）。
      return { ...view, unreachableReason: event.reason };

    case "LocalDone":
      // 端が音を鳴らした分を記録するだけ。decideView は音を鳴らさない（計算と作用の分離）。
      // 既に処理済みなら冪等に無視し、未処理のときだけ processedIds へ登録する（要件8.1/8.2）。
      if (!shouldHandleDone(event.timerId, view.processedIds)) {
        return view;
      }
      return { ...view, processedIds: markProcessed(view.processedIds, event.timerId) };

    case "Tick":
      // ビュー不変。再描画を促して残りを導出し直させるためだけにある（参照同一を返す・要件5.1）。
      return view;
  }
}

/**
 * LocalStart の畳み込み — degraded 中のローカル start を Provisional_Timer として注入する（decideView の分岐）。
 *
 * boilSeconds が 1〜1800 の整数（両端含む）のときだけ、origin:"local" の Timer をちょうど 1 件足す。
 * 範囲外（0・負・1801 以上・非整数・非有限）はビュー不変として view をそのまま返す（要件6.1/6.2/6.5）。
 * 範囲境界はサーバ core の検証規律（BOIL_SECONDS_MIN / BOIL_SECONDS_MAX）と同じ値を共有し二度定義しない。
 */
function decideLocalStart(
  view: ClientView,
  event: Extract<ClientEvent, { kind: "LocalStart" }>,
): ClientView {
  // 非整数・非有限・範囲外はローカルでも構築させない（サーバ core の検証規律に整合・要件6.5）。
  if (
    !Number.isInteger(event.boilSeconds) ||
    event.boilSeconds < BOIL_SECONDS_MIN ||
    event.boilSeconds > BOIL_SECONDS_MAX
  ) {
    return view;
  }
  // endTime は補正後現在時刻 + 茹で時間の絶対エポックミリ秒（事実）。startTime は補正後現在時刻（事実）。
  // 残り秒・進捗は持たず、この2点から導出する（要件6.1）。
  const provisional: ClientTimer = {
    id: event.newTimerId,
    slotIds: event.slotIds,
    noodleType: event.noodleType,
    firmness: DEFAULT_FIRMNESS,
    startTime: event.correctedNow,
    endTime: event.correctedNow + event.boilSeconds * 1000,
    origin: "local",
  };
  // 新規開始した駆動スロットの直前結果（残滓）は解除する（要件13.7）。
  return { ...view, timers: [...view.timers, provisional], lastResults: clearLastResults(view.lastResults, event.slotIds) };
}

/**
 * LocalCancel の畳み込み — degraded 中のローカル cancel を起源別に適用する（decideView の分岐）。
 *
 *   - origin==="local"（Provisional_Timer）→ timers から除去するだけ（要件7.1）。
 *   - origin==="server"（server-confirmed）→ 除去に加え markProcessed で記録し、後続のローカル発火を抑止する（要件7.2）。
 *   - 該当 id が存在しない → ビュー不変（view をそのまま返す）。
 *
 * 起源によらず、除去直前の麺種を直前結果（残滓）として記録する。中断（Cancel）でも完了（Complete）でも
 * 「在ったものが消えた」事実だけで一様に残滓を出す——degraded 経路も snapshot 差分と同じ規律に揃える
 * （LocalComplete と同一手順・要件5.2 / 5.3）。除去時刻 now を残滓の提示時間窓の起点 at に運ぶ。
 */
function decideLocalCancel(view: ClientView, timerId: string, now: number): ClientView {
  const target = view.timers.find((timer) => timer.id === timerId);
  if (target === undefined) {
    return view;
  }
  const timers = view.timers.filter((timer) => timer.id !== timerId);
  // server-confirmed のローカル cancel はローカル発火抑止のため処理済みに記録する（要件7.2）。
  const processedIds =
    target.origin === "server" ? markProcessed(view.processedIds, timerId) : view.processedIds;
  return {
    ...view,
    timers,
    processedIds,
    // 除去直前の麺種を直前結果として記録する（LocalComplete と同一・理由を問わない一様残滓・要件5.2）。
    lastResults: recordLastResults(view.lastResults, target, now),
  };
}

/**
 * LocalComplete の畳み込み — degraded 中の boiled 明示消し込みを適用する（decideView の分岐）。
 *
 * 起源によらず対象 Timer を除去し、処理済みに記録してローカル再発火を抑止する。該当 id が無ければ
 * ビュー不変。cancel と同形（id 指定で除去）だが別概念——完了は「茹で上がりの確認」である。
 */
function decideLocalComplete(view: ClientView, timerId: string, now: number): ClientView {
  const target = view.timers.find((timer) => timer.id === timerId);
  if (target === undefined) {
    return view;
  }
  return {
    ...view,
    timers: view.timers.filter((timer) => timer.id !== timerId),
    processedIds: markProcessed(view.processedIds, timerId),
    // 除去直前の麺種を直前結果として記録する（idle 表示で一定時間提示する・要件13.5）。
    lastResults: recordLastResults(view.lastResults, target, now),
  };
}

/** 明示完了で除去される Timer の麺種を、その駆動スロット（slotId）ごとに直前結果として記録する。 */
function recordLastResults(
  prev: ClientView["lastResults"],
  timer: ClientTimer,
  at: number,
): ClientView["lastResults"] {
  const next = new Map(prev);
  for (const slotId of timer.slotIds) next.set(slotId, { noodleType: timer.noodleType, at });
  return next;
}

/** 指定スロット（slotId 群）の直前結果を消す。新規開始でそのスロットの残滓を解除する（要件13.7）。 */
function clearLastResults(
  prev: ClientView["lastResults"],
  slotIds: readonly string[],
): ClientView["lastResults"] {
  if (!slotIds.some((slotId) => prev.has(slotId))) return prev;
  const next = new Map(prev);
  for (const slotId of slotIds) next.delete(slotId);
  return next;
}

/**
 * degraded 中のローカル発火対象を導出する純粋関数（端が毎ティック呼ぶ・要件8.1/8.3）。
 *
 * endTime が補正後現在時刻 correctedNow 以下に達し、かつ id が processedIds に未登録の Timer を
 * server / local 双方から返す。アラート音は持たない（音を鳴らすのは端の責務・計算と作用の分離）。
 */
export function dueLocalTimers(view: ClientView, correctedNow: number): readonly ClientTimer[] {
  return view.timers.filter(
    (timer) => timer.endTime <= correctedNow && shouldHandleDone(timer.id, view.processedIds),
  );
}

/**
 * Server メッセージの畳み込み — 受信した ServerMessage を現在ビューへ適用する（decideView の Server 分岐）。
 *
 * receivedAt は受信時点のローカル時刻（エポックミリ秒）。offset 算出に用いるため引数で受け取り、
 * Date.now() を関数内に持ち込まない（純粋性を保ち、任意時刻で検証可能にする）。
 */
function decideServerMessage(view: ClientView, message: ServerMessage, receivedAt: number): ClientView {
  // すべての server → client メッセージは serverTime を伴う。受信のたびに offset を最新化する（要件2.5）。
  const offset = clockOffset(message.serverTime, receivedAt);

  switch (message.type) {
    case "snapshot": {
      // server-confirmed の全置換＋直前集合との差分で残滓を導く唯一の権威表現（要件4.1〜4.7）。
      // 初回 hydration では prevServer / provisional が空ゆえ全置換に縮退する。offset 再確立・同期確定・
      // エラー解消を重ねる。残滓記録時刻 at には受信時刻 receivedAt を渡す（要件4.2 / 5.1）。
      const reconciled = reconcileServerConfirmed(view, message.timers, receivedAt);
      // 待ち行列と推奨も同じ snapshot が運ぶ（種別を増やさない・online-cook-scheduling AC 2.3 / 2.4）。
      // Timer と違い起源の区別が無いため全置換で足りる。導出（到着順の並び・担当範囲での絞り込み・
      // 開始に要る茹で秒）は表示時に行い、ここでは写すだけに留める。
      return {
        ...reconciled,
        pendingOrders: message.pendingOrders,
        recommendations: message.recommendations,
        offset,
        sync: "synced",
        error: null,
      };
    }

    case "config":
      // 店舗設定の一方向受信（サーバ権威・クライアント不変）。ユニット総数と麺種プリセットを確定し offset も最新化する。
      // 稼働中の差し替え（運用エンドポイント発の再配信）も同じ経路で反映される（要件2.3）。
      //
      // 計画のパラメータ（重み・許容幅・slot のグリッド座標）は読まない。それらは計画の採点（サーバ側の
      // 計算）にのみ効く事実で、client の表示・導出のどこからも参照されない。読み手の無い写しをビューへ
      // 置けば、サーバ設定の第二の真実を抱えるだけになる（online-cook-scheduling AC 3.4 の「表示・導出にのみ
      // 用い変更要求を送らない」を、最小の形——受け取っても持たない——で満たす）。
      return { ...view, offset, unitCount: message.unitCount, noodlePresets: message.noodlePresets };

    case "error":
      // 拒否・失敗の通知（要件2.4）。次の snapshot 受信で解消する（error: null）。
      return { ...view, offset, error: { code: message.code, message: message.message } };
  }
}

/**
 * server-confirmed を全置換し provisional は保持しつつ、直前集合との差分で一様残滓を導く共有規律
 * （snapshot と Reconcile が共有・要件4.1〜4.7 / 5.1 / 5.3）。
 *
 * 純粋関数。offset / connectivity / sync / error など serverTimers から導出できない事実は呼び出し元に委ね、
 * ここでは timers の置換・残滓（lastResults）の差分導出・processedIds の刈り取りだけを担う（重複の根絶）。
 *
 *   - (a) server-confirmed（origin==="server"）は serverTimers（すべて origin:"server" 化）で全置換し、
 *     Provisional_Timer（origin==="local"）は保持する（要件4.1 / 4.7）。
 *   - (b) 直前 server-confirmed に在り新 serverTimers に無い Timer（消えた Timer）の noodleType を、
 *     再占有されていない各 slotId へ受信時刻 at とともに残滓記録する。理由（Complete / Cancel / Fire→Complete）を
 *     問わず一様に扱う（要件4.2 / 5.1）。
 *   - (c) 占有スロット（新 serverTimers ∪ 保持 provisional）の残滓は消去する（要件4.3 / 5.3）。
 *   - (d) processedIds は「serverTimers の id ∪ 保持 provisional の id」に属するものだけ残す（記録を有界に保ちつつ、
 *     復活した server-confirmed のローカル発火抑止を維持する・要件4.4）。
 *
 * boiled / running 状態とアラート dedup は endTime からの導出を維持し、状態へ昇格させない（要件4.4）。
 * 同一 serverTimers を二度適用しても timers・processedIds は不変、lastResults はキー集合不変で新規残滓を生まない
 * （at の更新のみ・冪等・要件4.5）。残滓は (直前 server-confirmed, serverTimers, at) のみから導出し、
 * TimerFact への追加フィールドに依存しない（要件4.6）。
 */
export function reconcileServerConfirmed(
  view: ClientView,
  serverTimers: readonly TimerFact[],
  at: number,
): ClientView {
  // 直前の server-confirmed と provisional を分ける（差分の基準は直前 server-confirmed）。
  const prevServer = view.timers.filter((timer) => timer.origin === "server");
  const provisional = view.timers.filter((timer) => timer.origin === "local");
  // (a) server-confirmed は serverTimers で全置換する。すべて起源タグを "server" 化する（要件4.1）。
  const confirmed: readonly ClientTimer[] = serverTimers.map((timer) => ({ ...timer, origin: "server" as const }));

  // 占有スロット = 新 serverTimers のスロット ∪ 保持 provisional のスロット。
  const occupied = new Set<string>();
  for (const timer of serverTimers) for (const slotId of timer.slotIds) occupied.add(slotId);
  for (const timer of provisional) for (const slotId of timer.slotIds) occupied.add(slotId);

  // 新 server-confirmed の id 集合（消えた Timer の判定に用いる）。
  const newIds = new Set<string>(serverTimers.map((timer) => timer.id));

  // (c) 占有スロットの残滓は先に消去する（新規/継続タイマーが乗っているスロット・要件4.3 / 5.3）。
  const nextLastResults = new Map(view.lastResults);
  for (const slotId of occupied) nextLastResults.delete(slotId);

  // (b) 消えた Timer（直前 server にいて新 server にいない）の麺種を、再占有されない各 slotId へ残滓記録する
  //     （理由を問わず一様・要件4.2 / 5.1）。占有スロットは (c) で除去済みかつ記録条件で除外する。
  for (const timer of prevServer) {
    if (newIds.has(timer.id)) continue;
    for (const slotId of timer.slotIds) {
      if (occupied.has(slotId)) continue;
      nextLastResults.set(slotId, { noodleType: timer.noodleType, at });
    }
  }

  // (d) 保持 id 集合 = serverTimers に含まれる id ∪ 保持される provisional の id（要件4.4）。
  const retainedIds = new Set<string>(newIds);
  for (const timer of provisional) retainedIds.add(timer.id);

  // processedIds は保持 id 集合に属するものだけ残す（記録を有界に保ち、復活キャンセル抑止を維持・要件4.4）。
  const prunedProcessed = new Set<string>();
  for (const id of view.processedIds) {
    if (retainedIds.has(id)) prunedProcessed.add(id);
  }

  return {
    ...view,
    timers: [...confirmed, ...provisional],
    lastResults: nextLastResults,
    processedIds: prunedProcessed,
  };
}

/** 最小の WebSocket 抽象 — 送信と切断のみ。作用の端をテスト可能な継ぎ目に保つ。 */
export interface Socket {
  send(data: string): void;
  close(): void;
}

/** Socket からの受信反応。作用の端が呼び出す。 */
export interface SocketListeners {
  readonly onOpen: () => void;
  readonly onMessage: (data: string) => void;
  /**
   * 切断時に呼ぶ。close code を運ぶ（省略可＝コード不明）。到達性検出（down 確定）はコードに依らないが、
   * サーバが添えるアプリ固有の拒否符号（transport/rejection.ts の REJECTION_CLOSE_CODE）を Connectivity_Watch が
   * 識別して「接続拒否」を導けるよう、コードを透過する（要件7.6）。
   */
  readonly onClose: (code?: number) => void;
  readonly onError: () => void;
}

/** Socket を開く関数。既定はブラウザ WebSocket。テストでは差し替える。 */
export type SocketOpener = (url: string, listeners: SocketListeners) => Socket;

/** 接続のコントローラ。UI（タスク20）はこれを通してビューを購読し、操作を送る。 */
export interface TimerConnection {
  /** 現在のビューを取得する（描画のたびに残りを導出する元）。 */
  getView(): ClientView;
  /** ビュー更新（受信・接続状態変化・秒読みティック）を購読する。戻り値で解除する。 */
  subscribe(listener: () => void): () => void;
  /**
   * タイマー開始操作を送る（担当スコープの制限は UI の責務）。1 Timer は 1 つ以上のスロットを駆動する（非空）。
   *
   * orderItem は「どの Pending_Order の品目から始めたか」。推奨から開始する経路だけが添え、サーバが
   * 待ち行列から当該品目を除く手がかりにする（online-cook-scheduling AC 8.3 / 8.4）。省略時はアドホック
   * 麺茹で（POS を経ない開始）で、推奨と異なる操作も従来どおりこの経路を通る。
   */
  start(
    slotIds: NonEmptyArray<string>,
    noodleType: string,
    boilSeconds: number,
    orderItem?: { readonly externalOrderId: string; readonly itemIndex: number },
  ): void;
  /** タイマーキャンセル操作を送る。 */
  cancel(timerId: string): void;
  /** 茹で上がりの明示完了（消し込み）を送る。boiled な Timer を除去する。 */
  complete(timerId: string): void;
  /** 走行中の茹で加減変更を送る（live のみ・サーバが endTime を引き直す）。 */
  adjust(timerId: string, firmness: Firmness): void;
  /** 接続を閉じ、再接続・ティックを停止する。 */
  close(): void;
}

/** openTimerConnection のオプション。時計・Socket・永続・接続性検出・アラートを注入可能にしてテスト容易性を保つ。 */
export interface ConnectionOptions {
  /**
   * 接続先店舗の storeId（URL パス `/s/{storeId}/` 由来）。永続のスコープ元であり省略不能（要件1.3 / 1.5）。
   * 既定 ViewStore は必ずこの storeId でスコープされる（localStorageViewStore(storeId)）——店舗を跨いだ
   * ビューの漏洩をキー空間の分離で構造的に封じるため、スコープは条件付きではなく必須（不正な状態を表現不能にする）。
   */
  readonly storeId: string;
  /** 接続先 WS URL（例: wss://host/s/{storeId}/ws）。 */
  readonly url: string;
  /** 現在時刻の採取。既定 Date.now（offset 算出・補正後現在時刻・受信時刻に用いる）。 */
  readonly now?: () => number;
  /** Provisional_Timer の id を端で生成する関数。既定 crypto.randomUUID（要件6.1）。 */
  readonly newId?: () => string;
  /** Socket を開く関数。既定はブラウザ WebSocket。Connectivity_Watch へ渡される。 */
  readonly openSocket?: SocketOpener;
  /** 状態の永続化・再水和の裏側。既定 localStorage（要件4.7 / 11）。 */
  readonly persistence?: ViewStore;
  /** WS 生存検出（Connectivity_Watch）の生成関数。既定 watchConnectivity（要件1 / 2）。 */
  readonly connectivity?: ConnectivityWatchFactory;
  /** 茹で上がりアラートの発火（作用の端）。既定は no-op。decideView は決して鳴らさない（要件8.1）。 */
  readonly onBoilAlert?: (timer: ClientTimer) => void;
  /**
   * サーバに接続を拒否されたときの作用（既定は no-op・要件7.6）。未プロビジョニング／Roster 不一致／
   * deactivated による拒否を Connectivity_Watch が REJECTION_CLOSE_CODE から検出したら呼ばれる。App は
   * ここで Entry（`/`）へ戻り、行き先を解決し直す。redirect は純粋な決定（decideView）から切り離した
   * 端の作用ゆえビューには昇格させない（計算と作用の分離）。
   */
  readonly onRejected?: () => void;
  /** 接続確立から snapshot 受信までの猶予（ミリ秒）。既定 2000（要件4.1 / 4.6）。 */
  readonly syncTimeoutMs?: number;
  /**
   * 切断後に再接続を試みるまでの遅延（ミリ秒）。既定 1000。
   *
   * 再接続のライフサイクルは Connectivity_Watch が所有する（重複の根絶）。既定の再接続遅延は
   * Connectivity_Watch 側の既定（1000ms）と一致する。本オプションは公開シグネチャの後方互換として残す。
   */
  readonly reconnectDelayMs?: number;
  /** 残り再算出を促すティック間隔（ミリ秒）。既定 1000。1000ms 以下に保つ（要件10.5 / 5.1）。 */
  readonly tickMs?: number;
}

// ── 宛先の同定（addressing）— URL パスと storeId の相互変換（要件1.3） ──
//
// 同定（どの店舗か）と認可（入ってよいか）を分離する設計に従い、クライアントは自身の URL パスから
// storeId を読み、その同一 storeId で WS へ接続する（identity から宛先を導出しない）。storeId の型は
// client 側では素の string に留める（registry のイデア型 StoreId を client へ引き込まない — 依存方向
// client → domain を保つ）。許容形（[a-z0-9-]・1..64）は Worker が到達前に検証済み（要件1.2）だが、
// パス外（Entry `/` など）を null として弾けるよう、抽出時にも同じ許容形で照合する。

/** `/s/{storeId}/` の許容形。storeId は許容文字集合（[a-z0-9-]）かつ長さ 1..64（要件1.2 と同一形）。 */
const STORE_PATH_PATTERN = /^\/s\/([a-z0-9-]{1,64})(?:\/|$)/;

/**
 * URL パス（`window.location.pathname`）から接続先 storeId を読む（要件1.3）。
 *
 * `/s/{storeId}/`（画面）・`/s/{storeId}/ws`（WS）・`/s/{storeId}`（末尾スラッシュ無し）のいずれからも
 * storeId を取り出す。店舗パス外（Entry `/` や不正な storeId）は null を返す——呼び出し側（App）が
 * 「接続先なし」として扱い、行き先解決へ委ねる。純粋関数（window にも時計にも触れない）。
 */
export function storeIdFromPath(pathname: string): string | null {
  const match = STORE_PATH_PATTERN.exec(pathname);
  if (match === null) {
    return null;
  }
  return match[1] ?? null;
}

/**
 * storeId から同一オリジンの WS エンドポイント URL を構成する（要件1.3）。
 *
 * https なら wss、それ以外は ws。宛先は必ず `/s/{storeId}/ws`——URL から読んだ storeId と同一の storeId で
 * 接続することを、この一箇所の構成で担保する（宛先の二重定義を作らない）。window を読む作用の端。
 */
export function timerSocketUrl(storeId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/s/${storeId}/ws`;
}

/**
 * 店舗切替の選択肢 — Entry が渡す宛先 storeId と表示名 name の組（要件7.4）。
 *
 * storeId はランダムスラッグゆえ人間には無意味であり、切替 UI の表示には必ず name を用いる。client は
 * registry のイデア型を引き込まず素の string で持つ（依存方向 client → domain を保つ）。
 */
export interface StoreChoice {
  readonly storeId: string;
  readonly name: string;
}

/**
 * GET /entry/stores の 200 ボディ（パース済み JSON・unknown）から店舗選択肢 (storeId, name)[] を取り出す純粋関数。
 *
 * 配列でなければ空配列、配列なら storeId・name の string を持つ要素のみを受理する（未知形・欠落は静かに除く）。
 * fetch も status 判定もしない純粋な取り出し部であり、fetchStoreChoices（切替 UI）と probeReachability
 * （到達不能理由の分類・connectivity.ts）が同一の取り出し規律を共有するために公開する（重複の根絶）。
 * 「取り出す」という概念そのものを名に据え、汎用語（parse/process 一般ではなく対象を明示）で境界を語る。
 */
export function parseStoreChoices(data: unknown): readonly StoreChoice[] {
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter(
    (item): item is StoreChoice =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { storeId?: unknown }).storeId === "string" &&
      typeof (item as { name?: unknown }).name === "string",
  );
}

/**
 * GET /entry/stores を取得し、複数店舗担当者の切替 UI 用の店舗選択肢を返す（要件7.4）。
 *
 * Access ON のときだけサーバが (storeId, name)[] の JSON を返す。OFF（パイロット）は Entry の行き先解決を
 * 提供しないため 404 となり、ここは空配列へ畳む（切替 UI を出さない）。ネットワーク・パース失敗・想定外の
 * 形もすべて空配列へ優雅に劣化する——切替は複数店舗担当者向けの付加機能であり、タイマー機能の前提では
 * ないため、取得できないときは黙って提示しないのが最も害が少ない（作用の端・window/fetch に触れる）。
 * 200 ボディからの取り出しは共有純粋ヘルパ parseStoreChoices に委ね、二度書かない（重複の根絶）。
 */
export async function fetchStoreChoices(): Promise<readonly StoreChoice[]> {
  try {
    const response = await fetch("/entry/stores", { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return [];
    }
    const data: unknown = await response.json();
    return parseStoreChoices(data);
  } catch {
    return [];
  }
}

/** 既定の Socket オープナ — ブラウザ WebSocket を SocketListeners へ配線する。 */
function browserSocketOpener(url: string, listeners: SocketListeners): Socket {
  const ws = new WebSocket(url);
  ws.onopen = () => listeners.onOpen();
  ws.onmessage = (event: MessageEvent) => {
    // サーバは JSON 文字列のみ送る。文字列以外は破棄相当（空文字を渡し parse 失敗で無視させる）。
    listeners.onMessage(typeof event.data === "string" ? event.data : "");
  };
  ws.onclose = (event: CloseEvent) => listeners.onClose(event.code);
  ws.onerror = () => listeners.onError();
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}

/**
 * WebSocket 接続を開き、サーバ状態に追随する UI の唯一の窓口を返す（要件4.4 / 4.5）。
 *
 * 作用の端。WS のライフサイクル（開閉・ping/pong 生存検出・再接続・Connectivity 確定）は Connectivity_Watch へ、
 * 永続化・再水和は ViewStore へ委譲し、状態の決定は decideView（純粋）に委ねる。自身が担うのは次の配線だけ:
 *   - Mode 経路選択 — start / cancel を mode(view) で振り分ける（live: WS 送信／degraded: ローカル畳み込み・要件4.5）。
 *   - Reconcile 契機づけ — Connectivity が down→up へ遷移したとき、次の全量 snapshot を Reconcile として畳む（要件2.4）。
 *   - 秒読みティック＋ローカル発火 — tickMs ごとに dueLocalTimers を導出し、アラートを鳴らして LocalDone を畳む（要件5.1 / 8.1）。
 *   - 永続化 — ビューが変化するたび ViewStore.save を呼ぶ（要件11.1）。
 *   - boot 再水和＋期限到来分の発火 — 接続前に ViewStore.load で同期再水和し、既に期限が過ぎた Timer をローカル発火する（要件11.2 / 11.3）。
 *   - 同期失敗表示 — 接続確立から syncTimeoutMs 以内に snapshot 未着なら syncFailed を表面化する（既存表示は保持・要件4.6）。
 */
export function openTimerConnection(options: ConnectionOptions): TimerConnection {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  let openSocket = options.openSocket ?? browserSocketOpener;
  // dev/test 限定: 縮退テスト用 ping blackhole を既定オープナに被せる（送信 ping のみ破棄・要件14.1）。
  // import.meta.env.DEV を先頭ガードに置くことで、本番ビルドではこの分岐ごと dead-code 除去される（要件14.4）。
  // 有効状態はランタイム可逆なスイッチ（isPingBlackholeActive）から読む（要件14.3）。
  if (import.meta.env.DEV && pingBlackholeDebugEnabled()) {
    openSocket = withPingBlackhole(openSocket, isPingBlackholeActive);
  }
  const persistence = options.persistence ?? localStorageViewStore(options.storeId);
  const connectivityFactory = options.connectivity ?? watchConnectivity;
  const onBoilAlert = options.onBoilAlert ?? (() => {});
  const onRejected = options.onRejected ?? (() => {});
  const syncTimeoutMs = options.syncTimeoutMs ?? 2000;
  const tickMs = options.tickMs ?? 1000;

  let view: ClientView = EMPTY_VIEW;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  // 直近に観測した Connectivity。null は「まだ一度も接続が確立していない」状態（boot）を表す。
  // 初回の up は down→up 遷移とみなさず（boot の初回 hydration）、実接続を経た再接続のみ Reconcile を契機づける。
  let prevConnectivity: Connectivity | null = null;
  // 次の全量 snapshot を Reconcile として畳むか。down→up 遷移で立て、消費したら下ろす（要件2.4 / 11.5）。
  let pendingReconcile = false;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  // ビューが変化したときだけ永続化して購読者へ通知する（要件11.1）。参照同一なら何もしない。
  function update(next: ClientView): void {
    if (next === view) return;
    view = next;
    persistence.save(view);
    notify();
  }

  function clearSyncTimer(): void {
    if (syncTimer !== null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
  }

  /**
   * 期限到来分をローカル発火する（boot 再水和直後・毎ティック共通の発火経路）。
   *
   * dueLocalTimers（純粋導出）で endTime ≤ 補正後現在時刻かつ未処理の Timer を取り、各々に対し
   * アラートを 1 回鳴らして（作用の端）LocalDone を畳む（processedIds へ登録＝冪等・要件8.1 / 11.3）。
   * WS への送信は一切行わない（常駐ループは DO を wake させない・要件1.6 / 8.3）。
   */
  function fireDue(correctedNowMs: number): void {
    for (const timer of dueLocalTimers(view, correctedNowMs)) {
      onBoilAlert(timer);
      update(decideView(view, { kind: "LocalDone", timerId: timer.id }));
    }
  }

  // boot 再水和 — 接続前に同期的に永続ブロブからビューを復元する（要件11.2）。
  view = persistence.load();
  // 再水和直後、ダウンタイム中に endTime が過ぎた Timer をローカル発火する（要件11.3）。
  fireDue(now() + view.offset);

  // Connectivity_Watch へ渡す Socket オープナ。onOpen を端でタップし、syncTimeout の起点に用いる。
  // WS の開閉・再接続・ping/pong は Connectivity_Watch が所有し、ここでは onOpen の観測のみを足す（重複の根絶）。
  const tappedOpener: SocketOpener = (socketUrl, socketListeners) =>
    openSocket(socketUrl, {
      ...socketListeners,
      onOpen: () => {
        // 接続確立から syncTimeoutMs 以内に snapshot が来なければ同期失敗を表面化する（既存表示は保持・要件4.6）。
        clearSyncTimer();
        syncTimer = setTimeout(() => {
          syncTimer = null;
          update({ ...view, sync: "syncFailed" });
        }, syncTimeoutMs);
        socketListeners.onOpen();
      },
    });

  const watch = connectivityFactory(options.url, tappedOpener, now);

  // Connectivity の確定を購読し、ビューへ Connectivity イベントとして畳む（Mode 導出が追随・要件3）。
  watch.onConnectivity((status) => {
    // down→up 遷移（実接続を経た再接続）のとき、次の全量 snapshot を Reconcile として畳む（要件2.4）。
    // boot の初回 up（prevConnectivity === null）は通常の hydration として扱い、Reconcile にしない。
    if (status === "up" && prevConnectivity === "down") {
      pendingReconcile = true;
    }
    // down へ確定した契機に限り（down でない状態＝up / boot(null) からの遷移のみ）、到達不能理由を 1 回だけ
    // 分類する（要件15.1 / 15.13）。既に down のときは再発火しない——常駐ポーリングにはせず、遷移の一度きり。
    // prevConnectivity は直後に更新されるため、更新前の値で down 遷移を判定する（ホットパス分離）。
    const enteredDown = status === "down" && prevConnectivity !== "down";
    prevConnectivity = status;
    update(decideView(view, { kind: "Connectivity", status }));
    if (enteredDown) {
      // ベストエフォート。probeReachability は帯域外 HTTP fetch（WS ではない・DO を wake させない）で、
      // 内部で throw せず offline へ畳む設計ゆえ .catch は付けない。fetch が失敗・遅延しても degraded 運用
      // （ローカル権限・カウントダウン継続・茹で上がり発火・要件5〜8）を一切妨げない。非同期解決時点の
      // 最新 view に対して Classify を畳む（クロージャで可変な view を参照する）。
      // up 復帰時は Connectivity(up) 畳み込みが unreachableReason を "offline" へ戻すため明示クリアは不要。
      void probeReachability(options.storeId).then((reason) => {
        update(decideView(view, { kind: "Classify", reason }));
      });
    }
  });

  // サーバによる接続拒否（未プロビジョニング／Roster 不一致／deactivated）を購読し、端の作用として通知する。
  // ビュー状態には昇格させない——「Entry へ戻る」は決定ではなく作用ゆえ、App が onRejected で navigation を担う
  // （要件7.6。Entry の逆引きリダイレクト＝タスク 14.1 が再解決する）。
  watch.onRejected(() => {
    onRejected();
  });

  // 受信 ServerMessage を購読し、ビューへ畳む。snapshot は sync タイマを解除する。
  watch.onServerMessage((message, receivedAt) => {
    if (message.type === "snapshot") {
      clearSyncTimer();
      if (pendingReconcile) {
        // down→up 後の最初の全量 snapshot。server-confirmed のみ置換し provisional は保持する（決定 B・要件11.5）。
        pendingReconcile = false;
        update(
          decideView(view, {
            kind: "Reconcile",
            timers: message.timers,
            // 待ち行列と推奨は provisional の対概念を持たないため、再接続直後も通常の snapshot と同じ全置換。
            pendingOrders: message.pendingOrders,
            recommendations: message.recommendations,
            receivedAt,
          }),
        );
        return;
      }
    }
    update(decideView(view, { kind: "Server", message, receivedAt }));
  });

  // 秒読みティック。dueLocalTimers でローカル発火しつつ、Tick（ビュー不変）を畳んで再描画を促す（要件5.1 / 8.1）。
  // 切断中も止めない。最新 offset を凍結して使い続けローカル再算出を継続する（要件5.2 / 5.3）。
  const tickTimer: ReturnType<typeof setInterval> = setInterval(() => {
    fireDue(now() + view.offset);
    // Tick はビュー不変（参照同一を返す）。update は早期 return するため、再描画は notify で促す（要件5.1）。
    update(decideView(view, { kind: "Tick" }));
    notify();
  }, tickMs);

  return {
    getView: () => view,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: (slotIds, noodleType, boilSeconds, orderItem) => {
      if (mode(view) === "live") {
        // live: 既存どおり ClientMessage を WS へ送る。推奨から開始したときだけ注文品目を添える
        // （ワイヤは平坦な兄弟フィールドで運ぶ・domain/messages.ts の規律）。
        watch.send(
          orderItem === undefined
            ? { type: "start", slotIds, noodleType, boilSeconds }
            : {
                type: "start",
                slotIds,
                noodleType,
                boilSeconds,
                externalOrderId: orderItem.externalOrderId,
                itemIndex: orderItem.itemIndex,
              },
        );
        return;
      }
      // degraded: 補正後現在時刻と生成 id を端で採取し、LocalStart を畳む。WS へは送らない（要件6.3）。
      //
      // orderItem はここでは捨てる。Provisional_Timer はサーバが知らないローカル意図であり、添える先の
      // start メッセージがそもそも出ない——保持しても届く経路が無い。ゆえに Pending_Order は（更新が
      // 止まった）待ち行列に残り続ける。サーバが知らない開始を「待ち行列から消えた」と見せる方が嘘になる。
      update(
        decideView(view, {
          kind: "LocalStart",
          slotIds,
          noodleType,
          boilSeconds,
          newTimerId: newId(),
          correctedNow: now() + view.offset,
        }),
      );
    },
    cancel: (timerId) => {
      // provisional（origin:"local"）はサーバが知らないローカル意図。mode に関わらずローカルで畳んで除去する
      // （live なのにサーバへ送ると TimerNotFound で詰む＝幽霊タイマー化する）。server-confirmed のみ live で送る。
      const target = view.timers.find((timer) => timer.id === timerId);
      if (target?.origin === "server" && mode(view) === "live") {
        watch.send({ type: "cancel", timerId });
        return;
      }
      // degraded、または対象が provisional / 不在のときはローカル畳み込み（要件7.3・幽霊タイマーの解消）。
      // 除去直前の麺種を残滓へ記録するため、記録時刻に now()（client 実時刻）を運ぶ（要件5.2）。
      update(decideView(view, { kind: "LocalCancel", timerId, now: now() }));
    },
    complete: (timerId) => {
      // cancel と同じ origin 経路分け。provisional の boiled 消し込みもサーバへ送らずローカルで除去する。
      const target = view.timers.find((timer) => timer.id === timerId);
      if (target?.origin === "server" && mode(view) === "live") {
        watch.send({ type: "complete", timerId });
        return;
      }
      // degraded、または対象が provisional / 不在のときはローカル除去。直前結果の記録時刻は now()（client 実時刻）。
      update(decideView(view, { kind: "LocalComplete", timerId, now: now() }));
    },
    adjust: (timerId, firmness) => {
      // 茹で加減変更はサーバが麺ごとの硬さ別秒で endTime を引き直す操作。server-confirmed かつ live のときだけ送る。
      // provisional（サーバに対象が無い）・degraded では送らない（送れば TimerNotFound になるだけ）。
      const target = view.timers.find((timer) => timer.id === timerId);
      if (target?.origin === "server" && mode(view) === "live") {
        watch.send({ type: "adjust", timerId, firmness });
      }
    },
    close: () => {
      clearSyncTimer();
      clearInterval(tickTimer);
      watch.close();
      listeners.clear();
    },
  };
}
