// tests/core/order-item-bound.example.test.ts — 実走での有界性（性質 5.9）。
//
// Feature: order-item-truncation, Property 5.9
// **Validates: Requirements 2.4, 5.9**
//
// 閉包性（`order-item-bound.property`・性質 5.8）は**変換ごとに独立して**件数の動きを検査する。それは
// 「現在存在する変換の列挙」であって網羅ではない（design の既知の限界）。ここはその二重の網——engine を
// **実走**させ、どの時点でも `TimerState.orderItems.length ≤ ORDER_ITEM_LIMIT` が成り立つことを確かめる。
//
// 通す口は 2 つ。**状態遷移は `decide`**（`OrderArrived` / `StartOrderItem` / `Complete` / `Cancel` /
// `OrderCancelled` / `PlanArrived`）で、**hydration は永続の公開境界**（`toSnapshot` → `migrate` →
// `fromSnapshot`）である。hydration は遷移ではないので `decide` を通らない。
//
// 検査は**各 `decide` の直後**と**各 hydration の直後**に行う（周回の末尾ではない）。周回の末尾でだけ見ると、
// 途中で上限を超え、その後の `OrderCancelled` で減って戻る不具合を見逃す。
//
// **拒否は握り潰さない。** 通常経路のイベントはすべて成功を要求し、どの種別も少なくとも一度は成功したことを
// 最後に主張する——列挙したイベントが実は一度も成立していない、という形の空振りを防ぐ。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { migrate } from "../../src/engine/migrate";
import { fromSnapshot, toSnapshot } from "../../src/engine/snapshot";
import { ORDER_ITEM_LIMIT } from "../../src/engine/pending";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Event } from "../../src/engine/event";
import type { CookSchedule } from "../../src/engine/schedule";
import type { EpochMillis, SlotId, TimerId } from "../../src/engine/types";
import type { OrderItem } from "../../src/domain/order";
import {
  DEFAULT_NOODLE_PRESETS,
  DEFAULT_UNIT_COUNT,
  SLOTS_PER_UNIT,
  occupiedSlotsOf,
} from "../../src/domain/store";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const PARAMS = settleParams({ arms: 2, toleranceRatio: 0.1 });
const T0 = 1_700_000_000_000;
const SLOT_COUNT = DEFAULT_UNIT_COUNT * SLOTS_PER_UNIT;
const at = (seconds: number) => (T0 + seconds * 1000) as EpochMillis;

/** 実走で踏む遷移の種別。すべてが少なくとも一度は成功したことを最後に主張する。 */
type EventKind = Event["type"];
const EXPECTED_KINDS: readonly EventKind[] = [
  "OrderArrived",
  "StartOrderItem",
  "Complete",
  "Cancel",
  "OrderCancelled",
  "PlanArrived",
];

/** POS が送ってくる 1 品目。麺種はプリセットに在るものを使う（未知の麺種は受理で弾かれる）。 */
function arrival(index: number, arrivalTime: number): OrderItem {
  return {
    externalOrderId: `o-${String(index).padStart(6, "0")}`,
    itemIndex: 0,
    noodleType: DEFAULT_NOODLE_PRESETS[0]!.noodleType,
    firmness: "normal",
    tableId: `t-${index % 20}`,
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  };
}

/** いま Timer に塞がれていない釜のうち最小のもの。無ければ null（開始を試みない）。 */
function freeSlot(state: TimerState): SlotId | null {
  const occupied = occupiedSlotsOf(state.timers);
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    if (!occupied.has(slot)) return String(slot) as SlotId;
  }
  return null;
}

/** 品目 1 件を空き釜へ今から置く外部計画（形として妥当な CookSchedule）。 */
function planFor(item: OrderItem, slotId: SlotId, now: EpochMillis): CookSchedule {
  return {
    slices: [
      {
        tableKey: item.tableId ?? item.externalOrderId,
        placements: [
          {
            externalOrderId: item.externalOrderId,
            itemIndex: item.itemIndex,
            slotIds: nonEmpty([slotId]),
            startAt: now,
            serveAt: (now + 60_000) as EpochMillis,
            anchor: null,
          },
        ],
      },
    ],
  };
}

