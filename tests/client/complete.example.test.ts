// tests/client/complete.example.test.ts — boiled → 明示完了（complete）→ snapshot 差分で除去 → idle の遷移検証。
// 接続レベル（openTimerConnection）と表示導出（assignedSlotDisplays）で、complete 後に当該 Timer が
// snapshot から消えてスロットが idle へ戻ること、boiled の Complete 対象 timer が正しく拾えることを確認する
// （直前結果の表示そのものは SlotBoard の React state で、ここでは扱わない）。
//
// 後半の describe は同時上がり群の一括消し込み（sync-set-batch-complete）の経路分けを扱う。群の識別と
// 畳み込みの核は property test（boiledGroup.property.test.ts）が覆うため、ここは入力で振る舞いが
// 変わらない配線——live / degraded / 混在の振り分け、watch.send の発行、persistence.save の回数——だけを
// 少数の具体例で固める。
//
// 据え付け（偽 Socket / 偽 Connectivity_Watch）は support/timerConnection.ts に置き、connection.example と
// 共有する。本ファイルに残すのは、ここでしか意味を持たない観測——complete の送信列（completeSends）と、
// 実コーデックを通した再水和ビュー（rehydratedView）——だけである。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientView } from "../../src/client/connection";
import { parsePersistedView, type PersistedView } from "../../src/client/persistence";
import { SlotCard } from "../../src/client/components/SlotCard";
import { assignedSlotDisplays, type SlotDisplay } from "../../src/client/components/slotDisplay";
import type { TimerFact } from "../../src/domain/timer";
import {
  openConnectionWithFakeSockets,
  openConnectionWithFakeWatch,
  receiveFrame,
  START_NOW,
} from "./support/timerConnection";

function completeButtonCount(html: string): number {
  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  return buttons.filter((button) => /\saria-label="Complete"(?=\s|\/?>)/.test(button)).length;
}

function slotCardMarkup(display: SlotDisplay): string {
  return renderToStaticMarkup(
    createElement(SlotCard, {
      display,
      onStart: () => undefined,
      onCancel: () => undefined,
      onComplete: () => undefined,
      noodleColor: () => "#ffffff",
      onAdjust: () => undefined,
      // ここで描く idle は提案を持たない（next: []）ので resolver は呼ばれない。呼ばれたら前提違反。
      suggestionOf: () => {
        throw new Error("テストの前提違反：提案は無いはず");
      },
      onStartSuggested: () => undefined,
    }),
  );
}

