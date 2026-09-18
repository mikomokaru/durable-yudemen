// tests/client/order-queue.example.test.ts — 待ち行列と推奨の client 表示（online-cook-scheduling タスク 16）。
//
// 検証対象は 2 つの純粋層だけである。
//   (1) decideView の snapshot / Reconcile 分岐 — 待ち行列と推奨をサーバ由来の事実として全置換すること
//       （既存の timers の畳み込みは触らない）。
//   (2) orderQueueEntries — 到着順の並び・待ち時間の導出・担当範囲での提案の絞り込み。
// いずれも WS・DOM・時計に触れないため既定 pool（workerd 不要）で走る。now は引数で運ぶ。

import { describe, expect, it } from "vitest";
import {
  decideView,
  EMPTY_VIEW,
  type ClientTimer,
  type ClientView,
} from "../../src/client/connection";
import { orderQueueEntries, suggestedItemOf } from "../../src/client/components/queueDisplay";
import { liftGroups, slotSuggestions, visibleGroups } from "../../src/client/components/liftGroups";
import { correctedNow } from "../../src/client/clock";
import { ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import type { CookRecommendation } from "../../src/domain/messages";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";

const T = 1_700_000_000_000;

/** 品目の鍵（`id#itemIndex`・比較用の読める形）。 */
function keyOf(order: OrderItem): string {
  return `${order.externalOrderId}#${order.itemIndex}`;
}

/** 1 品目の未着手オーダー。既定プリセットに在る麺種（Thin: normal=60 秒）を既定に据える。 */
function order(
  externalOrderId: string,
  itemIndex: number,
  arrivalTime: number,
  overrides: Partial<OrderItem> = {},
): OrderItem {
  return {
    externalOrderId,
    itemIndex,
    noodleType: "Thin",
    firmness: "normal",
    tableId: null,
    arrivalTime,
    portions: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
    ...overrides,
  };
}

/** 1 件の推奨（slot 群と開始時刻）。 */
function recommendation(
  externalOrderId: string,
  itemIndex: number,
  slotIds: NonEmptyArray<string>,
  startAt: number,
): CookRecommendation {
  return { externalOrderId, itemIndex, slotIds, startAt, group: "g", anchor: null };
}

/** synced 済みのビュー（待ち行列と推奨だけを差し替える）。 */
function viewWith(
  orderItems: readonly OrderItem[],
  recommendations: readonly CookRecommendation[],
): ClientView {
  return {
    ...EMPTY_VIEW,
    sync: "synced",
    connectivity: "up",
    orderItems,
    recommendations,
    noodlePresets: DEFAULT_NOODLE_PRESETS,
  };
}

describe("client が待ち行列と推奨を受ける（AC 2.4）", () => {
  it("snapshot は待ち行列と推奨を全置換し、Provisional_Timer の扱いを変えない", () => {
    const provisional = decideView(EMPTY_VIEW, {
      kind: "LocalStart",
      slotIds: ["0"],
      noodleType: "Thin",
      boilSeconds: 60,
      newTimerId: "local-1",
      correctedNow: T,
    });
    expect(provisional.timers).toHaveLength(1);

    const applied = decideView(provisional, {
      kind: "Server",
      message: {
        type: "snapshot",
        serverTime: T,
        timers: [],
        orderItems: [order("o-1", 0, T)],
        recommendations: [recommendation("o-1", 0, ["2"], T + 5_000)],
      },
      receivedAt: T,
    });
    expect(applied.orderItems).toEqual([order("o-1", 0, T)]);
    expect(applied.recommendations).toEqual([recommendation("o-1", 0, ["2"], T + 5_000)]);
    // server-confirmed の全置換規律は不変（provisional は保持される）。
    expect(applied.timers.map((timer) => timer.id)).toEqual(["local-1"]);

    // 次の snapshot が空を運べば、待ち行列も推奨も空へ置き換わる（サーバだけが確定させる事実）。
    const emptied = decideView(applied, {
      kind: "Server",
      message: {
        type: "snapshot",
        serverTime: T + 1,
        timers: [],
        orderItems: [],
        recommendations: [],
      },
      receivedAt: T + 1,
    });
    expect(emptied.orderItems).toEqual([]);
    expect(emptied.recommendations).toEqual([]);
  });

  it("再接続直後の Reconcile でも待ち行列と推奨が反映される（端末間の一致）", () => {
    const stale = viewWith([order("o-old", 0, T)], []);
    const reconciled = decideView(stale, {
      kind: "Reconcile",
      timers: [],
      orderItems: [order("o-new", 0, T + 10)],
      recommendations: [recommendation("o-new", 0, ["1"], T + 20)],
      receivedAt: T + 30,
    });
    expect(reconciled.orderItems).toEqual([order("o-new", 0, T + 10)]);
    expect(reconciled.recommendations).toEqual([recommendation("o-new", 0, ["1"], T + 20)]);
  });

  it("config の追加項目を受け取ってもビューが持つのはユニット総数・麺種プリセットと、釜の組に要る 3 項目だけ", () => {
    const applied = decideView(EMPTY_VIEW, {
      kind: "Server",
      message: {
        type: "config",
        serverTime: T,
        unitCount: 2,
        noodlePresets: DEFAULT_NOODLE_PRESETS,
        arms: 3,
        toleranceRatio: 10,
        orderSyncWeight: 3,
        tableSyncWeight: 2,
        affinityWeight: 1,
        orderSyncToleranceSeconds: 30,
        tableSyncToleranceSeconds: 60,
        affinityToleranceDistance: 14,
        liftIntervalSeconds: 45,
        unitOrigins: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
        ],
        slotOffsets: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
          { x: 0, y: 2 },
          { x: 1, y: 2 },
        ],
        firmnessCodes: [{ code: 10010, firmness: "hard" }],
        menuItems: [
          { productCode: 11421, noodleType: "Thin", sizes: [{ code: 19401, portions: 1 }] },
        ],
      },
      receivedAt: T,
    });
    expect(applied.unitCount).toBe(2);
    expect(applied.noodlePresets).toEqual(DEFAULT_NOODLE_PRESETS);
    // 計画のパラメータのうち、重み・許容幅（秒）・POS の対応表は読み手が無いためビューへ写さない
    // （キーそのものを持たない）。写すのは釜の組が読む unitOrigins / slotOffsets / affinityToleranceDistance
    // だけで、その写しの例は connection.example に在る（lift-group-display 要件4.7）。
    expect(Object.keys(applied).sort()).toEqual(Object.keys(EMPTY_VIEW).sort());
  });
});

