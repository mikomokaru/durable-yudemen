// tests/client/complete.example.test.ts — boiled → 明示完了（complete）→ snapshot 差分で除去 → idle の遷移検証。
// 接続レベル（openTimerConnection）と表示導出（assignedSlotDisplays）で、complete 後に当該 Timer が
// snapshot から消えてスロットが idle へ戻ること、boiled の Complete 対象 timer が正しく拾えることを確認する
// （直前結果の表示そのものは SlotBoard の React state で、ここでは扱わない）。
//
// 後半の describe は同時上がり群の一括消し込み（sync-set-batch-complete）の経路分けを扱う。群の識別と
// 畳み込みの核は property test（boiledGroup.property.test.ts）が覆うため、ここは入力で振る舞いが
// 変わらない配線——live / degraded / 混在の振り分け、watch.send の発行、persistence.save の回数——だけを
// 少数の具体例で固める。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_VIEW,
  openTimerConnection,
  type ClientView,
  type Connectivity,
  type ConnectionOptions,
  type Socket,
  type SocketListeners,
} from "../../src/client/connection";
import type { ConnectivityWatch } from "../../src/client/connectivity";
import { parsePersistedView, type PersistedView } from "../../src/client/persistence";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import type { ClientMessage, ServerMessage } from "../../src/domain/messages";
import type { TimerFact } from "../../src/domain/timer";

const START_NOW = 1_000_000;

interface OpenedSocket {
  readonly listeners: SocketListeners;
  readonly send: ReturnType<typeof vi.fn<(data: string) => void>>;
  readonly close: ReturnType<typeof vi.fn<() => void>>;
}

function setup(overrides: Partial<ConnectionOptions> = {}) {
  const sockets: OpenedSocket[] = [];
  let currentNow = START_NOW;
  const connection = openTimerConnection({
    storeId: "test-store",
    url: "wss://test/ws",
    now: () => currentNow,
    openSocket: (_url, listeners) => {
      const send = vi.fn<(data: string) => void>();
      const close = vi.fn<() => void>();
      sockets.push({ listeners, send, close });
      const socket: Socket = { send, close };
      return socket;
    },
    ...overrides,
  });
  return {
    connection,
    latest: (): OpenedSocket => {
      const last = sockets[sockets.length - 1];
      if (last === undefined) throw new Error("Socket not opened");
      return last;
    },
    setNow: (n: number) => {
      currentNow = n;
    },
  };
}

