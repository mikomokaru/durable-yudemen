// Feature: lift-order-numbering, Component 1 / **Validates: Requirements 3.1, 3.2, 3.2′, 3.3, 3.4, 3.5**
//
// tests/domain/lift-order.property.test.ts — 上がり順（Lift_Order）の性質。
//
// 上がり順は 2 段である（2026-09-08 の改訂）。クラスタ（同じ実効 endTime）に上がる順の番号、クラスタ内の注文に
// 枝番。生成器は endTime と startTime を少数の値から引き、注文の識別子も少数（＋ null）から引く——同じ endTime・
// 同じ注文・同じ startTime の衝突を高い頻度で作り、クラスタの束ねと枝の断ち方（3.2 / 3.2′）を踏ませるため。
// id は位置から振り、一意である。slotIds は導出が読まない事実として同乗させ、複数釜でも 1 本として数えることを
// 鍵の集合で問う（3.5）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { liftOrderOf, type LiftOrder } from "../../src/domain/lift-order";

const NOW = 1_700_000_000_000;
const SECOND = 1000;

interface SceneTimer {
  readonly id: string;
  readonly slotIds: readonly string[];
  readonly startTime: number;
  readonly endTime: number;
  readonly orderItem: { readonly externalOrderId: string; readonly itemIndex: number } | null;
}

/** 実効 endTime。走行中（NOW より後）と茹で上がり（NOW 以前）を混ぜ、同値が頻出する粗い刻みにする。 */
const genEndTime: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 6 }).map((k) => NOW + k * 30 * SECOND) },
  { weight: 1, arbitrary: fc.integer({ min: -3, max: 0 }).map((k) => NOW + k * 30 * SECOND) },
);

const genTimerBody = fc.record({
  endTime: genEndTime,
  /** 開始は endTime の 10〜120 秒前を粗い刻みで（同値を作る）。 */
  boilSteps: fc.integer({ min: 1, max: 12 }),
  order: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("o-1", "o-2", "o-3") },
    { weight: 1, arbitrary: fc.constant(null) },
  ),
  itemIndex: fc.integer({ min: 0, max: 2 }),
  slots: fc.integer({ min: 1, max: 2 }),
});

const genTimers: fc.Arbitrary<readonly SceneTimer[]> = fc
  .array(genTimerBody, { maxLength: 10 })
  .map((bodies) =>
    bodies.map((body, index) => ({
      id: `t-${index}`,
      slotIds: body.slots === 1 ? [String(index)] : [String(index), String(index + 100)],
      startTime: body.endTime - body.boilSteps * 10 * SECOND,
      endTime: body.endTime,
      orderItem:
        body.order === null ? null : { externalOrderId: body.order, itemIndex: body.itemIndex },
    })),
  );

/** 走行中の Timer（導出と同じ線：endTime > now）。 */
function runningOf(timers: readonly SceneTimer[], now: number): readonly SceneTimer[] {
  return timers.filter((timer) => timer.endTime > now);
}

/** 枝の鍵（テスト側の独立な定義——同じ endTime かつ同じ注文。アドホックは id）。 */
function branchKeyOf(timer: SceneTimer): string {
  const order = timer.orderItem === null ? `#${timer.id}` : timer.orderItem.externalOrderId;
  return `${timer.endTime}|${order}`;
}

function orderOf(order: ReadonlyMap<string, LiftOrder>, id: string): LiftOrder {
  const found = order.get(id);
  if (found === undefined) throw new Error(`走行中の Timer ${id} に上がり順が無い`);
  return found;
}

/** `key` の集合へ値を足す（無ければ作る）。 */
function addTo<K, V>(groups: Map<K, Set<V>>, key: K, value: V): void {
  const found = groups.get(key);
  if (found === undefined) groups.set(key, new Set([value]));
  else found.add(value);
}

/** 上がり順の全順序（クラスタ → 枝）。番号そのものではなく順序を問うために使う。 */
function compareOrder(a: LiftOrder, b: LiftOrder): number {
  return a.cluster - b.cluster || a.branch - b.branch;
}

