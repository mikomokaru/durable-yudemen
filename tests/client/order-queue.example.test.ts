// tests/client/order-queue.example.test.ts — 待ち行列と推奨の client 表示（online-cook-scheduling タスク 16）。
//
// 検証対象は 2 つの純粋層だけである。
//   (1) decideView の snapshot / Reconcile 分岐 — 待ち行列と推奨をサーバ由来の事実として全置換すること
//       （既存の timers の畳み込みは触らない）。
//   (2) orderQueueEntries — 到着順の並び・待ち時間の導出・担当範囲での提案の絞り込み。
// いずれも WS・DOM・時計に触れないため既定 pool（workerd 不要）で走る。now は引数で運ぶ。

import { describe, expect, it } from "vitest";
import { decideView, EMPTY_VIEW, type ClientView } from "../../src/client/connection";
import { orderQueueEntries } from "../../src/client/components/queueDisplay";
import type { PendingOrder } from "../../src/domain/order";
import type { CookRecommendation } from "../../src/domain/messages";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";

const T = 1_700_000_000_000;

/** 1 品目の未着手オーダー。既定プリセットに在る麺種（Thin: normal=60 秒）を既定に据える。 */
function order(
  externalOrderId: string,
  itemIndex: number,
  arrivalTime: number,
  overrides: Partial<PendingOrder> = {},
): PendingOrder {
  return {
    externalOrderId,
    itemIndex,
    noodleType: "Thin",
    firmness: "normal",
    tableId: null,
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
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
  return { externalOrderId, itemIndex, slotIds, startAt };
}

/** synced 済みのビュー（待ち行列と推奨だけを差し替える）。 */
function viewWith(
  pendingOrders: readonly PendingOrder[],
  recommendations: readonly CookRecommendation[],
): ClientView {
  return {
    ...EMPTY_VIEW,
    sync: "synced",
    connectivity: "up",
    pendingOrders,
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
        pendingOrders: [order("o-1", 0, T)],
        recommendations: [recommendation("o-1", 0, ["2"], T + 5_000)],
      },
      receivedAt: T,
    });
    expect(applied.pendingOrders).toEqual([order("o-1", 0, T)]);
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
        pendingOrders: [],
        recommendations: [],
      },
      receivedAt: T + 1,
    });
    expect(emptied.pendingOrders).toEqual([]);
    expect(emptied.recommendations).toEqual([]);
  });

  it("再接続直後の Reconcile でも待ち行列と推奨が反映される（端末間の一致）", () => {
    const stale = viewWith([order("o-old", 0, T)], []);
    const reconciled = decideView(stale, {
      kind: "Reconcile",
      timers: [],
      pendingOrders: [order("o-new", 0, T + 10)],
      recommendations: [recommendation("o-new", 0, ["1"], T + 20)],
      receivedAt: T + 30,
    });
    expect(reconciled.pendingOrders).toEqual([order("o-new", 0, T + 10)]);
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
          { productCode: 11421, noodleType: "Thin", sizes: [{ code: 19401, slotSpan: 1 }] },
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
    expect(entries[0]?.suggestion).toEqual({ slotIds: ["3"], startAt: T + 5_000, boilSeconds: 60 });
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
