// tests/core/pending.property.test.ts — Property 8（到着の upsert は冪等で起点を保持する）と
// Property 21（開始済み品目は upsert で復活しない）。
//
// 対象は engine/pending の upsertOrder。純粋関数ゆえ workerd に依らず既定 pool で走る。
//
// 生成器の方針：待ち行列（pending）・生きた Timer（running）・到着（arrival）の 3 つは互いに独立ではない。
// 「開始済みの品目は待ち行列に居ない」（人の開始が consumeOrder で除く）という現実の不変条件を生成器が
// 尊重する——尊重しないと、実際には起きない状態に対する主張を検証してしまう。ゆえに品目ごとに
// started / pending / gone の札を振り、その札から pending と running の両方を組み立てる。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { upsertOrder } from "../../src/engine/pending";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { PendingOrder } from "../../src/domain/order";
import type { Firmness } from "../../src/domain/firmness";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const NOW = 10_000_000;

/** 品目の在り方。started は生きた Timer を持つ（＝待ち行列に居ない）、gone はキャンセル済み。 */
type ItemStatus = "started" | "pending" | "gone";

/** 品目の内容（itemIndex は注文内の位置から決定的に振る）。 */
interface ItemSpec {
  readonly noodleType: string;
  readonly firmness: Firmness;
  readonly tableId: string | null;
  readonly status: ItemStatus;
}

/** 1 注文の素データ。arrivalTime は注文単位で 1 つ（upsert が常に注文単位で与えるため）。 */
interface OrderSpec {
  readonly externalOrderId: string;
  readonly arrivalTime: number;
  readonly items: readonly ItemSpec[];
}

/** 素データから組み立てた場面。pending と running は同じ札から出るので互いに矛盾しない。 */
interface Scene {
  readonly orders: readonly OrderSpec[];
  readonly pending: readonly PendingOrder[];
  readonly running: readonly Timer[];
}

const genItemSpec: fc.Arbitrary<ItemSpec> = fc.record({
  noodleType: fc.constantFrom("thin", "thick", "curly"),
  firmness: fc.constantFrom<Firmness>("extraHard", "hard", "normal", "soft"),
  tableId: fc.oneof(fc.constantFrom("t-1", "t-2"), fc.constant(null)),
  status: fc.constantFrom<ItemStatus>("started", "pending", "gone"),
});

/** 注文 id は少数の固定集合から採る（同一 id の再送・別 id の共存を高い頻度で踏ませる）。 */
const genOrderSpec = (externalOrderId: string): fc.Arbitrary<OrderSpec> =>
  fc.record({
    externalOrderId: fc.constant(externalOrderId),
    // 到着（NOW）より必ず古い起点。引き継ぎと上書きが観測で区別できるように差を開ける。
    arrivalTime: fc.integer({ min: 0, max: NOW - 60_000 }),
    items: fc.array(genItemSpec, { minLength: 1, maxLength: 4 }),
  });

/** 3 つの注文それぞれの在/不在を振る（空集合・単独・複数注文の共存をすべて踏む）。 */
const genScene: fc.Arbitrary<Scene> = fc
  .tuple(
    fc.option(genOrderSpec("o-1"), { nil: undefined }),
    fc.option(genOrderSpec("o-2"), { nil: undefined }),
    fc.option(genOrderSpec("o-3"), { nil: undefined }),
  )
  .map((specs) => buildScene(specs.filter((spec): spec is OrderSpec => spec !== undefined)));

/** 素データから pending / running を組み立てる。札が唯一の出所（同じ品目が両方に現れない）。 */
function buildScene(orders: readonly OrderSpec[]): Scene {
  const pending: PendingOrder[] = [];
  const running: Timer[] = [];
  for (const order of orders) {
    order.items.forEach((item, itemIndex) => {
      if (item.status === "pending") pending.push(toPendingOrder(order, item, itemIndex, order.arrivalTime));
      if (item.status === "started") {
        running.push(timerFor(order.externalOrderId, itemIndex, running.length));
      }
    });
  }
  // アドホック麺茹で（orderItem === null）を必ず 1 本混ぜる。注文に紐づかない Timer が
  // 置換の判定に一切影響しないことを、全 property が同時に検査することになる。
  running.push(adHocTimer(running.length));
  return { orders, pending, running };
}

function toPendingOrder(
  order: OrderSpec,
  item: ItemSpec,
  itemIndex: number,
  arrivalTime: number,
): PendingOrder {
  return {
    externalOrderId: order.externalOrderId,
    itemIndex,
    noodleType: item.noodleType,
    firmness: item.firmness,
    tableId: item.tableId,
    arrivalTime,
    slotSpan: 1,
  };
}

