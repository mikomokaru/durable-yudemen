// tests/client/connectivityWatch.integration.test.ts — Connectivity_Watch の統合テスト（タスク6.3）。
//
// design.md「Connectivity 確定規律」の四つの契機を、モック WS と faketime で実際に
// watchConnectivity を走らせて確かめる。
//   (c) WS open ＋ 全量 snapshot 受信 → up（要件2.2）
//   (d) pong 受信 → up（要件1.3）
//   (a) ping 送信後 PONG_TIMEOUT_MS 以内に pong 無しが SILENT_LOSS_MISSES 回連続 → down（要件1.4）
//   (b) WS close / error → down（要件2.1）
// 加えて二系統の独立（要件2.3）と、ビューの決定を持たないこと（要件4.6）を主張する。
//
// 既存 tests/client/connection.example.test.ts との棲み分け: あちらは Sync_Mediator
// （openTimerConnection）の同期状態・再接続・経路選択を観測する側で、Connectivity_Watch は偽物
// （support/timerConnection.ts の偽 Watch）へ差し替えており watchConnectivity 自体を実行していない。
// ping/pong の閾値と二段階 down 検出を実際に走らせる経路はここだけである。
//
// 閾値は実装から import する。自前の数値リテラルで書き直せば、閾値が変わったときテストが追随せず
// 二つの真実になる。
//
// ここは実時間依存の作用の端であり、PING_INTERVAL_MS / PONG_TIMEOUT_MS を進めなければ検出そのものが
// 起きない。ゆえに faketime を使う（純粋層に課した faketime 不使用の規律はここには及ばない）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connectivity, Socket, SocketListeners, SocketOpener } from "../../src/client/connection";
import {
  PING_INTERVAL_MS,
  PING_REQUEST,
  PONG_RESPONSE,
  PONG_TIMEOUT_MS,
  SILENT_LOSS_MISSES,
  watchConnectivity,
} from "../../src/client/connectivity";
import type { ServerMessage } from "../../src/domain/messages";

const WS_URL = "wss://example.test/ws";

/** 受信時刻の採取に用いる固定時刻。到達性検出は now の進みに依らない（進めるのはタイマーだけ）。 */
const RECEIVED_AT = 1_700_000_000_000;

/** 偽 Socket。送信フレームを生のまま溜め、listeners を保持して受信・切断をテストから駆動する。 */
interface FakeSocket extends Socket {
  readonly listeners: SocketListeners;
  /** 送られたフレームの生文字列。ping が素の文字列であることを見るため一切加工しない。 */
  readonly sent: readonly string[];
  /** watchConnectivity が close() を呼んだ回数。 */
  readonly closeCount: number;
}

/** 最新に開かれた Socket。無ければテストの前提が崩れているので即座に失敗させる。 */
function latestSocket(opened: readonly FakeSocket[]): FakeSocket {
  const socket = opened.at(-1);
  if (socket === undefined) throw new Error("Socket が一つも開かれていない");
  return socket;
}

function isPing(frame: string): boolean {
  return frame === PING_REQUEST;
}

/** 全量 snapshot のワイヤ形式。up 確定の契機（要件2.2）として受信させる。 */
function snapshotFrame(): string {
  const message: ServerMessage = {
    type: "snapshot",
    serverTime: RECEIVED_AT,
    timers: [],
    pendingOrders: [],
    recommendations: [],
  };
  return JSON.stringify(message);
}