describe("Feature: lift-order-numbering — 上がり順の性質（Requirement 3）", () => {
  it("3.1 順序：クラスタ番号の大小は実効 endTime の大小と一致し、同じ endTime は同じクラスタ番号", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        const running = runningOf(timers, NOW);
        for (const a of running) {
          for (const b of running) {
            const clusterA = orderOf(order, a.id).cluster;
            const clusterB = orderOf(order, b.id).cluster;
            // クラスタ番号は endTime の順序をそのまま写す（同値も含めて）。
            expect(Math.sign(clusterA - clusterB)).toBe(Math.sign(a.endTime - b.endTime));
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("3.2 同時・同注文：同じ endTime かつ同じ注文 ⇔ 同じ（クラスタ・枝）。同じ endTime で注文が違えばクラスタは同じで枝が違う", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        const running = runningOf(timers, NOW);
        for (const a of running) {
          for (const b of running) {
            if (a.id === b.id) continue;
            const orderA = orderOf(order, a.id);
            const orderB = orderOf(order, b.id);
            const sameBranch = branchKeyOf(a) === branchKeyOf(b);
            expect(compareOrder(orderA, orderB) === 0).toBe(sameBranch);
            if (a.endTime === b.endTime && !sameBranch) {
              // 一括で上がる（クラスタを共有する）が、盛り付けの単位は分かれる。
              expect(orderA.cluster).toBe(orderB.cluster);
              expect(orderA.branch).not.toBe(orderB.branch);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("3.2′ 枝の順：同じクラスタの中では、枝内の最早 startTime が早い注文が小さい枝番", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        const running = runningOf(timers, NOW);
        // 枝ごとの最早 startTime。
        const earliest = new Map<string, number>();
        for (const timer of running) {
          const key = branchKeyOf(timer);
          earliest.set(key, Math.min(earliest.get(key) ?? Infinity, timer.startTime));
        }
        for (const a of running) {
          for (const b of running) {
            if (a.endTime !== b.endTime || branchKeyOf(a) === branchKeyOf(b)) continue;
            const startA = earliest.get(branchKeyOf(a)) ?? Infinity;
            const startB = earliest.get(branchKeyOf(b)) ?? Infinity;
            if (startA < startB) {
              expect(orderOf(order, a.id).branch).toBeLessThan(orderOf(order, b.id).branch);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("3.3 密：クラスタ番号の集合は 1..k（k は走行中の相異なる endTime の数）、各クラスタの枝番の集合は 1..m（m はその中の注文の数）", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        const running = runningOf(timers, NOW);
        const clusters = new Set(running.map((timer) => timer.endTime));
        const shown = [...new Set([...order.values()].map((o) => o.cluster))].sort((a, b) => a - b);
        expect(shown).toEqual(Array.from({ length: clusters.size }, (_, index) => index + 1));

        // クラスタごとに、枝番の集合はその中の注文の数だけ 1 から詰まっている。
        const branchesByCluster = new Map<number, Set<number>>();
        const keysByCluster = new Map<number, Set<string>>();
        for (const timer of running) {
          const { cluster, branch } = orderOf(order, timer.id);
          addTo(branchesByCluster, cluster, branch);
          addTo(keysByCluster, cluster, branchKeyOf(timer));
        }
        for (const [cluster, branches] of branchesByCluster) {
          const orders = keysByCluster.get(cluster)?.size ?? 0;
          expect([...branches].sort((a, b) => a - b)).toEqual(
            Array.from({ length: orders }, (_, index) => index + 1),
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it("3.4 店舗全体：上がり順は Timer 集合全体の関数——入力の並びに依らず、クラスタを丸ごと落として導き直せばクラスタ番号は押し上がるだけで枝と相対順序は変わらない", () => {
    // 担当ユニットを変えても同じ Timer の上がり順が変わらないのは、読む側が常に店舗全体の Map から引くからである
    // （client の slotDisplay.example が担当外の Timer による押し上げを固定する）。ここで問うのは、その Map が
    // 集合全体の関数であること——(a) 入力の並びに依らない、(b) クラスタ（同じ endTime の集合）を丸ごと落とした
    // 部分集合で導き直しても、残ったクラスタの中身は変わらないので枝番は不変・クラスタ番号は減るだけ・相対順序は
    // 同じ。クラスタを割って落とせば枝の最早 startTime が変わり枝の順が入れ替わりうるので、丸ごと落とす。
    fc.assert(
      fc.property(
        genTimers,
        fc.array(fc.boolean(), { minLength: 32, maxLength: 32 }),
        (timers, mask) => {
          const full = liftOrderOf(timers, NOW);
          expect(liftOrderOf([...timers].reverse(), NOW)).toEqual(full);
          const endTimes = [...new Set(timers.map((timer) => timer.endTime))];
          const kept = timers.filter((timer) => mask[endTimes.indexOf(timer.endTime)] ?? false);
          const partial = liftOrderOf(kept, NOW);
          const running = runningOf(kept, NOW);
          for (const a of running) {
            expect(orderOf(partial, a.id).cluster).toBeLessThanOrEqual(orderOf(full, a.id).cluster);
            expect(orderOf(partial, a.id).branch).toBe(orderOf(full, a.id).branch);
            for (const b of running) {
              expect(Math.sign(compareOrder(orderOf(partial, a.id), orderOf(partial, b.id)))).toBe(
                Math.sign(compareOrder(orderOf(full, a.id), orderOf(full, b.id))),
              );
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("3.5 複数釜と茹で上がり：鍵の集合は走行中の id とちょうど一致する（複数釜の Timer も 1 本・boiled は無い）", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        expect(new Set(order.keys())).toEqual(new Set(runningOf(timers, NOW).map((t) => t.id)));
        // slotIds は読まない——釜の数を変えても同じ Map。
        const singleSlot = timers.map((timer) => ({
          ...timer,
          slotIds: [timer.slotIds[0] ?? "0"],
        }));
        expect(liftOrderOf(singleSlot, NOW)).toEqual(order);
      }),
      { numRuns: 300 },
    );
  });

  it("決定性：同じ入力から同じ Map。時間が進んでもクラスタは丸ごと上がるので、枝は不変で相対順序も変わらない", () => {
    fc.assert(
      fc.property(genTimers, fc.integer({ min: 0, max: 200 * SECOND }), (timers, elapsed) => {
        const before = liftOrderOf(timers, NOW);
        expect(liftOrderOf(timers, NOW)).toEqual(before);
        const after = liftOrderOf(timers, NOW + elapsed);
        for (const a of runningOf(timers, NOW + elapsed)) {
          expect(orderOf(after, a.id).cluster).toBeLessThanOrEqual(orderOf(before, a.id).cluster);
          expect(orderOf(after, a.id).branch).toBe(orderOf(before, a.id).branch);
          for (const b of runningOf(timers, NOW + elapsed)) {
            expect(Math.sign(compareOrder(orderOf(after, a.id), orderOf(after, b.id)))).toBe(
              Math.sign(compareOrder(orderOf(before, a.id), orderOf(before, b.id))),
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