/** 当該注文品目から始まった生きた Timer。endTime は本 property の主張に関与しない。 */
function timerFor(externalOrderId: string, itemIndex: number, seq: number): Timer {
  return createTimer({
    id: `t-${externalOrderId}-${itemIndex}` as TimerId,
    slotIds: nonEmpty([String(seq % 6) as SlotId]),
    noodleType: "thin" as NoodleType,
    firmness: "normal",
    startTime: NOW as EpochMillis,
    endTime: (NOW + 120_000) as EpochMillis,
    seq,
    orderItem: { externalOrderId, itemIndex },
  });
}

/** POS を経ない麺茹で。orderItem が null ゆえ、どの注文の置換にも関わらない。 */
function adHocTimer(seq: number): Timer {
  return createTimer({
    id: `t-adhoc-${seq}` as TimerId,
    slotIds: nonEmpty(["5" as SlotId]),
    noodleType: "curly" as NoodleType,
    firmness: "hard",
    startTime: NOW as EpochMillis,
    endTime: (NOW + 60_000) as EpochMillis,
    seq,
  });
}

/** 到着の品目群（itemIndex は位置から振る。arrivalTime は受理時刻 NOW）。 */
function arrivalOf(externalOrderId: string, items: readonly ItemSpec[]): NonEmptyArray<PendingOrder> {
  return nonEmpty(
    items.map((item, itemIndex) =>
      toPendingOrder({ externalOrderId, arrivalTime: NOW, items }, item, itemIndex, NOW),
    ),
  );
}

/**
 * 場面に対する到着。3 通りを振る：
 *   - 全品目そのままの再送（modification のうち内容が変わらない場合＝冪等の芯）
 *   - 内容・件数が変わった再送（modification の正規化）
 *   - 未知の注文の初回到着
 */
function genArrivalFor(scene: Scene): fc.Arbitrary<NonEmptyArray<PendingOrder>> {
  const changed = fc
    .tuple(
      fc.constantFrom("o-1", "o-2", "o-3", "o-new"),
      fc.array(genItemSpec, { minLength: 1, maxLength: 4 }),
    )
    .map(([id, items]) => arrivalOf(id, items));
  const resends = scene.orders
    .filter((order) => order.items.length > 0)
    .map((order) => fc.constant(arrivalOf(order.externalOrderId, order.items)));
  return resends.length === 0 ? changed : fc.oneof(changed, ...resends);
}

const genSceneAndArrival = genScene.chain((scene) =>
  genArrivalFor(scene).map((arrival) => ({ scene, arrival })),
);

/** 品目を一意に指す鍵（テスト側の照合用）。 */
const keyOf = (externalOrderId: string, itemIndex: number): string => `${externalOrderId}#${itemIndex}`;

/** 当該注文が集合に持つ最早の arrivalTime。無ければ null。 */
function originOf(pending: readonly PendingOrder[], externalOrderId: string): number | null {
  const times = pending.filter((o) => o.externalOrderId === externalOrderId).map((o) => o.arrivalTime);
  return times.length === 0 ? null : Math.min(...times);
}

