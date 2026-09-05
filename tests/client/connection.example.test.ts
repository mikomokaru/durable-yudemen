// tests/client/connection.example.test.ts — WS 接続コントローラの example テスト（タスク19.2）。
//
// reduceView の純粋性は別途検証できるが、ここでは作用の端（openTimerConnection）の振る舞いを
// 具体例で確認する。確認対象は次の三つ:
//   1. snapshot 全置換と、含まれない Timer / 処理済み記録の刈り取り（要件4.2 / 4.5）
//   2. 接続確立から 2 秒で snapshot 未受信なら同期失敗を表面化し、既存表示を保持する（要件4.6 / 5.5）
//   3. 切断中も offset を固定したままローカル再算出ティックが継続し、サーバ通信が発生しない
//      （要件5.2 / 5.3）
//
// WebSocket グローバルには触れず、SocketOpener / now を注入して決定的に駆動する。据え付け
// （偽 Socket / 偽 Connectivity_Watch）は support/timerConnection.ts に置き、complete.example と共有する。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remainingMs } from "../../src/client/clock";
import { EMPTY_VIEW, mode } from "../../src/client/connection";
import type { SlotOffsets, UnitOrigin } from "../../src/domain/store";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import type { TimerFact } from "../../src/domain/timer";
import { configResidualDefaults } from "../storeConfigDefaults";
import {
  openConnectionWithFakeSockets,
  openConnectionWithFakeWatch,
  receiveFrame,
  START_NOW,
} from "./support/timerConnection";

/** テスト用 TimerFact 生成。endTime は START_NOW から十分先に置く。startTime は START_NOW（開始時刻の事実）。 */
function makeTimer(id: string, endTime = START_NOW + 180_000): TimerFact {
  return {
    id,
    slotIds: [`slot-${id}`],
    noodleType: "ramen",
    firmness: "normal",
    startTime: START_NOW,
    endTime,
    orderItem: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("client/connection — 状態同期と切断継続", () => {
  it("snapshot は表示中 Timer 集合を全置換し、含まれない Timer と処理済み記録を刈り取る（要件4.2 / 4.5）", () => {
    const { connection, latest } = openConnectionWithFakeSockets();
    latest().listeners.onOpen();

    // 最初の snapshot で A・B を保持し synced になる。A は endTime が過去（クライアントで boiled として導出される）。
    receiveFrame(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [makeTimer("A", START_NOW - 1000), makeTimer("B")],
      pendingOrders: [],
      recommendations: [],
    });
    expect(connection.getView().sync).toBe("synced");
    expect(connection.getView().timers.map((t) => t.id)).toEqual(["A", "B"]);

    // 茹で上がりアラートはクライアントのローカル導出（endTime ≤ 補正後現在）で鳴り、A を処理済みに記録する
    // （server の boiled メッセージは撤去済み。dedup は endTime 導出＋ LocalDone 記録で担う）。
    vi.advanceTimersByTime(1000);
    expect(connection.getView().processedIds.has("A")).toBe(true);

    // 次の snapshot は B・C のみ。A は表示から除去され、処理済み記録からも刈り取られる。
    receiveFrame(latest(), {
      type: "snapshot",
      serverTime: START_NOW + 20,
      timers: [makeTimer("B"), makeTimer("C")],
      pendingOrders: [],
      recommendations: [],
    });
    expect(connection.getView().timers.map((t) => t.id)).toEqual(["B", "C"]);
    expect(connection.getView().processedIds.has("A")).toBe(false);

    connection.close();
  });

  it("接続確立から 2 秒 snapshot 未受信なら同期失敗を表面化し、既存表示を保持する（要件4.6 / 5.5）", () => {
    const { connection, latest } = openConnectionWithFakeSockets();

    // 初回接続で snapshot を受け、A を表示中 synced にしておく。
    latest().listeners.onOpen();
    receiveFrame(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [makeTimer("A")],
      pendingOrders: [],
      recommendations: [],
    });
    expect(connection.getView().sync).toBe("synced");

    // 切断 → 再接続猶予（既定 1000ms）後に再接続が試みられ、新しい Socket が開く。
    latest().listeners.onClose();
    const beforeReconnect = latest();
    vi.advanceTimersByTime(1000);
    expect(latest()).not.toBe(beforeReconnect); // 再接続で別 Socket が開いている

    // 再接続が確立しても 2 秒以内に snapshot が来なければ同期失敗。
    latest().listeners.onOpen();
    vi.advanceTimersByTime(2000);

    expect(connection.getView().sync).toBe("syncFailed");
    // 既存表示（A）は失われない（瞬断で表示は死なない・要件4.6）。
    expect(connection.getView().timers.map((t) => t.id)).toEqual(["A"]);

    connection.close();
  });

  it("切断中は offset を固定したままローカル再算出ティックが継続し、サーバ通信は発生しない（要件5.2 / 5.3）", () => {
    const { connection, latest, setNow } = openConnectionWithFakeSockets();

    // 接続中に snapshot を受け、offset を確立する（serverTime と受信時刻 START_NOW の差）。
    latest().listeners.onOpen();
    const endTime = START_NOW + 60_000; // 受信時点で残り 60 秒
    receiveFrame(latest(), {
      type: "snapshot",
      serverTime: START_NOW + 5_000, // サーバはローカルより 5 秒進んでいる
      timers: [
        {
          id: "A",
          slotIds: ["slot-A"],
          noodleType: "ramen",
          firmness: "normal",
          startTime: endTime - 60_000,
          endTime,
        },
      ],
      pendingOrders: [],
      recommendations: [],
    });
    const fixedOffset = connection.getView().offset;
    expect(fixedOffset).toBe(5_000);

    // 切断。以降サーバからの受信はない。
    const disconnected = latest();
    disconnected.listeners.onClose();

    // 再描画（ローカル再算出）の継続をティック購読で確認する。
    let renders = 0;
    const unsubscribe = connection.subscribe(() => {
      renders += 1;
    });

    // ローカル時刻を 10 秒進めつつ、再算出ティック（既定 1000ms）を進める。
    setNow(START_NOW + 10_000);
    vi.advanceTimersByTime(3_000);
    expect(renders).toBeGreaterThanOrEqual(3); // 切断中もティックが止まらない

    // offset は固定のまま（新しい serverTime を受け取っていないので再確立されない）。
    expect(connection.getView().offset).toBe(fixedOffset);

    // 固定 offset（5s）と進んだローカル時刻だけで残りがローカル導出され、経過分だけ減り続ける。
    // 受信時点（START_NOW）: 補正後現在は +5s 進むため remaining 55s、10 秒経過後は 45s。サーバ問い合わせなし。
    expect(remainingMs(endTime, fixedOffset, START_NOW)).toBe(55_000);
    expect(remainingMs(endTime, fixedOffset, START_NOW + 10_000)).toBe(45_000);

    // 切断中の操作はサーバへ送られない（送信は connected を満たす時だけ）。
    connection.start(["slot-X"], "udon", 120);
    connection.cancel("A");
    expect(disconnected.send).not.toHaveBeenCalled();

    unsubscribe();
    connection.close();
  });
});

