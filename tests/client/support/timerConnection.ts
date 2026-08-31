// tests/client/support/timerConnection.ts — 接続コントローラ（openTimerConnection）の据え付けを共有する。
//
// 作用の端を具体例で検証するテストは、二つの継ぎ目のどちらかで偽物を注入する。どちらの据え付けも
// 同じ骨（固定の基準時刻・可変 now・接続の生成）を要し、同形の写しが二ファイルに置かれていたため
// 写しを作らずここ一箇所に置く。
//
//   - Socket の継ぎ目（openConnectionWithFakeSockets）: 既定の Connectivity_Watch を本物のまま通し、
//     WebSocket だけを偽 Socket へ差し替える。観測対象はワイヤ（JSON フレーム）と Socket の生死
//     （再接続で別 Socket が開くこと）である。
//   - Connectivity_Watch の継ぎ目（openConnectionWithFakeWatch）: Watch そのものを偽物にして
//     Connectivity を直接駆動する。観測対象は ClientMessage の送信有無と mode による経路分けである。
//
// **なぜ二つ並べ、一つに統合しないか:** 既定の watchConnectivity は切断中に socket を捨てるため、Socket の
// 継ぎ目では degraded の「送らない」が mode の判断なのか socket 不在の帰結なのか区別できない。逆に偽 Watch は
// 再接続の営みと JSON コーデックを飛び越えるため、ワイヤと Socket の生死は観測できない。二つは同じ据え付けの
// 別表現ではなく、観測対象そのものが違う。統合すれば、どちらの観測も濁る。
//
// **何を偽装し、何を偽装しないか:** 偽装するのは Socket・Connectivity_Watch・now・newId・ViewStore の
// 五つだけである。接続コントローラ本体・decideView / reduceView・JSON コーデック・永続コーデック
// （parsePersistedView）は一切偽装せず実物を通す——検証したいのは端の配線であって、模型の振る舞いではない。
//
// 利用者:
//   - tests/client/connection.example.test.ts（要件4.2 / 4.5 / 4.6 / 5.2 / 5.3・provisional の経路分け）
//   - tests/client/complete.example.test.ts（明示完了・同時上がり群の一括消し込み・残滓・拒否の畳み込み）
//   - tests/client/degradedRouting.example.test.ts（degraded の cancel・Reconcile 契機づけ・boot 再水和発火・
//     到達不能理由の分類の契機づけ）

import { vi } from "vitest";
import {
  EMPTY_VIEW,
  openTimerConnection,
  type ClientTimer,
  type ClientView,
  type Connectivity,
  type Socket,
  type SocketListeners,
} from "../../../src/client/connection";
import type { ConnectivityWatch } from "../../../src/client/connectivity";
import type { ClientMessage, ServerMessage } from "../../../src/domain/messages";
import type { TimerFact } from "../../../src/domain/timer";

/** 任意の固定エポックミリ秒。両ハーネスの now の起点であり、受信時刻・endTime の基準になる。 */
export const START_NOW = 1_000_000;

/**
 * 両ハーネスが接続する storeId。
 *
 * 到達不能理由の分類（probeReachability）は「この storeId が `GET /entry/stores` の返却リストに在るか」で
 * noAccess / offline を分ける。ゆえに呼び出し側は据え付けが名乗る storeId を知る必要がある——テスト側に
 * 同じ文字列を書けば、据え付けを変えたときに気づけない第二の真実になる。
 */
export const STORE_ID = "test-store";

/** 1 回の接続試行で生成された偽 Socket（送信・切断のモック）とそのリスナの組。 */
export interface OpenedSocket {
  readonly listeners: SocketListeners;
  readonly send: ReturnType<typeof vi.fn<(data: string) => void>>;
  readonly close: ReturnType<typeof vi.fn<() => void>>;
}

/**
 * 既定の Connectivity_Watch を通したまま、Socket だけを偽物にして接続を組む。
 *
 * now は可変参照で制御し、切断中の時間経過（ローカル再算出）を表現できるようにする。
 * openSocket は接続試行のたびに新しい偽 Socket を sockets へ積む（再接続も追跡できる）。
 */
export function openConnectionWithFakeSockets() {
  const sockets: OpenedSocket[] = [];
  let currentNow = START_NOW;

  const connection = openTimerConnection({
    storeId: STORE_ID,
    url: "wss://test/ws",
    now: () => currentNow,
    openSocket: (_url, listeners) => {
      const send = vi.fn<(data: string) => void>();
      const close = vi.fn<() => void>();
      sockets.push({ listeners, send, close });
      const socket: Socket = { send, close };
      return socket;
    },
  });

  return {
    connection,
    /**
     * 直近に開かれた Socket（再接続後は最新を指す）。未生成なら明示的に失敗する。
     *
     * 履歴の配列そのものは外へ出さない。再接続で別 Socket が開いたことは、再接続前後で latest() が返す
     * 参照の非同一で示せる（要件4.6 の再接続ケース）——配列を渡す口を足しても観測は増えない。
     */
    latest: (): OpenedSocket => {
      const last = sockets[sockets.length - 1];
      if (last === undefined) throw new Error("Socket がまだ開かれていない");
      return last;
    },
    setNow: (next: number) => {
      currentNow = next;
    },
  };
}

