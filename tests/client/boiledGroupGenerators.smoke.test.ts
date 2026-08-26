// tests/client/boiledGroupGenerators.smoke.test.ts — sync-set-batch-complete の生成器
// （./boiledGroupGenerators）が design.md「生成器の前提」の入力空間を踏むことを確かめる。
//
// **なぜカバレッジの主張を Property から分けるのか。** 「性質が成り立つ」と「生成器がその枝を踏む」は
// 別の主張である。前者は入力空間の全域について述べ、外れれば実装かモデルが誤っている。後者は標本の
// 分布について述べ、外れても実装は正しいまま——外れるのは引きが偏ったときであり、乱数シードに依存する
// 確率的な主張になる。二つを一つのテストへ同居させると、性質の検査がシードで落ちる。実際、fc.assert の
// 中で分岐を数え末尾に toBeGreaterThan(0) を掛ける形は、条件の狭い次元で反復回数を吊り上げる圧力を
// 生んでいた（Property 5 の numRuns が 1000 まで上がっていた）。ゆえにカバレッジの主張はここ一箇所へ
// 集め、Property 側には性質の検査だけを残す。
//
// 標本は fc.sample で取る（性質を評価せず縮小もしないため、反復を大きく取っても安い）。反復数は 30 回
// 計測した最小ヒット数に余裕があることを確かめてから決めている——期待値が細い次元（Property 5 の
// 担当外メンバー引き込み）だけ標本を大きく取り、その理由をその場に記す。
//
// 置き場は既存前例（generators.ts ↔ generators.smoke.test.ts）に倣い、生成器モジュールと対にする。
// offline-degradation の生成器のスモークは generators.smoke.test.ts が担う（別の生成器ゆえ混ぜない）。
//
// 純粋層の生成器ゆえ Date.now のスタブも vi.useFakeTimers() も用いない（時刻は生成器が引数値として吐く）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { boiledGroup } from "../../src/client/boiledGroup";
import type { ClientTimer, ClientView } from "../../src/client/connection";
import {
  genBatchCase,
  genBoiledCase,
  genReflectionOrderCase,
  genUnits,
  type BatchCase,
} from "./boiledGroupGenerators";
import { drivesAssignedSlot, findTarget, lastDriverOf } from "./support/boiledGroupFacts";

/**
 * 標本の大きさ。下の全次元について 30 回計測した最小ヒット数は 21 以上ある（最も細いのは Property 9 の
 * 群外 running が 21/400、次に群 2 件以上の 47/400）。担当外メンバー引き込みの次元だけは別に取る。
 */
const SAMPLE_SIZE = 400;

/** unit u は slot 6u..6u+5 を占める。担当 units = [0] を基準に担当内・外を判定する。 */
function isAssignedToUnitZero(slotId: string): boolean {
  const slot = Number(slotId);
  return slot >= 0 && slot <= 5;
}

/** 群が駆動するスロット（重複を畳んだ集合）。 */
function slotsDrivenBy(group: readonly ClientTimer[]): ReadonlySet<string> {
  return new Set(group.flatMap((member) => [...member.slotIds]));
}

/** 群が駆動するスロットの延べ数（退化——同一スロットの重複駆動——を上の集合と比べて見るため）。 */
function drivenSlotCount(group: readonly ClientTimer[]): number {
  return group.reduce((count, member) => count + member.slotIds.length, 0);
}

/** 群に属さない Timer（畳み込みが同一内容で残す側）。 */
function outsidersOf(view: ClientView, group: readonly ClientTimer[]): readonly ClientTimer[] {
  const memberIds = new Set(group.map((member) => member.id));
  return view.timers.filter((timer) => !memberIds.has(timer.id));
}

/** 盤面から群を立てる（Property 側と同じ引き方）。 */
function groupOf(batch: BatchCase): readonly ClientTimer[] {
  return boiledGroup(batch.view, batch.timerId, batch.correctedNow);
}

