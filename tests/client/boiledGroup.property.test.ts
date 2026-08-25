// tests/client/boiledGroup.property.test.ts — sync-set-batch-complete の Property テスト。
//
// 本ファイルは design.md の Property 1〜9（タスク 1.3〜1.7 / 2.2〜2.5）の置き場である。冒頭のスモークは、
// 生成器（./boiledGroupGenerators）が design.md「生成器の前提」の入力空間を実際にサンプリングできることを
// 固める——各 Property の前提が空虚でないことの土台。
//
// 純粋層のテストゆえ Date.now のスタブも vi.useFakeTimers() も用いない（時刻は引数で渡る）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assignedTimers } from "../../src/client/assignment";
import { boiledGroup } from "../../src/client/boiledGroup";
import { type ClientTimer, type ClientView, decideView } from "../../src/client/connection";
import {
  genBatchCase,
  genBatchView,
  genBoiledCase,
  genRecordedAt,
  genReflectionOrderCase,
  genUnits,
} from "./boiledGroupGenerators";

/** unit u は slot 6u..6u+5 を占める。担当 units = [0] を基準に担当内・外を判定する。 */
function isAssignedToUnitZero(slotId: string): boolean {
  const slot = Number(slotId);
  return slot >= 0 && slot <= 5;
}

/** 対象 Timer をビューから引く（不在なら undefined）。boiledGroup の関門と同じ引き方を二度書かない。 */
function findTarget(view: ClientView, timerId: string): ClientTimer | undefined {
  return view.timers.find((timer) => timer.id === timerId);
}

/**
 * その Timer が担当ユニットのいずれかのスロットを駆動するか（unit u は slot 6u..6u+5）。
 * 判定は assignment.ts の担当射影（any-overlap）へ委ね、担当判定を二度書かない。
 */
function drivesAssignedSlot(timer: ClientTimer, units: readonly number[]): boolean {
  return assignedTimers([timer], units).length === 1;
}

/**
 * 群へ LocalComplete を順に畳む。端（openTimerConnection.complete）のループと同形——同一の記録時刻 at を
 * 全メンバーへ渡し、中間ビューを外に出さずに畳み切る。
 */
function foldLocalComplete(view: ClientView, members: readonly ClientTimer[], at: number): ClientView {
  return members.reduce(
    (next, member) => decideView(next, { kind: "LocalComplete", timerId: member.id, now: at }),
    view,
  );
}