describe("client/connection — config 受信で釜の組に要る 3 項目が写る（lift-group-display 要件4.7）", () => {
  it("unitOrigins / slotOffsets / affinityToleranceDistance をサーバの値のまま持ち、重み・許容幅は持たない", () => {
    const { connection, receiveMessage } = openConnectionWithFakeWatch();

    // 既定と見分けのつく値を置く。既定のまま送ると「写した」と「EMPTY_VIEW の既定が残った」が同じ観測になる。
    const unitOrigins: readonly UnitOrigin[] = [
      { x: 0, y: 0 },
      { x: 0, y: 5 },
    ];
    const slotOffsets: SlotOffsets = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
      { x: 2, y: 2 },
    ];
    receiveMessage(
      {
        type: "config",
        serverTime: START_NOW,
        ...configResidualDefaults(2),
        unitCount: 2,
        arms: 2,
        toleranceRatio: 10,
        noodlePresets: DEFAULT_NOODLE_PRESETS,
        unitOrigins,
        slotOffsets,
        affinityToleranceDistance: 24,
      },
      START_NOW,
    );

    const view = connection.getView();
    expect(view.unitOrigins).toEqual(unitOrigins);
    expect(view.slotOffsets).toEqual(slotOffsets);
    expect(view.affinityToleranceDistance).toBe(24);
    // 写すのは読み手のできた 3 項目だけ。重み・許容幅（秒）・POS の対応表はキーそのものを持たない。
    expect(Object.keys(view).sort()).toEqual(Object.keys(EMPTY_VIEW).sort());

    connection.close();
  });
});

