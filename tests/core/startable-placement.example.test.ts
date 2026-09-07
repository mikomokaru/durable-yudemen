// tests/core/startable-placement.example.test.ts — 観測事実 8 の再現とレビュー反例（startable-placement design「Testing Strategy」）。
//
// Feature: startable-placement
// **Validates: Requirements 1.1〜1.8, 2.1, 3.1, 3.2, 4.1〜4.4, 4.7**
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
//
// **修正後（task 3・2 段の計画）。** 1 段目は同じ計画を組み、配分（`pinNow`）が「今」の品目を表示の順（A・B）に見て、
// 今割り当てられる釜 1 を A に配り、B は待つ釜 0 へ退避する。72 秒の直後に A が釜 1 に「今」で先頭に出て、空白は 0 箇所。

import { describe, expect, it } from "vitest";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { boilMillisOf } from "../../src/engine/boil";
import { committedSchedule } from "../../src/engine/commit";
import { recommend } from "../../src/engine/recommend";
import { initialLifts } from "../../src/engine/lift";
import { tableMembers } from "../../src/engine/project";
import {
  baselineSchedule,
  initialRelease,
  scheduleStages,
  type AcceptedSlice,
  type CookSchedule,
} from "../../src/engine/schedule";
import type { SettleParams } from "../../src/engine/settle";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { itemKeyOf, type OrderItem } from "../../src/domain/order";
import { headsOf, liftGroupsOf, visibleGroupsOf, type LiftItem } from "../../src/domain/lift-group";
import { DEFAULT_NOODLE_PRESETS, occupiedSlotsOf, type NoodlePreset } from "../../src/domain/store";
import { physicalViolationsOf, sceneFrom, totalOf } from "./restoreScenes";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";
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
  type OperationPolicy,
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
      // 残り 2 品（A・B）は釜 1・0 の Complete の後に始まる（時刻は下の検査が固定する）。
      ...transitionsOf("start o6#0").map((transition) => [transition.operation, transition.at]),
      ...transitionsOf("start o7#0").map((transition) => [transition.operation, transition.at]),
    ]);
    // Boil_Sync が 0・3 秒開始の 2 本を 57 秒へ、6・9 秒開始の 2 本を 67.5 秒へ揃える。A（72 秒開始）と B（75 秒開始）は
    // 133.5 秒へ揃う（修正前は A が 75 秒・B が 78 秒に始まり 136.5 秒だった）。
    expect(transitionsOf("fire ").map((transition) => transition.at)).toEqual([
      57, 67.5, 103.5, 133.5,
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

  it("72 秒の釜 1 の Complete の直後、開始できる先頭の提案が出る——A が釜 1 に「今」で先頭（AC 3.1・性質 4.3）", () => {
    const after = transitionAt(72, "complete slot 1");
    expect(startableGapOf(KITCHEN, after.step)).toBeNull();
    expect(suggestionSummaryOf(KITCHEN, after.step.snapshot, after.step.now)).toEqual([
      [1, ["o6#0 now"]],
    ]);
    expect(planOf(after.step.snapshot)).toContainEqual(["o6#0", ["1"], 72, null]);
  });

  it("A は今割り当てられる釜 1 へ、B は待つ釜 0 へ退避し、空白は 0 箇所（AC 1.1・1.4・性質 4.2）", () => {
    // 1 段目は A を釜 0（boiled・解放 `now`）・B を釜 1（空き）に「今」で置く。配分は表示の順（A・B）に今割り当てられる
    // 釜 1 を A に配り、B は残った待つ釜（boiled の釜 0）へ退避する（固定配置どうしの釜は重ならない）。
    const after = transitionAt(72, "complete slot 1");
    expect(planOf(after.step.snapshot)).toEqual([
      ["o6#0", ["1"], 72, null],
      ["o7#0", ["0"], 72, null],
    ]);
    expect(after.gap).toBeNull();
    // 他の遷移にも空白は無い——45 秒〜67.5 秒（全釜が Timer で埋まる間）は空き釜不足の例外であって空白ではない。
    expect(gapsOf(trace)).toEqual([]);
  });

  it("A は 72 秒に釜 1 で始まり、75 秒の釜 0 の Complete で B が続く——8 品は最後まで処理される（harness の検証）", () => {
    expect(transitionAt(72, "start o6#0 on 1").at).toBe(72);
    const after = transitionAt(75, "complete slot 0");
    expect(startableGapOf(KITCHEN, after.step)).toBeNull();
    expect(suggestionSummaryOf(KITCHEN, after.step.snapshot, after.step.now)).toEqual([
      [0, ["o7#0 now"]],
    ]);
    const startedB = transitionsOf("start o7#0");
    expect(startedB).toHaveLength(1);
    expect(startedB[0]!.at).toBe(75);
    const last = trace[trace.length - 1]!;
    // 品目は開始で消費されない（order-lifecycle）——全品目が done（completedAt 付き）で走行中が無いことが「最後まで処理された」。
    expect(last.step.state.orderItems.every((item) => item.completedAt !== null)).toBe(true);
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
});

// ── レビュー反例（design「Testing Strategy」）────────────────────────────────────────────────

const NOW = at(0);
const SECOND = 1000;

/** 茹で時間 600 秒（Long）と 60 秒（Thin）の 2 種（plan.example と同じ）。 */
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Long", boilSeconds: every(600) },
  { noodleType: "Thin", boilSeconds: every(60) },
];

/** 1 ユニット（6 釜）・重み・許容幅・arms 2・上げ間隔 45 秒は既定。 */
const PARAMS: SettleParams = { noodlePresets: PRESETS, ...schedulingDefaults(1) };

/** 釜 slot に載る Timer。endSeconds ≤ 0 なら boiled（茹で上がり済み・Complete 待ち）、正なら走行中。 */
function timerOn(slot: number, endSeconds: number): Timer {
  return createTimer({
    id: `t-${slot}` as TimerId,
    slotIds: nonEmpty([String(slot) as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: "normal",
    startTime: at(endSeconds - 60),
    endTime: at(endSeconds),
    seq: slot,
    boiledAt: endSeconds <= 0 ? at(endSeconds) : null,
  });
}

/** 自前解（NOW の解放表・成員表・上げ表・占有から）。 */
function ownPlan(pending: readonly OrderItem[], running: readonly Timer[]) {
  return baselineSchedule(
    pending,
    initialRelease(running, NOW, 6),
    tableMembers(running),
    initialLifts(running),
    PRESETS,
    PARAMS,
    NOW,
    occupiedSlotsOf(running),
    null,
  );
}

/** 計画を「名 → [釜, 開始秒]」に写す。 */
function placementsOf(schedule: {
  readonly slices: readonly {
    readonly placements: readonly {
      externalOrderId: string;
      slotIds: readonly string[];
      startAt: number;
    }[];
  }[];
}) {
  return new Map(
    schedule.slices
      .flatMap((slice) => slice.placements)
      .map((placement) => [
        placement.externalOrderId,
        [placement.slotIds.map(Number), (placement.startAt - NOW) / SECOND] as const,
      ]),
  );
}

describe("Feature: startable-placement — レビュー反例", () => {
  it("(i) 配分は表示の順——卓 X（−3 秒 Thin・−1 秒 Long）と卓 Y（−2 秒 Long）で、空き釜は最終的な表示順で先の品目に渡る（AC 1.5・1.8 改訂）", () => {
    // 釜 0 だけ空き、釜 1・2 は boiled（解放 `now`・Timer あり）、釜 3〜5 は遠い未来まで走行中。
    const running = [
      timerOn(1, -20),
      timerOn(2, -20),
      timerOn(3, 3000),
      timerOn(4, 3000),
      timerOn(5, 3000),
    ];
    const x1 = order("x-thin", { noodleType: "Thin", tableId: "X", arrivalTime: at(-3) });
    const x2 = order("x-long", { noodleType: "Long", tableId: "X", arrivalTime: at(-1) });
    const y = order("y-long", { noodleType: "Long", tableId: "Y", arrivalTime: at(-2) });
    // 1 段目：計画の一片の順は X（最早到着 −3 秒）→ Y。X は Long を釜 0 に今・Thin を釜 1 に 540 秒後で揃え、Y の Long は
    // 釜 2 に今。「今」の表示順は y（−2 秒）→ x-long（−1 秒）——計画順と逆なので、1 回目の配分は空き釜 0 を y に渡し、
    // x-long は待つ釜 1 へ。すると X の一片は Thin（釜 1・540 秒）が x-long と重なって不正になり、x-long を残して再生成される
    // ——Thin は残った釜（boiled の釜 2）に今（60 秒）で置かれ、新たに「今」になる（design Component 3′ の反例と同じ形）。
    // 2 回目の配分は「今」の全体を最終的な表示順 x-thin（−3 秒）→ y（−2 秒）→ x-long（−1 秒）で配り直し、空き釜 0 は
    // x-thin に渡る。y と x-long は待つ釜へ（いまの釜 → index 順）。
    const plan = placementsOf(ownPlan([x1, x2, y], running));
    expect(plan.get("x-thin")).toEqual([[0], 0]);
    expect(plan.get("y-long")).toEqual([[1], 0]);
    expect(plan.get("x-long")).toEqual([[2], 0]);
  });

  it("(ii) 採用済み接頭辞の予約——Timer の無い釜 1 を採用済み B が 30〜90 秒に予約していれば、A は boiled の釜 0 で待つ（性質 4.1 の除外・AC 3.2）", () => {
    // 釜 0 は boiled、釜 1 は空き、釜 2〜5 は遠い未来まで走行中。B（卓 b・Thin）は採用済み一片が釜 1 に 30〜90 秒で置く。
    const running = [timerOn(0, -20), ...[2, 3, 4, 5].map((slot) => timerOn(slot, 3000))];
    const b = order("b", { noodleType: "Thin", tableId: "b", arrivalTime: at(-5) });
    const a = order("a", { noodleType: "Thin", tableId: null, arrivalTime: at(-1) });
    const accepted: AcceptedSlice = {
      tableKey: "b",
      placements: [
        {
          externalOrderId: "b",
          itemIndex: 0,
          slotIds: nonEmpty(["1" as SlotId]),
          startAt: at(30),
          serveAt: at(90),
          anchor: null,
        },
      ],
    };
    const committed = committedSchedule([accepted], [b, a], running, NOW, PRESETS, PARAMS, null);
    const plan = placementsOf(committed);
    // B は接頭辞として残る（陳腐化せず・開始時刻はまだ先）。A の 1 段目は釜 0 に「今」——釜 1 は 90 秒まで空かない
    // （予約を反映した解放表）ので今割り当てられる釜ではなく、配分は A を動かさない。
    expect(plan.get("b")).toEqual([[1], 30]);
    expect(plan.get("a")).toEqual([[0], 0]);

    // harness の空白の述語も同じ判断——先頭 A の釜は Timer で押せないが、予約されていない Timer の無い釜が無いので
    // 空き釜不足の例外（空白と数えない）。
    const kitchen = kitchenOf({
      unitCount: 1,
      arms: PARAMS.arms,
      toleranceRatio: PARAMS.toleranceRatio,
      presets: nonEmpty([...PRESETS]),
    });
    const state: TimerState = {
      ...EMPTY_STATE,
      timers: running,
      nextSeq: 10,
      orderItems: [b],
      acceptedSlices: [accepted],
    };
    const arrived = step(kitchen, state, arrive([a], NOW));
    expect(planOf(arrived.snapshot)).toEqual([
      ["b#0", ["1"], 30, null],
      ["a#0", ["0"], 0, null],
    ]);
    expect(suggestionSummaryOf(kitchen, arrived.snapshot, NOW)).toEqual([]);
    expect(startableGapOf(kitchen, arrived)).toBeNull();
  });

  it("(iii) 「今」の集合は不変——A・B の再配分で釜 0 が早く空いても、1 段目で 60 秒後だった C は「今」にならない（AC 1.8・性質 4.7）", () => {
    // 釜 5 だけ空き、釜 0・1 は boiled、釜 2〜4 は走行中。卓 X の A・B（Thin）は釜 0・1 に「今」、卓なし D（Thin）は
    // 釜 5 に「今」、卓 Y の C（Long）は A の釜 0 が空く 60 秒後——1 段目の「今」は {A, B, D}。
    const running = [
      timerOn(0, -20),
      timerOn(1, -20),
      timerOn(2, 3000),
      timerOn(3, 3000),
      timerOn(4, 3000),
    ];
    const a = order("a", { noodleType: "Thin", tableId: "X", arrivalTime: at(-4) });
    const b = order("b", { noodleType: "Thin", tableId: "X", arrivalTime: at(-4) });
    const d = order("d", { noodleType: "Thin", tableId: null, arrivalTime: at(-3) });
    const c = order("c", { noodleType: "Long", tableId: "Y", arrivalTime: at(-2) });
    const plan = placementsOf(ownPlan([a, b, d, c], running));
    // 配分：表示の順は A・B・D。A が今割り当てられる釜 5 を取り、B は 1 段目の釜 1（待つ釜）を保ち、D は残った待つ釜 0 へ退避。
    expect(plan.get("a")).toEqual([[5], 0]);
    expect(plan.get("b")).toEqual([[1], 0]);
    expect(plan.get("d")).toEqual([[0], 0]);
    // 2 段目で釜 0 は D の 60 秒後に空く。C の下限は 1 段目の 60 秒——釜の組の選択が変わっても前倒ししない。
    expect(plan.get("c")![1]).toBe(60);
  });
});

describe("Feature: startable-placement — 2 段目の固定配置の扱い（design Component 3 のレビュー反例）", () => {
  it("固定配置は卓の成員表（走行中の錨）に足さない——同卓の Long を今・Thin を後に置く卓で、再生成した Thin に錨は付かない", () => {
    // 走行中の仲間は無い（釜 0 の boiled は卓なし）。1 段目は Long を釜 0（boiled）に「今」、Thin を釜 1 に 540 秒後で揃える。
    // 配分が Long を空き釜 1 へ動かすと Thin（釜 1）は重なって不正になり、Long を残して Thin が再生成される。固定した Long を
    // 成員表に足せば Thin が実在しない Timer に合流して `anchor: 600` を運ぶ——`keepsAnchor` (a) が現実の Timer に対して
    // 失敗する。再生成した Thin は残った釜 0（boiled・解放 `now`）に「今」で置かれ（design Component 3′ の反例と同じ形）、
    // 配り直しでも空き釜は表示で先の Long が保つ（AC 1.7）ので、Thin は待つ釜 0 に残る。
    const running = [timerOn(0, -20), ...[2, 3, 4, 5].map((slot) => timerOn(slot, 3000))];
    const long = order("long", { noodleType: "Long", tableId: "T", arrivalTime: at(-2) });
    const thin = order("thin", { noodleType: "Thin", tableId: "T", arrivalTime: at(-1) });
    const schedule = ownPlan([long, thin], running);
    const placements = new Map(
      schedule.slices
        .flatMap((slice) => slice.placements)
        .map((each) => [each.externalOrderId, each]),
    );
    expect(placementsOf(schedule).get("long")).toEqual([[1], 0]);
    expect(placementsOf(schedule).get("thin")).toEqual([[0], 0]);
    expect(placements.get("long")!.anchor).toBeNull();
    expect(placements.get("thin")!.anchor).toBeNull();
  });

  it("合流の下限は置いた後に当てる——錨 60 秒・上げ窓で 105 秒へ延期された Thin の合流（開始 45 秒）は 2 段目でも残る", () => {
    // 走行中 3 本が 60 秒に上がる（釜 0 が卓 T の仲間、釜 1・2 は卓なし）。arms 1・L 45 の窓 [60, 105) は 3 本で上限。
    // 卓 T の Thin は錨 60 秒に届く（earliest 60）が窓が満ちているので 105 秒へ延期され、開始は 45 秒（合法な窓延期の合流）。
    // 卓なし N（Long・600 秒に上がるので窓に触れない）は釜 3（boiled）に「今」——配分が N を空き釜 4 へ動かして 2 段目を
    // 組む。Thin の判定を `notBefore ≤ 錨 − boil`（45 ≤ 0）で行えば合流が落ちるが、置いた後の配置時刻に下限（105）を
    // 当てる形では合流のまま残る。
    const params: SettleParams = { ...PARAMS, arms: 1, liftIntervalSeconds: 45 };
    const running = [
      createTimer({
        id: "mate" as TimerId,
        slotIds: nonEmpty(["0" as SlotId]),
        noodleType: "Thin" as NoodleType,
        firmness: "normal",
        startTime: NOW,
        endTime: at(60),
        seq: 0,
        orderItem: { externalOrderId: "run-mate", itemIndex: 0, tableId: "T" },
      }),
      timerOn(1, 60),
      timerOn(2, 60),
      timerOn(3, -20),
      timerOn(5, 3000),
    ];
    const n = order("n", { noodleType: "Long", tableId: null, arrivalTime: at(-5) });
    const thin = order("thin", { noodleType: "Thin", tableId: "T", arrivalTime: at(-1) });
    const schedule = baselineSchedule(
      [n, thin],
      initialRelease(running, NOW, 6),
      tableMembers(running),
      initialLifts(running),
      PRESETS,
      params,
      NOW,
      occupiedSlotsOf(running),
      null,
    );
    const placements = new Map(
      schedule.slices
        .flatMap((slice) => slice.placements)
        .map((each) => [each.externalOrderId, each]),
    );
    expect(placementsOf(schedule).get("n")).toEqual([[4], 0]);
    expect(placementsOf(schedule).get("thin")).toEqual([[3], 45]);
    expect((placements.get("thin")!.serveAt - NOW) / SECOND).toBe(105);
    expect((placements.get("thin")!.anchor! - NOW) / SECOND).toBe(60);
  });
});

// ── レビュー反例：同卓の先着 Short・後着 Long（design Component 3′・性質 4.7 改訂）────────────────────────────

describe("Feature: startable-placement — 「今」の集合全体を最終的な表示順で配り直す（design Component 3′ の反例）", () => {
  it("同卓の先着 Short 60 秒・後着 Long 600 秒・釜 0 boiled・釜 1 だけ空き：Short が釜 1 に「今」で先頭に出る（4.7′）", () => {
    // 釜 0 は boiled（解放 `now`・Timer あり）、釜 1 は空き、釜 2〜5 は 1000 秒後まで走行中。
    const running = [timerOn(0, -20), ...[2, 3, 4, 5].map((slot) => timerOn(slot, 1000))];
    const short = order("short", { noodleType: "Thin", tableId: "T", arrivalTime: at(-2) });
    const long = order("long", { noodleType: "Long", tableId: "T", arrivalTime: at(-1) });
    // 1 段目は卓を Long の 600 秒に揃える——Long を釜 0 に今、Short を釜 1 に 540 秒後。「今」は Long だけ。
    // 1 回目の配分は Long を空き釜 1 へ動かし、Short（釜 1・540 秒）は重なって不正になるので Long を残して再生成される
    // ——Short は残った釜 0（boiled・解放 `now`）に今（60 秒）で置かれ、新たに「今」になる。loop で発見した順に固定すれば
    // Long が釜 1・Short が釜 0（押せない）で `headsOf` は空。2 回目の配分は {Short, Long} 全体を最終的な表示順（Short が
    // 先着）で配り直すので、Short が空き釜 1、Long は待つ釜 0 に落ち着く。
    const schedule = ownPlan([short, long], running);
    expect(placementsOf(schedule).get("short")).toEqual([[1], 0]);
    expect(placementsOf(schedule).get("long")).toEqual([[0], 0]);
    // 表示：推奨 → 群 → 連鎖 → 全釜 idle → 先頭 arms 本。Short は Timer の無い釜 1 に在り、先頭として現れる。
    const orderByKey = new Map([short, long].map((each) => [itemKeyOf(each), each]));
    const items: LiftItem[] = recommend(schedule).map((recommendation) => {
      const each = orderByKey.get(itemKeyOf(recommendation))!;
      return { recommendation, order: each, boilSeconds: boilMillisOf(each, PRESETS)! / 1000 };
    });
    const occupied = occupiedSlotsOf(running);
    const heads = headsOf(visibleGroupsOf(liftGroupsOf(items, NOW)), occupied, NOW, PARAMS.arms);
    expect(heads).toEqual([itemKeyOf(short)]);
  });
});

// ── 24 品の連続処理（性質 4.2・4.4）─────────────────────────────────────────────────────────

/** 24 品の卓の付け方——卓なし／同卓／4 品ごとの卓。 */
const TABLES = {
  none: () => null,
  same: () => "t",
  quads: (index: number) => `t${Math.floor(index / 4)}`,
} as const;

function itemsOf(tables: keyof typeof TABLES, slotSpan: number): readonly OrderItem[] {
  return Array.from({ length: 24 }, (_unused, index) =>
    order(`o${index}`, {
      noodleType: "Thin",
      tableId: TABLES[tables](index),
      arrivalTime: at(-30 + index),
      slotSpan,
    }),
  );
}

function runOf(
  tables: keyof typeof TABLES,
  slotSpan: number,
  options: Partial<OperationPolicy>,
): readonly Transition[] {
  return operate(KITCHEN, step(KITCHEN, EMPTY_STATE, arrive(itemsOf(tables, slotSpan), at(0))), {
    tickSeconds: 3,
    completeDelaySeconds: 15,
    completeOrder: "descending",
    startsPerTick: 1,
    fromSeconds: 0,
    untilSeconds: 3000,
    ...options,
  });
}

describe("Feature: startable-placement — 24 品の連続処理で、例外に当たらない空白は 0 箇所（性質 4.2・4.4）", () => {
  const variants: (readonly [string, keyof typeof TABLES, number, Partial<OperationPolicy>])[] = [];
  for (const tables of ["none", "same", "quads"] as const) {
    for (const slotSpan of [1, 2]) {
      for (const completeOrder of ["ascending", "descending"] as const) {
        for (const forgetShownPlan of [false, true]) {
          for (const adoptCommitted of [false, true]) {
            variants.push([
              `${tables}・slotSpan ${slotSpan}・${completeOrder}・Shown_Plan ${forgetShownPlan ? "なし" : "あり"}・接頭辞 ${adoptCommitted ? "あり" : "なし"}`,
              tables,
              slotSpan,
              { completeOrder, forgetShownPlan, adoptCommitted },
            ]);
          }
        }
      }
    }
  }
  for (const [label, tables, slotSpan, options] of variants) {
    it(`${label}：二周目以降まで空白 0・24 品は最後まで処理される`, () => {
      const run = runOf(tables, slotSpan, options);
      expect(gapsOf(run)).toEqual([]);
      const last = run[run.length - 1]!;
      // 品目は開始で消費されない（order-lifecycle）——全品目が done（completedAt 付き）で走行中が無いことが「最後まで処理された」。
      expect(last.step.state.orderItems.every((item) => item.completedAt !== null)).toBe(true);
      expect(last.step.state.timers).toHaveLength(0);
      // 釜の再利用が二周目以降まで進んでいる（釜ごとに 24 / 6 ≧ 2 回以上の開始）。
      const starts = run.filter((transition) => transition.operation.startsWith("start "));
      expect(starts).toHaveLength(24);
    });
  }
});

// ── レビュー反例：「今」の入れ替えは費用改善の判断（判断 14・性質 4.7′）─────────────────────────────────

describe("Feature: startable-placement — 固定した「今」を残した再生成が成り立たない場面は、候補 K と再生成を総費用で比べる（判断 14）", () => {
  // 6 釜・釜 0 だけ boiled・arms 1・上げ間隔 5 秒（上限 arms + HELPER_ARMS = 3 本）。卓 T は 45 秒麺 N（Thin extraHard）と
  // 75 秒麺 A（Medium extraHard）、別注文（卓なし）は 45 秒麺 C と大盛 45 秒麺 M（slotSpan 2）。
  // 1 段目：T は A を釜 0（boiled・解放 now）に今・N を釜 1 に 30 秒後で 75 秒に揃え、C は釜 2 に今、M は釜 3+5 に今
  // （45 秒の窓は C + M = 3 本で上限）。配分は A を空き釜 1 へ動かす（釜 0 は Timer で押せない）——N（釜 1・30 秒）と重なって
  // T が不正になり、A を残した再生成は N を今（45 秒）へ繰り上げる。すると 45 秒の窓は N + C + M = 4 本で上限を超え、固定した
  // M の一片が成り立たない。ここが判断 14 の場面——候補 K（1 段目の時刻を保ち釜だけ交換：A が釜 1・N は A が空けた釜 0 に
  // 30 秒後・C と M は今）と、固定を外した再生成（N を今へ繰り上げ、M は上げ窓の競合で 5 秒後へ）を同じ総費用で比べる。
  const kitchenParams = (weights: Partial<SettleParams>): SettleParams => ({
    noodlePresets: DEFAULT_NOODLE_PRESETS,
    ...schedulingDefaults(1),
    arms: 1,
    liftIntervalSeconds: 5,
    ...weights,
  });
  const boiled: Timer = createTimer({
    id: "boiled-0" as TimerId,
    slotIds: nonEmpty(["0" as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: "normal",
    startTime: at(-80),
    endTime: at(-20),
    seq: 0,
    boiledAt: at(-20),
  });
  const n = order("t", {
    noodleType: "Thin",
    firmness: "extraHard",
    tableId: "T",
    arrivalTime: at(-600),
  });
  const a = order("t", {
    noodleType: "Medium",
    firmness: "extraHard",
    tableId: "T",
    arrivalTime: at(-600),
    itemIndex: 1,
  });
  const c = order("o", {
    noodleType: "Thin",
    firmness: "extraHard",
    tableId: null,
    arrivalTime: at(-1),
  });
  const m = order("o", {
    noodleType: "Thin",
    firmness: "extraHard",
    tableId: null,
    arrivalTime: at(-1),
    itemIndex: 1,
    slotSpan: 2,
  });
  const pending = [n, a, c, m];
  const running = [boiled];

  /** 生成候補 F の経過（1 段目・候補 K・再生成・完成形）と、同じ場面（前回なし）に対する総費用。 */
  function stagesOf(params: SettleParams) {
    const scene = sceneFrom(pending, running, 6, params, NOW);
    const { fresh } = scheduleStages(
      pending,
      scene.release,
      scene.members,
      scene.lifts,
      DEFAULT_NOODLE_PRESETS,
      params,
      NOW,
      scene.occupied,
      null,
    );
    return { scene, ...fresh, totalOf: (plan: CookSchedule) => totalOf(scene, plan, null) };
  }

  /** 計画を「品目 → [釜, 開始秒]」に（`placementsOf` は externalOrderId だけで引くので、同じ注文の 2 品目を区別する）。 */
  function timesOf(plan: CookSchedule) {
    return new Map(
      plan.slices
        .flatMap((slice) => slice.placements)
        .map((placement) => [
          `${placement.externalOrderId}#${placement.itemIndex}`,
          [placement.slotIds.map(Number), (placement.startAt - NOW) / SECOND] as const,
        ]),
    );
  }

  const STAGE1 = [
    ["t#0", [[1], 30]],
    ["t#1", [[0], 0]],
    ["o#0", [[2], 0]],
    ["o#1", [[3, 5], 0]],
  ] as const;
  /** 候補 K：A が空き釜 1・N は A が空けた釜 0 に 30 秒後（時刻は 1 段目のまま）・C と M は今。 */
  const SWAP = [
    ["t#0", [[0], 30]],
    ["t#1", [[1], 0]],
    ["o#0", [[2], 0]],
    ["o#1", [[3, 5], 0]],
  ] as const;
  /** 再生成：N を今へ繰り上げ（A と揃えない・判断 15）、M は 45 秒の窓の競合で 5 秒後へ。 */
  const REGENERATED = [
    ["t#1", [[2], 0]],
    ["t#0", [[1], 0]],
    ["o#0", [[3], 0]],
    ["o#1", [[4, 5], 5]],
  ] as const;

  it("両候補は合法——K は 1 段目の時刻のまま釜だけ交換し、再生成は同卓の麺を今へ繰り上げて大盛を 5 秒後へ", () => {
    const { scene, stage1, swap, regenerated } = stagesOf(kitchenParams({}));
    expect([...timesOf(stage1)]).toEqual(STAGE1);
    expect(swap).not.toBeNull();
    expect([...timesOf(swap!)]).toEqual(SWAP);
    expect([...timesOf(regenerated)]).toEqual(REGENERATED);
    expect(physicalViolationsOf(scene, swap!)).toEqual([]);
    expect(physicalViolationsOf(scene, regenerated)).toEqual([]);
  });

  it("業務費用が待ち時間だけ（同期の重み 0）なら再生成が 30 秒相当低く、費用ゆえに再生成が選ばれる（K 1457・再生成 1427）", () => {
    const { swap, regenerated, completed, totalOf } = stagesOf(
      kitchenParams({ orderSyncWeight: 0, tableSyncWeight: 0, affinityWeight: 0 }),
    );
    expect(totalOf(swap!)).toBe(1457);
    expect(totalOf(regenerated)).toBe(1427);
    expect(totalOf(regenerated)).toBeLessThan(totalOf(swap!));
    expect(completed).toEqual(regenerated);
    expect([...timesOf(completed)]).toEqual(REGENERATED);
  });

  it("既定の重み（卓同期 2）では A と N を 30 秒ずらす再生成の方が 30 秒相当高く、費用ゆえに K が選ばれる——N は 30 秒後のまま・M は今（K 1457・再生成 1487）", () => {
    const { swap, regenerated, completed, totalOf } = stagesOf(kitchenParams({}));
    expect(totalOf(swap!)).toBe(1457);
    expect(totalOf(regenerated)).toBe(1487);
    expect(totalOf(swap!)).toBeLessThan(totalOf(regenerated));
    expect(completed).toEqual(swap);
    expect([...timesOf(completed)]).toEqual(SWAP);
    // 完成形の「今」（A・C・M）はすべて Timer の無い釜に在り、表示の先頭に A が出る。
    const heads = headsOf(
      visibleGroupsOf(liftGroupsOf(liftItemsOf(completed, DEFAULT_NOODLE_PRESETS), NOW)),
      occupiedSlotsOf(running),
      NOW,
      1,
    );
    expect(heads).toEqual([itemKeyOf(a)]);
  });

  function liftItemsOf(plan: CookSchedule, presets: readonly NoodlePreset[]): readonly LiftItem[] {
    const orderByKey = new Map(pending.map((each) => [itemKeyOf(each), each]));
    return recommend(plan).map((recommendation) => {
      const each = orderByKey.get(itemKeyOf(recommendation))!;
      return { recommendation, order: each, boilSeconds: boilMillisOf(each, presets)! / 1000 };
    });
  }
});