describe("client/boiledGroupGenerators 生成器のスモーク", () => {
  it("design.md「生成器の前提」の各次元を構造的にサンプリングできる", () => {
    const cases = fc.sample(genBatchCase, 400);
    const views = cases.map((c) => c.view);
    const timers = views.flatMap((view) => view.timers);

    // origin は server / local 混在（要件2.3 / 2.4 の経路分けの前提）。
    expect(timers.some((timer) => timer.origin === "server")).toBe(true);
    expect(timers.some((timer) => timer.origin === "local")).toBe(true);

    // slotIds は担当ユニット内・外の双方を駆動する（要件4.1 / 4.2）。
    expect(timers.some((timer) => timer.slotIds.some(isAssignedToUnitZero))).toBe(true);
    expect(timers.some((timer) => timer.slotIds.every((slotId) => !isAssignedToUnitZero(slotId)))).toBe(true);

    // 同一スロットを複数の Timer が駆動する退化入力（要件8.4 / 8.8 の前提）。
    expect(
      views.some((view) => {
        const driven = view.timers.flatMap((timer) => [...timer.slotIds]);
        return new Set(driven).size < driven.length;
      }),
    ).toBe(true);

    // processedIds は空・timers の id と一部一致の双方（要件5.4 の処理済み記録の前提）。
    expect(views.some((view) => view.processedIds.size === 0)).toBe(true);
    expect(views.some((view) => view.timers.some((timer) => view.processedIds.has(timer.id)))).toBe(true);

    // lastResults は空・既存残滓ありの双方（要件8.4 の上書き検査の前提）。
    expect(views.some((view) => view.lastResults.size === 0)).toBe(true);
    expect(views.some((view) => view.lastResults.size > 0)).toBe(true);

    // 対象は「ビュー内の boiled」「ビュー内の running」「不在」の三種に分布する（要件1.2 の窓）。
    const target = (c: (typeof cases)[number]) => findTarget(c.view, c.timerId);
    expect(cases.some((c) => (target(c)?.endTime ?? Infinity) <= c.correctedNow)).toBe(true);
    expect(cases.some((c) => (target(c)?.endTime ?? -Infinity) > c.correctedNow)).toBe(true);
    expect(cases.some((c) => target(c) === undefined)).toBe(true);

    // endTime === correctedNow の境界（boiled 側）を必ず踏む。
    expect(cases.some((c) => c.view.timers.some((timer) => timer.endTime === c.correctedNow))).toBe(true);

    // 同値衝突により群が 2 件以上に立つ盤面と、1 件へ退化する盤面（要件1.5 / 2.2）の双方を踏む。
    const groupSizes = cases.map((c) => boiledGroup(c.view, c.timerId, c.correctedNow).length);
    expect(groupSizes.some((size) => size >= 2)).toBe(true);
    expect(groupSizes.some((size) => size === 1)).toBe(true);

    // 群外 Timer が群メンバーと同一スロットを駆動する盤面（除去してもスロットが空かない・要件2.6 / 8.8）。
    expect(
      cases.some((c) => {
        const group = boiledGroup(c.view, c.timerId, c.correctedNow);
        if (group.length === 0) return false;
        const groupSlots = new Set(group.flatMap((timer) => [...timer.slotIds]));
        const ids = new Set(group.map((timer) => timer.id));
        return c.view.timers.some(
          (timer) => !ids.has(timer.id) && timer.slotIds.some((slotId) => groupSlots.has(slotId)),
        );
      }),
    ).toBe(true);

    // 空ビューも非空ビューも踏む（境界）。
    expect(views.some((view) => view.timers.length === 0)).toBe(true);
    expect(views.some((view) => view.timers.length > 0)).toBe(true);

    // genBatchView 単体も実行可能（Property 側が view のみを要する場合の入口）。
    expect(fc.sample(genBatchView, 10).length).toBe(10);

    // 反映順は群の全要素の置換であり（長さ・メンバー集合が保たれる）、並びが変わる例を含む。
    const orders = fc.sample(genReflectionOrderCase, 400);
    expect(orders.every((o) => o.group.length > 0)).toBe(true);
    expect(orders.every((o) => o.reflected.length === o.group.length)).toBe(true);
    expect(
      orders.every(
        (o) => new Set(o.reflected.map((timer) => timer.id)).size === new Set(o.group.map((timer) => timer.id)).size,
      ),
    ).toBe(true);
    expect(
      orders.some((o) => o.group.some((timer, index) => timer.id !== o.reflected[index]?.id)),
    ).toBe(true);
  });
});