describe("client/boiledGroupGenerators genBatchCase の入力空間（Property 1〜5 / 9 の入力）", () => {
  it("対象は「ビュー内の boiled」「ビュー内の running」「不在」の三種に分布し、endTime === correctedNow の境界を踏む", () => {
    // Property 1 / 3 は boiled を前提に採り、Property 4 は running と不在という二つの現れ方を一つの言明に
    // 畳んでいる。双方が踏まれなければ Property 4 は言明の半分しか検査していない（要件1.2 の窓）。
    const cases = fc.sample(genBatchCase, SAMPLE_SIZE);
    const endTimeOf = (batch: BatchCase): number | undefined => findTarget(batch.view, batch.timerId)?.endTime;

    expect(cases.some((batch) => (endTimeOf(batch) ?? Infinity) <= batch.correctedNow)).toBe(true);
    expect(cases.some((batch) => (endTimeOf(batch) ?? -Infinity) > batch.correctedNow)).toBe(true);
    expect(cases.some((batch) => endTimeOf(batch) === undefined)).toBe(true);

    // 境界は boiled 側に転ぶ（述語は endTime <= correctedNow）。
    expect(cases.some((batch) => batch.view.timers.some((timer) => timer.endTime === batch.correctedNow))).toBe(
      true,
    );
  });

  it("origin は server / local 混在で、slotIds は担当ユニット内・外の双方を駆動する", () => {
    // origin は要件2.3 / 2.4 の経路分けの前提、担当内・外は要件4.1 / 4.2 の前提。
    const timers = fc.sample(genBatchCase, SAMPLE_SIZE).flatMap((batch) => batch.view.timers);

    expect(timers.some((timer) => timer.origin === "server")).toBe(true);
    expect(timers.some((timer) => timer.origin === "local")).toBe(true);
    expect(timers.some((timer) => timer.slotIds.some(isAssignedToUnitZero))).toBe(true);
    expect(timers.some((timer) => timer.slotIds.every((slotId) => !isAssignedToUnitZero(slotId)))).toBe(true);
  });

  it("ビューは空・非空、退化スロット、処理済み記録、既存残滓の各次元を踏む", () => {
    const views = fc.sample(genBatchCase, SAMPLE_SIZE).map((batch) => batch.view);

    expect(views.some((view) => view.timers.length === 0)).toBe(true);
    expect(views.some((view) => view.timers.length > 0)).toBe(true);

    // 同一スロットを複数の Timer が駆動する退化入力（要件8.4 / 8.8 の前提）。
    expect(views.some((view) => slotsDrivenBy(view.timers).size < drivenSlotCount(view.timers))).toBe(true);

    // processedIds は空・timers の id と一部一致の双方（要件5.4 の処理済み記録の前提）。
    expect(views.some((view) => view.processedIds.size === 0)).toBe(true);
    expect(views.some((view) => view.timers.some((timer) => view.processedIds.has(timer.id)))).toBe(true);

    // lastResults は空・既存残滓ありの双方（要件8.4 の上書き検査の前提）。
    expect(views.some((view) => view.lastResults.size === 0)).toBe(true);
    expect(views.some((view) => view.lastResults.size > 0)).toBe(true);
  });

  it("群は 2 件以上に立つ盤面と 1 件へ退化する盤面の双方に分布し、群外 Timer による占有を踏む", () => {
    const boards = fc.sample(genBatchCase, SAMPLE_SIZE).map((batch) => ({ batch, group: groupOf(batch) }));

    // 同値衝突で群が複数件に立つ盤面（要件1.5）と、1 件へ退化する盤面（要件2.2）の双方。
    expect(boards.some(({ group }) => group.length >= 2)).toBe(true);
    expect(boards.some(({ group }) => group.length === 1)).toBe(true);

    // 群外 Timer が群メンバーと同一スロットを駆動する盤面（除去してもスロットが空かない・要件2.6 / 8.8）。
    expect(
      boards.some(({ batch, group }) => {
        if (group.length === 0) return false;
        const groupSlots = slotsDrivenBy(group);
        return outsidersOf(batch.view, group).some((timer) =>
          timer.slotIds.some((slotId) => groupSlots.has(slotId)),
        );
      }),
    ).toBe(true);
  });

  it("群が非空のとき、群外の running と群外の boiled（実効 endTime が対象と異なる）の双方が残る盤面を踏む", () => {
    // Property 9 は「群に属さない」の二つの現れ方——running であること、実効 endTime が対象と異なる boiled
    // であること——を一つの言明に畳んでいる（要件3.2）。群が空なら畳み込みが起きず「残る」が自明に成り立つ
    // ため、群が非空の盤面だけを見る。
    const boards = fc
      .sample(genBatchCase, SAMPLE_SIZE)
      .map((batch) => ({ batch, group: groupOf(batch) }))
      .filter(({ group }) => group.length > 0);

    expect(
      boards.some(({ batch, group }) =>
        outsidersOf(batch.view, group).some((timer) => timer.endTime > batch.correctedNow),
      ),
    ).toBe(true);
    expect(
      boards.some(({ batch, group }) => {
        const targetEndTime = findTarget(batch.view, batch.timerId)?.endTime;
        return outsidersOf(batch.view, group).some(
          (timer) => timer.endTime <= batch.correctedNow && timer.endTime !== targetEndTime,
        );
      }),
    ).toBe(true);
  });

  it("担当スロットからの押下が担当外メンバーを引き込む盤面を踏む", () => {
    // Property 5 の核心の次元。操作口は担当スロットにしか現れない（要件4.3）ため、その起点から押したときに
    // 担当外メンバーが群へ入ることが「担当集合に依らない」（要件4.1 / 4.2）の非空虚さを支える。
    //
    // 条件が pressable かつ担当外メンバー非空の二重の狭さゆえ、この次元だけ標本を 10 倍取る——実測では
    // 400 標本でヒットが平均 5・最小 2 に落ち、4000 標本で平均 48・最小 37（いずれも 30 回計測）になる。
    // 性質を評価しない標本ゆえ 10 倍でも 0.1 秒で済み、Property の反復回数へ圧力をかけない。
    const pairs = fc.sample(fc.record({ batch: genBatchCase, units: genUnits }), SAMPLE_SIZE * 10);

    expect(
      pairs.some(({ batch, units }) => {
        const target = findTarget(batch.view, batch.timerId);
        if (target === undefined || target.endTime > batch.correctedNow) return false;
        // 担当スロットからの押下でなければ、担当外メンバーを引き込んだ証拠にならない（units が空なら全員が
        // 担当外に転ぶため、それを数えても分岐を踏んだことにならない）。
        if (!drivesAssignedSlot(target, units)) return false;
        return batch.view.timers.some(
          (timer) => timer.endTime === target.endTime && !drivesAssignedSlot(timer, units),
        );
      }),
    ).toBe(true);
  });
});