/** SocketOpener を注入して watchConnectivity を据え付ける。WS グローバルには触れない。 */
function watchWithFakeSockets() {
  const opened: FakeSocket[] = [];
  const openSocket: SocketOpener = (_url, listeners) => {
    const sent: string[] = [];
    let closeCount = 0;
    const socket: FakeSocket = {
      listeners,
      sent,
      get closeCount() {
        return closeCount;
      },
      send: (data) => {
        sent.push(data);
      },
      close: () => {
        closeCount += 1;
      },
    };
    opened.push(socket);
    return socket;
  };

  const statuses: Connectivity[] = [];
  const messages: { readonly message: ServerMessage; readonly receivedAt: number }[] = [];
  const watch = watchConnectivity(WS_URL, openSocket, () => RECEIVED_AT);
  watch.onConnectivity((status) => {
    statuses.push(status);
  });
  watch.onServerMessage((message, receivedAt) => {
    messages.push({ message, receivedAt });
  });

  return { watch, opened, statuses, messages, latest: () => latestSocket(opened) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("client/connectivity — Connectivity 確定規律の四つの契機", () => {
  it("(c) WS open だけでは up を確定せず、全量 snapshot 受信で up になる（要件2.2）", () => {
    const { watch, statuses, messages, latest } = watchWithFakeSockets();

    latest().listeners.onOpen();
    // 対の主張。「開いたら up」の実装ならここで緑にならない（open は接続確立の確証ではない）。
    expect(statuses).toEqual([]);

    latest().listeners.onMessage(snapshotFrame());
    expect(statuses).toEqual(["up"]);
    // snapshot は up 確定と同時に購読者へも渡る。受信時刻は注入した now から採る。
    expect(messages).toHaveLength(1);
    expect(messages[0]?.receivedAt).toBe(RECEIVED_AT);

    // 同値の連続発行は抑えられる。二枚目の snapshot で up が二度出ない。
    latest().listeners.onMessage(snapshotFrame());
    expect(statuses).toEqual(["up"]);

    watch.close();
  });

  it("(d) pong 受信で up を確定する。ping は素の文字列フレームで送る（要件1.3 / 1.6）", () => {
    const { watch, statuses, messages, latest } = watchWithFakeSockets();

    latest().listeners.onOpen();
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(latest().sent).toEqual([PING_REQUEST]);
    // JSON でくるまない。auto-response 経路だけを通り DO を wake させないための要（要件1.6）。
    expect(() => JSON.parse(PING_REQUEST)).toThrow();
    // ping 送信そのものは up を確定しない（確定は応答の受信のみ）。
    expect(statuses).toEqual([]);

    latest().listeners.onMessage(PONG_RESPONSE);
    expect(statuses).toEqual(["up"]);
    // pong は素の文字列フレームゆえ ServerMessage としては購読者へ渡らない。
    expect(messages).toEqual([]);

    watch.close();
  });

  it("(a) ping 未応答が SILENT_LOSS_MISSES 回連続したときに初めて down になる（静かな喪失・要件1.4）", () => {
    const { watch, statuses, opened, latest } = watchWithFakeSockets();

    latest().listeners.onOpen();
    latest().listeners.onMessage(snapshotFrame());
    const live = latest();
    expect(statuses).toEqual(["up"]);

    // 1 回目の未応答。対の主張。「未応答が 1 回でも down」の実装ならここで緑にならない。
    vi.advanceTimersByTime(PING_INTERVAL_MS + PONG_TIMEOUT_MS);
    expect(live.sent.filter(isPing)).toHaveLength(1);
    expect(statuses).toEqual(["up"]);

    // 次の ping も未応答のまま PONG_TIMEOUT_MS を過ぎ、SILENT_LOSS_MISSES 回目で down。
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(live.sent.filter(isPing)).toHaveLength(SILENT_LOSS_MISSES);
    expect(statuses).toEqual(["up", "down"]);
    // この down は WS からの通知ではなく未応答の計数から確定した。close は確定の結果であって原因ではない
    // （このテストは onClose / onError を一度も呼んでいない）。
    expect(live.closeCount).toBe(1);

    // 再接続は予約であって即時ではない。down と同じ時点では新しい Socket は開かない。
    expect(opened).toHaveLength(1);
    // 猶予（非公開の内部値）を十分に超える幅だけ進める。値ではなく「予約されている」ことを主張する。
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(opened).toHaveLength(2);

    watch.close();
  });

  it("pong 受信は未応答の計数をリセットする（1 回未応答 → pong → 1 回未応答では down にならない）", () => {
    const { watch, statuses, latest } = watchWithFakeSockets();

    latest().listeners.onOpen();
    const live = latest();

    // 1 回目の未応答。
    vi.advanceTimersByTime(PING_INTERVAL_MS + PONG_TIMEOUT_MS);
    expect(live.sent.filter(isPing)).toHaveLength(1);

    // pong 受信で up を確定し、同時に計数を 0 へ戻す。
    live.listeners.onMessage(PONG_RESPONSE);
    expect(statuses).toEqual(["up"]);

    // 再び 1 回だけ未応答。リセットが効いていなければ SILENT_LOSS_MISSES 回目として down になる。
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(statuses).toEqual(["up"]);

    // 対の主張。リセットは down を一巡ぶん先へ送るだけで、検出を無効化しない。
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(statuses).toEqual(["up", "down"]);

    watch.close();
  });

  it("(b) WS close で down を確定し、死んだソケットへの ping ループを止める（明示的切断・要件2.1）", () => {
    const { watch, statuses, latest } = watchWithFakeSockets();

    latest().listeners.onOpen();
    latest().listeners.onMessage(snapshotFrame());
    const live = latest();
    expect(statuses).toEqual(["up"]);

    live.listeners.onClose();
    expect(statuses).toEqual(["up", "down"]);

    // 閉じたソケットへ ping を送り続けない（ループは open 中のみ走る）。
    const sentAtClose = live.sent.length;
    vi.advanceTimersByTime(PING_INTERVAL_MS * 2);
    expect(live.sent).toHaveLength(sentAtClose);

    watch.close();
  });

  it("(b) WS error でも down を確定する（close が続かない実装でも確定を保証する・要件2.1）", () => {
    const { watch, statuses, latest } = watchWithFakeSockets();

    latest().listeners.onOpen();
    latest().listeners.onMessage(PONG_RESPONSE);
    expect(statuses).toEqual(["up"]);

    latest().listeners.onError();
    expect(statuses).toEqual(["up", "down"]);

    watch.close();
  });
});

describe("client/connectivity — 二系統の独立と関心の限定", () => {
  it("明示的切断は未応答が 0 回でも down を確定する（二系統は互いの成立を待たない・要件2.3）", () => {
    const { watch, statuses, latest } = watchWithFakeSockets();

    latest().listeners.onOpen();
    const live = latest();

    // ping を 1 本送り pong で応答させる。未応答計数は 0 で、静かな喪失は成立していない。
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    live.listeners.onMessage(PONG_RESPONSE);
    expect(statuses).toEqual(["up"]);

    // それでも close 一発で down。静かな喪失（要件1.4）の成立を待たない。
    live.listeners.onClose();
    expect(statuses).toEqual(["up", "down"]);

    watch.close();
  });

  it("Connectivity_Watch はビューを持たず、確定の通知だけを公開する（要件4.6）", () => {
    const { watch } = watchWithFakeSockets();

    // 公開面に getView 相当が無い。ビューの決定は純粋関数（decideView）の領分であり、
    // 端は Connectivity の確定と受信の中継だけを担う。
    expect(Object.keys(watch).sort()).toEqual([
      "close",
      "onConnectivity",
      "onRejected",
      "onServerMessage",
      "send",
    ]);

    watch.close();
  });
});