/** JSON 文字列としてサーバメッセージを受信させる（偽 Socket 経路は実コーデックを通す）。 */
export function receiveFrame(opened: OpenedSocket, message: unknown): void {
  opened.listeners.onMessage(JSON.stringify(message));
}

/**
 * Connectivity を直接駆動できる偽 Watch と、呼び出し回数を数える偽 ViewStore で接続を組む。
 * 既定の watchConnectivity の ping/pong に依存せず、degraded ↔ live の遷移と送信有無を決定的に検証する
 * （openSocket は偽 Watch が無視するため渡さない）。
 *
 * **なぜ persistence を注入するか:** 一括を 1 回の update に畳む判断（design「ファンアウトの形」）は、
 * save の呼び出し回数としてしか外から見えない。2 回走れば中間ビュー（群の一部だけが消えた盤面）が
 * 外へ出ている。load は既定で EMPTY_VIEW にして boot 再水和の雑音を消し、未同期経路（要件2.7）だけ
 * 再水和ビューを渡す——`openTimerConnection` は接続前に load で再水和するため、hydration 前の
 * `sync === "connecting"` を作れる入口はここだけである。
 *
 * **なぜ onBoilAlert を常に数えるか:** 茹で上がりの発火は音という作用であり、ビューに残る痕跡は
 * `processedIds` への登録だけである。「鳴って記録された」と「鳴らずに記録された」はビューからは同じ形に
 * 見えるため、安全要（各 timerId につきちょうど一度鳴る・要件8）は呼び出し回数でしか外から観測できない。
 * 既定は no-op ゆえ、常に数える形にしても振る舞いは変わらない——引数で有無を切り替える理由が無い。
 */
export function openConnectionWithFakeWatch(rehydrated: ClientView = EMPTY_VIEW) {
  const send = vi.fn<(message: ClientMessage) => void>();
  const save = vi.fn<(view: ClientView) => void>();
  const boilAlert = vi.fn<(timer: ClientTimer) => void>();
  let currentNow = START_NOW;
  let connectivityHandler: ((status: Connectivity) => void) | null = null;
  let serverMessageHandler: ((message: ServerMessage, receivedAt: number) => void) | null = null;
  const watch: ConnectivityWatch = {
    onConnectivity: (handler) => {
      connectivityHandler = handler;
    },
    send,
    onServerMessage: (handler) => {
      serverMessageHandler = handler;
    },
    onRejected: () => {},
    close: vi.fn(),
  };
  let idCounter = 0;
  const connection = openTimerConnection({
    storeId: STORE_ID,
    url: "wss://test/ws",
    now: () => currentNow,
    newId: () => `local-${(idCounter += 1)}`,
    connectivity: () => watch,
    persistence: { save, load: () => rehydrated },
    onBoilAlert: boilAlert,
  });

  return {
    connection,
    send,
    save,
    boilAlert,
    setConnectivity: (status: Connectivity) => connectivityHandler?.(status),
    /**
     * サーバメッセージを受信させる一次口。serverTime と受信時刻を独立に置けるため、offset
     * （= serverTime − receivedAt）を呼び出し側が決められる。受信時刻を now と切り離したい呼び出しは
     * これを直接使う。
     */
    receiveMessage: (message: ServerMessage, receivedAt: number) =>
      serverMessageHandler?.(message, receivedAt),
    /**
     * 全量 snapshot を受信させる。serverTime に受信時点の now を渡すため offset は常に 0 になる。
     * 群の基準時刻は now() + view.offset ゆえ、offset を 0 に保つと endTime と setNow の値がそのまま対応する。
     */
    receiveSnapshot: (timers: readonly TimerFact[]) =>
      serverMessageHandler?.(
        { type: "snapshot", serverTime: currentNow, timers, pendingOrders: [], recommendations: [] },
        currentNow,
      ),
    /**
     * 拒否（`{ type: "error", … }`）を受信させる。shell は拒否を Effect 列にせず要求元の WS だけへ返すため、
     * broadcast（receiveSnapshot）とは別の受信経路として与える。
     *
     * serverTime を受信時点の now と別値にできるようにしてあるのは、`TimerNotFound` で「error を立てない」
     * ことと「何もしない」ことを区別するためである——offset だけが動くことを見なければ、畳み込みが
     * 拒否をまるごと捨てていても同じ観測になる。
     */
    receiveError: (code: string, message: string, serverTime: number = currentNow) =>
      serverMessageHandler?.({ type: "error", serverTime, code, message }, currentNow),
    /** ローカル時刻を進める（ティックは進めない）。boiled まで到達させるために使う。 */
    setNow: (next: number) => {
      currentNow = next;
    },
  };
}