describe("待ち行列の表示導出（AC 8.1 / 8.2 / 8.5）", () => {
  it("到着順に並び、同時到着は識別子と品目連番で決定的に断つ", () => {
    const view = viewWith(
      [order("o-b", 0, T + 100), order("o-a", 1, T), order("o-a", 0, T), order("o-c", 0, T + 50)],
      [],
    );
    const entries = orderQueueEntries(view, [0], T);
    expect(
      entries.map((entry) => `${entry.order.externalOrderId}#${entry.order.itemIndex}`),
    ).toEqual(["o-a#0", "o-a#1", "o-c#0", "o-b#0"]);
  });

  it("待ち時間は arrivalTime と補正後現在時刻からの導出で、負にはならない", () => {
    const view = { ...viewWith([order("o-1", 0, T)], []), offset: 1_000 };
    // 補正後現在時刻 = now + offset = T + 3_000 → 待ち 3 秒。
    expect(orderQueueEntries(view, [0], T + 2_000)[0]?.waitingMs).toBe(3_000);
    // 未来の到着（時計ずれ）でも負にしない。
    expect(orderQueueEntries(view, [0], T - 10_000)[0]?.waitingMs).toBe(0);
  });

  it("提案は担当スロット範囲だけに付き、範囲外・推奨なしの品目も一覧には並ぶ", () => {
    const view = viewWith(
      [order("o-mine", 0, T), order("o-theirs", 0, T + 1), order("o-unplanned", 0, T + 2)],
      [
        recommendation("o-mine", 0, ["3"], T + 5_000), // unit 0（slot 0..5）
        recommendation("o-theirs", 0, ["7"], T + 6_000), // unit 1（担当外）
      ],
    );
    const entries = orderQueueEntries(view, [0], T);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.suggestion).toEqual({
      slotIds: ["3"],
      startAt: T + 5_000,
      boilSeconds: 60,
      serveAt: T + 65_000,
    });
    expect(entries[1]?.suggestion).toBeNull();
    expect(entries[2]?.suggestion).toBeNull();
  });

  it("過ぎた推奨開始時刻はそのまま提示され、client は何も起こさない（自動開始しない）", () => {
    const view = viewWith([order("o-1", 0, T)], [recommendation("o-1", 0, ["0"], T - 60_000)]);
    const entries = orderQueueEntries(view, [0], T);
    // startAt は過去のまま。ビューは変わらず、開始は人の操作を待つ。
    expect(entries[0]?.suggestion?.startAt).toBe(T - 60_000);
    expect(orderQueueEntries(view, [0], T + 60_000)[0]?.suggestion?.startAt).toBe(T - 60_000);
  });

  // 空のスロット集合の場合は検査しない。CookRecommendation.slotIds が NonEmptyArray<string> になり
  // （verified-wire-contract）、空の推奨は構築できなくなった——実行時に弾く対象ではなく、型で表現不能である。
  // ワイヤ境界（domain/wire.ts）が非空を確立するため、空の推奨が届く経路も無い。
  it("現在のプリセットに無い麺種の推奨は提案として成立しない", () => {
    const unknownNoodle = viewWith(
      [order("o-1", 0, T, { noodleType: "Retired" })],
      [recommendation("o-1", 0, ["0"], T)],
    );
    expect(orderQueueEntries(unknownNoodle, [0], T)[0]?.suggestion).toBeNull();
  });
});