describe("client/boiledGroupGenerators genBoiledCase の入力空間（Property 6〜8 の入力）", () => {
  it("群は構成的に非空で、1 件へ退化する盤面と 2 件以上の盤面の双方を踏む", () => {
    // 非空は生成器の構成（correctedNow を対象の endTime から導く）が保証する。1 件は Property 6 の前提
    // ——踏まなければ「単一は一括の退化ケース」（要件2.2）を何も検査していない。
    const groups = fc.sample(genBoiledCase, SAMPLE_SIZE).map(groupOf);

    expect(groups.every((group) => group.length > 0)).toBe(true);
    expect(groups.some((group) => group.length === 1)).toBe(true);
    expect(groups.some((group) => group.length >= 2)).toBe(true);
  });

  it("群の origin は server を含む・local を含む・双方が同居するの三種を踏む", () => {
    // Property 7 は「origin を問わず一様に記録する」ことを言う。片方の origin しか踏まなければ半分しか
    // 検査しておらず、混在群（経路が分かれるメンバーが一つのビューへ畳まれる形）が最も強い検査になる。
    const groups = fc.sample(genBoiledCase, SAMPLE_SIZE).map(groupOf);
    const hasServer = (group: readonly ClientTimer[]): boolean =>
      group.some((member) => member.origin === "server");
    const hasLocal = (group: readonly ClientTimer[]): boolean =>
      group.some((member) => member.origin === "local");

    expect(groups.some(hasServer)).toBe(true);
    expect(groups.some(hasLocal)).toBe(true);
    expect(groups.some((group) => hasServer(group) && hasLocal(group))).toBe(true);
  });
});

