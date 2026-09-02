// tests/client/pingBlackhole.integration.test.ts — dev/test 限定フォルトインジェクション（ping blackhole）の
// ライフサイクル統合テスト（offline-degradation タスク12.2・要件14.1 / 14.2 / 14.3 / 14.5）。
//
// 担うのは **blackhole を被せた状態での一連の遷移** だけである。既存テストとの棲み分け:
//   - tests/client/connectivityWatch.integration.test.ts — 生の watchConnectivity（ping/pong の閾値・
//     二段階 down 検出）を偽 Socket で駆動する。blackhole は一切被せない。
//   - tests/client/degradedRouting.example.test.ts — 偽 Watch で Connectivity を直接駆動し、Reconcile の
//     契機づけ・分類の契機づけを見る。ping/pong を飛び越えるため blackhole の効き目は観測できない。
//   - 本ファイル — 実物の `withPingBlackhole` を実物の `watchConnectivity`（openTimerConnection の既定）へ
//     被せ、送信 ping を落とすことだけで **本物の silent-loss 検知**（要件1.4）を通して degraded へ落ち、
//     解除で `up` へ戻り Reconcile が立つまでを一続きに見る。ここだけがその経路を通る。
//
// 据え付けはこのファイル内にローカルで持つ。support/timerConnection.ts の
// `openConnectionWithFakeSockets()` は偽 opener をハードコードして引数を取らず、blackhole を被せた opener を
// 渡せないためである（共有ハーネスの形を変えるより、被せる一点だけをここで持つ方が影響が小さい）。
//
// **`VITE_PING_BLACKHOLE_DEBUG` は test では undefined ゆえ `pingBlackholeDebugEnabled()` は false であり、
// `connection.ts` の自動配線は効かない。** ゆえに `options.openSocket` へ被せた opener を明示的に渡す。
// 自動配線そのものの形（`import.meta.env.DEV` 先頭ガード）は静的検査（tests/ping-blackhole.static.test.ts）が担う。
//
// 閾値は実装から import する。数値リテラルで書き直せば閾値が変わったときに追随せず、二つの真実になる。
// ここは実時間依存の端であり、`PONG_TIMEOUT_MS × SILENT_LOSS_MISSES` を進めなければ検知そのものが起きない
// ため faketime を使う（純粋層に課した faketime 不使用の規律はここには及ばない）。
//
// blackhole のスイッチはモジュールスコープの可変状態ゆえ、afterEach で必ず false へ戻す（テスト間の汚染を断つ）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_VIEW,
  mode,
  openTimerConnection,
  type ClientView,
  type Socket,
  type SocketListeners,
  type SocketOpener,
} from "../../src/client/connection";
import {
  isPingBlackholeActive,
  PING_INTERVAL_MS,
  PING_REQUEST,
  PONG_RESPONSE,
  PONG_TIMEOUT_MS,
  setPingBlackholeActive,
  SILENT_LOSS_MISSES,
  withPingBlackhole,
} from "../../src/client/connectivity";
import type { ServerMessage } from "../../src/domain/messages";
import type { TimerFact } from "../../src/domain/timer";

const STORE_ID = "test-store";
const WS_URL = "wss://test/ws";

/**
 * 受信時刻の採取に用いる固定時刻。到達性検出は now の進みに依らない（進めるのは faketime のタイマーだけ）。
 * offset（= serverTime − receivedAt）を呼び出し側が決められるよう、受信時刻はこの一点に固定する。
 */
const RECEIVED_AT = 1_700_000_000_000;

/** inner（blackhole の内側）の偽 Socket。送信フレームを生のまま溜め、listeners を保持して受信を駆動する。 */
interface InnerSocket {
  readonly listeners: SocketListeners;
  /** inner へ実際に届いたフレーム。blackhole が落としたものはここに現れない。 */
  readonly sent: readonly string[];
  readonly closeCount: number;
}

function isPing(frame: string): boolean {
  return frame === PING_REQUEST;
}

/** 偽 opener と、開かれた inner Socket の履歴。blackhole を被せる前の素の継ぎ目。 */
function fakeOpener(): { readonly opener: SocketOpener; readonly opened: readonly InnerSocket[] } {
  const opened: InnerSocket[] = [];
  const opener: SocketOpener = (_url, listeners) => {
    const sent: string[] = [];
    let closeCount = 0;
    opened.push({
      listeners,
      sent,
      get closeCount() {
        return closeCount;
      },
    });
    const socket: Socket = {
      send: (data) => {
        sent.push(data);
      },
      close: () => {
        closeCount += 1;
      },
    };
    return socket;
  };
  return { opener, opened };
}