describe("実走での有界性（order-item-truncation 性質 5.9）", () => {
  it("到着・開始・完了・キャンセル・後着・取消・外部計画・hydration のどの直後でも上限を超えない", () => {
    const succeeded = new Set<EventKind>();
    let state: TimerState = EMPTY_STATE;
    let timerSeq = 0;
    let issued = 0;

    /** 上限の検査点はここ一つ。`decide` と hydration の**直後**に必ず通る。 */
    function expectBounded(next: TimerState, whence: string) {
      expect(next.orderItems.length, `${whence} の直後に上限を超えた`).toBeLessThanOrEqual(
        ORDER_ITEM_LIMIT,
      );
    }

    /** 一手進める。**拒否は失敗として扱う**——列挙した遷移が実は成立していない空振りを防ぐ。 */
    function step(event: Event): void {
      const outcome = decide(state, event, PARAMS);
      expect(
        outcome.ok ? "ok" : `rejected(${outcome.rejection.code})`,
        `${event.type} は成功しなければならない`,
      ).toBe("ok");
      if (!outcome.ok) return;
      succeeded.add(event.type);
      expectBounded(outcome.state, event.type);
      state = outcome.state;
    }

    /** 永続の公開境界を往復する（遷移ではないので decide を通らない）。 */
    function hydrate(): void {
      const revived = migrate(structuredClone(toSnapshot(state)) as unknown);
      expect(revived.ok).toBe(true);
      if (!revived.ok) return;
      state = fromSnapshot(revived.snapshot);
      expectBounded(state, "hydration");
    }

    // 上限の 2 倍以上を投入して、上限に達した後の定常状態を十分に踏む。到着は 1 遷移に BATCH 件を
    // まとめる——1 品ずつだと遷移が 8000 回を超え、1 遷移 25〜40ms（実測）なので数分に伸びる。
    // 検査したいのは遷移の細かさではなく「何度通しても件数が上限を超えない」ことである。
    const BATCH = 64;
    const ROUNDS = Math.ceil((ORDER_ITEM_LIMIT * 2 + 50) / BATCH);

    for (let round = 0; round < ROUNDS; round++) {
      const now = at(round);

      // 1. 到着（毎回・BATCH 件）。
      const batch = Array.from({ length: BATCH }, () => arrival(issued++, now));
      step({ type: "OrderArrived", arrival: nonEmpty(batch), now });

      // 2. ときどき開始する。**空き釜と未調理の品目が在るときだけ**——無い状態で送れば正当に拒否され、
      //    それは本テストの主張（上限）とは別の話である。対象は最も新しい品目（忘却で消えない側）。
      const slot = freeSlot(state);
      const startable = state.orderItems.at(-1);
      if (round % 7 === 0 && slot !== null && startable !== undefined) {
        step({
          type: "StartOrderItem",
          slotIds: [slot],
          externalOrderId: startable.externalOrderId,
          itemIndex: startable.itemIndex,
          newTimerId: `t-${timerSeq++}` as TimerId,
          now,
        });
      }

      // 3. 完了とキャンセルは**別の Timer**に当てる（同じ id へ二度送れば二度目は TimerNotFound）。
      if (round % 11 === 0 && state.timers.length >= 1) {
        step({ type: "Complete", timerId: state.timers[0]!.id, now });
      }
      if (round % 13 === 0 && state.timers.length >= 1) {
        step({ type: "Cancel", timerId: state.timers[0]!.id, now });
      }

      // 4. 後着（同じ注文の属性更新）と POS 取消。
      const existing = state.orderItems[0];
      if (existing !== undefined && round % 5 === 0) {
        step({
          type: "OrderArrived",
          arrival: nonEmpty([{ ...existing, tableId: "t-moved" }]),
          now,
        });
      }
      if (existing !== undefined && round % 19 === 0) {
        step({ type: "OrderCancelled", externalOrderId: existing.externalOrderId, now });
      }

      // 5. 外部計画の受領（Requirement 5.9 の「外部計画の受領」）。**計画対象は到着順の先頭
      //    PLAN_TARGET_LIMIT 件**なので、最も新しい品目を指す計画は必ず失効する（isStale）——
      //    採用されうる計画にするには、先頭側の未調理の品目を指さなければならない。
      const planSlot = freeSlot(state);
      const planTarget = state.orderItems.find(
        (item) =>
          item.completedAt === null &&
          !state.timers.some(
            (timer) =>
              timer.orderItem !== null &&
              timer.orderItem.externalOrderId === item.externalOrderId &&
              timer.orderItem.itemIndex === item.itemIndex,
          ),
      );
      if (round % 3 === 0 && planSlot !== null && planTarget !== undefined) {
        step({ type: "PlanArrived", plan: planFor(planTarget, planSlot, now), now });
      }

      // 6. ときどき hydration を挟む。
      if (round % 23 === 0) hydrate();
    }

    // 列挙した遷移がすべて少なくとも一度は成功したこと（テストが空振りしていないことの証拠）。
    for (const kind of EXPECTED_KINDS) {
      expect(succeeded.has(kind), `${kind} が一度も成功していない`).toBe(true);
    }
    // 十分に投入したので、終状態は上限に張り付いている（上限の経路を実際に踏んだ証拠）。
    expect(state.orderItems.length).toBe(ORDER_ITEM_LIMIT);
    // **採用（Acceptance_Gate の通過）はこの場面では起きない**（実測 0 件）。1 placement の計画は
    // 64 件の計画対象に対する自前解に総費用で勝てないためで、それは正しい振る舞いである。採用そのものは
    // `admit.example` / `decide-quadruple.property` が守る。採用は `acceptedSlices` を差し替えるだけで
    // `orderItems` には触れない（`plan.ts` の `moved`）ので、本テストが主張する件数の有界性には関与しない。
    // ここで `PlanArrived` を踏むのは、受領という遷移そのものが上限を壊さないことを見るためである。
  });
});
