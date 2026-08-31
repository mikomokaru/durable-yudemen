// tests/client/degradedRouting.example.test.ts — Sync_Mediator（openTimerConnection）の配線の example テスト
// （offline-degradation タスク7.3 の残余 / 7.4 / 15.6 の配線）。
//
// 主題は**端の配線だけ**である。純粋な畳み込みと到達不能理由の判定表は既に property / example が縛って
// おり、ここでは一切繰り返さない:
//   - 判定表（throw / 403 / 200 リスト在・不在 / 404 / 非配列 …）→ reachability.example / reachability.property
//   - Reconcile の置換規律（server-confirmed 全置換・provisional 保持・processedIds 刈り取り）→ reconcile*.property
//   - degraded の start が未送信で provisional を注入すること・live の start / cancel の送信
//     → connection.example.test.ts:148-152 / :166-185 / :210-231
//   - down→up 後の snapshot でも provisional が保たれること → complete.example.test.ts:544-548
//
// ゆえに本ファイルが担うのは、それらが**契機に正しく繋がっている**ことの三点である。
//
//   1. **degraded の cancel**（要件7.1 / 7.2 / 7.3）— WS へ出ず、provisional は除去だけ・server-confirmed は
//      除去＋`processedIds` 登録へ振り分けられること。「送らない」を送信口の不在と交絡させないため、同じ
//      送信口が live で 1 通出すことを先に見せてから degraded へ落とす。
//   2. **Reconcile の契機づけ**（要件2.4）— down→up 遷移が次の全量 snapshot を Reconcile へ回すこと。観測点は
//      **offset の凍結**に取る。盤面（timers）の置換規律は両経路で同一ゆえ、そこを見ても `pendingReconcile` の
//      配線が壊れたことに気づけない（既存カバーの限界がそこだった）。あわせて **boot 再水和の期限到来分**が
//      接続の確立を待たずに鳴ること（要件11.2 / 11.3）。
//   3. **到達不能理由の分類の契機づけ**（要件15.1 / 15.12 / 15.13）— down 確定契機で 1 回だけ probe すること、
//      常駐ポーリングにしないこと、up 復帰で `unreachableReason` が `offline` へ戻ること。
//
// 端ゆえ faketime を使う（純粋層テストの禁止事項は端には適用されない）。据え付けは support/timerConnection.ts の
// 偽 Watch を用いる——ping/pong を飛び越えて Connectivity を直接駆動でき、かつ**送信口が Connectivity に依らず
// 生きている**唯一の継ぎ目である（既定の watchConnectivity は切断中に socket を捨てるため、Socket の継ぎ目では
// 「送らない」が socket 不在の帰結と区別できない）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePersistedView, type PersistedView } from "../../src/client/persistence";
import type { ServerMessage } from "../../src/domain/messages";
import type { TimerFact } from "../../src/domain/timer";
import { openConnectionWithFakeWatch, START_NOW, STORE_ID } from "./support/timerConnection";