describe("client/boiledGroupGenerators genReflectionOrderCase の入力空間（Property 8 の入力）", () => {
  it("反映順は群の全要素の置換であり、並びが変わる例を含む", () => {
    const orders = fc.sample(genReflectionOrderCase, SAMPLE_SIZE);

    for (const order of orders) {
      expect(order.group.length).toBeGreaterThan(0);
      expect(order.reflected.length).toBe(order.group.length);
      // 同じ要素集合であることを参照同一で見る——濃度の一致だけでは、別の Timer に入れ替わった並びを
      // 見逃す。長さが等しく全メンバーが含まれるなら、各メンバーはちょうど一度現れる。
      for (const member of order.group) {
        expect(order.reflected).toContain(member);
      }
    }

    expect(
      orders.some((order) => order.group.some((member, index) => member.id !== order.reflected[index]?.id)),
    ).toBe(true);
  });

  it("退化群・既存残滓の上書き・置換で勝者が変わる盤面を踏む", () => {
    const orders = fc.sample(genReflectionOrderCase, SAMPLE_SIZE);

    // 同一スロットを複数メンバーが駆動する退化群（要件8.4 の競合規則の前提）。
    expect(orders.some((order) => slotsDrivenBy(order.group).size < drivenSlotCount(order.group))).toBe(true);

    // 既存残滓（stale-*・負の at）が群のスロットに載っている盤面——上書きが現に起きる。
    expect(
      orders.some((order) =>
        [...slotsDrivenBy(order.group)].some((slotId) => order.view.lastResults.has(slotId)),
      ),
    ).toBe(true);

    // 反映順を置換したことで勝者が変わる盤面。順序の引数化が効いている証拠であり、これを踏まなければ
    // Property 8 は「どの順でも同じ答えになる盤面」だけを見ていることになる。勝者は群・反映順・麺種だけで
    // 決まる（要件8.4 の規則そのもの）ゆえ、畳み込みを走らせずに判定できる。
    expect(
      orders.some((order) =>
        [...slotsDrivenBy(order.group)].some(
          (slotId) =>
            lastDriverOf(order.reflected, slotId)?.noodleType !== lastDriverOf(order.group, slotId)?.noodleType,
        ),
      ),
    ).toBe(true);
  });

  it("群外 Timer が群のスロットを駆動する盤面（畳み込み後の占有）を踏む", () => {
    // 要件8.8 は「占有されていても残滓を記録する」ことを言う。占有は畳み込み後の残存 Timer で見るが、
    // 畳み込みが除くのは群のメンバーだけで群外は同一内容で残る（Property 9 が独立に検査する）。ゆえに
    // 「畳み込み後に群外が群スロットを駆動する」は畳み込み前の盤面として同じことを言える——標本側は
    // 畳み込みを走らせない（カバレッジの主張は畳み込みの結果について何も述べない）。
    const orders = fc.sample(genReflectionOrderCase, SAMPLE_SIZE);

    expect(
      orders.some((order) => {
        const groupSlots = slotsDrivenBy(order.group);
        return outsidersOf(order.view, order.group).some((timer) =>
          timer.slotIds.some((slotId) => groupSlots.has(slotId)),
        );
      }),
    ).toBe(true);
  });
});