/** テスト用 TimerFact。観測に効くのは id / endTime だけゆえ、残りは固定値で置く。 */
function serverTimer(id: string, endTime: number): TimerFact {
  return {
    id,
    slotIds: [`slot-${id}`],
    noodleType: `noodle-${id}`,
    firmness: "normal",
    startTime: RECEIVED_AT,
    endTime,
  };
}

/** 全量 snapshot のワイヤ形式。serverTime を受信時刻から独立に置けるようにする（offset の観測点）。 */
function snapshotFrame(timers: readonly TimerFact[], serverTime: number): string {
  const message: ServerMessage = {
    type: "snapshot",
    serverTime,
    timers,
    pendingOrders: [],
    recommendations: [],
  };
  return JSON.stringify(message);
}

/**
 * blackhole を被せた opener で接続を組む。**Connectivity_Watch は既定（本物の watchConnectivity）を通す**
 * ——silent-loss 検知（要件1.4）を実際に走らせる必要があるためである。
 *
 * persistence を注入するのは localStorage への依存を断つためだけで、観測には用いない。
 */
function openConnectionThroughBlackhole() {
  const { opener, opened } = fakeOpener();
  const connection = openTimerConnection({
    storeId: STORE_ID,
    url: WS_URL,
    now: () => RECEIVED_AT,
    newId: () => "local-1",
    // 明示的に被せる（自動配線は test では効かない）。isEnabled はランタイム可逆なスイッチそのもの。
    openSocket: withPingBlackhole(opener, isPingBlackholeActive),
    persistence: { save: () => {}, load: (): ClientView => EMPTY_VIEW },
  });

  return {
    connection,
    opened,
    /** 直近に開かれた inner Socket（再接続後は最新）。未生成ならテストの前提が崩れているので即失敗させる。 */
    latest: (): InnerSocket => {
      const last = opened.at(-1);
      if (last === undefined) throw new Error("inner Socket が一つも開かれていない");
      return last;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // down 確定契機は到達不能理由の分類 fetch（probeReachability）を 1 回出す。本ファイルの主題ではないため
  // 実ネットワークへ出さず既定の offline へ畳む形に固定し、ビューを動かさないようにしておく。
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Load failed")));
});

afterEach(() => {
  // モジュールスコープの可変スイッチを必ず戻す。残せば次のテストが blackhole 有効のまま走る。
  setPingBlackholeActive(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("client/connectivity — withPingBlackhole がこの環境で実際に効いている前提", () => {
  it("恒等関数にならず、スイッチの切替がそのまま送信 ping の生死になる（要件14.1 / 14.3）", () => {
    const { opener, opened } = fakeOpener();
    const decorated = withPingBlackhole(opener, isPingBlackholeActive);

    // import.meta.env.DEV が false の環境では実装が inner をそのまま返す（tree-shaking 前提・要件14.4）。
    // その環境で本ファイルが走れば以降の主張はすべて空虚な緑になるため、ここで前提ごと落とす。
    expect(decorated).not.toBe(opener);

    const listeners: SocketListeners = {
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
    };
    const socket = decorated(WS_URL, listeners);
    const inner = opened.at(-1);
    if (inner === undefined) throw new Error("inner Socket が開かれていない");

    // blackhole 無効: ping は inner へ届く。対の主張。これが無ければ「send を常に捨てる」実装でも緑になる。
    socket.send(PING_REQUEST);
    expect(inner.sent).toEqual([PING_REQUEST]);

    // 有効化 → 同じ ping が落ちる。スイッチ（setPingBlackholeActive）が isEnabled（isPingBlackholeActive）へ
    // 届いていることの直接の観測であり、両者が同じ値を見る「一つのスイッチ」であることを示す。
    setPingBlackholeActive(true);
    expect(isPingBlackholeActive()).toBe(true);
    socket.send(PING_REQUEST);
    expect(inner.sent).toEqual([PING_REQUEST]);

    // 解除 → 再び届く（ランタイム可逆・要件14.3）。
    setPingBlackholeActive(false);
    socket.send(PING_REQUEST);
    expect(inner.sent).toEqual([PING_REQUEST, PING_REQUEST]);

    // 観測経路（listeners）は inner のまま。close も素通しする（送信 ping 以外を変えない・要件14.1）。
    socket.close();
    expect(inner.closeCount).toBe(1);
  });
});

describe("client/connectivity — blackhole は送信 ping のみを落とす（要件14.1）", () => {
  it("blackhole 中も通常メッセージ・受信・切断の観測は素通しし、ping だけが inner へ届かない", () => {
    const { connection, latest } = openConnectionThroughBlackhole();

    latest().listeners.onOpen();
    const live = latest();

    // blackhole 無効のうちは ping が inner へ届く（対の主張）。pong を返して未応答計数を 0 に戻し、
    // 以降の miss をここから数え始められるようにする。
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(live.sent.filter(isPing)).toHaveLength(1);
    live.listeners.onMessage(PONG_RESPONSE);
    expect(connection.getView().connectivity).toBe("up");

    setPingBlackholeActive(true);

    // 以後の ping は inner へ届かない（1 本目のまま増えない）。SILENT_LOSS_MISSES 未満で止めて、
    // ここでは検知そのものと交絡させない（検知は次の describe が主題）。
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(live.sent.filter(isPing)).toHaveLength(1);
    expect(connection.getView().connectivity).toBe("up");

    // 受信は素通し。blackhole 中でも全量 snapshot が届き、盤面と offset に畳まれる。
    live.listeners.onMessage(
      snapshotFrame([serverTimer("S", RECEIVED_AT + 180_000)], RECEIVED_AT + 5_000),
    );
    expect(connection.getView().timers.map((timer) => timer.id)).toEqual(["S"]);
    expect(connection.getView().offset).toBe(5_000);

    // 通常メッセージの送信も素通し。live 経路の start が ClientMessage として inner へ届く。
    connection.start(["slot-X"], "udon", 120);
    const nonPing = live.sent.filter((frame) => !isPing(frame));
    expect(nonPing.map((frame): unknown => JSON.parse(frame))).toEqual([
      { type: "start", slotIds: ["slot-X"], noodleType: "udon", boilSeconds: 120 },
    ]);
    // ping が落ちても通常メッセージの本数は減らない（落ちるのは ping だけ・ping-only）。
    expect(live.sent.filter(isPing)).toHaveLength(1);

    // 切断の観測経路も inner のまま。blackhole 中の close が従来どおり down を確定する（要件2.1）。
    live.listeners.onClose();
    expect(connection.getView().connectivity).toBe("down");

    connection.close();
  });
});

describe("client/connectivity — blackhole は本物の silent-loss 検知を通して degraded に入る（要件14.2 / 14.5）", () => {
  it("Mode を書き換えず、連続未応答の計数だけで down を確定する", () => {
    const { connection, latest } = openConnectionThroughBlackhole();

    latest().listeners.onOpen();
    const live = latest();
    live.listeners.onMessage(snapshotFrame([serverTimer("S", RECEIVED_AT + 180_000)], RECEIVED_AT));
    expect(connection.getView().connectivity).toBe("up");
    expect(mode(connection.getView())).toBe("live");

    // **対の主張（因果の分離）。** blackhole 無効のまま同じ時間幅を進め、届いた ping に pong を返す限り up は
    // 保たれる。これを見せずに「時間を進めたら down になった」だけを主張すると、blackhole が何もしていなくても
    // （pong を返さないだけで）緑になる——down の原因が ping の破棄であることを、ここで先に切り分ける。
    for (let attempt = 0; attempt < SILENT_LOSS_MISSES; attempt += 1) {
      vi.advanceTimersByTime(PING_INTERVAL_MS);
      expect(live.sent.filter(isPing)).toHaveLength(attempt + 1);
      live.listeners.onMessage(PONG_RESPONSE);
    }
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(connection.getView().connectivity).toBe("up");
    const pingsBeforeBlackhole = live.sent.filter(isPing).length;

    // スイッチを入れた瞬間には何も起きない。Mode は Connectivity からの導出値であり、blackhole は
    // それに触れない（要件14.5）。時間が経って初めて、検知の側から degraded へ変わる。
    const beforeSwitch = connection.getView();
    setPingBlackholeActive(true);
    expect(connection.getView()).toBe(beforeSwitch);
    expect(mode(connection.getView())).toBe("live");

    // 1 回目の未応答。対の主張。「未応答 1 回で down」の実装ならここで緑にならない。
    vi.advanceTimersByTime(PING_INTERVAL_MS + PONG_TIMEOUT_MS);
    expect(connection.getView().connectivity).toBe("up");
    expect(mode(connection.getView())).toBe("live");

    // SILENT_LOSS_MISSES 回目で down → degraded。落ちた ping は inner へ 1 本も届いていない。
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(connection.getView().connectivity).toBe("down");
    expect(mode(connection.getView())).toBe("degraded");
    // blackhole 有効化以後、inner へ届いた ping は 1 本も増えていない。up を保っていた局面との差は
    // 「ping が破棄されたこと」だけである。
    expect(live.sent.filter(isPing)).toHaveLength(pingsBeforeBlackhole);

    // この down は WS からの通知ではなく未応答の計数から確定した（onClose / onError を一度も呼んでいない）。
    // close は確定の結果であって原因ではない。
    expect(live.closeCount).toBe(1);

    // Mode は独立状態として保持されていない。ClientView は Connectivity だけを持ち、mode(view) で導出する。
    expect(Object.keys(connection.getView())).not.toContain("mode");

    connection.close();
  });
});

describe("client/connectivity — blackhole 解除はランタイム可逆で up 復帰と Reconcile を導く（要件14.3）", () => {
  it("ping 送信が再開して pong で up へ戻り、down→up 遷移が次の全量 snapshot を Reconcile として畳む", () => {
    const { connection, opened, latest } = openConnectionThroughBlackhole();

    // boot の初回 up は down→up 遷移ではない。ゆえにこの snapshot は通常 hydration を通り offset を確立する。
    latest().listeners.onOpen();
    latest().listeners.onMessage(
      snapshotFrame([serverTimer("S", RECEIVED_AT + 180_000)], RECEIVED_AT + 5_000),
    );
    expect(connection.getView().offset).toBe(5_000);

    // blackhole で down まで落とす（本物の silent-loss 経路）。
    setPingBlackholeActive(true);
    vi.advanceTimersByTime(PING_INTERVAL_MS * SILENT_LOSS_MISSES + PONG_TIMEOUT_MS);
    expect(connection.getView().connectivity).toBe("down");

    // 再接続は予約であって即時ではない。猶予（非公開の内部値）を十分に超える幅だけ進める。
    expect(opened).toHaveLength(1);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(opened).toHaveLength(2);

    // 解除 → 新しい接続で ping 送信が再開する（ランタイム可逆）。
    setPingBlackholeActive(false);
    const revived = latest();
    revived.listeners.onOpen();
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(revived.sent.filter(isPing)).toHaveLength(1);

    // pong 受信で up へ復帰する（要件1.3 / 14.3）。ここで down→up 遷移が成立する。
    revived.listeners.onMessage(PONG_RESPONSE);
    expect(connection.getView().connectivity).toBe("up");
    expect(mode(connection.getView())).toBe("live");

    // 復帰後の最初の全量 snapshot は Reconcile として畳まれる。観測点は **offset の凍結** に取る
    // ——Reconcile は serverTime を運ばないため offset を変えず、通常 snapshot 経路なら 9_000 へ書き換わる。
    // 盤面の置換規律は両経路で同一ゆえ、ここが二つの経路を外から分ける唯一の観測点である。
    revived.listeners.onMessage(
      snapshotFrame([serverTimer("N", RECEIVED_AT + 240_000)], RECEIVED_AT + 9_000),
    );
    expect(connection.getView().offset).toBe(5_000);
    // 契機だけ立てて中身を捨てていないこと（Reconcile が snapshot の timers を確かに畳んだ）。
    expect(connection.getView().timers.map((timer) => timer.id)).toEqual(["N"]);

    // 契機は 1 通で消費されて下りる。以降は通常経路へ戻り offset が再確立される——offset が凍結したのは
    // Reconcile だからであって「offset が二度と動かない」からではない。
    revived.listeners.onMessage(
      snapshotFrame([serverTimer("N", RECEIVED_AT + 240_000)], RECEIVED_AT + 12_000),
    );
    expect(connection.getView().offset).toBe(12_000);

    connection.close();
  });
});