// ── pending-order-expiry: client も同じ述語で絞る（Requirement 3・性質 5.8） ────────────────────────────
//
// wire の `orderItems` は保持したまま（ClientView に絞った値を持たない）、レールを並べる入口が補正後現在時刻で
// domain の liveOrders に通す。サーバは既に絞って送るが、snapshot の後に時刻が進んで寿命を跨ぐ品目は client が
// 消す——次の snapshot を待たない。時刻はすべて引数で運び、Date.now は用いない（純粋層の規律）。

describe("Feature: pending-order-expiry — 寿命を跨いだ品目は次の snapshot を待たずに左レールから消える（AC 3.1 / 3.2・性質 5.8）", () => {
  /** T にちょうど寿命を迎える品目（T − 1 では生きている）。 */
  const EXPIRING = order("o-expiring", 0, T - ORDER_LIFETIME_MS);
  /** 今届いた品目（どの場面でも生きている）。 */
  const FRESH = order("o-fresh", 0, T - 1_000);

  const keys = (entries: ReturnType<typeof orderQueueEntries>) =>
    entries.map((entry) => keyOf(entry.order));

  it("snapshot 直後は残り、correctedNow が寿命を跨ぐと消える。view の orderItems は wire のまま", () => {
    const view = viewWith([EXPIRING, FRESH], []);
    expect(keys(orderQueueEntries(view, [0], T - 1))).toEqual(["o-expiring#0", "o-fresh#0"]);
    expect(keys(orderQueueEntries(view, [0], T))).toEqual(["o-fresh#0"]);
    expect(keys(orderQueueEntries(view, [0], T + 60_000))).toEqual(["o-fresh#0"]);
    // 絞った値を状態にしない——wire の全量はそのまま残る（design 原則 1）。
    expect(view.orderItems).toEqual([EXPIRING, FRESH]);
  });

  it("境界は半開区間：ちょうど arrivalTime + 寿命 は含まず、その 1 ms 前は含む（domain と同じ 1 つの述語）", () => {
    const view = viewWith([EXPIRING], []);
    expect(orderQueueEntries(view, [0], T - 1)).toHaveLength(1);
    expect(orderQueueEntries(view, [0], T)).toHaveLength(0);
  });

  it("寿命の判定は補正後現在時刻で行う——ローカル時計では生きていても、offset を足せば切れている", () => {
    // offset +30 秒：ローカル T − 30 秒 は補正後 T に等しく、EXPIRING はちょうど寿命。
    const view = { ...viewWith([EXPIRING, FRESH], []), offset: 30_000 };
    expect(keys(orderQueueEntries(view, [0], T - 30_000 - 1))).toEqual([
      "o-expiring#0",
      "o-fresh#0",
    ]);
    expect(keys(orderQueueEntries(view, [0], T - 30_000))).toEqual(["o-fresh#0"]);
    // 待ち時間もその補正後現在時刻から導く（同じ 1 回の補正）。
    expect(orderQueueEntries(view, [0], T - 30_000)[0]?.waitingMs).toBe(T - FRESH.arrivalTime);
  });

  it("寿命を過ぎた品目を指す推奨は提案として成立しない（待ち行列に無い推奨と同じ経路・AC 3.3）", () => {
    const view = viewWith(
      [EXPIRING, FRESH],
      [recommendation("o-expiring", 0, ["0"], T - 10_000), recommendation("o-fresh", 0, ["1"], T)],
    );
    // 1 ms 手前：両方に提案が付く。
    const before = orderQueueEntries(view, [0], T - 1);
    expect(before.map((entry) => [keyOf(entry.order), entry.suggestion !== null])).toEqual([
      ["o-expiring#0", true],
      ["o-fresh#0", true],
    ]);
    // ちょうど寿命：品目が消え、推奨も捨てられる（レールに提案の残骸が現れない）。
    const at = orderQueueEntries(view, [0], T);
    expect(at.map((entry) => [keyOf(entry.order), entry.suggestion !== null])).toEqual([
      ["o-fresh#0", true],
    ]);
    // suggestedItemOf は補正済み時刻を受け、寿命の境界で null に切り替わる。
    const target = view.recommendations[0]!;
    expect(suggestedItemOf(view, target, T - 1)?.order).toBe(EXPIRING);
    expect(suggestedItemOf(view, target, T)).toBeNull();
  });
});

