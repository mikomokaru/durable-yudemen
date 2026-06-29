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
import type { ServerMessage } from "../domain/messages";
import type { TimerFact, NonEmptyArray } from "../domain/timer";
import { DEFAULT_UNIT_COUNT, DEFAULT_NOODLE_PRESETS } from "../domain/store";
import type { NoodlePreset } from "../domain/store";
import { DEFAULT_FIRMNESS, type Firmness } from "../domain/firmness";
import { clockOffset } from "./clock";
import {
  isPingBlackholeActive,
  pingBlackholeDebugEnabled,
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
  /** 最新のクロックオフセット。serverTime を伴う受信のたびに再確立する（要件10.3 / 10.6）。 */
  readonly offset: number;
  /** done / cancelled を処理済みとして記録した timerId 集合（表示制御用・SSOT のコピーではない）。 */
  readonly processedIds: ReadonlySet<string>;
  /**
   * 直前の調理結果（client 専用・ベストエフォート）。slotId → { 麺種, 記録時刻 }。明示完了（completed /
   * LocalComplete）で除去される直前に記録し、idle 表示で一定時間だけ提示する（要件13.5/13.6）。SSOT では
   * なく processedIds と同じ表示制御用ローカル情報で、永続もしない（リロードで消えてよい）。
   */
  readonly lastResults: ReadonlyMap<string, { readonly noodleType: string; readonly at: number }>;
  /** 到達性の事実。Mode の導出元（要件3.1）。 */
  readonly connectivity: Connectivity;
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
  | { readonly kind: "LocalCancel"; readonly timerId: string } // 要件7
  | { readonly kind: "LocalComplete"; readonly timerId: string; readonly now: number } // boiled の明示消し込み（degraded）
  | { readonly kind: "Connectivity"; readonly status: Connectivity } // 要件2/3
  | { readonly kind: "LocalDone"; readonly timerId: string } // 要件8（茹で上がりアラート記録）
  | { readonly kind: "Tick" } // 要件5（ビュー不変）
  | { readonly kind: "Reconcile"; readonly timers: readonly TimerFact[]; readonly receivedAt: number }; // 要件11（決定 B）

/** 初期ビュー。まだ何も受信しておらず接続中。boot 時は接続未確立 = degraded 起点（要件3）。 */
export const EMPTY_VIEW: ClientView = {
  timers: [],
  offset: 0,
  processedIds: new Set<string>(),
  lastResults: new Map<string, { readonly noodleType: string; readonly at: number }>(),
  connectivity: "down",
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
      // snapshot と同一規律（server-confirmed のみ置換・provisional 保持・processedIds 刈り取り・要件11.5/11.6/11.7）。
      // Reconcile イベントは serverTime を運ばないため offset は凍結する（接続中に確立した最新値を維持・要件5.2）。
      return reconcileServerConfirmed(view, event.timers);

    case "LocalStart":
      return decideLocalStart(view, event);

    case "LocalCancel":
      return decideLocalCancel(view, event.timerId);

    case "LocalComplete":
      // boiled の明示消し込み（degraded）。対象を除去し、ローカル再発火抑止のため処理済みに記録する。
      return decideLocalComplete(view, event.timerId, event.now);

    case "Connectivity":
      // 到達性の事実だけをセットする。offset は変えない（degraded 中の凍結を維持・要件5.2）。
      // Mode は mode(view) で導出するためここでは更新しない（導出値を状態に昇格させない・要件3.3）。
      return { ...view, connectivity: event.status };

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
 */
function decideLocalCancel(view: ClientView, timerId: string): ClientView {
  const target = view.timers.find((timer) => timer.id === timerId);
  if (target === undefined) {
    return view;
  }
  const timers = view.timers.filter((timer) => timer.id !== timerId);
  // server-confirmed のローカル cancel はローカル発火抑止のため処理済みに記録する（要件7.2）。
  const processedIds =
    target.origin === "server" ? markProcessed(view.processedIds, timerId) : view.processedIds;
  return { ...view, timers, processedIds };
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
  // すべての server → client メッセージは serverTime を伴う。受信のたびに offset を最新化する（要件10.3）。
  const offset = clockOffset(message.serverTime, receivedAt);

  switch (message.type) {
    case "snapshot": {
      // server-confirmed のみ全置換し provisional は保持する共有規律（要件11.5/11.6/11.7）。
      // 初回 hydration では provisional 空ゆえ全置換に縮退する。offset 再確立・同期確定・エラー解消を重ねる。
      const reconciled = reconcileServerConfirmed(view, message.timers);
      return { ...reconciled, offset, sync: "synced", error: null };
    }

    case "started": {
      // 当該 Timer のカウントダウンを開始（要件1.4）。同一 id の重複 started は最新で置き換える。provisional は保持。
      // 新規開始した駆動スロットの直前結果（残滓）は解除する（要件13.7）。
      const withoutDuplicate = view.timers.filter((timer) => timer.id !== message.timer.id);
      return {
        ...view,
        offset,
        timers: [...withoutDuplicate, { ...message.timer, origin: "server" as const }],
        lastResults: clearLastResults(view.lastResults, message.timer.slotIds),
      };
    }

    case "cancelled": {
      // 既に処理済み（＝除去済み）の重複 cancelled は冪等に無視する（要件6.8）。offset のみ最新化。
      if (!shouldHandleDone(message.timerId, view.processedIds)) {
        return { ...view, offset };
      }
      // 当該 Slot の表示を除去し（要件6.7）、処理済みとして記録する。
      return {
        ...view,
        offset,
        timers: view.timers.filter((timer) => timer.id !== message.timerId),
        processedIds: markProcessed(view.processedIds, message.timerId),
      };
    }

    case "boiled": {
      // 茹で上がり通知（除去しない・明示完了待ち）。処理済み（＝既にアラート済み）の重複は冪等に無視する。
      // boiled 表示は endTime ≤ now の導出から出すため、ここでの記録はアラート重複の抑止だけが目的。
      // Timer 自体は集合に残す（明示完了 completed で初めて除去される）。
      if (!shouldHandleDone(message.timerId, view.processedIds)) {
        return { ...view, offset };
      }
      return { ...view, offset, processedIds: markProcessed(view.processedIds, message.timerId) };
    }

    case "completed": {
      // 明示完了による除去。既に除去済みの重複 completed は冪等に無視する。当該 Timer を集合から除き、
      // 除去直前の麺種を直前結果として記録する（idle 表示で一定時間提示・要件13.5）。処理済みにも登録する。
      const target = view.timers.find((timer) => timer.id === message.timerId);
      if (target === undefined) {
        return { ...view, offset };
      }
      return {
        ...view,
        offset,
        timers: view.timers.filter((timer) => timer.id !== message.timerId),
        processedIds: markProcessed(view.processedIds, message.timerId),
        lastResults: recordLastResults(view.lastResults, target, receivedAt),
      };
    }

    case "error": {
      return { ...view, offset, error: { code: message.code, message: message.message } };
    }

    case "config": {
      // 店舗設定の一方向受信（サーバ権威・クライアント不変）。ユニット総数と麺種プリセットを確定し offset も最新化する。
      // 稼働中の差し替え（運用エンドポイント発の再配信）も同じ経路で反映される。
      return { ...view, offset, unitCount: message.unitCount, noodlePresets: message.noodlePresets };
    }

    case "adjusted": {
      // 茹で加減変更の反映（サーバ権威）。当該 Timer を更新後の事実で置き換える（endTime/firmness 更新）。
      // 同一 id を差し替えるだけ（provisional は保持）。offset も最新化する。
      const withoutTarget = view.timers.filter((timer) => timer.id !== message.timer.id);
      return { ...view, offset, timers: [...withoutTarget, { ...message.timer, origin: "server" as const }] };
    }
  }
}

/**
 * server-confirmed のみ全置換し provisional は保持する共有規律（snapshot と Reconcile が共有・決定 B）。
 *
 * 純粋関数。offset / connectivity / sync / error など serverTimers から導出できない事実は呼び出し元に委ね、
 * ここでは「timers の置換」と「processedIds の刈り取り」だけを担う（重複の根絶・要件11.5/11.6/11.7）。
 *
 *   - server-confirmed（origin==="server"）は serverTimers（すべて origin:"server" 化）で全置換する（要件11.5）。
 *   - Provisional_Timer（origin==="local"）は保持する。回線復帰の瞬間に走行中ポットを消さない（要件11.6）。
 *   - processedIds は「serverTimers の id ∪ 保持 provisional の id」に属するものだけ残す（記録を有界に保ちつつ、
 *     復活した server-confirmed のローカル発火抑止を維持する・要件11.7）。
 */
export function reconcileServerConfirmed(view: ClientView, serverTimers: readonly TimerFact[]): ClientView {
  // Provisional_Timer は未確定なローカル意図として保持する（決定 B・要件11.6）。
  const provisional = view.timers.filter((timer) => timer.origin === "local");
  // server-confirmed は snapshot で全置換する。すべて起源タグを "server" 化する（要件11.5）。
  const confirmed: readonly ClientTimer[] = serverTimers.map((timer) => ({ ...timer, origin: "server" as const }));

  // 保持 id 集合 = serverTimers に含まれる id ∪ 保持される provisional の id（要件11.7）。
  const retainedIds = new Set<string>(serverTimers.map((timer) => timer.id));
  for (const timer of provisional) retainedIds.add(timer.id);

  // processedIds は保持 id 集合に属するものだけ残す（記録を有界に保ち、復活キャンセル抑止を維持・要件11.7）。
  const prunedProcessed = new Set<string>();
  for (const id of view.processedIds) {
    if (retainedIds.has(id)) prunedProcessed.add(id);
  }

  return {
    ...view,
    timers: [...confirmed, ...provisional],
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
  readonly onClose: () => void;
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
  /** タイマー開始操作を送る（担当スコープの制限は UI の責務）。1 Timer は 1 つ以上のスロットを駆動する（非空）。 */
  start(slotIds: NonEmptyArray<string>, noodleType: string, boilSeconds: number): void;
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
  /** 接続先 WS URL（例: wss://host/ws）。 */
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

/** 既定の Socket オープナ — ブラウザ WebSocket を SocketListeners へ配線する。 */
function browserSocketOpener(url: string, listeners: SocketListeners): Socket {
  const ws = new WebSocket(url);
  ws.onopen = () => listeners.onOpen();
  ws.onmessage = (event: MessageEvent) => {
    // サーバは JSON 文字列のみ送る。文字列以外は破棄相当（空文字を渡し parse 失敗で無視させる）。
    listeners.onMessage(typeof event.data === "string" ? event.data : "");
  };
  ws.onclose = () => listeners.onClose();
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
  const persistence = options.persistence ?? localStorageViewStore();
  const connectivityFactory = options.connectivity ?? watchConnectivity;
  const onBoilAlert = options.onBoilAlert ?? (() => {});
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
    prevConnectivity = status;
    update(decideView(view, { kind: "Connectivity", status }));
  });

  // 受信 ServerMessage を購読し、ビューへ畳む。snapshot は sync タイマを解除する。
  watch.onServerMessage((message, receivedAt) => {
    if (message.type === "snapshot") {
      clearSyncTimer();
      if (pendingReconcile) {
        // down→up 後の最初の全量 snapshot。server-confirmed のみ置換し provisional は保持する（決定 B・要件11.5）。
        pendingReconcile = false;
        update(decideView(view, { kind: "Reconcile", timers: message.timers, receivedAt }));
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
    start: (slotIds, noodleType, boilSeconds) => {
      if (mode(view) === "live") {
        // live: 既存どおり ClientMessage を WS へ送る。
        watch.send({ type: "start", slotIds, noodleType, boilSeconds });
        return;
      }
      // degraded: 補正後現在時刻と生成 id を端で採取し、LocalStart を畳む。WS へは送らない（要件6.3）。
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
      if (mode(view) === "live") {
        watch.send({ type: "cancel", timerId });
        return;
      }
      // degraded: LocalCancel を畳む（mint する id は無い）。WS へは送らない（要件7.3）。
      update(decideView(view, { kind: "LocalCancel", timerId }));
    },
    complete: (timerId) => {
      if (mode(view) === "live") {
        watch.send({ type: "complete", timerId });
        return;
      }
      // degraded: LocalComplete を畳んでローカル除去する。WS へは送らない。直前結果の記録時刻は now()（client 実時刻）。
      update(decideView(view, { kind: "LocalComplete", timerId, now: now() }));
    },
    adjust: (timerId, firmness) => {
      // 茹で加減変更は live のみ（サーバが麺ごとの硬さ別秒で endTime を引き直す）。degraded では送らない。
      if (mode(view) === "live") {
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