describe("client/boiledGroup 同時上がり群の再構成", () => {
  // Feature: sync-set-batch-complete, Property 1: 群は対象自身を含む
  //
  // 任意の ClientView・timerId・correctedNow について、対象 Timer がビューに存在し boiled
  // （endTime <= correctedNow）であるならば、boiledGroup(view, timerId, correctedNow) は当該 Timer を含む。
  // **Validates: Requirements 1.4**
  it("Property 1: 対象がビューに在り boiled なら群は対象自身を含む", () => {
    fc.assert(
      fc.property(genBatchCase, ({ view, timerId, correctedNow }) => {
        const target = findTarget(view, timerId);
        // 含意の前提を前置でそのまま表す（対象が running / 不在のときの帰結は Property 4 の担当）。
        // 一般ケース genBatchCase を入力に採るのは、前提を満たす盤面だけに絞った生成器で検査すると
        // 「前提が満たされない入力では何も言わない」という含意の形が入力側へ隠れてしまうため。
        fc.pre(target !== undefined && target.endTime <= correctedNow);

        const group = boiledGroup(view, timerId, correctedNow);

        // 参照同一で含まれる（view.timers の要素をそのまま返す）ことと、id で引けることの双方を見る。
        expect(group).toContain(target);
        expect(group.some((member) => member.id === timerId)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: sync-set-batch-complete, Property 2: 全メンバーが boiled である
  //
  // 任意の ClientView・timerId・correctedNow について、boiledGroup が返す各メンバーは
  // endTime <= correctedNow を満たす。
  // **Validates: Requirements 1.6, 3.1**
  it("Property 2: 群の各メンバーは boiled である", () => {
    fc.assert(
      fc.property(genBatchCase, ({ view, timerId, correctedNow }) => {
        // この性質は Property 3（実効 endTime が対象と等しい）と対象の boiled 関門から構造的に導かれる。
        // それでも独立に検査するのは、導出が実装で崩れていないことを見るため（design.md「冗長性の検討」）。
        const group = boiledGroup(view, timerId, correctedNow);

        // 群が空のときは検査対象が無く自明に成り立つ。ゆえに前提を絞らず一般ケースをそのまま採る
        // （群が空になる帰結そのものは Property 4 の担当）。
        for (const member of group) {
          expect(member.endTime).toBeLessThanOrEqual(correctedNow);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: sync-set-batch-complete, Property 3: 全メンバーの実効 endTime が対象と等しい
  //
  // 任意の ClientView・timerId・correctedNow について、boiledGroup が空でないならば、返る各メンバーの
  // endTime は対象 Timer の endTime と等しい。さらに、ビュー内で対象と endTime が等しく boiled な Timer は、
  // すべて返り値に含まれる（漏れが無い）。
  // **Validates: Requirements 1.1, 1.3**
  it("Property 3: 群の各メンバーは対象と実効 endTime が等しく、等しい boiled Timer に漏れが無い", () => {
    fc.assert(
      fc.property(genBatchCase, ({ view, timerId, correctedNow }) => {
        // 「群が空でない」は「対象がビューに在り boiled」と同値ゆえ、前提を入力側の形で前置する
        // （Property 1 と同一の前提。群が空になる場合の帰結は Property 4 の担当）。
        const target = findTarget(view, timerId);
        fc.pre(target !== undefined && target.endTime <= correctedNow);
        // fc.pre は型を絞らないため、対象の endTime は optional chaining で受けてから等値に用いる。
        const targetEndTime = target?.endTime;

        const group = boiledGroup(view, timerId, correctedNow);

        expect(group.length).toBeGreaterThan(0);

        // 健全性 — 返るものはすべて対象と実効 endTime が等しい（等値のみで集め、許容窓を持たない）。
        for (const member of group) {
          expect(member.endTime).toBe(targetEndTime);
        }

        // 完全性 — 対象と実効 endTime が等しく boiled な Timer は、担当スコープに依らず漏れなく含まれる。
        const memberIds = new Set(group.map((member) => member.id));
        const missing = view.timers.filter(
          (timer) =>
            timer.endTime === targetEndTime && timer.endTime <= correctedNow && !memberIds.has(timer.id),
        );
        expect(missing).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: sync-set-batch-complete, Property 4: 対象が running または不在なら群を形成しない
  //
  // 任意の ClientView・timerId・correctedNow について、対象 Timer がビューに存在しない、または running
  // （endTime > correctedNow）であるならば、boiledGroup は空を返す。
  // **Validates: Requirements 1.2, 3.2**
  it("Property 4: 対象が running または不在なら群を形成しない", () => {
    // 前提は「不在」と「running」という二つの現れ方を一つの言明に畳んでいる（design.md「冗長性の検討」）。
    // 片方の分岐しか踏まないまま通れば言明の半分しか検査していないため、どちらを踏んだかを数え、
    // fc.assert の後に双方が実際に現れたことを確かめる。
    let absentRuns = 0;
    let runningRuns = 0;

    fc.assert(
      fc.property(genBatchCase, ({ view, timerId, correctedNow }) => {
        const target = findTarget(view, timerId);
        // 含意の前提を前置でそのまま表す（Property 1 / 3 と同一の判断。対象が boiled のときの帰結は
        // Property 1〜3 の担当）。一般ケース genBatchCase を入力に採るのは、前提を満たす盤面だけを吐く
        // 生成器で検査すると、含意の形が入力側へ隠れてしまうため。
        fc.pre(target === undefined || target.endTime > correctedNow);
        if (target === undefined) absentRuns += 1;
        else runningRuns += 1;

        // 一括しない——送信もローカル畳み込みも起点を持たない（端は群が空なら早期 return する）。
        expect(boiledGroup(view, timerId, correctedNow)).toEqual([]);
      }),
      { numRuns: 100 },
    );

    expect(absentRuns).toBeGreaterThan(0);
    expect(runningRuns).toBeGreaterThan(0);
  });

  // Feature: sync-set-batch-complete, Property 5: 群は担当スコープに依存しない
  //
  // 任意の ClientView・timerId・correctedNow・任意の担当ユニット集合について、boiledGroup の結果は担当
  // ユニット集合に依らず同一であり、対象と実効 endTime が等しい boiled Timer は、その slotIds が担当
  // ユニットのどのスロットも駆動しない場合であっても結果に含まれる。
  // **Validates: Requirements 4.1, 4.2**
  it("Property 5: 群は担当ユニット集合に依らず同一で、担当外メンバーも含む", () => {
    // 「担当外メンバーが現に群へ入った」分岐を数える（Property 4 と同じ作法）。この分岐が踏まれることは、
    // 担当射影を掛ける実装なら答えが変わっていたことの証拠でもある——ゆえに下の scoped 比較は空虚でない。
    let outsiderRuns = 0;

    fc.assert(
      fc.property(genBatchCase, genUnits, genUnits, ({ view, timerId, correctedNow }, unitsA, unitsB) => {
        const target = findTarget(view, timerId);
        // fc.pre を用いず一般ケースを採るため、対象の endTime は optional chaining で受ける（Property 3 と同形）。
        const targetEndTime = target?.endTime;
        const actual = boiledGroup(view, timerId, correctedNow);

        // boiledGroup は units を引数に取らない。ゆえに「担当集合に依らない」を空虚でない形で言うには、
        // 担当射影を先に掛けた「もしも」の実装——units に依って答えが変わる形の代表——と比べる。
        const scopedGroup = (units: readonly number[]): readonly ClientTimer[] =>
          boiledGroup({ ...view, timers: assignedTimers(view.timers, units) }, timerId, correctedNow);

        for (const units of [unitsA, unitsB]) {
          const scoped = scopedGroup(units);
          const pressable = target !== undefined && drivesAssignedSlot(target, units);

          // 射影は落とすだけで足さない（起点が担当外なら対象ごと落ちて空になる）。
          expect(actual).toEqual(expect.arrayContaining([...scoped]));

          // 操作口は担当スロットにしか現れない（要件4.3）。その起点から押した場合、担当射影版が失うのは
          // 「担当外メンバーちょうど」であり、実際の群は units が何であれそれを保つ（要件4.1）。
          if (pressable) {
            expect(scoped).toEqual(assignedTimers(actual, units));
          }

          // 対象と実効 endTime が等しい boiled Timer は、担当ユニットのどのスロットも駆動しなくても群に
          // 含まれる（要件4.2）。actual から引き直さず view.timers から独立に導いて突き合わせる。
          const outsiders =
            targetEndTime !== undefined && targetEndTime <= correctedNow
              ? view.timers.filter(
                  (timer) => timer.endTime === targetEndTime && !drivesAssignedSlot(timer, units),
                )
              : [];
          for (const outsider of outsiders) {
            expect(actual).toContain(outsider);
          }
          // 担当スロットからの押下が担当外メンバーを引き込んだ盤面だけを数える（units が空なら全員が担当外に
          // 転ぶため、それを数えても分岐を踏んだ証拠にならない）。
          if (pressable && outsiders.length > 0) outsiderRuns += 1;
        }
      }),
      // 他の Property より多く回す。上の計数条件は pressable かつ outsiders 非空の二重の狭さで、
      // 200 run では outsiderRuns の期待値が 5 前後しかなく、genUnits / genUnits の引き次第で 0 に落ちて
      // 末尾の toBeGreaterThan(0) がフレークする（実測 1.7%）。1000 run で期待値が 20 を超え、実質消える。
      // 揃えるために 200 へ戻さない——計数条件は Property 5 の核心（担当スロットからの押下が担当外メンバーを
      // 引き込んだ盤面）であり、緩めれば検査が薄まる。
      { numRuns: 1000 },
    );

    expect(outsiderRuns).toBeGreaterThan(0);
  });

  // Feature: sync-set-batch-complete, Property 6: 1 件のときは単一消し込みと一致する
  //
  // 任意の ClientView・timerId・correctedNow について、boiledGroup の結果がちょうど 1 件であるならば、
  // その 1 件は対象 Timer であり、群に対する LocalComplete の畳み込み結果は、対象 1 件のみに LocalComplete を
  // 適用した結果（従来の単一消し込み）と等しい。
  // **Validates: Requirements 2.2**
  it("Property 6: 群が 1 件のときの畳み込みは従来の単一消し込みと一致する", () => {
    // 1 件へ退化した盤面が現に踏まれたことを数える（Property 4 / 5 と同じ作法）。前提が一度も満たされない
    // まま通れば、単一が一括の退化ケースであることを何も検査していない。
    let singletonRuns = 0;

    fc.assert(
      // 対象が必ず boiled のケースを採る（群が非空になる）。そこから 1 件へ退化した盤面だけを前置で絞る
      // ——END_TIME_POOL の同値衝突は密なので、絞っても十分に踏める。
      fc.property(genBoiledCase, genRecordedAt, ({ view, timerId, correctedNow }, at) => {
        const group = boiledGroup(view, timerId, correctedNow);
        fc.pre(group.length === 1);
        singletonRuns += 1;

        // 1 件は対象自身である（他の誰かへ退化しない・要件1.4 の帰結）。
        expect(group[0]?.id).toBe(timerId);

        const batched = foldLocalComplete(view, group, at);
        const single = decideView(view, { kind: "LocalComplete", timerId, now: at });

        // ビュー全体で比べる——除去（timers）・処理済み記録（processedIds）・残滓（lastResults）のどれかが
        // ずれれば「同一の結果」ではない。Set / Map も toEqual が構造比較する。
        expect(batched).toEqual(single);
      }),
      { numRuns: 100 },
    );

    expect(singletonRuns).toBeGreaterThan(0);
  });
});

describe("client/connection degraded の一括完了の畳み込み", () => {
  // Feature: sync-set-batch-complete, Property 7: degraded の一括は全メンバーを除去し処理済みに記録する
  //
  // 任意の ClientView・任意の空でない boiledGroup の結果について、各メンバーへ順に LocalComplete を畳んだ
  // 結果のビューは、(a) 全メンバーを timers から除去しており、(b) 全メンバーの id を processedIds に含む。
  // **Validates: Requirements 5.3, 5.4**
  it("Property 7: degraded の一括は全メンバーを除去し全メンバーの id を処理済みに記録する", () => {
    // 記録は origin を問わず一様である——decideLocalComplete は markProcessed を条件分岐しない
    // （decideLocalCancel が origin で分岐するのとは異なる）。要件5.4 は server-confirmed について記録を
    // 要求し、要件5.3 は Provisional_Timer について記録の有無を定めないため、一様な記録は要件に反しない。
    // provisional の記録は次の snapshot / Reconcile で reconcileServerConfirmed の刈り取りにより除かれる
    // （保持 id 集合に属さないため）。本機能はこの既存規律を変えない。
    //
    // 一様であることが検査の核心ゆえ、両 origin が現に踏まれたことを数える（Property 4〜6 と同じ作法）。
    // 片方の origin しか踏まないまま通れば「origin を問わず」を半分しか検査していない。混在群（同一の群に
    // 両 origin が同居する盤面）も別に数える——経路が分かれるメンバーが一つのビューへ畳まれる形が、
    // 一様な記録の検査として最も強い。
    let serverRuns = 0;
    let localRuns = 0;
    let mixedRuns = 0;

    fc.assert(
      // 対象が必ず boiled のケースを採る（群が構成的に非空になる。空でない群という前提を filter で捨てない）。
      fc.property(genBoiledCase, genRecordedAt, ({ view, timerId, correctedNow }, at) => {
        const group = boiledGroup(view, timerId, correctedNow);
        expect(group.length).toBeGreaterThan(0);

        const hasServer = group.some((member) => member.origin === "server");
        const hasLocal = group.some((member) => member.origin === "local");
        if (hasServer) serverRuns += 1;
        if (hasLocal) localRuns += 1;
        if (hasServer && hasLocal) mixedRuns += 1;

        const next = foldLocalComplete(view, group, at);

        const remainingIds = new Set(next.timers.map((timer) => timer.id));
        for (const member of group) {
          // (a) 全メンバーが timers から消える（要件5.3 / 5.4 の除去）。
          expect(remainingIds.has(member.id)).toBe(false);
          // (b) 全メンバーの id が処理済みに記録される（ローカル再発火の抑止・origin を問わず一様に）。
          expect(next.processedIds.has(member.id)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );

    expect(serverRuns).toBeGreaterThan(0);
    expect(localRuns).toBeGreaterThan(0);
    expect(mixedRuns).toBeGreaterThan(0);
  });
});
describe("client/connection 一括完了の残滓の記録", () => {
  // Feature: sync-set-batch-complete, Property 8: 残滓は反映順で最後のメンバーの麺種になる（ローカル畳み込み経路）
  //
  // 任意の ClientView・任意の空でない boiledGroup の結果・任意の記録時刻 at・任意の反映順（群の並びの任意の
  // 置換）について、その順に各メンバーへ LocalComplete{ now: at } を畳んだ結果の lastResults は、全メンバーの
  // 全 slotIds をキーとして含み、各エントリの at は与えた記録時刻に等しく、各スロットの noodleType は当該
  // スロットを駆動するメンバーのうちその反映順で最後に現れるメンバーの麺種に等しい（占有の有無に依らず
  // 記録される）。
  // **Validates: Requirements 8.1, 8.2, 8.4, 8.8**
  it("Property 8: 残滓は全メンバーの全スロットへ記録時刻とともに書かれ、麺種は反映順で最後のメンバーに従う", () => {
    // 適用範囲は degraded / provisional 経路（LocalComplete の畳み込み）に限る。live の server-confirmed 経路の
    // 残滓は reconcileServerConfirmed が snapshot 受信時に導き、反映順は二段（snapshot 間は到着順、同一 snapshot
    // 内は prevServer の走査順）で決まるため、この畳み込みでは表せない。占有スロットの扱いの非対称
    // （要件8.7 / 8.8）も経路ごとに異なり、live 側は example テストが担う。範囲を書かずに一般規則を主張すれば、
    // プロパティ自身が実装について嘘をつくことになる（design.md「冗長性の検討」）。
    //
    // 前提が空虚でないことを分岐計数で確かめる（Property 4〜7 と同じ作法）。三つの分岐がいずれも踏まれない
    // まま通れば、言明の核心（退化入力での競合規則・占有を見ない記録・既存残滓の上書き）が未検査になる。
    let degenerateRuns = 0; // 同一スロットを複数メンバーが駆動する退化入力（要件8.4 の競合規則の前提）
    let occupiedRuns = 0; // 畳み込み後も群外 Timer が当該スロットを駆動する盤面（要件8.8）
    let overwriteRuns = 0; // 既存残滓（stale-*・負の at）が上書きされる盤面
    let orderMattersRuns = 0; // 反映順を置換したことで勝者が変わる盤面（順序の引数化が効いている証拠）

    fc.assert(
      fc.property(genReflectionOrderCase, ({ view, group, reflected, at }) => {
        expect(group.length).toBeGreaterThan(0);

        // 「その反映順で最後に現れる、当該スロットを駆動するメンバー」を順序から独立に導く
        // （Map の上書き手順を写さず、要件8.4 の規則そのものの形で書く）。
        const lastDriverOf = (order: readonly ClientTimer[], slotId: string): ClientTimer | undefined =>
          order.reduce<ClientTimer | undefined>(
            (last, member) => (member.slotIds.includes(slotId) ? member : last),
            undefined,
          );

        const drivenSlots = group.flatMap((member) => [...member.slotIds]);
        const groupSlots = new Set(drivenSlots);
        if (groupSlots.size < drivenSlots.length) degenerateRuns += 1;
        if ([...groupSlots].some((slotId) => view.lastResults.has(slotId))) overwriteRuns += 1;
        if (
          [...groupSlots].some(
            (slotId) => lastDriverOf(reflected, slotId)?.noodleType !== lastDriverOf(group, slotId)?.noodleType,
          )
        ) {
          orderMattersRuns += 1;
        }

        // 反映順を畳み込み順として与える（押下時の並び group では「並びで最後が勝つ」しか検査できない）。
        const next = foldLocalComplete(view, reflected, at);

        // 占有は畳み込み後の残存 Timer で見る——メンバーは全て消えるため、残るのは群外 Timer だけである。
        const occupiedSlots = new Set(next.timers.flatMap((timer) => [...timer.slotIds]));
        if ([...groupSlots].some((slotId) => occupiedSlots.has(slotId))) occupiedRuns += 1;

        for (const slotId of groupSlots) {
          const entry = next.lastResults.get(slotId);
          // 全メンバーの全 slotIds がキーとして含まれる（要件8.1）。占有の有無で分岐しない（要件8.8）。
          expect(entry).toBeDefined();
          // 押下時刻を一度だけ採る帰結——同時に上げたスロットの残滓は同じ瞬間を刻む（提示時間窓がずれない）。
          expect(entry?.at).toBe(at);
          // 記録する値は反映順で最後に現れるメンバーの麺種（要件8.4）。同一スロットを一つのメンバーしか
          // 駆動しない通常入力では、この規則は「そのただ一つのメンバーの麺種」に退化する。
          expect(entry?.noodleType).toBe(lastDriverOf(reflected, slotId)?.noodleType);
        }
      }),
      { numRuns: 300 },
    );

    expect(degenerateRuns).toBeGreaterThan(0);
    expect(occupiedRuns).toBeGreaterThan(0);
    expect(overwriteRuns).toBeGreaterThan(0);
    expect(orderMattersRuns).toBeGreaterThan(0);
  });
});

describe("client/connection 一括完了と群外 Timer の不変", () => {
  // Feature: sync-set-batch-complete, Property 9: 一括完了は群に属さない Timer を変えない
  //
  // 任意の ClientView・timerId・correctedNow について、群への LocalComplete 畳み込みの後、boiledGroup に
  // 含まれない Timer（running であるもの、および実効 endTime が対象と異なる boiled であるもの）はすべて
  // timers に同一内容で残る。
  // **Validates: Requirements 3.2**
  it("Property 9: 畳み込みの後も群外 Timer は同一内容で timers に残る", () => {
    // 当初「running を除去しない（要件3.2）」と「非メンバーを変えない」を別に立てていたが、後者が前者を
    // 含むため一つに統合した（design.md「冗長性の検討」）。running であることも実効 endTime が対象と異なる
    // ことも、「群に属さない」の二つの現れ方にすぎない——群は実効 endTime の等値だけで立つのだから、
    // 除去されない理由は「等値でない」に一本化される。
    //
    // 一つに畳んだ言明は、片方の現れ方しか踏まないまま通れば半分しか検査していない。ゆえに双方を数える
    // （Property 4〜8 と同じ作法）。群が空のときは畳み込みが起きず「残る」が自明に成り立つため、群が
    // 非空である盤面だけを数える。
    let runningOutsiderRuns = 0; // (a) 群外の running が残った盤面
    let boiledOutsiderRuns = 0; // (b) 群外の boiled（実効 endTime が対象と異なる）が残った盤面

    fc.assert(
      // 一般ケースを採る（対象が boiled / running / 不在の三種すべてで言明が立つ）。
      fc.property(genBatchCase, genRecordedAt, ({ view, timerId, correctedNow }, at) => {
        const group = boiledGroup(view, timerId, correctedNow);
        const memberIds = new Set(group.map((member) => member.id));
        const outsiders = view.timers.filter((timer) => !memberIds.has(timer.id));

        // 畳み込み前の内容を写し取る——群外 Timer が破壊的に書き換えられた場合、畳み込み後の view.timers から
        // 期待値を引き直すと同じ変異したオブジェクトを見てしまい、比較が空虚になる。フィールドを列挙せず
        // spread で写すのは、芯（TimerFact）が育っても検査が自動追従するため（slotIds だけ配列を複製する）。
        const before = outsiders.map((timer) => ({ ...timer, slotIds: [...timer.slotIds] }));

        if (group.length > 0) {
          const targetEndTime = findTarget(view, timerId)?.endTime;
          if (outsiders.some((timer) => timer.endTime > correctedNow)) runningOutsiderRuns += 1;
          if (outsiders.some((timer) => timer.endTime <= correctedNow && timer.endTime !== targetEndTime)) {
            boiledOutsiderRuns += 1;
          }
        }

        const next = foldLocalComplete(view, group, at);

        outsiders.forEach((outsider, index) => {
          // 参照同一で残る（decideLocalComplete の filter は残す要素をそのまま通す）。オブジェクトを
          // 作り直さないことは内容不変よりも強い主張であり、群外へ手が伸びていないことの直接の証拠。
          expect(next.timers).toContain(outsider);
          // 内容も畳み込み前と同一（id だけでなく駆動スロット・麺種・硬さ・開始／終了時刻・起源まで）。
          expect(next.timers.find((timer) => timer.id === outsider.id)).toEqual(before[index]);
        });
      }),
      { numRuns: 200 },
    );

    expect(runningOutsiderRuns).toBeGreaterThan(0);
    expect(boiledOutsiderRuns).toBeGreaterThan(0);
  });
});
