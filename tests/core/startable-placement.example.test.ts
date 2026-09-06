// tests/core/startable-placement.example.test.ts — 観測事実 8 の再現（startable-placement design「Testing Strategy」）。
//
// Feature: startable-placement
// **Validates: Requirements 4.3（8 品の再現）**
//
// 6 釜・arms 2・toleranceRatio 10%・上げ間隔 45 秒・Thin normal 60 秒・slotSpan 1・卓なし 8 品。表示された先頭から
// 3 秒間隔で開始し、茹で上がりの 15 秒後から釜番号の大きい順に 3 秒間隔で Complete する。操作列は harness
// （`tests/core/operationScenes.ts`）が engine の実走で踏み、snapshot は一切手書きしない。
//
// **修正前（task 3 の前）の観測。** 最初の 6 品の開始は 0 / 3 / 6 / 9 / 42 / 45 秒（Boil_Sync が 0・3 秒開始の 2 本を
// 57 秒へ、6・9 秒開始の 2 本を 67.5 秒へ揃える。42・45 秒は上げ窓 [57, 102) が 4 本で埋まるため）。57 秒に釜 0・1 が
// 茹で上がり、72 秒（57 + 15）に釜 1 を Complete すると、釜 0 は茹で上がり済み・未完了、釜 1 は完了済み・空きで、
// 残り A（o6）は釜 0 に「今」（先頭群）、B（o7）は釜 1 に「今」（後続群）——**表示はどちらも出ない**。A は釜が占有
// 扱いで非表示、B は空き釜で開始可能だが A の群が未開始なので連鎖で非表示。75 秒に釜 0 を Complete すると再開する。
// 原因は観測事実 5（前回の釜の第一候補は解放時刻だけを見る）と 1（boiled の釜は解放 `now`）の組——A は釜 0 に留まる。

import { describe, expect, it } from "vitest";
import { EMPTY_STATE } from "../../src/engine/state";
import {
  arrive,
  at,
  every,
  gapsOf,
  kitchenOf,
  operate,
  order,
  planOf,
  startableGapOf,
  step,
  suggestionSummaryOf,
  timersOf,
  type Transition,
} from "./operationScenes";

/** 6 釜・arms 2・10%・上げ間隔 45 秒・Thin 60 秒。 */
const KITCHEN = kitchenOf({
  unitCount: 1,
  arms: 2,
  toleranceRatio: 10,
  liftIntervalSeconds: 45,
  presets: [{ noodleType: "Thin", boilSeconds: every(60) }],
});

/** 卓なし 8 品（到着は 1 秒刻み・o0 が最初）。A = o6・B = o7。 */
const ITEMS = Array.from({ length: 8 }, (_unused, index) =>
  order(`o${index}`, { noodleType: "Thin", tableId: null, arrivalTime: at(-10 + index) }),
);

/** 観測事実 8 の操作列——3 秒刻み・茹で上がりの 15 秒後から釜番号の大きい順に Complete・1 刻みに 1 本開始。 */
const trace = operate(KITCHEN, step(KITCHEN, EMPTY_STATE, arrive(ITEMS, at(0))), {
  tickSeconds: 3,
  completeDelaySeconds: 15,
  completeOrder: "descending",
  startsPerTick: 1,
  fromSeconds: 0,
  untilSeconds: 200,
});

function transitionsOf(prefix: string): readonly Transition[] {
  return trace.filter((transition) => transition.operation.startsWith(prefix));
}

/** 時刻 atSeconds に踏んだ操作の遷移（同じ釜の Complete は周回で繰り返すので時刻で指す）。 */
function transitionAt(atSeconds: number, operation: string): Transition {
  const matches = trace.filter(
    (transition) => transition.at === atSeconds && transition.operation === operation,
  );
  expect(matches, `${atSeconds} 秒 ${operation}`).toHaveLength(1);
  return matches[0]!;
}

