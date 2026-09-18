// tests/core/persisted-size.example.test.ts — 永続サイズの代表値による回帰（性質 5.10）。
//
// Feature: order-item-truncation, Property 5.10
// **Validates: Requirements 5.10**
//
// **これはハード上界ではなく参考指標である。** 守るのは「代表的な入力で桁が変わっていないこと」だけで、
// 「`put` が必ず通る」ことは主張しない。理由は 4 つある。
//
//   (a) 実際に載るのは structured clone で符号化されたオブジェクトであって JSON 文字列ではない
//       （`store-timer-do.ts` は `storage.put(SNAPSHOT_KEY, snapshot)` にオブジェクトをそのまま渡す）。
//   (b) SQLite バックエンドの上限 2 MB は **key と value の合算**で、キー長は別に載る。
//   (c) `itemName` / `sizeName` / `externalOrderId` / `noodleType` / `tableId` は長さを検証していないので、
//       1 件あたりのバイト数に上界が無い（`toDeclaredName` は「空でない文字列か」だけを見る）。
//   (d) `lastSequenceByTerminal` は構造的に有界でない（端末集合の有限性は外部契約への前提）。
//
// 件数上限がバイト数の上界を与えないことは判断 4 の既知の帰結である（ADR-0014）。ここが検出するのは
// 「1 件あたりの大きさが黙って倍になった」「上限の件数が黙って増えた」といった桁の変化である。

import { describe, expect, it } from "vitest";
import { ORDER_ITEM_LIMIT } from "../../src/engine/pending";
import { PLAN_TARGET_LIMIT } from "../../src/engine/schedule";
import type { AcceptedSlice } from "../../src/engine/schedule";
import { toSnapshot } from "../../src/engine/snapshot";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { ShownItem } from "../../src/engine/stability";
import { MAX_TIMERS } from "../../src/engine/types";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { OrderItem } from "../../src/domain/order";
import { nonEmpty } from "../nonEmpty";

const T0 = 1_757_300_000_000;
/** 実運用に近い値——日本語の商品名・麺量・卓・完了時刻を持つ品目。 */
const ITEM_NAME = "プレミアム塩ラーメン";
const SIZE_NAME = "中盛";
const NOODLE_TYPE = "プレミアム塩";
/** KDS が採番する実際の形（56 桁）。端末数は 1 店舗の実運用規模。 */
const SEQUENCE_DIGITS = 56;
const TERMINALS = 8;

function representativeItem(index: number): OrderItem {
  return {
    externalOrderId: `20260908-0012-${String(index).padStart(6, "0")}`,
    itemIndex: index % 3,
    noodleType: NOODLE_TYPE,
    firmness: "normal",
    tableId: String(index % 40),
    arrivalTime: T0 + index * 1000,
    portions: 1,
    itemName: ITEM_NAME,
    sizeName: SIZE_NAME,
    completedAt: T0 + index * 1000 + 600_000,
    interruptedAt: null,
    tableAssignedAt: null,
  };
}

function representativeTimer(index: number): Timer {
  return createTimer({
    id: `t-${String(index).padStart(4, "0")}` as TimerId,
    slotIds: nonEmpty([String(index % 18) as SlotId]),
    noodleType: NOODLE_TYPE as NoodleType,
    firmness: "normal",
    startTime: (T0 + index * 1000) as EpochMillis,
    endTime: (T0 + index * 1000 + 180_000) as EpochMillis,
    seq: index,
    orderItem: {
      externalOrderId: `20260908-0012-${String(index).padStart(6, "0")}`,
      itemIndex: index % 3,
      tableId: String(index % 40),
    },
  });
}

function representativeSlice(index: number): AcceptedSlice {
  return {
    tableKey: String(index % 40),
    placements: [
      {
        externalOrderId: `20260908-0012-${String(index).padStart(6, "0")}`,
        itemIndex: index % 3,
        slotIds: nonEmpty([String(index % 18) as SlotId]),
        startAt: (T0 + index * 1000) as EpochMillis,
        serveAt: (T0 + index * 1000 + 180_000) as EpochMillis,
        anchor: null,
      },
    ],
  };
}

function representativeShownItem(index: number): ShownItem {
  return {
    externalOrderId: `20260908-0012-${String(index).padStart(6, "0")}`,
    itemIndex: index % 3,
    slotIds: nonEmpty([String(index % 18) as SlotId]),
    startAt: (T0 + index * 1000) as EpochMillis,
    serveAt: (T0 + index * 1000 + 180_000) as EpochMillis,
    anchor: null,
    mates: [],
  };
}

/** 満杯の状態——上限いっぱいの品目に、他の成員も上限規模で載せる。 */
function fullState(): TimerState {
  const lastSequenceByTerminal: Record<string, string> = {};
  for (let terminal = 0; terminal < TERMINALS; terminal++) {
    lastSequenceByTerminal[String(terminal)] = String(terminal + 1)
      .repeat(SEQUENCE_DIGITS)
      .slice(0, SEQUENCE_DIGITS);
  }
  return {
    ...EMPTY_STATE,
    timers: Array.from({ length: MAX_TIMERS }, (_unused, index) => representativeTimer(index)),
    nextSeq: MAX_TIMERS,
    orderItems: Array.from({ length: ORDER_ITEM_LIMIT }, (_unused, index) =>
      representativeItem(index),
    ),
    acceptedSlices: Array.from({ length: PLAN_TARGET_LIMIT }, (_unused, index) =>
      representativeSlice(index),
    ),
    lastSequenceByTerminal,
    shownPlan: Array.from({ length: PLAN_TARGET_LIMIT }, (_unused, index) =>
      representativeShownItem(index),
    ),
  };
}

/** UTF-8 バイト数（`TextEncoder`）。structured clone の実サイズではない——ヘッダ (a) を参照。 */
function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe("永続サイズの代表値（order-item-truncation 性質 5.10）", () => {
  it("満杯の状態の代表値が桁として変わっていない（参考指標であってハード上界ではない）", () => {
    const snapshot = toSnapshot(fullState());
    const total = utf8Bytes(snapshot);
    const items = utf8Bytes(snapshot.orderItems);
    const perItem = items / ORDER_ITEM_LIMIT;

    // **実測（2026-09-08）：1 件 279.7 B・品目集合 1.093 MiB・全体 1.137 MiB。**
    // 回帰の帯は実測の周りに広めに取る——ここは「桁の変化」を捕まえるものであり、
    // 数バイトの揺れ（フィールド名の変更など）で赤くする箱にはしない。
    expect(perItem).toBeGreaterThan(200);
    expect(perItem).toBeLessThan(400);
    expect(total).toBeLessThan(1.5 * 1024 * 1024);
    // ハード上限（key + value 合わせて 2 MB）に対して余裕が在ること。**保証ではない**——
    // 文字列長は未検証であり (c)、実際に載るのは JSON ではない (a)。
    expect(total).toBeLessThan(2 * 1024 * 1024);
  });

  it("品目集合が全体の大部分を占める（上限を置く対象が正しいことの確認）", () => {
    const snapshot = toSnapshot(fullState());
    const items = utf8Bytes(snapshot.orderItems);
    const total = utf8Bytes(snapshot);

    // **本 spec の導入前に**無条件で伸び続けていたのは orderItems だけである（観測事実 5〜6——
    // `lastSequenceByTerminal` は構造的には有界でなく、有界性は外部契約への前提）。有界化した後も、
    // 他の成員を足して全体が品目集合に支配されることは変わらない
    // （実測 2026-09-08：96.1%）。
    expect(items / total).toBeGreaterThan(0.9);
  });
});