describe("Feature: pending-order-expiry — 非ゼロの offset で左レールと釜の提案は同じ品目集合を生きているとみなす（design Component 5・一致テスト）", () => {
  /** offset は負で大きく振る（ローカル時計がサーバより 2 分進んでいる端末）。 */
  const OFFSET = -120_000;
  /** ローカル時計 NOW_LOCAL の補正後現在時刻がちょうど T になる。 */
  const NOW_LOCAL = T - OFFSET;
  const EXPIRING = order("o-expiring", 0, T - ORDER_LIFETIME_MS);
  const FRESH = order("o-fresh", 1, T - 1_000);
  /** 同じ群 g の 2 品目。startAt は補正後現在時刻より前で、全釜 idle ゆえ両方が釜の提案に現れる。 */
  const VIEW: ClientView = {
    ...viewWith(
      [EXPIRING, FRESH],
      [
        recommendation("o-expiring", 0, ["0"], T - 30_000),
        recommendation("o-fresh", 1, ["1"], T - 20_000),
      ],
    ),
    offset: OFFSET,
  };

  /** 左レールが生きているとみなす品目の鍵（担当は全釜）。 */
  function railKeys(now: number): readonly string[] {
    return orderQueueEntries(VIEW, [0], now).map((entry) => keyOf(entry.order));
  }

  /** 釜の提案が生きているとみなす品目の鍵（境界で 1 回だけ補正した corrected を下へ渡す）。 */
  function boardKeys(now: number): readonly string[] {
    const corrected = correctedNow(VIEW.offset, now);
    const bySlot = slotSuggestions(visibleGroups(liftGroups(VIEW, corrected)), VIEW, corrected);
    return [...new Set([...bySlot.values()].flat().map((s) => keyOf(s.item.order)))].sort();
  }

  it("補正後現在時刻の 1 ms 前では両方が 2 品目を、ちょうど寿命では両方が生きている 1 品目だけを見る", () => {
    expect(correctedNow(VIEW.offset, NOW_LOCAL)).toBe(T);
    expect(railKeys(NOW_LOCAL - 1)).toEqual(["o-expiring#0", "o-fresh#1"]);
    expect(boardKeys(NOW_LOCAL - 1)).toEqual(["o-expiring#0", "o-fresh#1"]);
    expect(railKeys(NOW_LOCAL)).toEqual(["o-fresh#1"]);
    expect(boardKeys(NOW_LOCAL)).toEqual(["o-fresh#1"]);
  });

  it("切り替わる瞬間は同じ 1 ms——どちらか一方だけが先に消える瞬間が無い", () => {
    for (const now of [NOW_LOCAL - 2, NOW_LOCAL - 1, NOW_LOCAL, NOW_LOCAL + 1]) {
      expect(railKeys(now), `now = ${now - NOW_LOCAL}`).toEqual(boardKeys(now));
    }
  });
});