function receive(opened: OpenedSocket, message: unknown): void {
  opened.listeners.onMessage(JSON.stringify(message));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("client/connection — 茹で上がりの明示完了", () => {
  it("boiled スロットを complete すると completed 受信で除去され idle へ戻る", () => {
    const { connection, latest } = setup();
    latest().listeners.onOpen();

    // endTime が過去の Timer を hydration で受け取る（クライアントでは boiled として導出される）。
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [{ id: "T", slotIds: ["3"], noodleType: "Medium", endTime: START_NOW - 1000 }],
    });

    // boiled として在席し、表示導出も boiled（Complete 対象 timer を保持）になる。
    const view1 = connection.getView();
    expect(view1.timers.map((t) => t.id)).toEqual(["T"]);
    const displays1 = assignedSlotDisplays(view1, [0], START_NOW);
    const slot3 = displays1.find((d) => d.slot === 3);
    expect(slot3?.kind).toBe("boiled");
    expect(slot3 && slot3.kind === "boiled" ? slot3.timer.noodleType : null).toBe("Medium");

    // 明示完了を送る（live 経路）。
    connection.complete("T");
    const sent = latest().send.mock.calls.map(([d]) => JSON.parse(d));
    expect(sent).toContainEqual({ type: "complete", timerId: "T" });

    // サーバが T の消えた snapshot をブロードキャスト → Timer 除去 → スロットは idle へ。直前結果が差分で記録される。
    receive(latest(), { type: "snapshot", serverTime: START_NOW + 5, timers: [] });
    const view2 = connection.getView();
    expect(view2.timers.some((t) => t.id === "T")).toBe(false);
    const displays2 = assignedSlotDisplays(view2, [0], START_NOW);
    expect(displays2.find((d) => d.slot === 3)?.kind).toBe("idle");
    // 直前結果（残滓）が当該スロット（slotId "3"）に記録されている。at は client 受信時刻（receivedAt = now()）。
    expect(view2.lastResults.get("3")).toEqual({ noodleType: "Medium", at: START_NOW });

    connection.close();
  });

  it("当該スロットで新規開始すると直前結果（残滓）は解除される（要件13.7）", () => {
    const { connection, latest } = setup();
    latest().listeners.onOpen();
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [{ id: "T", slotIds: ["3"], noodleType: "Medium", endTime: START_NOW - 1000 }],
    });
    connection.complete("T");
    receive(latest(), { type: "snapshot", serverTime: START_NOW + 5, timers: [] });
    expect(connection.getView().lastResults.has("3")).toBe(true);

    // スロット 3 で新規開始（当該スロットを占有する snapshot 受信）→ 残滓は差分で解除される。
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW + 10,
      timers: [{ id: "U", slotIds: ["3"], noodleType: "Thin", endTime: START_NOW + 70_000 }],
    });
    expect(connection.getView().lastResults.has("3")).toBe(false);

    connection.close();
  });
});
describe("client/connection — 同時上がり群の一括消し込み（経路分けと端の観測）", () => {
  /** boiled な実効 endTime（offset 0 ゆえ START_NOW との差だけで boiled / running が決まる）。 */
  const BOILED_AT = START_NOW - 1_000;

  /**
   * Connectivity を直接駆動できる偽 Watch と、呼び出し回数を数える偽 ViewStore で接続を組む
   * （connection.example.test.ts の setupWithWatch と同形）。
   *
   * なぜ既定の watchConnectivity では足りないか: 切断中の watchConnectivity は socket を捨てるため、
   * degraded の「送らない」が mode の判断なのか socket 不在の帰結なのか区別できない。偽 Watch の send を
   * 直接数えることで、観測対象を経路分けそのものに絞る。
   *
   * なぜ persistence を注入するか: 一括を 1 回の update に畳む判断（design「ファンアウトの形」）は、
   * save の呼び出し回数としてしか外から見えない。2 回走れば中間ビュー（群の一部だけが消えた盤面）が
   * 外へ出ている。load は既定で EMPTY_VIEW にして boot 再水和の雑音を消し、未同期経路（要件2.7）だけ
   * 再水和ビューを渡す——`openTimerConnection` は接続前に load で再水和するため、hydration 前の
   * `sync === "connecting"` を作れる入口はここだけである。
   */
  function setupWithWatch(rehydrated: ClientView = EMPTY_VIEW) {
    const send = vi.fn<(message: ClientMessage) => void>();
    const save = vi.fn<(view: ClientView) => void>();
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
      storeId: "test-store",
      url: "wss://test/ws",
      now: () => currentNow,
      newId: () => `local-${(idCounter += 1)}`,
      connectivity: () => watch,
      persistence: { save, load: () => rehydrated },
    });
    return {
      connection,
      send,
      save,
      setConnectivity: (status: Connectivity) => connectivityHandler?.(status),
      /**
       * 全量 snapshot を受信させる。serverTime に受信時点の now を渡すため offset は常に 0 になる。
       * 群の基準時刻は now() + view.offset ゆえ、offset を 0 に保つと endTime と setNow の値がそのまま対応する。
       */
      receiveSnapshot: (timers: readonly TimerFact[]) =>
        serverMessageHandler?.(
          { type: "snapshot", serverTime: currentNow, timers, pendingOrders: [], recommendations: [] },
          currentNow,
        ),
      setNow: (next: number) => {
        currentNow = next;
      },
      /** サーバへ送られた complete の timerId 列（どのメンバーが送られたか）。ping 等の他フレームは混じらない。 */
      completeSends: (): readonly string[] =>
        send.mock.calls
          .map(([message]) => message)
          .filter((message) => message.type === "complete")
          .map((message) => message.timerId),
    };
  }

  /** テスト用 TimerFact。slotId は数値文字列（担当ユニット 0 は slot 0..5・slotOf が Number で読む）。 */
  function timerAt(id: string, slotId: string, endTime: number): TimerFact {
    return {
      id,
      slotIds: [slotId],
      noodleType: `noodle-${id}`,
      firmness: "normal",
      startTime: START_NOW,
      endTime,
    };
  }

  /**
   * 永続ブロブから再水和したビュー（setupWithWatch の load へ渡す）。
   *
   * なぜ ClientView を手組みしないか: 再水和後の sync が "connecting"・connectivity が "down" 起点であることは
   * parsePersistedView が EMPTY_VIEW のベース値へ重ねる帰結であり、それが要件2.7 の前提そのものである。
   * 手組みすれば前提をテスト側で捏造することになる。実コーデックを通せば前提は実装から出る。
   */
  function rehydratedView(timers: readonly TimerFact[]): ClientView {
    const blob: PersistedView = {
      version: 1,
      timers: timers.map((timer) => ({ ...timer, origin: "server" as const })),
      offset: 0,
      processedIds: [],
    };
    return parsePersistedView(JSON.stringify(blob));
  }

  it("live × 全 server-confirmed — 群の全メンバーへ complete を送り、局所ビューは動かさない（要件2.1 / 2.3 / 6.3）", () => {
    const { connection, save, setConnectivity, receiveSnapshot, completeSends } = setupWithWatch();
    setConnectivity("up");
    // 同一 endTime の boiled 2 件を hydration で受ける（同期確定した Sync_Set の実効 endTime は完全一致する）。
    receiveSnapshot([timerAt("T1", "0", BOILED_AT), timerAt("T2", "1", BOILED_AT)]);
    const before = connection.getView();
    expect(before.timers.map((t) => t.id)).toEqual(["T1", "T2"]);

    save.mockClear();
    connection.complete("T1");

    // 押下は片方だけ。送信は 2 件それぞれへ発行される（どのメンバーが送られたかまで見る）。
    expect(completeSends()).toEqual(["T1", "T2"]);
    // ビューは参照ごと不変。server-confirmed の除去はサーバの全量 snapshot が運ぶため、押下時点で
    // 局所ビューを動かす理由が無い（動かせば、まだ確定していない除去を先に見せることになる）。
    expect(connection.getView()).toBe(before);
    expect(save).not.toHaveBeenCalled();

    connection.close();
  });

  it("degraded — 送信ゼロで 2 件消え、persistence.save は 1 回だけ（要件5.1 / 5.2）", () => {
    const { connection, send, save, setConnectivity, receiveSnapshot } = setupWithWatch();
    setConnectivity("up");
    receiveSnapshot([timerAt("T1", "0", BOILED_AT), timerAt("T2", "1", BOILED_AT)]);
    // 回線喪失。以降 mode は degraded ゆえローカル権限で畳む。
    setConnectivity("down");

    send.mockClear();
    save.mockClear();
    connection.complete("T1");

    expect(send).not.toHaveBeenCalled();
    expect(connection.getView().timers.map((t) => t.id)).toEqual([]);
    // 2 件消しても save は 1 回。2 回なら中間ビュー（片方だけ消えた盤面）が購読者と永続層へ出ている。
    expect(save).toHaveBeenCalledTimes(1);

    connection.close();
  });

  it("混在（live）— server 分はサーバへ送り、Provisional_Timer はローカル除去する（要件2.3 / 2.4）", () => {
    const { connection, save, setConnectivity, receiveSnapshot, setNow, completeSends } = setupWithWatch();
    // boot は connectivity down（degraded）。ここで開始すると provisional（origin:"local"）が生まれる。
    connection.start(["1"], "udon", 120);
    const provisional = connection.getView().timers.find((t) => t.origin === "local");
    expect(provisional).toBeDefined();

    setConnectivity("up");
    // provisional と同一の実効 endTime を持つ server-confirmed を受ける（同時上がり）。
    receiveSnapshot([timerAt("S", "0", provisional!.endTime)]);
    // offset は 0 ゆえ endTime をそのまま渡せば両者 boiled（境界 endTime === correctedNow は boiled 側）。
    setNow(provisional!.endTime);

    save.mockClear();
    connection.complete("S");

    // server 分だけが送られ、local 分は送られない（サーバは id を知らない＝幽霊タイマー化を避ける）。
    expect(completeSends()).toEqual(["S"]);
    const after = connection.getView();
    expect(after.timers.map((t) => t.id)).toEqual(["S"]);
    expect(after.timers.some((t) => t.id === provisional!.id)).toBe(false);
    // ローカル除去の 1 件分だけビューが動く（save も 1 回）。
    expect(save).toHaveBeenCalledTimes(1);

    connection.close();
  });

  it("1 件（退化）— 同一 endTime の他メンバーが無ければ complete は 1 回だけ（要件2.2）", () => {
    const { connection, setConnectivity, receiveSnapshot, completeSends } = setupWithWatch();
    setConnectivity("up");
    // U も boiled だが endTime が違う。群の識別は「boiled であること」ではなく実効 endTime の等値である。
    receiveSnapshot([timerAt("T", "0", BOILED_AT), timerAt("U", "1", BOILED_AT - 1_000)]);

    connection.complete("T");

    expect(completeSends()).toEqual(["T"]);

    connection.close();
  });

  it("対象 running — 群が空ゆえ送信ゼロ・ビュー不変（要件1.2 / 3.2）", () => {
    const { connection, send, save, setConnectivity, receiveSnapshot } = setupWithWatch();
    setConnectivity("up");
    receiveSnapshot([timerAt("R", "0", START_NOW + 60_000)]);
    const before = connection.getView();

    send.mockClear();
    save.mockClear();
    connection.complete("R");

    // 窓口の関門（boiledGroup が空を返す）で止まる。update(view) は参照同一ゆえ早期 return する。
    expect(send).not.toHaveBeenCalled();
    expect(connection.getView()).toBe(before);
    expect(save).not.toHaveBeenCalled();

    connection.close();
  });

  it("担当外メンバー — 担当ユニット外のスロットを駆動する boiled メンバーも消し込む（要件4.1 / 4.2）", () => {
    const { connection, setConnectivity, receiveSnapshot, completeSends } = setupWithWatch();
    setConnectivity("up");
    // OUT は slot 11（unit 1）を駆動する。押下者の担当は unit 0（slot 0..5）ゆえ盤面には現れない。
    receiveSnapshot([timerAt("IN", "3", BOILED_AT), timerAt("OUT", "11", BOILED_AT)]);
    const displays = assignedSlotDisplays(connection.getView(), [0], START_NOW);
    expect(displays.find((d) => d.slot === 3)?.kind).toBe("boiled");
    expect(displays.some((d) => d.slot === 11)).toBe(false); // 担当外＝操作口も表示も持たない

    connection.complete("IN");

    // 担当射影は群に掛からない。同時に上がった以上、担当外のメンバーも一括の対象である。
    expect(completeSends()).toEqual(["IN", "OUT"]);

    connection.close();
  });

  // 一括完了の後にスロットが何として見えるか。slotDisplay.ts は変更しないため、ここは新しい挙動の検証では
  // なく「群が消えた盤面へ既存導出を掛けた帰結」の固定である。degraded で観測するのは、live の
  // server-confirmed 除去はサーバの全量 snapshot が運ぶため押下時点の局所ビューが動かないからである。
  describe("完了後の表示導出（既存 assignedSlotDisplays の帰結）", () => {
    it("完了後の idle 導出 — 駆動 Timer が残らず sync が synced なら idle（要件2.5）", () => {
      const { connection, setConnectivity, receiveSnapshot } = setupWithWatch();
      setConnectivity("up");
      receiveSnapshot([timerAt("T1", "0", BOILED_AT), timerAt("T2", "1", BOILED_AT)]);
      // 回線喪失。sync は snapshot 受信で立った "synced" のまま（Connectivity は sync を触らない）。
      setConnectivity("down");
      expect(connection.getView().sync).toBe("synced");

      connection.complete("T1");

      const after = connection.getView();
      expect(after.timers).toEqual([]);
      expect(after.sync).toBe("synced");
      const displays = assignedSlotDisplays(after, [0], START_NOW);
      // 両スロットとも駆動 Timer が残らない → 同期済みゆえ idle（開始操作を提示できる状態）。
      expect(displays.find((d) => d.slot === 0)?.kind).toBe("idle");
      expect(displays.find((d) => d.slot === 1)?.kind).toBe("idle");

      connection.close();
    });

    it("未同期での完了後は unreceived — 再水和直後の一括完了は idle を騙らない（要件2.7）", () => {
      // 永続ブロブから server-confirmed を再水和し、hydration を受けずに complete する。sync は
      // "connecting"・connectivity は "down" 起点ゆえ mode は degraded——ローカル畳み込みだけで群が消える。
      const { connection, send } = setupWithWatch(
        rehydratedView([timerAt("T1", "0", BOILED_AT), timerAt("T2", "1", BOILED_AT)]),
      );
      const before = connection.getView();
      expect(before.sync).toBe("connecting");
      expect(before.timers.map((t) => t.id)).toEqual(["T1", "T2"]);

      connection.complete("T1");

      const after = connection.getView();
      expect(send).not.toHaveBeenCalled();
      expect(after.timers).toEqual([]);
      const displays = assignedSlotDisplays(after, [0], START_NOW);
      // 要件2.5 と同じ盤面（駆動 Timer が残らない）でも、未受信を idle と偽らない。idle は同期済みを要する。
      expect(displays.find((d) => d.slot === 0)?.kind).toBe("unreceived");
      expect(displays.find((d) => d.slot === 1)?.kind).toBe("unreceived");

      connection.close();
    });

    it("完了後もスロットが占有される — 群外 Timer が残れば走行中優先・同区分は最早 endTime（要件2.6）", () => {
      const { connection, setConnectivity, receiveSnapshot } = setupWithWatch();
      setConnectivity("up");
      // engine はスロット排他を課さないため、同一スロットを複数 Timer が駆動する盤面は有効入力である。
      // 群は endTime の等値で決まる（BOILED_AT の 2 件のみ）。他は群外——走行中 2 件と、別 endTime の boiled 2 件。
      receiveSnapshot([
        timerAt("T1", "0", BOILED_AT), // 群メンバー（押下対象）
        timerAt("RUN_LATE", "0", START_NOW + 60_000), // 群外・走行中
        timerAt("RUN_EARLY", "0", START_NOW + 20_000), // 群外・走行中（最早）
        timerAt("STALE", "0", BOILED_AT - 5_000), // 群外・boiled（走行中があるので表示には出ない）
        timerAt("T2", "1", BOILED_AT), // 群メンバー
        timerAt("OLD", "1", BOILED_AT - 2_000), // 群外・boiled
        timerAt("OLDEST", "1", BOILED_AT - 7_000), // 群外・boiled（最早）
      ]);
      setConnectivity("down");

      connection.complete("T1");

      const after = connection.getView();
      // 消えたのは群の 2 件だけ（群外は endTime が異なるゆえ一括の対象にならない）。
      expect(after.timers.map((t) => t.id)).toEqual(["RUN_LATE", "RUN_EARLY", "STALE", "OLD", "OLDEST"]);

      const displays = assignedSlotDisplays(after, [0], START_NOW);
      const slot0 = displays.find((d) => d.slot === 0);
      // slot 0 は走行中が残る → boiled（STALE）より走行中を優先し、走行中が複数なら最早 endTime を採る。
      expect(slot0?.kind).toBe("running");
      expect(slot0 && slot0.kind === "running" ? slot0.timer.id : null).toBe("RUN_EARLY");
      const slot1 = displays.find((d) => d.slot === 1);
      // slot 1 は boiled のみが残る → 最早 endTime を消し込み対象にする。
      expect(slot1?.kind).toBe("boiled");
      expect(slot1 && slot1.kind === "boiled" ? slot1.timer.id : null).toBe("OLDEST");

      connection.close();
    });
  });

  // 残滓（直前結果）の反映順と占有スロットの扱い。recordLastResults / reconcileServerConfirmed は変更しない
  // ため、ここは新しい挙動の検証ではなく既存規律へ一括完了を掛けた帰結の固定である。
  //
  // 前提は退化入力である——engine はスロット排他を課さないため同一スロットを複数メンバーが駆動し得る一方、
  // lastResults はスロットをキーとする写像で 1 件しか保持しない。ゆえに「どのメンバーの麺種が残るか」（値の
  // 選択規則・要件8.4）と「そもそも記録するか」（経路が決める・要件8.7 / 8.8）が問題になる。timerAt が
  // noodleType を `noodle-${id}` にするので、残った麺種から id を読み取れる。
  //
  // Property 8 はローカル畳み込み経路に範囲を限っている（反映順を引数化して値の選択規則だけを検査する）。
  // ここが覆うのは Property が意図的に外した範囲——live の server-confirmed 経路の残滓と、占有スロットの
  // 扱いの経路間の非対称（degraded は占有を見ずに記録し、live は記録を見送り既存の残滓まで消す）である。
  describe("残滓の反映順と占有スロット（既存 recordLastResults / reconcileServerConfirmed の帰結）", () => {
    it("degraded の畳み込み順 — 同一スロットを駆動する 2 メンバーでは保持列で後のメンバーの麺種が残る（要件8.5 degraded 節）", () => {
      // 端のループは boiledGroup の返す並び（＝ view.timers の並び）で LocalComplete を畳み、
      // recordLastResults は set で上書きする。ゆえに後に畳まれたメンバーが残滓に残る。
      const forward = setupWithWatch();
      forward.setConnectivity("up");
      forward.receiveSnapshot([timerAt("T1", "0", BOILED_AT), timerAt("T2", "0", BOILED_AT)]);
      forward.setConnectivity("down");

      forward.connection.complete("T1");

      expect(forward.connection.getView().timers).toEqual([]);
      expect(forward.connection.getView().lastResults.get("0")).toEqual({
        noodleType: "noodle-T2",
        at: START_NOW,
      });
      forward.connection.close();

      // 並びを入れ替えれば残る麺種も入れ替わる。この観測が要るのは、id の辞書順・押下対象・endTime では
      // なく「保持列の並び」が決めていることを示すためである（一方向だけでは区別できない）。
      const reversed = setupWithWatch();
      reversed.setConnectivity("up");
      reversed.receiveSnapshot([timerAt("T2", "0", BOILED_AT), timerAt("T1", "0", BOILED_AT)]);
      reversed.setConnectivity("down");

      reversed.connection.complete("T1");

      expect(reversed.connection.getView().lastResults.get("0")).toEqual({
        noodleType: "noodle-T1",
        at: START_NOW,
      });
      reversed.connection.close();
    });

    it("degraded の占有スロットへの記録 — 群外 Timer が占有していても残滓を記録する（要件8.8）", () => {
      const { connection, setConnectivity, receiveSnapshot } = setupWithWatch();
      setConnectivity("up");
      // HOLD は群外（endTime が違う）だが、群メンバー T1 と同一スロット "0" を駆動する。
      receiveSnapshot([
        timerAt("T1", "0", BOILED_AT),
        timerAt("T2", "1", BOILED_AT),
        timerAt("HOLD", "0", START_NOW + 60_000),
      ]);
      setConnectivity("down");

      connection.complete("T1");

      const after = connection.getView();
      expect(after.timers.map((t) => t.id)).toEqual(["HOLD"]);
      // 占有が実在することを表示導出で確かめる（slot 0 は idle にならず HOLD で running）。この観測が要るのは、
      // 「占有していないから記録された」という別の説明を排すためである。占有していても記録される——
      // recordLastResults は占有を見ない。live 経路との非対称がここに現れる。
      const displays = assignedSlotDisplays(after, [0], START_NOW);
      expect(displays.find((d) => d.slot === 0)?.kind).toBe("running");
      expect(after.lastResults.get("0")).toEqual({ noodleType: "noodle-T1", at: START_NOW });
      expect(after.lastResults.get("1")).toEqual({ noodleType: "noodle-T2", at: START_NOW });

      connection.close();
    });

    it("live の占有スロットの残滓 — 新 serverTimers が占有すれば記録を見送り既存の残滓も消える（要件8.7）", () => {
      const { connection, setConnectivity, receiveSnapshot, completeSends } = setupWithWatch();
      // 先に残滓の種を仕込む。A / B が slot "0" を占有する間、snapshot の (c) は毎回その slot の残滓を
      // 消すため、この窓で残滓を作れるのはローカル畳み込みだけである（boot は degraded ゆえ provisional が生まれる）。
      connection.start(["0"], "seed-noodle", 120);
      const seed = connection.getView().timers.find((t) => t.origin === "local");
      expect(seed).toBeDefined();

      setConnectivity("up");
      // 同一スロット "0" を駆動する server-confirmed 2 件（同一 endTime ゆえ同一群）。
      receiveSnapshot([timerAt("A", "0", BOILED_AT), timerAt("B", "0", BOILED_AT)]);
      // provisional を cancel してローカルに残滓を書く（除去理由を問わない一様残滓・要件8.2 と同じ規律）。
      connection.cancel(seed!.id);
      expect(connection.getView().lastResults.get("0")).toEqual({ noodleType: "seed-noodle", at: START_NOW });

      connection.complete("A");

      // live × server-confirmed ゆえ押下時点でビューは動かない。除去は snapshot が運ぶ。
      expect(completeSends()).toEqual(["A", "B"]);
      expect(connection.getView().lastResults.get("0")).toEqual({ noodleType: "seed-noodle", at: START_NOW });

      // その snapshot が slot "0" を新しい server-confirmed N で占有している。
      receiveSnapshot([timerAt("N", "0", START_NOW + 90_000)]);

      const after = connection.getView();
      expect(after.timers.map((t) => t.id)).toEqual(["N"]);
      // (c) が既存の残滓を消し、(b) は占有スロットへ書かない。ゆえに noodle-A も noodle-B も seed-noodle も残らない。
      // 記録が見送られる以上、値の選択規則（要件8.4）はここでは適用先を持たない——階層が違うので衝突しない。
      expect(after.lastResults.has("0")).toBe(false);

      connection.close();
    });

    it("live の占有スロットの残滓 — 保持 provisional が占有しても同じ（要件8.7）", () => {
      const { connection, setConnectivity, receiveSnapshot } = setupWithWatch();
      // occupied は「新 serverTimers ∪ 保持 provisional」のスロット。占有役の provisional（残す）と、
      // 残滓の種になる provisional（あとで cancel する）を degraded の boot で作る。
      connection.start(["0"], "keep-noodle", 180);
      connection.start(["0"], "seed-noodle", 120);
      const locals = connection.getView().timers.filter((t) => t.origin === "local");
      expect(locals).toHaveLength(2);
      const keep = locals[0]!;
      const seed = locals[1]!;

      setConnectivity("up");
      receiveSnapshot([timerAt("A", "0", BOILED_AT), timerAt("B", "0", BOILED_AT)]);
      connection.cancel(seed.id);
      expect(connection.getView().lastResults.get("0")).toEqual({ noodleType: "seed-noodle", at: START_NOW });

      connection.complete("A");

      // 除去を運ぶ snapshot に server-confirmed は残らないが、保持 provisional keep が slot "0" を占有する。
      receiveSnapshot([]);

      const after = connection.getView();
      expect(after.timers.map((t) => t.id)).toEqual([keep.id]);
      expect(after.lastResults.has("0")).toBe(false);

      connection.close();
    });

    it("同一 snapshot 内の反映順 — 1 通で 2 件の消失が判明すると prevServer で後のメンバーの麺種が残る（要件8.5 live 節）", () => {
      // reconcileServerConfirmed は差分を受け取らない。消失は prevServer（受信時点の保持列から
      // origin==="server" を抽出した並び）の走査で導く。ゆえに中間 snapshot を受けず全量 snapshot を
      // 1 通だけ受ける形にする——2 通に分ければ到着順でも同じ結果が説明でき、走査順を固定できない。
      const forward = setupWithWatch();
      forward.setConnectivity("up");
      forward.receiveSnapshot([timerAt("X", "0", BOILED_AT), timerAt("Y", "0", BOILED_AT)]);

      forward.connection.complete("X");
      expect(forward.completeSends()).toEqual(["X", "Y"]);

      // 両者が消えた全量 snapshot を 1 通だけ受ける（中間 snapshot の取り逃しは要件6.6 が許容する）。
      forward.receiveSnapshot([]);
      expect(forward.connection.getView().lastResults.get("0")).toEqual({
        noodleType: "noodle-Y",
        at: START_NOW,
      });
      forward.connection.close();

      // 保持列の並びを入れ替えれば残る麺種も入れ替わる。受けた snapshot は同じく 1 通ゆえ、決めているのは
      // 到着順ではなく prevServer の走査順である。
      const reversed = setupWithWatch();
      reversed.setConnectivity("up");
      reversed.receiveSnapshot([timerAt("Y", "0", BOILED_AT), timerAt("X", "0", BOILED_AT)]);

      reversed.connection.complete("X");
      reversed.receiveSnapshot([]);

      expect(reversed.connection.getView().lastResults.get("0")).toEqual({
        noodleType: "noodle-X",
        at: START_NOW,
      });
      reversed.connection.close();
    });

    it("混在の反映順 — 保持列で最後の provisional は残らず、後から届く server 分が上書きする（要件8.6）", () => {
      const { connection, setConnectivity, receiveSnapshot, setNow, completeSends } = setupWithWatch();
      // boot は degraded ゆえ provisional が生まれる。
      connection.start(["0"], "local-noodle", 120);
      const provisional = connection.getView().timers.find((t) => t.origin === "local");
      expect(provisional).toBeDefined();

      setConnectivity("up");
      // 同一スロット "0"・同一実効 endTime の server-confirmed を受ける。保持列は [S, P]（provisional が最後）。
      receiveSnapshot([timerAt("S", "0", provisional!.endTime)]);
      setNow(provisional!.endTime);
      expect(connection.getView().timers.map((t) => t.origin)).toEqual(["server", "local"]);

      connection.complete("S");

      // 押下時点で反映されるのは provisional 分だけ（S はサーバ確定待ち）。ここで残滓は保持列で最後の
      // メンバーの麺種になっている——この中間状態を見ておかないと、あとの上書きが観測にならない。
      expect(completeSends()).toEqual(["S"]);
      expect(connection.getView().lastResults.get("0")).toEqual({
        noodleType: "local-noodle",
        at: provisional!.endTime,
      });

      // S の除去が snapshot で届く。slot "0" は占有されていないので (b) が残滓を上書きする。
      receiveSnapshot([]);

      // 保持列で最後の provisional が残るとは限らない（design が挙げた反例そのもの）。経路をまたぐ反映順は
      // 到着順に委ねられ、後に反映された server 分が勝つ。
      expect(connection.getView().lastResults.get("0")).toEqual({
        noodleType: "noodle-S",
        at: provisional!.endTime,
      });

      connection.close();
    });

    it("混在の反映順 — 後から届く snapshot が当該スロットを占有していれば provisional の残滓は消える（要件8.6 / 8.7）", () => {
      const { connection, setConnectivity, receiveSnapshot, setNow } = setupWithWatch();
      connection.start(["0"], "local-noodle", 120);
      const provisional = connection.getView().timers.find((t) => t.origin === "local");
      expect(provisional).toBeDefined();

      setConnectivity("up");
      receiveSnapshot([timerAt("S", "0", provisional!.endTime)]);
      setNow(provisional!.endTime);

      connection.complete("S");
      expect(connection.getView().lastResults.get("0")).toEqual({
        noodleType: "local-noodle",
        at: provisional!.endTime,
      });

      // 除去を運ぶ snapshot が slot "0" を新しい server-confirmed で占有している。
      receiveSnapshot([timerAt("N", "0", provisional!.endTime + 200_000)]);

      const after = connection.getView();
      expect(after.timers.map((t) => t.id)).toEqual(["N"]);
      // 上書きではなく消去。同じ混在の盤面でも、占有の有無で live 経路の帰結が分かれる（要件8.7）。
      expect(after.lastResults.has("0")).toBe(false);

      connection.close();
    });
  });
});