describe("SlotCard — Complete の実描画境界", () => {
  const timer: TimerFact = {
    id: "SSR-TIMER",
    slotIds: ["0"],
    noodleType: "Udon",
    firmness: "normal",
    startTime: START_NOW - 60_000,
    endTime: START_NOW,
    orderItem: null,
  };

  it("boiled は Complete button を 1 つ描画し、running / idle は描画しない（要件7.1 / 7.3）", () => {
    const boiled = slotCardMarkup({
      kind: "boiled",
      slot: 0,
      timer: { ...timer, endTime: START_NOW - 1_000 },
      overdueMs: 1_000,
    });
    const running = slotCardMarkup({
      kind: "running",
      slot: 0,
      timer: { ...timer, endTime: START_NOW + 30_000 },
      remainingMs: 30_000,
      unconfirmed: false,
    });
    const idle = slotCardMarkup({ kind: "idle", slot: 0, next: [] });

    expect(completeButtonCount(boiled)).toBe(1);
    expect(completeButtonCount(running)).toBe(0);
    expect(completeButtonCount(idle)).toBe(0);
  });
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("client/connection — 茹で上がりの明示完了", () => {
  it("boiled スロットを complete すると completed 受信で除去され idle へ戻る", () => {
    const { connection, latest } = openConnectionWithFakeSockets();
    latest().listeners.onOpen();

    // endTime が過去の Timer を hydration で受け取る（クライアントでは boiled として導出される）。
    receiveFrame(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [
        {
          id: "T",
          slotIds: ["3"],
          noodleType: "Medium",
          firmness: "normal",
          startTime: START_NOW - 91_000,
          endTime: START_NOW - 1000,
        },
      ],
      pendingOrders: [],
      recommendations: [],
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
    receiveFrame(latest(), {
      type: "snapshot",
      serverTime: START_NOW + 5,
      timers: [],
      pendingOrders: [],
      recommendations: [],
    });
    const view2 = connection.getView();
    expect(view2.timers.some((t) => t.id === "T")).toBe(false);
    const displays2 = assignedSlotDisplays(view2, [0], START_NOW);
    expect(displays2.find((d) => d.slot === 3)?.kind).toBe("idle");
    // 直前結果（残滓）が当該スロット（slotId "3"）に記録されている。at は client 受信時刻（receivedAt = now()）。
    expect(view2.lastResults.get("3")).toEqual({ noodleType: "Medium", at: START_NOW });

    connection.close();
  });

  it("当該スロットで新規開始すると直前結果（残滓）は解除される（要件13.7）", () => {
    const { connection, latest } = openConnectionWithFakeSockets();
    latest().listeners.onOpen();
    receiveFrame(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [
        {
          id: "T",
          slotIds: ["3"],
          noodleType: "Medium",
          firmness: "normal",
          startTime: START_NOW - 91_000,
          endTime: START_NOW - 1000,
        },
      ],
      pendingOrders: [],
      recommendations: [],
    });
    connection.complete("T");
    receiveFrame(latest(), {
      type: "snapshot",
      serverTime: START_NOW + 5,
      timers: [],
      pendingOrders: [],
      recommendations: [],
    });
    expect(connection.getView().lastResults.has("3")).toBe(true);

    // スロット 3 で新規開始（当該スロットを占有する snapshot 受信）→ 残滓は差分で解除される。
    receiveFrame(latest(), {
      type: "snapshot",
      serverTime: START_NOW + 10,
      timers: [
        {
          id: "U",
          slotIds: ["3"],
          noodleType: "Thin",
          firmness: "normal",
          startTime: START_NOW + 10_000,
          endTime: START_NOW + 70_000,
        },
      ],
      pendingOrders: [],
      recommendations: [],
    });
    expect(connection.getView().lastResults.has("3")).toBe(false);

    connection.close();
  });
});
describe("client/connection — 同時上がり群の一括消し込み（経路分けと端の観測）", () => {
  /** boiled な実効 endTime（offset 0 ゆえ START_NOW との差だけで boiled / running が決まる）。 */
  const BOILED_AT = START_NOW - 1_000;

  /** 偽 Watch が受け取った ClientMessage 送信の記録（openConnectionWithFakeWatch が返す send そのもの）。 */
  type WatchSend = ReturnType<typeof openConnectionWithFakeWatch>["send"];

  /**
   * サーバへ送られた complete の timerId 列（どのメンバーが送られたか）。ping 等の他フレームは混じらない。
   *
   * 共有ハーネスへ載せず本ファイルに置くのは、これが complete の送信列という一機能固有の絞り込みであり、
   * 据え付け（偽 Watch の配線）とは別の関心事だからである。観測元を引数で明示すれば、二台の端末を並べる
   * ケース（要件6.16）でもどちらの送信列を見ているかが読める。
   */
  function completeSends(send: WatchSend): readonly string[] {
    return send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "complete")
      .map((message) => message.timerId);
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
      orderItem: null,
    };
  }

  /**
   * 永続ブロブから再水和したビュー（openConnectionWithFakeWatch の load へ渡す）。
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
    const { connection, send, save, setConnectivity, receiveSnapshot } =
      openConnectionWithFakeWatch();
    setConnectivity("up");
    // 同一 endTime の boiled 2 件を hydration で受ける（同期確定した Sync_Set の実効 endTime は完全一致する）。
    receiveSnapshot([timerAt("T1", "0", BOILED_AT), timerAt("T2", "1", BOILED_AT)]);
    const before = connection.getView();
    expect(before.timers.map((t) => t.id)).toEqual(["T1", "T2"]);

    save.mockClear();
    connection.complete("T1");

    // 押下は片方だけ。送信は 2 件それぞれへ発行される（どのメンバーが送られたかまで見る）。
    expect(completeSends(send)).toEqual(["T1", "T2"]);
    // ビューは参照ごと不変。server-confirmed の除去はサーバの全量 snapshot が運ぶため、押下時点で
    // 局所ビューを動かす理由が無い（動かせば、まだ確定していない除去を先に見せることになる）。
    expect(connection.getView()).toBe(before);
    expect(save).not.toHaveBeenCalled();

    connection.close();
  });

  it("degraded — 送信ゼロで 2 件消え、persistence.save は 1 回だけ（要件5.1 / 5.2）", () => {
    const { connection, send, save, setConnectivity, receiveSnapshot } =
      openConnectionWithFakeWatch();
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
    const { connection, send, save, setConnectivity, receiveSnapshot, setNow } =
      openConnectionWithFakeWatch();
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
    expect(completeSends(send)).toEqual(["S"]);
    const after = connection.getView();
    expect(after.timers.map((t) => t.id)).toEqual(["S"]);
    expect(after.timers.some((t) => t.id === provisional!.id)).toBe(false);
    // ローカル除去の 1 件分だけビューが動く（save も 1 回）。
    expect(save).toHaveBeenCalledTimes(1);

    connection.close();
  });

  it("1 件（退化）— 同一 endTime の他メンバーが無ければ complete は 1 回だけ（要件2.2）", () => {
    const { connection, send, setConnectivity, receiveSnapshot } = openConnectionWithFakeWatch();
    setConnectivity("up");
    // U も boiled だが endTime が違う。群の識別は「boiled であること」ではなく実効 endTime の等値である。
    receiveSnapshot([timerAt("T", "0", BOILED_AT), timerAt("U", "1", BOILED_AT - 1_000)]);

    connection.complete("T");

    expect(completeSends(send)).toEqual(["T"]);

    connection.close();
  });

  it("対象 running — 群が空ゆえ送信ゼロ・ビュー不変（要件1.2 / 3.2）", () => {
    const { connection, send, save, setConnectivity, receiveSnapshot } =
      openConnectionWithFakeWatch();
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
    const { connection, send, setConnectivity, receiveSnapshot } = openConnectionWithFakeWatch();
    setConnectivity("up");
    // OUT は slot 11（unit 1）を駆動する。押下者の担当は unit 0（slot 0..5）ゆえ盤面には現れない。
    receiveSnapshot([timerAt("IN", "3", BOILED_AT), timerAt("OUT", "11", BOILED_AT)]);
    const displays = assignedSlotDisplays(connection.getView(), [0], START_NOW);
    expect(displays.find((d) => d.slot === 3)?.kind).toBe("boiled");
    expect(displays.some((d) => d.slot === 11)).toBe(false); // 担当外＝操作口も表示も持たない

    connection.complete("IN");

    // 担当射影は群に掛からない。同時に上がった以上、担当外のメンバーも一括の対象である。
    expect(completeSends(send)).toEqual(["IN", "OUT"]);

    connection.close();
  });

  // 一括完了の後にスロットが何として見えるか。slotDisplay.ts は変更しないため、ここは新しい挙動の検証では
  // なく「群が消えた盤面へ既存導出を掛けた帰結」の固定である。degraded で観測するのは、live の
  // server-confirmed 除去はサーバの全量 snapshot が運ぶため押下時点の局所ビューが動かないからである。
  describe("完了後の表示導出（既存 assignedSlotDisplays の帰結）", () => {
    it("完了後の idle 導出 — 駆動 Timer が残らず sync が synced なら idle（要件2.5）", () => {
      const { connection, setConnectivity, receiveSnapshot } = openConnectionWithFakeWatch();
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
      const { connection, send } = openConnectionWithFakeWatch(
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
      const { connection, setConnectivity, receiveSnapshot } = openConnectionWithFakeWatch();
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
      expect(after.timers.map((t) => t.id)).toEqual([
        "RUN_LATE",
        "RUN_EARLY",
        "STALE",
        "OLD",
        "OLDEST",
      ]);

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
      const forward = openConnectionWithFakeWatch();
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
      const reversed = openConnectionWithFakeWatch();
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
      const { connection, setConnectivity, receiveSnapshot } = openConnectionWithFakeWatch();
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
      const { connection, send, setConnectivity, receiveSnapshot, setNow } =
        openConnectionWithFakeWatch();
      // 先に残滓の種を仕込む。A / B が slot "0" を占有する間、snapshot の (c) は毎回その slot の残滓を
      // 消すため、この窓で残滓を作れるのはローカル畳み込みだけである（boot は degraded ゆえ provisional が生まれる）。
      //
      // なぜ「走行中の A / B を受けてから時刻を進める」形にするか: この窓は provisional と server-confirmed が
      // 同一スロットに同席することを要するが、修正後にその同席が snapshot を越えて残るのは**双方が走行中**の
      // ときだけである（degraded-slot-superimposition 判断 2 の真理値表の最終行＝両側 running の残余）。
      // boiled な A / B を走行中の provisional と同席させる盤面は解決が A / B を落とすため到達不能であり、
      // それを fixture に組めば死んだ振る舞いを守ることになる。ゆえに走行中で受け、そのあと上がらせる。
      const BOTH_RUNNING_UNTIL = START_NOW + 60_000;
      connection.start(["0"], "seed-noodle", 120);
      const seed = connection.getView().timers.find((t) => t.origin === "local");
      expect(seed).toBeDefined();

      setConnectivity("up");
      // 同一スロット "0" を駆動する走行中の server-confirmed 2 件（同一 endTime ゆえ同一群）。
      receiveSnapshot([
        timerAt("A", "0", BOTH_RUNNING_UNTIL),
        timerAt("B", "0", BOTH_RUNNING_UNTIL),
      ]);
      // 双方走行中ゆえ解決は決着させない——A / B と seed（120 秒ゆえより後に上がる）が同席する。
      expect(connection.getView().timers.map((t) => t.id)).toEqual(["A", "B", seed!.id]);

      // A / B が上がる（seed はまだ走行中）。
      setNow(BOTH_RUNNING_UNTIL);
      // provisional を cancel してローカルに残滓を書く（除去理由を問わない一様残滓・要件8.2 と同じ規律）。
      connection.cancel(seed!.id);
      expect(connection.getView().lastResults.get("0")).toEqual({
        noodleType: "seed-noodle",
        at: BOTH_RUNNING_UNTIL,
      });

      connection.complete("A");

      // live × server-confirmed ゆえ押下時点でビューは動かない。除去は snapshot が運ぶ。
      expect(completeSends(send)).toEqual(["A", "B"]);
      expect(connection.getView().lastResults.get("0")).toEqual({
        noodleType: "seed-noodle",
        at: BOTH_RUNNING_UNTIL,
      });

      // その snapshot が slot "0" を新しい server-confirmed N で占有している。
      receiveSnapshot([timerAt("N", "0", BOTH_RUNNING_UNTIL + 90_000)]);

      const after = connection.getView();
      expect(after.timers.map((t) => t.id)).toEqual(["N"]);
      // (c) が既存の残滓を消し、(b) は占有スロットへ書かない。ゆえに noodle-A も noodle-B も seed-noodle も残らない。
      // 記録が見送られる以上、値の選択規則（要件8.4）はここでは適用先を持たない——階層が違うので衝突しない。
      expect(after.lastResults.has("0")).toBe(false);

      connection.close();
    });

    it("live の占有スロットの残滓 — 保持 provisional が占有しても同じ（要件8.7）", () => {
      const { connection, setConnectivity, receiveSnapshot, setNow } =
        openConnectionWithFakeWatch();
      // occupied は「新 serverTimers ∪ 保持 provisional」のスロット。ゆえに要るのは三つである——slot "0" を
      // 最後まで占有し続ける provisional keep、その slot に既に在る残滓、そして最後の snapshot で消える prev server。
      //
      // なぜ provisional を 2 本作らないか: 同一スロットへの 2 度目の start は修正後に拒否されるため
      // （degraded-slot-superimposition 要件2.2）、provisional 2 本で slot "0" を埋める盤面は到達不能である。
      // keep が占有している slot "0" に残滓を書ける経路は、同席する server-confirmed をローカルで消し込む道
      // （degraded の消し込みは占有を見ずに記録する・要件8.8）だけになる。
      //
      // なぜ走行中の A / B を受けてから時刻を進めるか: その同席が snapshot を越えて残るのは**双方が走行中**の
      // ときだけである（判断 2 の真理値表の最終行＝両側 running の残余）。A と B の endTime を分けるのは、
      // A だけを群として消し込み（残滓の種）、B を最後の snapshot で消える prev server として残すためである。
      const A_UP_AT = START_NOW + 30_000;
      const B_UP_AT = START_NOW + 60_000;
      connection.start(["0"], "keep-noodle", 180);
      const keep = connection.getView().timers.find((t) => t.origin === "local");
      expect(keep).toBeDefined();

      setConnectivity("up");
      receiveSnapshot([timerAt("A", "0", A_UP_AT), timerAt("B", "0", B_UP_AT)]);
      // 双方走行中ゆえ解決は決着させない——A / B と keep（180 秒ゆえ最後まで走行中）が同席する。
      expect(connection.getView().timers.map((t) => t.id)).toEqual(["A", "B", keep!.id]);

      // A が上がったところで回線が落ちる。degraded ゆえローカル権限で消し込み、残滓が slot "0" に載る。
      setNow(A_UP_AT);
      setConnectivity("down");
      connection.complete("A");
      expect(connection.getView().timers.map((t) => t.id)).toEqual(["B", keep!.id]);
      expect(connection.getView().lastResults.get("0")).toEqual({
        noodleType: "noodle-A",
        at: A_UP_AT,
      });

      // 回線復帰。除去を運ぶ snapshot に server-confirmed は残らないが、保持 provisional keep が slot "0" を占有する。
      setConnectivity("up");
      receiveSnapshot([]);

      const after = connection.getView();
      expect(after.timers.map((t) => t.id)).toEqual([keep!.id]);
      // (c) が既存の残滓（noodle-A）を消し、(b) は消えた B の麺種を占有スロットへ書かない。
      expect(after.lastResults.has("0")).toBe(false);

      connection.close();
    });

    it("同一 snapshot 内の反映順 — 1 通で 2 件の消失が判明すると prevServer で後のメンバーの麺種が残る（要件8.5 live 節）", () => {
      // reconcileServerConfirmed は差分を受け取らない。消失は prevServer（受信時点の保持列から
      // origin==="server" を抽出した並び）の走査で導く。ゆえに中間 snapshot を受けず全量 snapshot を
      // 1 通だけ受ける形にする——2 通に分ければ到着順でも同じ結果が説明でき、走査順を固定できない。
      const forward = openConnectionWithFakeWatch();
      forward.setConnectivity("up");
      forward.receiveSnapshot([timerAt("X", "0", BOILED_AT), timerAt("Y", "0", BOILED_AT)]);

      forward.connection.complete("X");
      expect(completeSends(forward.send)).toEqual(["X", "Y"]);

      // 両者が消えた全量 snapshot を 1 通だけ受ける（中間 snapshot の取り逃しは要件6.6 が許容する）。
      forward.receiveSnapshot([]);
      expect(forward.connection.getView().lastResults.get("0")).toEqual({
        noodleType: "noodle-Y",
        at: START_NOW,
      });
      forward.connection.close();

      // 保持列の並びを入れ替えれば残る麺種も入れ替わる。受けた snapshot は同じく 1 通ゆえ、決めているのは
      // 到着順ではなく prevServer の走査順である。
      const reversed = openConnectionWithFakeWatch();
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
      const { connection, send, setConnectivity, receiveSnapshot, setNow } =
        openConnectionWithFakeWatch();
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
      expect(completeSends(send)).toEqual(["S"]);
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
      const { connection, setConnectivity, receiveSnapshot, setNow } =
        openConnectionWithFakeWatch();
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

  // 重複 complete とその拒否の畳み込み（要件6.11〜6.17）。ファンアウトは重複送信を系統的に生むため、
  // 「一括は成功しているのに赤帯が出る」形が起こり得る。ここで固めるのは二段である——重複が実際に飛ぶこと
  // （live が局所ビューを動かさない帰結・要件6.11 / 6.12）と、その拒否 `TimerNotFound` が提示されないこと
  // （要件6.14）。落とすのは code 一つだけで、他の拒否種別は従来どおり立つ（要件6.15）。
  //
  // 入力で振る舞いが変わらない配線（`code` の等値で分けるだけ）ゆえ Property には向かない。
  describe("重複 complete の拒否は提示しない（error 畳み込み）", () => {
    it("snapshot 未到着での再押下 — 操作口が残り同一メンバーへ再度 complete が飛ぶ（要件6.11 / 6.12）", () => {
      const { connection, send, setConnectivity, receiveSnapshot } = openConnectionWithFakeWatch();
      setConnectivity("up");
      receiveSnapshot([timerAt("T1", "0", BOILED_AT), timerAt("T2", "1", BOILED_AT)]);

      connection.complete("T1");
      expect(completeSends(send)).toEqual(["T1", "T2"]);

      // 除去を運ぶ snapshot は届いていない。局所ビューが動かないため両スロットは boiled のまま導出され、
      // ゆえに Complete の操作口も残る（`assignedSlotDisplays` が boiled を返す＝SlotCard がボタンを描く）。
      const displays = assignedSlotDisplays(connection.getView(), [0], START_NOW);
      expect(displays.find((d) => d.slot === 0)?.kind).toBe("boiled");
      expect(displays.find((d) => d.slot === 1)?.kind).toBe("boiled");

      // 二度目の押下。群は導出値であって送信済みを覚えないため、同じメンバー集合を再構成して再送する。
      connection.complete("T2");
      expect(completeSends(send)).toEqual(["T1", "T2", "T1", "T2"]);

      connection.close();
    });

    it("TimerNotFound を受けても view.error は null のまま・offset だけ最新化される（要件6.14）", () => {
      const { connection, setConnectivity, receiveSnapshot, receiveError } =
        openConnectionWithFakeWatch();
      setConnectivity("up");
      receiveSnapshot([timerAt("T1", "0", BOILED_AT), timerAt("T2", "1", BOILED_AT)]);
      expect(connection.getView().offset).toBe(0);

      connection.complete("T1");
      // 再送分に対してサーバが返す拒否。状態は変わらず、要求元の接続だけへ届く。
      receiveError(
        "TimerNotFound",
        "指定された timerId の Timer は存在しない: T2",
        START_NOW + 4_000,
      );

      const after = connection.getView();
      // 意図（この Timer を消す）は達成済みゆえ警告帯を出さない。SlotBoard は view.error を見るため、
      // null のままであることが「提示されない」ことそのものである。
      expect(after.error).toBeNull();
      // それでも offset は最新化される——拒否をまるごと捨てているのではなく、error を立てないだけである。
      expect(after.offset).toBe(4_000);

      connection.close();
    });

    it("他の拒否種別は従来どおり view.error が立つ（要件6.15）", () => {
      const { connection, setConnectivity, receiveSnapshot, receiveError } =
        openConnectionWithFakeWatch();
      setConnectivity("up");
      receiveSnapshot([timerAt("T1", "0", BOILED_AT)]);

      receiveError("CapacityExceeded", "同時稼働上限に達している");
      expect(connection.getView().error).toEqual({
        code: "CapacityExceeded",
        message: "同時稼働上限に達している",
      });

      // 後から TimerNotFound が届いても、既に立っている error は書き換わらない。要件6.14 は「更新しない」で
      // あって「null にする」ではない——落とす判断が、提示中の別の拒否を消してしまわないことを固める。
      receiveError("TimerNotFound", "指定された timerId の Timer は存在しない: T1");
      expect(connection.getView().error).toEqual({
        code: "CapacityExceeded",
        message: "同時稼働上限に達している",
      });

      // 解消は従来どおり次の snapshot が担う。
      receiveSnapshot([]);
      expect(connection.getView().error).toBeNull();

      connection.close();
    });

    it("二台の端末が同一 Sync_Set を押す — 負けた側の TimerNotFound も提示されない（要件6.16）", () => {
      // 二つの接続を作る（端末 2 台）。同一の Sync_Set を両者が hydration で受け、それぞれ別のスロットを押す。
      // 要件4.1 の帰結として、どちらの押下も群の全メンバーへ送る——ゆえに後に届いた側が必ず拒否を受ける。
      const first = openConnectionWithFakeWatch();
      const second = openConnectionWithFakeWatch();
      const sync = [timerAt("T1", "0", BOILED_AT), timerAt("T2", "1", BOILED_AT)];
      for (const terminal of [first, second]) {
        terminal.setConnectivity("up");
        terminal.receiveSnapshot(sync);
      }

      first.connection.complete("T1");
      second.connection.complete("T2");
      // 二台とも群の全メンバーへ送る（担当スコープは群に掛からない）。
      expect(completeSends(first.send)).toEqual(["T1", "T2"]);
      expect(completeSends(second.send)).toEqual(["T1", "T2"]);

      // 先に届いた first の 2 件が確定し、second の 2 件は対象不在で拒否される（拒否は要求元だけへ返る）。
      second.receiveError("TimerNotFound", "指定された timerId の Timer は存在しない: T1");
      second.receiveError("TimerNotFound", "指定された timerId の Timer は存在しない: T2");

      // 負けた側にも警告帯は出ない。判断は code のみで、由来（自分が二番目だったこと）を知る必要が無い。
      expect(second.connection.getView().error).toBeNull();
      expect(first.connection.getView().error).toBeNull();

      first.connection.close();
      second.connection.close();
    });
  });
});