// order-lifecycle（AC 4.5・性質 7.6）：左レール（とそれを読むラジアルの帯）は `pendingOrders(view.orderItems,
// view.timers, corrected)`＝期限内 ∧ unstarted だけを出す。snapshot の `orderItems` は調理中（生きた Timer の参照先）と
// 調理済み（completedAt）も運ぶ（釜のカードが参照で引くため）が、それらはレールに現れない。中断された品目
// （interruptedAt・状態には効かない）は未調理として戻る。
describe("Feature: order-lifecycle — 左レールは未調理（pendingOrders）だけを出す（AC 4.5・性質 7.6）", () => {
  const UNSTARTED = order("o-u", 0, T);
  const COOKING = order("o-c", 0, T + 1);
  const DONE = order("o-d", 0, T + 2, { completedAt: T + 100_000 });
  const INTERRUPTED = order("o-i", 0, T + 3, { interruptedAt: T + 50_000 });

  /** COOKING を指す生きた Timer（走行中・boiled とも「生きた Timer」で、指す品目は cooking）。 */
  function timerFor(item: OrderItem, endTime: number): ClientTimer {
    return {
      id: `t-${item.externalOrderId}`,
      slotIds: ["3"],
      noodleType: item.noodleType,
      firmness: item.firmness,
      startTime: endTime - 60_000,
      endTime,
      orderItem: { externalOrderId: item.externalOrderId, itemIndex: item.itemIndex },
      origin: "server",
    };
  }

  const NOW = T + 200_000;

  it("調理中（生きた Timer が指す）と調理済み（completedAt）は orderItems に在ってもレールに無く、未調理と中断済みは並ぶ", () => {
    const view: ClientView = {
      ...viewWith([DONE, INTERRUPTED, COOKING, UNSTARTED], []),
      timers: [timerFor(COOKING, NOW + 30_000)],
    };
    expect(view.orderItems).toHaveLength(4); // wire のまま保持する（絞った値を view に持たない）
    expect(orderQueueEntries(view, [0], NOW).map((entry) => keyOf(entry.order))).toEqual([
      "o-u#0",
      "o-i#0",
    ]);
  });

  it("茹で上がって Complete を待つ boiled の Timer が指す品目も調理中（時間が来ただけでは done にならない）", () => {
    const view: ClientView = {
      ...viewWith([COOKING, UNSTARTED], []),
      timers: [timerFor(COOKING, NOW - 30_000)],
    };
    expect(orderQueueEntries(view, [0], NOW).map((entry) => keyOf(entry.order))).toEqual(["o-u#0"]);
  });

  it("Timer が snapshot から消えると品目はレールに戻る（厨房 Cancel で unstarted へ・期限内なら再び現れる）", () => {
    const cooking: ClientView = {
      ...viewWith([COOKING, UNSTARTED], []),
      timers: [timerFor(COOKING, NOW + 30_000)],
    };
    const cancelled = decideView(cooking, {
      kind: "Server",
      message: {
        type: "snapshot",
        serverTime: NOW,
        timers: [],
        orderItems: [{ ...COOKING, interruptedAt: NOW }, UNSTARTED],
        recommendations: [],
      },
      receivedAt: NOW,
    });
    expect(orderQueueEntries(cancelled, [0], NOW).map((entry) => keyOf(entry.order))).toEqual([
      "o-u#0",
      "o-c#0",
    ]);
  });

  describe("通信断（degraded）ではレールを列挙しない（order-lifecycle 判断 18・レビュー P2）", () => {
    // 未調理は「自分を指す生きた Timer が無い品目」の導出なので、通信断中にローカルで Timer だけを消す完了は品目に
    // completedAt を書けず、調理済みの品目が未調理として戻って見える（実測：レール [] → ["A"]）。ラジアルと同じく
    // degraded では列挙せず、再接続の snapshot で復帰する。サーバ未確定の completedAt を client では書かない。
    const cookingLive: ClientView = {
      ...viewWith([COOKING, UNSTARTED], []),
      timers: [timerFor(COOKING, NOW + 30_000)],
    };
    const offline = decideView(cookingLive, { kind: "Connectivity", status: "down" });

    it("通信断中はレールが空（未調理が在っても列挙しない）", () => {
      expect(orderQueueEntries(cookingLive, [0], NOW).map((entry) => keyOf(entry.order))).toEqual([
        "o-u#0",
      ]);
      expect(orderQueueEntries(offline, [0], NOW)).toEqual([]);
    });

    it("通信断中の通常完了（boiled の LocalComplete）で、調理済みの品目が未調理として戻らない", () => {
      const boiledOffline = decideView(
        { ...cookingLive, timers: [timerFor(COOKING, NOW - 30_000)] },
        { kind: "Connectivity", status: "down" },
      );
      const completed = decideView(boiledOffline, {
        kind: "LocalComplete",
        timerId: timerFor(COOKING, NOW - 30_000).id,
        now: NOW,
      });
      expect(completed.timers).toEqual([]);
      expect(orderQueueEntries(completed, [0], NOW)).toEqual([]);
    });

    it("通信断中の早め上げ（走行中への complete → LocalComplete）でも戻らない", () => {
      const lifted = decideView(offline, {
        kind: "LocalComplete",
        timerId: timerFor(COOKING, NOW + 30_000).id,
        now: NOW,
      });
      expect(lifted.timers).toEqual([]);
      expect(orderQueueEntries(lifted, [0], NOW)).toEqual([]);
    });

    it("通信断中の中断（LocalCancel）でも通信断の間は戻らない（未調理へ戻すのはサーバの snapshot）", () => {
      const interrupted = decideView(offline, {
        kind: "LocalCancel",
        timerId: timerFor(COOKING, NOW + 30_000).id,
        now: NOW,
      });
      expect(interrupted.timers).toEqual([]);
      expect(orderQueueEntries(interrupted, [0], NOW)).toEqual([]);
    });

    it("段階ごとの検査：down → ローカル完了 → pong/up → snapshot。up だけでは復帰せず、snapshot の再整合で復帰する", () => {
      const lifted = decideView(offline, {
        kind: "LocalComplete",
        timerId: timerFor(COOKING, NOW + 30_000).id,
        now: NOW,
      });
      expect(orderQueueEntries(lifted, [0], NOW)).toEqual([]);
      // pong だけで connectivity は up になる。view はまだ「古い品目集合 ＋ ローカルで消した Timer 集合」——
      // ここで導けば A が未調理として戻る（レビュー実走：レール [A]・snapshot 受信数 0）。再整合までは列挙しない。
      const pong = decideView(lifted, { kind: "Connectivity", status: "up" });
      expect(pong.connectivity).toBe("up");
      expect(pong.awaitingResync).toBe(true);
      expect(orderQueueEntries(pong, [0], NOW)).toEqual([]);
      const reconciled = decideView(pong, {
        kind: "Server",
        message: {
          type: "snapshot",
          serverTime: NOW,
          timers: [],
          orderItems: [{ ...COOKING, completedAt: NOW }, UNSTARTED],
          recommendations: [],
        },
        receivedAt: NOW,
      });
      expect(reconciled.awaitingResync).toBe(false);
      expect(orderQueueEntries(reconciled, [0], NOW).map((entry) => keyOf(entry.order))).toEqual([
        "o-u#0",
      ]);
    });

    it("Reconcile でも再整合する（snapshot と同じ規律）", () => {
      const pong = decideView(
        decideView(offline, {
          kind: "LocalComplete",
          timerId: timerFor(COOKING, NOW + 30_000).id,
          now: NOW,
        }),
        { kind: "Connectivity", status: "up" },
      );
      const reconciled = decideView(pong, {
        kind: "Reconcile",
        timers: [],
        orderItems: [{ ...COOKING, completedAt: NOW }, UNSTARTED],
        recommendations: [],
        receivedAt: NOW,
      });
      expect(reconciled.awaitingResync).toBe(false);
      expect(orderQueueEntries(reconciled, [0], NOW).map((entry) => keyOf(entry.order))).toEqual([
        "o-u#0",
      ]);
    });
  });

  it("調理中・調理済みの品目を指す推奨は提案として成立しない（待ち行列に無い推奨と同じ経路）", () => {
    const recommendations = [
      recommendation("o-c", 0, ["0"], NOW),
      recommendation("o-d", 0, ["1"], NOW),
      recommendation("o-u", 0, ["2"], NOW),
    ];
    const view: ClientView = {
      ...viewWith([DONE, COOKING, UNSTARTED], recommendations),
      timers: [timerFor(COOKING, NOW + 30_000)],
    };
    expect(suggestedItemOf(view, recommendations[0]!, NOW)).toBeNull();
    expect(suggestedItemOf(view, recommendations[1]!, NOW)).toBeNull();
    expect(suggestedItemOf(view, recommendations[2]!, NOW)?.order).toEqual(UNSTARTED);
    const entries = orderQueueEntries(view, [0], NOW);
    expect(entries.map((entry) => [keyOf(entry.order), entry.suggestion !== null])).toEqual([
      ["o-u#0", true],
    ]);
  });

  it("全件が未調理なら view.orderItems と同じ参照で読む（再描画の抑制を壊さない）——アドホックの Timer は品目を指さない", () => {
    const adHoc: ClientTimer = {
      id: "t-adhoc",
      slotIds: ["0"],
      noodleType: "Thin",
      firmness: "normal",
      startTime: NOW - 10_000,
      endTime: NOW + 50_000,
      orderItem: null,
      origin: "server",
    };
    const view: ClientView = { ...viewWith([UNSTARTED, INTERRUPTED], []), timers: [adHoc] };
    expect(orderQueueEntries(view, [0], NOW).map((entry) => entry.order)).toEqual([
      UNSTARTED,
      INTERRUPTED,
    ]);
  });
});