describe("engine/pending — 到着の upsert", () => {
  // Feature: online-cook-scheduling, Property 8: 到着の upsert は冪等で、起点を保持する
  // **Validates: Requirements 1.3, 1.8**
  //
  // 主張は 4 つ。
  //   1. 冪等 — 同じ到着を二度適用した結果は一度適用した結果と一致する（AC 1.3）。しかも二度目は
  //      集合を変えないので、同じ配列インスタンスが返る（no-op が呼び出し側から === で見える）。
  //   2. 起点の保持 — 既に同一 externalOrderId が集合に在れば、結果の当該品目の arrivalTime は
  //      到着の受理時刻ではなく既存の起点である（AC 1.8：変更で待ち時間の起点をリセットしない）。
  //   3. 重複しない — 結果に同一 (externalOrderId, itemIndex) が二度現れない（AC 1.3）。
  //   4. 巻き込まない — 到着が触れていない注文の品目はそのまま残る。
  it("Property 8: 同じ到着の再適用は集合を変えず、既存注文の arrivalTime は引き継がれる", () => {
    fc.assert(
      fc.property(genSceneAndArrival, ({ scene, arrival }) => {
        const { pending, running } = scene;
        const next = upsertOrder(pending, running, arrival);

        // 1. 冪等（二度目は同一インスタンス＝集合を変えない）。
        expect(upsertOrder(next, running, arrival)).toBe(next);

        const arrivedIds = new Set(arrival.map((item) => item.externalOrderId));

        // 2. 起点の保持。既存が在る注文は到着の受理時刻（NOW）を採らない。
        for (const externalOrderId of arrivedIds) {
          const origin = originOf(pending, externalOrderId);
          const expected = origin ?? NOW;
          for (const order of next.filter((o) => o.externalOrderId === externalOrderId)) {
            expect(order.arrivalTime).toBe(expected);
          }
        }

        // 3. 重複しない。
        const keys = next.map((order) => keyOf(order.externalOrderId, order.itemIndex));
        expect(new Set(keys).size).toBe(keys.length);

        // 4. 到着が触れていない注文は巻き込まれない（並びまで含めて不変）。
        expect(next.filter((o) => !arrivedIds.has(o.externalOrderId))).toEqual(
          pending.filter((o) => !arrivedIds.has(o.externalOrderId)),
        );
      }),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property 21: 開始済み品目は upsert で復活しない
  // **Validates: Requirements 1.3, 1.8**
  //
  // POS が「一部の品目が既に開始された注文」について全品目を含む modification を再送する、という
  // 現場で実際に起きる事故の形をそのまま生成する。生きた Timer（running / boiled）を持つ品目が
  // 待ち行列へ戻れば、同じ麺が二度茹でられる。
  //   1. 生きた Timer を持つ品目は結果に現れない（復活しない）。
  //   2. それでいて未開始の品目は現れる（除外が到着全体を捨てているのではない）。
  it("Property 21: 全品目を含む modification でも生きた Timer を持つ品目は待ち行列へ戻らない", () => {
    fc.assert(
      fc.property(genRevivalScene, ({ scene, arrival, startedKeys }) => {
        const next = upsertOrder(scene.pending, scene.running, arrival);

        // 1. 開始済み品目は復活しない。
        for (const order of next) {
          expect(startedKeys.has(keyOf(order.externalOrderId, order.itemIndex))).toBe(false);
        }

        // 2. 未開始の到着品目は待ち行列に居る（除外が広すぎない）。
        for (const item of arrival) {
          const key = keyOf(item.externalOrderId, item.itemIndex);
          if (startedKeys.has(key)) continue;
          expect(next.some((order) => keyOf(order.externalOrderId, order.itemIndex) === key)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

/**
 * 「一部の品目が既に開始された注文」へ全品目を含む modification が届く場面。
 *
 * boiled（発火済み・明示完了待ち）も生きた Timer である——釜から上がっていても提供前であり、
 * 復活させれば二度茹でになる。ゆえに started の Timer には running と boiled の双方を混ぜる。
 */
const genRevivalScene: fc.Arbitrary<{
  scene: Scene;
  arrival: NonEmptyArray<PendingOrder>;
  startedKeys: ReadonlySet<string>;
}> = fc
  .record({
    externalOrderId: fc.constantFrom("o-1", "o-2"),
    arrivalTime: fc.integer({ min: 0, max: NOW - 60_000 }),
    // 少なくとも 1 つが started、少なくとも 1 つが started でない品目群。
    head: fc.record({
      noodleType: fc.constantFrom("thin", "thick"),
      firmness: fc.constantFrom<Firmness>("hard", "normal"),
      tableId: fc.oneof(fc.constantFrom("t-1"), fc.constant(null)),
      status: fc.constant<ItemStatus>("started"),
    }),
    tail: fc.array(genItemSpec, { minLength: 1, maxLength: 3 }),
    boiled: fc.boolean(),
    other: fc.array(genItemSpec, { minLength: 0, maxLength: 2 }),
  })
  .map(({ externalOrderId, arrivalTime, head, tail, boiled, other }) => {
    // tail から started を落として「未開始が必ず 1 つ以上」を確保する（started は head が担う）。
    const items: readonly ItemSpec[] = [
      head,
      ...tail.map((item) => (item.status === "started" ? { ...item, status: "pending" as ItemStatus } : item)),
    ];
    const target: OrderSpec = { externalOrderId, arrivalTime, items };
    const bystander: OrderSpec = { externalOrderId: "o-9", arrivalTime, items: other };
    const scene = buildScene(other.length === 0 ? [target] : [target, bystander]);
    const startedKeys = new Set<string>();
    for (const timer of scene.running) {
      if (timer.orderItem === null) continue;
      startedKeys.add(keyOf(timer.orderItem.externalOrderId, timer.orderItem.itemIndex));
    }
    // boiled も生きた Timer である（提供前）。同じ主張が両方の状態で立つことを検査する。
    const running = boiled
      ? scene.running.map((timer) =>
          timer.orderItem === null ? timer : { ...timer, boiledAt: (NOW + 1) as EpochMillis },
        )
      : scene.running;
    return {
      scene: { ...scene, running },
      // 全品目を含む再送（開始済みも含む）。これが二重調理を招く形である。
      arrival: arrivalOf(externalOrderId, items),
      startedKeys,
    };
  });