/** テスト用 TimerFact。配線の観測に効くのは id / slotIds / endTime だけゆえ、残りは固定値で置く。 */
function serverTimer(id: string, endTime: number, slotId = `slot-${id}`): TimerFact {
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
 * 全量 snapshot。serverTime を受信時刻から独立に置けるようにしてある——offset（= serverTime − receivedAt）が
 * 通常 snapshot 経路と Reconcile 経路を分ける唯一の観測点だからである（据え付けの receiveSnapshot は
 * offset を常に 0 にするため、この識別には使えない）。
 */
function snapshotOf(timers: readonly TimerFact[], serverTime: number): ServerMessage {
  return { type: "snapshot", serverTime, timers, pendingOrders: [], recommendations: [] };
}

/** probe が読む面（`type` / `status` / `json`）だけを持つ応答の代役。端はこの 3 つ以外を読まない。 */
interface ProbeReply {
  readonly type: string;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

/** 200 ＋ 店舗リスト。リストに storeId が在れば offline、不在なら noAccess へ分類される。 */
function storeListReply(storeIds: readonly string[]): ProbeReply {
  return {
    type: "default",
    status: 200,
    json: () => Promise.resolve(storeIds.map((storeId) => ({ storeId, name: `Store ${storeId}` }))),
  };
}

/** 403（Access セッション無効）→ signInRequired。端は 200 以外に本文の読み取りを掛けない。 */
function forbiddenReply(): ProbeReply {
  return { type: "default", status: 403, json: () => Promise.reject(new SyntaxError("no json body")) };
}

/**
 * グローバル fetch を差し替え、probe の呼び出し回数を数える。
 *
 * 応答を呼び出し回数の関数で与えるのは、契機ごとに**別の分類**を返させるためである——同じ理由が二度
 * 畳まれたのでは、2 度目の probe が起きたことをビューから確かめられない。
 */
function stubProbeFetch(replyAt: (callIndex: number) => ProbeReply): () => number {
  let calls = 0;
  vi.stubGlobal("fetch", () => {
    const reply = replyAt(calls);
    calls += 1;
    return Promise.resolve(reply as unknown as Response);
  });
  return () => calls;
}

/**
 * probe の解決（fetch → 本文読取 → Classify 畳み込み）を待つ。
 *
 * 経路は複数段の await で繋がるが挟まるのは microtask だけで、タイマーを一つも通らない（常駐ポーリングに
 * していないことの裏返し）。faketime の下で microtask を一巡させるため、0ms の非同期進行を 1 回挟む。
 */
async function settleProbe(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  // 分類の作用を主題としない群でも down 遷移は probe を出す。実ネットワークへ出さず必ず offline（既定値）へ
  // 畳む形に固定し、ビューを動かさないようにしておく（群3 は自前の stub で上書きする）。
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Load failed")));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("client/connection — degraded の cancel はローカル権限で畳む（要件7.1 / 7.2 / 7.3）", () => {
  it("生きた送信口を保ったまま degraded へ落ちても cancel は送られず、provisional は除去・server-confirmed は processedIds へ入る", () => {
    const { connection, send, setConnectivity, receiveMessage } = openConnectionWithFakeWatch();

    // まず交絡を解く。live で同じ送信口から 1 通出ることを見せておけば、以降の「送られない」は口の不在では
    // なく mode(view) の経路選択の帰結だと言える（偽 Watch の send は Connectivity に依らず生きている）。
    setConnectivity("up");
    receiveMessage(
      snapshotOf(
        [serverTimer("S1", START_NOW + 180_000), serverTimer("S2", START_NOW + 240_000)],
        START_NOW,
      ),
      START_NOW,
    );
    connection.cancel("S1");
    expect(send).toHaveBeenCalledWith({ type: "cancel", timerId: "S1" });

    // 回線喪失。送信口はそのまま在り続ける（差し替えも close もしない）。
    setConnectivity("down");
    send.mockClear();

    // degraded の start で provisional を 1 件作る（注入と未送信は既存カバー。ここでは cancel の対象として使う）。
    connection.start(["slot-P"], "udon", 120);
    const provisional = connection.getView().timers.find((timer) => timer.origin === "local");
    expect(provisional).toBeDefined();

    // 要件7.1: provisional の cancel は除去だけ。processedIds へは入れない——サーバが知らない id を記録しても
    // 抑止する相手が居らず（復活しようがない）、記録は次の snapshot で刈られる。
    connection.cancel(provisional!.id);
    expect(connection.getView().timers.some((timer) => timer.id === provisional!.id)).toBe(false);
    expect(connection.getView().processedIds.has(provisional!.id)).toBe(false);

    // 要件7.2: server-confirmed の cancel は除去に加えて processedIds へ登録する。取り消しはサーバへ届かない
    // ため当該 Timer は次の snapshot で復活しうる——そのときローカル発火を鳴らさないための記録である。
    connection.cancel("S2");
    expect(connection.getView().timers.map((timer) => timer.id)).toEqual(["S1"]);
    expect(connection.getView().processedIds.has("S2")).toBe(true);

    // 要件7.3: degraded の cancel は 2 件とも WS へ出ない。live で出ることは上で示したとおり。
    expect(send).not.toHaveBeenCalled();

    connection.close();
  });
});

describe("client/connection — Reconcile の契機づけと boot 再水和の発火（要件2.4 / 11.2 / 11.3）", () => {
  it("down→up 後の最初の snapshot だけが Reconcile として畳まれる — offset の凍結が通常 snapshot 経路と分ける", () => {
    const { connection, setConnectivity, receiveMessage } = openConnectionWithFakeWatch();

    // boot の初回 up は down→up 遷移ではない（直前の Connectivity は未確立）。ゆえに続く snapshot は通常の
    // hydration 経路を通り、serverTime から offset を再確立する。
    setConnectivity("up");
    receiveMessage(snapshotOf([serverTimer("S", START_NOW + 180_000)], START_NOW + 5_000), START_NOW);
    expect(connection.getView().offset).toBe(5_000);
    expect(connection.getView().sync).toBe("synced");

    // 回線喪失 → 復帰。ここで初めて down→up 遷移が成立し、次の全量 snapshot が Reconcile になる。
    setConnectivity("down");
    setConnectivity("up");

    // 同じ形の snapshot を**別の serverTime** で受ける。Reconcile イベントは serverTime を運ばないため offset は
    // 凍結し（degraded 中に確立した最新値の維持・要件5.2）、通常 snapshot 経路なら 9_000 へ書き換わる。盤面は
    // 両経路で同一規律ゆえ、ここが二つの経路を外から分ける唯一の観測点である。
    receiveMessage(snapshotOf([serverTimer("N", START_NOW + 240_000)], START_NOW + 9_000), START_NOW);
    expect(connection.getView().offset).toBe(5_000);
    // 契機だけ立てて中身を捨てていないこと（Reconcile が snapshot の timers を確かに畳んだ）。
    expect(connection.getView().timers.map((timer) => timer.id)).toEqual(["N"]);

    // 契機は 1 通で消費されて下りる。以降の snapshot は通常経路へ戻り、offset が再確立される。
    receiveMessage(snapshotOf([serverTimer("N", START_NOW + 240_000)], START_NOW + 12_000), START_NOW);
    expect(connection.getView().offset).toBe(12_000);

    connection.close();
  });

  it("boot 再水和の期限到来分は接続の確立を待たずに鳴り、LocalDone として畳まれる", () => {
    // 再水和ビューは実コーデック（parsePersistedView）を通す。sync が "connecting"・connectivity が "down"
    // 起点であることは実装の帰結であり、ClientView を手組みすればその前提をテスト側で捏造することになる。
    const blob: PersistedView = {
      version: 1,
      timers: [
        // 期限到来・未登録 → 鳴る。
        { ...serverTimer("DUE", START_NOW - 1_000), origin: "server" },
        // まだ走行中 → 鳴らない。
        { ...serverTimer("PENDING", START_NOW + 60_000), origin: "server" },
        // 期限到来だが processedIds 登録済み → 鳴らない（ダウンタイム前に鳴り終えている）。
        { ...serverTimer("MUTED", START_NOW - 2_000), origin: "server" },
      ],
      offset: 0,
      processedIds: ["MUTED"],
    };
    const { connection, boilAlert, send } = openConnectionWithFakeWatch(
      parsePersistedView(JSON.stringify(blob)),
    );

    // 発火は接続の確立を待たない。Connectivity も snapshot もまだ一度も届いていない（sync は "connecting"）。
    const booted = connection.getView();
    expect(booted.sync).toBe("connecting");
    expect(boilAlert.mock.calls.map(([timer]) => timer.id)).toEqual(["DUE"]);
    // 鳴らした分だけが処理済みへ入る（LocalDone の畳み込み）。既存の登録は保たれる。
    expect(booted.processedIds.has("DUE")).toBe(true);
    expect(booted.processedIds.has("MUTED")).toBe(true);
    // 発火は Timer を除去しない——消し込み（Complete）は別概念である。
    expect(booted.timers.map((timer) => timer.id)).toEqual(["DUE", "PENDING", "MUTED"]);
    // 発火経路は WS へ何も出さない（常駐ループも boot 発火も DO を wake させない・要件1.6 / 8.3）。
    expect(send).not.toHaveBeenCalled();

    // 秒読みティックが回っても DUE は二度鳴らない（processedIds が冪等に抑止する）。PENDING はまだ期限前。
    vi.advanceTimersByTime(3_000);
    expect(boilAlert).toHaveBeenCalledTimes(1);

    connection.close();
  });
});

describe("client/connection — 到達不能理由の分類の契機づけ（要件15.1 / 15.12 / 15.13）", () => {
  it("down 確定契機で probe を 1 回だけ発行し、分類結果を Classify として畳む", async () => {
    const probeCount = stubProbeFetch(() => forbiddenReply());
    const { connection, setConnectivity } = openConnectionWithFakeWatch();

    setConnectivity("up");
    expect(probeCount()).toBe(0); // up は分類の契機ではない

    setConnectivity("down");
    await settleProbe();

    expect(probeCount()).toBe(1);
    expect(connection.getView().unreachableReason).toBe("signInRequired");
    // Connectivity（二値）と Mode（導出）は分類の追加で一切変わらない（別軸である・要件15.12）。
    expect(connection.getView().connectivity).toBe("down");

    connection.close();
  });

  it("down が続く間は再発火せず、時間が経っても probe は増えない（常駐ポーリングにしない）", async () => {
    const probeCount = stubProbeFetch(() => storeListReply([]));
    const { connection, setConnectivity } = openConnectionWithFakeWatch();

    setConnectivity("up");
    setConnectivity("down");
    await settleProbe();
    expect(probeCount()).toBe(1);
    // 店舗リストに自店が不在 → この店舗の権限なし（既定の offline から動いたことが分類の到達を示す）。
    expect(connection.getView().unreachableReason).toBe("noAccess");

    // 既に down のところへ down が重なっても契機にならない（Connectivity_Watch は down を繰り返し確定しうる）。
    setConnectivity("down");
    setConnectivity("down");
    await settleProbe();
    expect(probeCount()).toBe(1);

    // 秒読みティックが回り続けても分類 fetch は増えない。probe は遷移の一度きりで、常駐ループを持たない。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probeCount()).toBe(1);
    expect(connection.getView().unreachableReason).toBe("noAccess");

    connection.close();
  });

  it("up 復帰で unreachableReason は offline へ戻り、down のたびに分類が引き直される（問うのは自店の storeId）", async () => {
    // 契機ごとに別の応答を返させる。同じ理由が二度畳まれたのでは、2 度目の probe が起きたことをビューから
    // 確かめられない。3 回目だけ自店を含むリストを返すのは、probe が**どの storeId を問うか**を見るためである。
    const probeCount = stubProbeFetch((callIndex) => {
      if (callIndex === 0) return forbiddenReply();
      if (callIndex === 1) return storeListReply(["other-store"]);
      return storeListReply([STORE_ID, "other-store"]);
    });
    const { connection, setConnectivity } = openConnectionWithFakeWatch();

    setConnectivity("up");
    setConnectivity("down");
    await settleProbe();
    expect(connection.getView().unreachableReason).toBe("signInRequired");

    // up 復帰。到達不能理由は down 時のみ意味を持つ分類結果ゆえ、Connectivity(up) の畳み込みが既定へ戻す。
    // 明示的なクリアの手続きは無い（一方向の流れで担保する・要件15.12）。
    setConnectivity("up");
    expect(connection.getView().unreachableReason).toBe("offline");
    expect(probeCount()).toBe(1); // up 自体は probe を出さない

    // 再度の down は新しい契機。前回の分類が残るのではなく、その時点の観測から引き直される。
    setConnectivity("down");
    await settleProbe();
    expect(probeCount()).toBe(2);
    expect(connection.getView().unreachableReason).toBe("noAccess");

    // 三度目は自店を含むリスト → 認可はあり WS 断は一過性ゆえ offline。**据え付けの storeId 以外を問うて
    // いれば noAccess のまま残る**——この一点が、probe に渡る storeId が接続先と同一であることを縛る。
    setConnectivity("up");
    setConnectivity("down");
    await settleProbe();
    expect(probeCount()).toBe(3);
    expect(connection.getView().unreachableReason).toBe("offline");

    connection.close();
  });
});