describe("Feature: startable-placement — 観測事実 8（卓なし 8 品・降順 Complete）の再現", () => {
  it("最初の 6 品の開始は 0 / 3 / 6 / 9 / 42 / 45 秒——上げ窓が 4 本で埋まり、5・6 本目は次の窓へ", () => {
    expect(
      transitionsOf("start ").map((transition) => [transition.operation, transition.at]),
    ).toEqual([
      ["start o0#0 on 0", 0],
      ["start o1#0 on 1", 3],
      ["start o2#0 on 2", 6],
      ["start o3#0 on 3", 9],
      ["start o4#0 on 4", 42],
      ["start o5#0 on 5", 45],
      // 残り 2 品（A・B）は釜 0・1 の Complete の後に始まる（時刻は下の検査が固定する）。
      ...transitionsOf("start o6#0").map((transition) => [transition.operation, transition.at]),
      ...transitionsOf("start o7#0").map((transition) => [transition.operation, transition.at]),
    ]);
    // Boil_Sync が 0・3 秒開始の 2 本を 57 秒へ、6・9 秒開始の 2 本を 67.5 秒へ揃える。
    expect(transitionsOf("fire ").map((transition) => transition.at)).toEqual([
      57, 67.5, 103.5, 136.5,
    ]);
  });

  it("72 秒の釜 1 の Complete の直後：釜 0 は茹で上がり済み・未完了、釜 1 は空き、残り A・B は両方「今」（72 秒）", () => {
    const after = transitionAt(72, "complete slot 1");
    // 釜 1 の Timer は消え、釜 0 は 57 秒に上がった boiled のまま。釜 2・3 は 67.5 秒に上がった boiled、4・5 は走行中。
    expect(timersOf(after.step.snapshot).map((timer) => [timer.slots[0], timer.endAt])).toEqual([
      [0, 57],
      [2, 67.5],
      [3, 67.5],
      [4, 103.5],
      [5, 103.5],
    ]);
    // 残りは A（o6）と B（o7）で、どちらも開始推奨時刻が来ている（72 秒＝now）。
    expect(planOf(after.step.snapshot).map(([name, , startAt]) => [name, startAt])).toEqual([
      ["o6#0", 72],
      ["o7#0", 72],
    ]);
  });

  // task 3（2 段の計画・pinNow）が `.fails` を外す。修正前は A が boiled の釜 0 に留まり、B は空き釜 1 に置かれる
  // が A の群が未開始ゆえ連鎖で隠れ、提案はどちらも出ない（harness の空白 `startableGapOf` が 72 秒に 1 件立つ）。
  it.fails("【task 3 で緑になる】72 秒の釜 1 の Complete の直後、開始できる先頭の提案が出る——A が釜 1 に「今」で先頭", () => {
    const after = transitionAt(72, "complete slot 1");
    expect(startableGapOf(KITCHEN, after.step)).toBeNull();
    expect(suggestionSummaryOf(KITCHEN, after.step.snapshot, after.step.now)).toEqual([
      [1, ["o6#0 now"]],
    ]);
    expect(planOf(after.step.snapshot)).toContainEqual(["o6#0", ["1"], 72, null]);
  });

  it("75 秒の釜 0 の Complete で再開する——直後に押せる先頭が出て、8 品は最後まで処理される（harness の検証）", () => {
    const after = transitionAt(75, "complete slot 0");
    expect(startableGapOf(KITCHEN, after.step)).toBeNull();
    const shown = suggestionSummaryOf(KITCHEN, after.step.snapshot, after.step.now);
    expect(shown.flatMap(([, list]) => list).some((phrase) => phrase.endsWith(" now"))).toBe(true);
    // A・B は 75 秒以降に始まり、最後の遷移では待ち行列も Timer も残らない。
    const startedA = transitionsOf("start o6#0");
    const startedB = transitionsOf("start o7#0");
    expect(startedA).toHaveLength(1);
    expect(startedB).toHaveLength(1);
    expect(startedA[0]!.at).toBeGreaterThanOrEqual(72);
    expect(startedB[0]!.at).toBeGreaterThan(startedA[0]!.at);
    const last = trace[trace.length - 1]!;
    expect(last.step.state.pendingOrders).toHaveLength(0);
    expect(last.step.state.timers).toHaveLength(0);
    // 開始はすべて提案の釜——Timer の無い釜——で行われた（開始の直前の snapshot でその釜に Timer が無い）。
    for (const [index, transition] of trace.entries()) {
      if (!transition.operation.startsWith("start ")) continue;
      const before = trace[index - 1]?.step.snapshot;
      const slot = Number(transition.operation.split(" on ")[1]);
      expect(
        before === undefined ||
          before.timers.every((timer) => !timer.slotIds.map(Number).includes(slot)),
        transition.operation,
      ).toBe(true);
    }
  });

  it("【修正前の観測・task 3 が 0 箇所へ置き換える】空白は 72 秒の 1 箇所——A（釜 0・boiled）が先頭で、今割り当てられる釜 1 が在るのに提案が無い", () => {
    // 修正前の状態をそのまま固定する：A は釜 0（boiled・解放 `now`）に「今」、B は釜 1（空き）に「今」、提案は空。
    const after = transitionAt(72, "complete slot 1");
    expect(planOf(after.step.snapshot)).toEqual([
      ["o6#0", ["0"], 72, null],
      ["o7#0", ["1"], 72, null],
    ]);
    expect(suggestionSummaryOf(KITCHEN, after.step.snapshot, after.step.now)).toEqual([]);
    expect(after.gap).toEqual({
      at: 72,
      head: "o6#0",
      placedOn: [0],
      startable: [1],
      occupied: [0, 2, 3, 4, 5],
      groups: [["o6#0"], ["o7#0"]],
    });
    // 他の遷移に空白は無い——45 秒〜67.5 秒（全釜が Timer で埋まる間）は空き釜不足の例外であって空白ではない。
    expect(gapsOf(trace)).toEqual([after.gap]);
  });
});