describe("client/connection — provisional への操作は origin で経路分けする（幽霊タイマー解消）", () => {
  it("degraded で開始した provisional を live で Cancel するとサーバへ送らずローカル除去する（TimerNotFound 回避）", () => {
    const { connection, send, setConnectivity } = openConnectionWithFakeWatch();

    // boot は connectivity down（degraded）。ここで開始すると provisional（origin:"local"）が生まれ、送信はしない。
    connection.start(["slot-5"], "ramen", 180);
    const provisional = connection.getView().timers.find((t) => t.origin === "local");
    expect(provisional).toBeDefined();
    expect(send).not.toHaveBeenCalled();

    // 回線復帰（live）。provisional は保持される。
    setConnectivity("up");
    expect(mode(connection.getView())).toBe("live");

    // live でも provisional の Cancel はサーバへ送らず、ローカルで除去する（幽霊タイマーにならない）。
    connection.cancel(provisional!.id);
    expect(send).not.toHaveBeenCalled();
    expect(connection.getView().timers.some((t) => t.id === provisional!.id)).toBe(false);

    connection.close();
  });

  it("live で server-confirmed な Timer の Cancel は従来どおりサーバへ送る", () => {
    const { connection, send, setConnectivity, receiveMessage } = openConnectionWithFakeWatch();

    setConnectivity("up");
    // 受信時刻は START_NOW 固定（serverTime も同値ゆえ offset は 0 に落ち着く）。ここで見たいのは
    // origin による経路分けだけなので、受信時刻を now の進みから切り離しておく。
    receiveMessage(
      {
        type: "snapshot",
        serverTime: START_NOW,
        timers: [makeTimer("S")],
        pendingOrders: [],
        recommendations: [],
      },
      START_NOW,
    );
    expect(mode(connection.getView())).toBe("live");

    connection.cancel("S");
    expect(send).toHaveBeenCalledWith({ type: "cancel", timerId: "S" });

    connection.close();
  });

  it("live で provisional の Complete もサーバへ送らずローカル除去する", () => {
    const { connection, send, setConnectivity, setNow } = openConnectionWithFakeWatch();

    connection.start(["slot-3"], "udon", 120);
    const provisional = connection.getView().timers.find((t) => t.origin === "local");
    expect(provisional).toBeDefined();

    setConnectivity("up");
    // 消し込みは boiled な Timer にしか作用しない（対象が running なら窓口が弾く・要件1.2 / 3.2）。
    // 検証したいのは origin による経路分けゆえ、対象を茹で上がりまで到達させてから押す。
    setNow(provisional!.endTime);
    connection.complete(provisional!.id);
    expect(send).not.toHaveBeenCalled();
    expect(connection.getView().timers.some((t) => t.id === provisional!.id)).toBe(false);

    connection.close();
  });
});

describe("client/connection — 占有ゲートは degraded の畳み込みにしか無い（degraded-slot-superimposition）", () => {
  it("live では占有スロットへの start も従来どおりサーバへ送る（要件3.4）", () => {
    const { connection, send, setConnectivity, receiveSnapshot, setNow } =
      openConnectionWithFakeWatch();

    setConnectivity("up");
    // slot "0" を駆動する server-confirmed を受け、その endTime まで時刻を進めて boiled にする。
    // degraded ならこのスロットへの start は占有ゲートが拒む形（釜は茹で上がっても消し込みまで塞がって
    // いる）であり、その同じ形で live が従来どおり送信することを見る——ゲートは decideLocalStart の
    // 先頭にしか無く、live の start はそこを通らない。拒否の側は Property 1 の領分ゆえ重ねない。
    const occupant: TimerFact = {
      id: "S",
      slotIds: ["0"],
      noodleType: "ramen",
      firmness: "normal",
      startTime: START_NOW,
      endTime: START_NOW + 120_000,
      orderItem: null,
    };
    receiveSnapshot([occupant]);
    expect(mode(connection.getView())).toBe("live");
    setNow(occupant.endTime);

    connection.start(["0"], "udon", 90);
    expect(send).toHaveBeenCalledWith({
      type: "start",
      slotIds: ["0"],
      noodleType: "udon",
      boilSeconds: 90,
    });
    // 送るだけで、ローカルには provisional を注入しない（live は LocalStart の畳み込み経路を通らない）。
    expect(connection.getView().timers.map((t) => t.id)).toEqual(["S"]);

    connection.close();
  });
});
