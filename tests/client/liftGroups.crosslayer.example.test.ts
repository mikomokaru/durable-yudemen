// tests/client/liftGroups.crosslayer.example.test.ts — engine を実走させた snapshot を client の導出に通す横断 Example
// （lift-group-display task 7）。
//
// **Validates: Requirements 1.7, 6.3, 6.10**
//
// liftGroups.example は snapshot を手書きして線を固定した。ここは snapshot を一切書かない——engine の唯一の遷移
// `decide`（品目からの開始・アドホック開始・発火・完了・計画受領）が実際に出した Broadcast の snapshot を、client の
// 唯一の遷移 `decideView` に通し、そこから群・連鎖・釜ごとの提案を導く。判断 20 の「群の所属と錨は engine が運び、
// client は `anchor > Corrected_Now` で開始済みを読む」は、計画側（lift-group-planning）が確定計画から `group` /
// `anchor` を射影し、client がそれを読むだけで正しい連鎖に達して初めて成り立つ主張であり、片側だけの検査では
// 固定できない。
//
// 場面は design「Testing Strategy」が名指しで求めた 3 つ。
//   1. 茹で上がりの 2 場面——同じ snapshot で 599 → 600 秒を跨ぐ転移と、その後の発火 snapshot。boiled の釜が
//      index 最小 / 最大の両方を置く（発火後の再計画が残りを boiled の釜へ置き直すか否かは釜の割当に依る）。
//   2. 容量分割（6 釜・同卓 4 品・各 2 釜）の到達可能な続き (i)(ii)——(ii) は再統合後に 3 品とも head。
//   3. keepsAnchor の帰結——採用済みの合流一片の錨が Boil_Sync で動いたとき、h_i の内側なら一片は残って群は
//      動いた錨に合流したまま started、h_i の外へ動けば一片は残っても合流でなくなり started でない。
//
// 時刻はすべて T0 からの秒で読む（serveAt / startAt / anchor の期待値も秒）。receivedAt を serverTime に揃えるので
// offset は 0 で、Corrected_Now はサーバ時刻そのものである。群の識別子は snapshot 内で閉じた記号なので、その文字列
// は読まない——群は品目の名の列で、群の同一性は識別子の一致・不一致で見る。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Event } from "../../src/engine/event";
import type { SettleParams } from "../../src/engine/settle";
import type { CookSchedule } from "../../src/engine/schedule";
import type { EpochMillis, SlotId, TimerId } from "../../src/engine/types";
import { decideView, EMPTY_VIEW, type ClientView } from "../../src/client/connection";
import {
  headOf,
  liftGroups,
  slotSuggestions,
  visibleGroups,
  type GroupItem,
  type LiftGroup,
  type SlotSuggestion,
} from "../../src/client/components/liftGroups";
import type { ServerMessage } from "../../src/domain/messages";
import type { PendingOrder } from "../../src/domain/order";
import type { FirmnessSeconds, NoodlePreset } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import { configResidualDefaults } from "../storeConfigDefaults";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const T0 = 1_700_000_000_000;
const SECOND = 1000;

/** T0 から offsetSeconds 秒後の絶対時刻。 */
function at(offsetSeconds: number): EpochMillis {
  return (T0 + offsetSeconds * SECOND) as EpochMillis;
}

/** 絶対時刻を T0 からの秒へ戻す（期待値を秒で書くため）。 */
function seconds(time: number): number {
  return (time - T0) / SECOND;
}

/** 茹で加減に依らず同じ秒（場面の関心事は茹で秒の差だけ）。 */
function every(boilSeconds: number): FirmnessSeconds {
  return { extraHard: boilSeconds, hard: boilSeconds, normal: boilSeconds, soft: boilSeconds };
}

/** 茹で 600 / 360 / 300 秒の 3 麺種。 */
const PRESETS: NonEmptyArray<NoodlePreset> = [
  { noodleType: "Long", boilSeconds: every(600) },
  { noodleType: "Mid", boilSeconds: every(360) },
  { noodleType: "Short", boilSeconds: every(300) },
];

/** Boil_Sync の 2 値。engine の params と client へ配る config で同じ値を使う。合流の窓 h_i は茹で秒の 10%。 */
const SYNC = { arms: 2, toleranceRatio: 10 } as const;

/** engine が受ける値の束（1 ユニット＝6 釜・採点は既定・麺種は上の 3 種）。 */
const PARAMS: SettleParams = { ...settleParams(SYNC, 1), noodlePresets: PRESETS };

/** client が受ける店舗設定。engine の params と同じ釜の数・レイアウト・麺種（片側だけが違えば等号は嘘になる）。 */
const CONFIG: ServerMessage = {
  type: "config",
  serverTime: T0,
  unitCount: 1,
  ...SYNC,
  noodlePresets: PRESETS,
  ...configResidualDefaults(1),
};

type Snapshot = Extract<ServerMessage, { readonly type: "snapshot" }>;

/** 遷移の結果——次の状態と、その遷移が Broadcast した snapshot（client が受け取るもの）。 */
interface Step {
  readonly state: TimerState;
  readonly snapshot: Snapshot;
}

/**
 * engine の遷移を一つ踏み、Broadcast された snapshot を取り出す。拒否や no-op（snapshot 無し）はこの検査の
 * 前提違反なので throw する——場面が engine の実際の挙動から外れたことをそこで知る。
 */
function step(state: TimerState, event: Event): Step {
  const outcome = decide(state, event, PARAMS);
  if (!outcome.ok) throw new Error(`engine rejected ${event.type}: ${outcome.rejection.code}`);
  const broadcast = outcome.effects.find((effect) => effect.type === "Broadcast");
  if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") {
    throw new Error(`no snapshot was broadcast after ${event.type}`);
  }
  return { state: outcome.state, snapshot: broadcast.message };
}

/** 遷移を順に踏み、最後の状態だけを返す（途中の snapshot は読まない）。 */
function advance(state: TimerState, events: readonly Event[]): TimerState {
  return events.reduce((current, event) => step(current, event).state, state);
}

// ── イベント ─────────────────────────────────────────────────────────────────────────────────

function order(
  externalOrderId: string,
  overrides: Partial<PendingOrder> & { readonly noodleType: string; readonly tableId: string },
): PendingOrder {
  return {
    externalOrderId,
    itemIndex: 0,
    firmness: "normal",
    arrivalTime: T0,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    ...overrides,
  };
}

/** 品目の名（externalOrderId#itemIndex）。期待値と Timer id の両方に使う。 */
function nameOf(item: { readonly externalOrderId: string; readonly itemIndex: number }): string {
  return `${item.externalOrderId}#${item.itemIndex}`;
}

function arrive(orders: readonly PendingOrder[], now: EpochMillis): Event {
  return { type: "OrderArrived", arrival: nonEmpty(orders), now };
}

/** 品目を指す開始。釜は現場が押した釜——推奨と一致しなくても engine は通す（観測事実 12）。 */
function startItem(item: PendingOrder, slots: readonly number[], now: EpochMillis): Event {
  return {
    type: "StartOrderItem",
    slotIds: slots.map(String),
    externalOrderId: item.externalOrderId,
    itemIndex: item.itemIndex,
    newTimerId: `timer-${nameOf(item)}` as TimerId,
    now,
  };
}

/** アドホック麺茹で（POS を経ない開始・どの卓の成員にもならない）。 */
function startAdhoc(id: string, slot: number, boilSeconds: number, now: EpochMillis): Event {
  return {
    type: "Start",
    slotIds: [String(slot)],
    noodleType: "Long",
    boilSeconds,
    newTimerId: `adhoc-${id}` as TimerId,
    now,
  };
}

function fire(now: EpochMillis): Event {
  return { type: "AlarmFired", now };
}

function complete(item: PendingOrder, now: EpochMillis): Event {
  return { type: "Complete", timerId: `timer-${nameOf(item)}`, now };
}

// ── client 側 ─────────────────────────────────────────────────────────────────────────────────

/** 設定を受けて live になった端末が snapshot を受け取ったビュー。receivedAt = serverTime ゆえ offset は 0。 */
function viewOf(snapshot: Snapshot): ClientView {
  const live = decideView(EMPTY_VIEW, { kind: "Connectivity", status: "up" });
  const configured = decideView(live, { kind: "Server", message: CONFIG, receivedAt: T0 });
  return decideView(configured, {
    kind: "Server",
    message: snapshot,
    receivedAt: snapshot.serverTime,
  });
}

/** 群の要約——錨（秒・合流していなければ null）・品目の名（群の中の順）・started。 */
function groupsAt(snapshot: Snapshot, corrected: number) {
  return liftGroups(viewOf(snapshot), corrected).map((group: LiftGroup) => ({
    anchor: group.anchor === null ? null : seconds(group.anchor),
    items: group.items.map((item: GroupItem) => nameOf(item.order)),
    started: group.started,
  }));
}

/** 表示できる群の品目の名の列。 */
function visibleAt(snapshot: Snapshot, corrected: number) {
  return visibleGroups(liftGroups(viewOf(snapshot), corrected)).map((group) =>
    group.items.map((item) => nameOf(item.order)),
  );
}

/** 各群の先頭の名。 */
function headsAt(snapshot: Snapshot, corrected: number) {
  return liftGroups(viewOf(snapshot), corrected).map((group) =>
    headOf(group).map((item) => nameOf(item.order)),
  );
}

/**
 * 釜ごとの提案の要約——釜番号の昇順に `[釜, ["名 solid" | "名 faint" | "名 member", …]]`。
 * 空の Map は `[]`（提案が一つも出ていない）。
 */
function suggestionsAt(snapshot: Snapshot, corrected: number) {
  const view = viewOf(snapshot);
  const bySlot = slotSuggestions(visibleGroups(liftGroups(view, corrected)), view, corrected);
  return [...bySlot]
    .sort(([slot], [other]) => slot - other)
    .map(([slot, list]) => [slot, list.map(phraseOf)] as const);
}

function phraseOf(suggestion: SlotSuggestion): string {
  const name = nameOf(suggestion.item.order);
  return suggestion.role === "head" ? `${name} ${suggestion.phase}` : `${name} member`;
}

/**
 * snapshot が運ぶ推奨——名・釜・startAt（秒）・錨（秒・合流していなければ null）。engine がどこへ置き、どの錨に
 * 合流させたかを読む（計画順のまま）。
 */
function planOf(snapshot: Snapshot) {
  return snapshot.recommendations.map((each) => [
    nameOf(each),
    [...each.slotIds],
    seconds(each.startAt),
    each.anchor === null ? null : seconds(each.anchor),
  ]);
}

/** snapshot が運ぶ推奨の群の識別子（名ごと）。同じ群かどうかは識別子の一致で見る（文字列そのものは読まない）。 */
function groupIdsOf(snapshot: Snapshot): ReadonlyMap<string, string> {
  return new Map(snapshot.recommendations.map((each) => [nameOf(each), each.group]));
}

/** snapshot が運ぶ Timer の実効 endTime（秒）。id 順。 */
function endTimesOf(snapshot: Snapshot) {
  return [...snapshot.timers]
    .map((timer) => [timer.id, seconds(timer.endTime)] as const)
    .sort(([id], [other]) => (id < other ? -1 : 1));
}

describe("Feature: lift-group-display — 茹で上がりの 2 場面（design Testing Strategy・判断 16・Requirement 6.3 の例外）", () => {
  /**
   * 同卓 t-1 の A（Long 600 秒）と B（Mid 360 秒）、別卓 t-2 の C（Short 300 秒・2 釜）。3 釜はアドホック麺茹でが
   * 塞いでいる——塞がなければ C は今すぐ空く釜へ置かれて最早の群になり、G1 の後ろに並ばない。うち 1 釜は 900 秒で
   * 上がる。C の群の serveAt（900 秒）と偶然一致する卓なしの Timer で、Timer の endTime の一致だけでは started に
   * ならない（engine は C を合流させず anchor を null で運ぶ）ことを engine の実物で踏む（判断 16 / 20）。A を
   * 始めると B は走行中の錨 600 秒に合流し（startAt 240 秒・anchor 600 秒）、C は釜が空く 600 秒に置かれる
   * （別卓の G2・anchor null）。
   *
   * 塞ぐ釜と A を始める釜は変種ごとに違う。再計画は同点の釜を index で断つので、発火後に残りの B が boiled の
   * 釜へ置き直されるか（index 最小）、自分の釜に留まるか（index 最大）は釜の割当だけで決まる。
   */
  const A = order("a", { noodleType: "Long", tableId: "t-1", arrivalTime: at(-20) });
  const B = order("b", { noodleType: "Mid", tableId: "t-1", arrivalTime: at(-20) });
  const C = order("c", { noodleType: "Short", tableId: "t-2", arrivalTime: at(-10), slotSpan: 2 });

  interface Variant {
    readonly name: string;
    /** アドホック麺茹でが塞ぐ釜と、その茹で秒。 */
    readonly blocked: readonly (readonly [slot: number, boilSeconds: number])[];
    /** 現場が A を始めた釜（推奨とは違う釜でもよい）。 */
    readonly pressed: number;
    /** A を始めた直後の計画（B と C の釜・startAt・錨）。C の釜の並びは engine の解放時刻順（先に空く釜が先）。 */
    readonly plan: readonly (readonly [string, readonly string[], number, number | null])[];
    /** 599 秒の提案（G1 の B が濃く、G2 の C が薄く、C の 2 釜に同じ提案）。 */
    readonly at599: readonly (readonly [number, readonly string[]])[];
    /** 600 秒の提案（同じ snapshot・C が消え、B だけが残る）。 */
    readonly at600: readonly (readonly [number, readonly string[]])[];
    /** 発火 snapshot の計画（B の新しい釜と startAt 600 秒・錨は無い）。 */
    readonly firedPlan: readonly (readonly [string, readonly string[], number, number | null])[];
    /** 発火 snapshot の提案。 */
    readonly fired: readonly (readonly [number, readonly string[]])[];
    /** A を Complete した後の提案。 */
    readonly completed: readonly (readonly [number, readonly string[]])[];
  }

  const VARIANTS: readonly Variant[] = [
    {
      name: "boiled の釜が index 最小（釜 0 で始めた・残りは釜 4・別卓は釜 4・5）",
      blocked: [
        [1, 900],
        [2, 1800],
        [3, 1800],
      ],
      pressed: 0,
      plan: [
        ["b#0", ["4"], 240, 600],
        ["c#0", ["5", "4"], 600, null],
      ],
      at599: [
        [4, ["b#0 solid", "c#0 faint"]],
        [5, ["c#0 faint"]],
      ],
      at600: [[4, ["b#0 solid"]]],
      // 再計画は 600 秒に空く釜（boiled の 0・計画上の 4・空きの 5）のうち index 最小の釜 0 へ B を置き直す。
      // 釜 0 は Complete 待ちで埋まっているので、B の提案はどこにも出ない（Error Handling「Complete までは残りの
      // 提案が出ないことがある」）。
      firedPlan: [
        ["b#0", ["0"], 600, null],
        ["c#0", ["4", "5"], 600, null],
      ],
      fired: [],
      completed: [[0, ["b#0 solid"]]],
    },
    {
      name: "boiled の釜が index 最大（釜 5 で始めた・残りは釜 2・別卓は釜 2・4）",
      blocked: [
        [0, 900],
        [1, 1800],
        [3, 1800],
      ],
      pressed: 5,
      plan: [
        ["b#0", ["2"], 240, 600],
        ["c#0", ["4", "2"], 600, null],
      ],
      at599: [
        [2, ["b#0 solid", "c#0 faint"]],
        [4, ["c#0 faint"]],
      ],
      at600: [[2, ["b#0 solid"]]],
      // index 最小は B 自身の釜 2 なので B はそこに留まり、釜 2 は idle ゆえ濃く出る。
      firedPlan: [
        ["b#0", ["2"], 600, null],
        ["c#0", ["4", "5"], 600, null],
      ],
      fired: [[2, ["b#0 solid"]]],
      completed: [[2, ["b#0 solid"]]],
    },
  ];

  /** 変種の場面を engine で走らせ、A の開始・600 秒の発火・A の Complete の 3 つの snapshot を得る。 */
  function scene(variant: Variant) {
    const ready = advance(EMPTY_STATE, [
      ...variant.blocked.map(([slot, boilSeconds]) =>
        startAdhoc(`blocked-${slot}`, slot, boilSeconds, at(0)),
      ),
      arrive([A, B], at(0)),
      arrive([C], at(0)),
    ]);
    const started = step(ready, startItem(A, [variant.pressed], at(0)));
    const fired = step(started.state, fire(at(600)));
    const completed = step(fired.state, complete(A, at(600)));
    return { started: started.snapshot, fired: fired.snapshot, completed: completed.snapshot };
  }

  for (const variant of VARIANTS) {
    describe(variant.name, () => {
      const { started, fired, completed } = scene(variant);

      it("A を始めた snapshot：B は走行中の錨 600 秒に合流し（anchor 600）、C は釜の空く 600 秒に置かれる（anchor null・engine の配置）", () => {
        expect(planOf(started)).toEqual(variant.plan);
        expect(endTimesOf(started)).toContainEqual([`timer-${nameOf(A)}`, 600]);
        // B と C は別の群（別の一片）。
        const ids = groupIdsOf(started);
        expect(ids.get("b#0")).not.toBe(ids.get("c#0"));
      });

      it("599 秒：G1 は started（anchor 600 秒 > now）で、G2 の提案も見える", () => {
        // G2 の serveAt 900 秒は、卓なしのアドホック麺茹での endTime と一致する。engine は C を合流させておらず
        // anchor は null——client は Timer の endTime の一致を読まないので started にならない（AC 1.7）。
        expect(endTimesOf(started)).toContainEqual([
          `adhoc-blocked-${variant.blocked[0]![0]}`,
          900,
        ]);
        expect(groupsAt(started, at(599))).toEqual([
          { anchor: 600, items: ["b#0"], started: true },
          { anchor: null, items: ["c#0"], started: false },
        ]);
        expect(visibleAt(started, at(599))).toEqual([["b#0"], ["c#0"]]);
        expect(suggestionsAt(started, at(599))).toEqual(variant.at599);
      });

      it("600 秒（同じ snapshot）：錨が茹で上がりに転じて G1 は started でなくなり、G2 の提案は消え、B が先頭として濃く残る", () => {
        expect(groupsAt(started, at(600))).toEqual([
          { anchor: 600, items: ["b#0"], started: false },
          { anchor: null, items: ["c#0"], started: false },
        ]);
        expect(visibleAt(started, at(600))).toEqual([["b#0"]]);
        expect(suggestionsAt(started, at(600))).toEqual(variant.at600);
      });

      it("発火 snapshot：B は錨を持たない新しい群として届き、G2 は引き続き隠れる", () => {
        expect(planOf(fired)).toEqual(variant.firedPlan);
        // 残りは「いま始める群」に組み直される——boiled の A（600 秒）にはもう合流せず anchor は null で started でない。
        // G2 との startAt の同値は到着順で断たれ、先に届いた t-1 が先頭に立つ（AC 1.4）。
        expect(groupsAt(fired, at(600))).toEqual([
          { anchor: null, items: ["b#0"], started: false },
          { anchor: null, items: ["c#0"], started: false },
        ]);
        expect(visibleAt(fired, at(600))).toEqual([["b#0"]]);
        expect(suggestionsAt(fired, at(600))).toEqual(variant.fired);
      });

      it("A を Complete した snapshot：B の釜が idle になり、B が先頭として濃く出る。G2 はまだ隠れる", () => {
        expect(visibleAt(completed, at(600))).toEqual([["b#0"]]);
        expect(suggestionsAt(completed, at(600))).toEqual(variant.completed);
      });
    });
  }
});

describe("Feature: lift-group-display — 容量分割（6 釜・同卓 4 品・各 2 釜・design Testing Strategy）", () => {
  /** 同卓 t-1 の 1 注文 4 品（Mid 360 秒・各 2 釜）。容量 6 釜ゆえ 3 品が batch 1、残る 1 品が batch 2。 */
  const ITEMS = [0, 1, 2, 3].map((itemIndex) =>
    order("o", { itemIndex, noodleType: "Mid", tableId: "t-1", arrivalTime: at(-30), slotSpan: 2 }),
  );
  const ITEM1 = ITEMS[0]!;
  const ITEM2 = ITEMS[1]!;
  const ITEM3 = ITEMS[2]!;

  const arrived = step(EMPTY_STATE, arrive(ITEMS, at(0)));
  /** 1 本目（item1）を推奨どおり釜 0・1 で始めた直後。 */
  const firstStarted = step(arrived.state, startItem(ITEM1, [0, 1], at(0)));

  it("到着直後：batch 1 の 3 品が一つの群（serveAt 360 秒）、釜 0・1 を待つ item4 は別の群（serveAt 720 秒）。どちらも錨は無い", () => {
    expect(planOf(arrived.snapshot)).toEqual([
      ["o#0", ["0", "1"], 0, null],
      ["o#1", ["2", "3"], 0, null],
      ["o#2", ["4", "5"], 0, null],
      ["o#3", ["0", "1"], 360, null],
    ]);
    expect(groupsAt(arrived.snapshot, at(0))).toEqual([
      { anchor: null, items: ["o#0", "o#1", "o#2"], started: false },
      { anchor: null, items: ["o#3"], started: false },
    ]);
  });

  it("1 本目を始めた後：合流する 2 品が G1（started・anchor ＝ 走行中の endTime）で今、item4 は G2 の唯一の head", () => {
    expect(groupsAt(firstStarted.snapshot, at(0))).toEqual([
      { anchor: 360, items: ["o#1", "o#2"], started: true },
      { anchor: null, items: ["o#3"], started: false },
    ]);
    // 同じ卓でも後の batch の G2 は合流しておらず（anchor null）started にならない（AC 1.7 / 6.10）。
    expect(headsAt(firstStarted.snapshot, at(0))).toEqual([["o#1", "o#2"], ["o#3"]]);
    expect(suggestionsAt(firstStarted.snapshot, at(0))).toEqual([
      [2, ["o#1 solid"]],
      [3, ["o#1 solid"]],
      [4, ["o#2 solid"]],
      [5, ["o#2 solid"]],
    ]);
    // item4 の Prep_Lead（300 秒）が来ても、釜 0・1 が走行中の間は全釜 idle を満たさず提案自体が出ない（AC 2.7）。
    expect(suggestionsAt(firstStarted.snapshot, at(300))).toEqual([
      [2, ["o#1 solid"]],
      [3, ["o#1 solid"]],
      [4, ["o#2 solid"]],
      [5, ["o#2 solid"]],
    ]);
  });

  it("(i) 2 品を始め、360 秒に 3 本が boiled、1 本目を Complete → G2 が先頭の群として現れ、item4 が釜 0・1 に head・solid", () => {
    const allStarted = advance(firstStarted.state, [
      startItem(ITEM2, [2, 3], at(0)),
      startItem(ITEM3, [4, 5], at(0)),
    ]);
    // 同時に始めた 3 本を Boil_Sync（arms 2）は 2 本＋1 本の Sync_Set に割り、324 / 324 / 396 秒へ散らす。
    // Alarm はまず 324 秒に鳴り（2 本を凍結・残る 1 本は単独で 360 秒へ戻る）、次に 360 秒に鳴る。
    const fired = step(step(allStarted, fire(at(324))).state, fire(at(360)));
    // 3 本とも boiled。G1 は pending を持たず存在せず、item4 の群だけが残る（先頭の群）。
    expect(endTimesOf(fired.snapshot)).toEqual([
      ["timer-o#0", 324],
      ["timer-o#1", 324],
      ["timer-o#2", 360],
    ]);
    expect(planOf(fired.snapshot)).toEqual([["o#3", ["0", "1"], 360, null]]);
    expect(groupsAt(fired.snapshot, at(360))).toEqual([
      { anchor: null, items: ["o#3"], started: false },
    ]);
    // Complete までは釜 0・1 が boiled で埋まっており、先頭の群でも提案は出ない。
    expect(suggestionsAt(fired.snapshot, at(360))).toEqual([]);

    const completed = step(fired.state, complete(ITEM1, at(360)));
    // item2 / item3 の釜が boiled のままでも、釜 0・1 は idle なので item4 が head・solid で現れる。
    expect(planOf(completed.snapshot)).toEqual([["o#3", ["0", "1"], 360, null]]);
    expect(suggestionsAt(completed.snapshot, at(360))).toEqual([
      [0, ["o#3 solid"]],
      [1, ["o#3 solid"]],
    ]);
  });

  it("(ii) 2 品を始めないまま 360 秒に 1 本目が発火 → 残り 3 品が一群に再統合され、3 品とも head。item4 は空いている釜 4・5 に置かれ Complete 前から見える", () => {
    const fired = step(firstStarted.state, fire(at(360)));
    // 走行中の錨（360 秒）は過去ゆえ誰も合流できず、3 品が startAt 360 秒 / serveAt 720 秒の同じ batch（錨なし）になる。
    expect(planOf(fired.snapshot)).toEqual([
      ["o#1", ["0", "1"], 360, null],
      ["o#2", ["2", "3"], 360, null],
      ["o#3", ["4", "5"], 360, null],
    ]);
    expect(groupsAt(fired.snapshot, at(360))).toEqual([
      { anchor: null, items: ["o#1", "o#2", "o#3"], started: false },
    ]);
    expect(headsAt(fired.snapshot, at(360))).toEqual([["o#1", "o#2", "o#3"]]);
    // 釜 0・1 は boiled で item2 は出ないが、item3 / item4 の釜はそこではない。
    expect(suggestionsAt(fired.snapshot, at(360))).toEqual([
      [2, ["o#2 solid"]],
      [3, ["o#2 solid"]],
      [4, ["o#3 solid"]],
      [5, ["o#3 solid"]],
    ]);

    const completed = step(fired.state, complete(ITEM1, at(360)));
    expect(suggestionsAt(completed.snapshot, at(360))).toEqual([
      [0, ["o#1 solid"]],
      [1, ["o#1 solid"]],
      [2, ["o#2 solid"]],
      [3, ["o#2 solid"]],
      [4, ["o#3 solid"]],
      [5, ["o#3 solid"]],
    ]);
  });
});

describe("Feature: lift-group-display — keepsAnchor の帰結（design「解決済み」・Requirement 6.10）", () => {
  /**
   * 同卓 t-a に走行中の仲間 S（Long 600 秒・釜 5）。空いている釜は 0・1 だけ（釜 2〜4 はアドホック麺茹で）。
   * 待ち行列は先に届いた P（2 品・Short 300 秒・各 1 釜）と、後から届いた Q（1 品・Short 300 秒・2 釜）。
   *
   * 自前解は正準順序の貪欲で P の 2 品を錨 600 秒に合流させ、Q を 900 秒へ置く。外部計画は逆に Q を合流させて
   * P を 900 秒へ置く——合流分が錨に一致し、P は Q の後では合流できない（押し出しではない）ので keepsAnchor を
   * 守る。採点は待ち時間が 300 秒増える一方、最遅（900 秒）から見た卓の遅れが錨に残る本数の分だけ減る
   * （S を含めて 3 本 × 300 秒 → 2 本 × 300 秒・重み 2）ので、合成後の総和が真に小さく改善として採用される。
   *
   * Q（Short 300 秒）の合流の窓 h_i は 30 秒。S の実効 endTime が Boil_Sync で動いたとき、Q の serveAt 600 秒から
   * 30 秒の内側に留まる限り一片は合流のまま残り（錨だけが動く）、外へ出れば合流でなくなる。
   */
  const S = order("s", { noodleType: "Long", tableId: "t-a", arrivalTime: at(-200) });
  const P = [0, 1].map((itemIndex) =>
    order("p", { itemIndex, noodleType: "Short", tableId: "t-a", arrivalTime: at(-100) }),
  );
  const Q = order("q", { noodleType: "Short", tableId: "t-a", arrivalTime: at(-50), slotSpan: 2 });

  const EXTERNAL: CookSchedule = {
    slices: [
      {
        tableKey: "t-a",
        placements: [
          {
            externalOrderId: "q",
            itemIndex: 0,
            slotIds: nonEmpty(["0" as SlotId, "1" as SlotId]),
            startAt: at(300),
            serveAt: at(600),
          },
          {
            externalOrderId: "p",
            itemIndex: 0,
            slotIds: nonEmpty(["0" as SlotId]),
            startAt: at(600),
            serveAt: at(900),
          },
          {
            externalOrderId: "p",
            itemIndex: 1,
            slotIds: nonEmpty(["1" as SlotId]),
            startAt: at(600),
            serveAt: at(900),
          },
        ],
      },
    ],
  };

  const ready = advance(EMPTY_STATE, [
    ...[2, 3, 4].map((slot) => startAdhoc(`blocked-${slot}`, slot, 1800, at(0))),
    arrive([S], at(0)),
    startItem(S, [5], at(0)),
    arrive(P, at(0)),
    arrive([Q], at(0)),
  ]);
  const accepted = step(ready, { type: "PlanArrived", plan: EXTERNAL, now: at(0) });

  it("採用直後：合流一片の群（Q・anchor 600 秒）が started、後続の batch（P・900 秒・anchor null）は同じ卓でも started でない", () => {
    expect(accepted.state.acceptedSlices).toEqual(EXTERNAL.slices);
    expect(planOf(accepted.snapshot)).toEqual([
      ["q#0", ["0", "1"], 300, 600],
      ["p#0", ["0"], 600, null],
      ["p#1", ["1"], 600, null],
    ]);
    expect(groupsAt(accepted.snapshot, at(0))).toEqual([
      { anchor: 600, items: ["q#0"], started: true },
      { anchor: null, items: ["p#0", "p#1"], started: false },
    ]);
    // 同じ一片の中でも、合流した Q と後続の P は別の群。
    const ids = groupIdsOf(accepted.snapshot);
    expect(ids.get("p#0")).toBe(ids.get("p#1"));
    expect(ids.get("q#0")).not.toBe(ids.get("p#0"));
  });

  it("錨が後ろへ h_i の内側で動く：S の実効 endTime が 605 秒になっても採用済み一片は残り、Q の群は動いた錨 605 秒に合流したまま started", () => {
    // 釜 1 でアドホック麺茹で（600 秒・10 秒遅れて開始）。Boil_Sync が S と U を 605 秒へ揃える（S は +5 秒）。
    const shifted = step(accepted.state, startAdhoc("u", 1, 600, at(10)));
    expect(endTimesOf(shifted.snapshot)).toContainEqual(["timer-s#0", 605]);
    // Q の serveAt 600 秒は錨 605 秒から h_i（30 秒）の内側——合流分は錨に一致していなくてよい（判断 18）ので、
    // 採用済み一片は keepsAnchor を守って残り、推奨は serveAt をそのままに錨だけを 605 秒へ更新して運ぶ。
    expect(shifted.state.acceptedSlices).toEqual(EXTERNAL.slices);
    expect(planOf(shifted.snapshot)).toEqual([
      ["q#0", ["0", "1"], 300, 605],
      ["p#0", ["0"], 600, null],
      ["p#1", ["1"], 600, null],
    ]);
    // client は serveAt（600 秒）と anchor（605 秒）の等号を見ない——anchor が未来なら started（AC 1.7）。
    expect(groupsAt(shifted.snapshot, at(10))).toEqual([
      { anchor: 605, items: ["q#0"], started: true },
      { anchor: null, items: ["p#0", "p#1"], started: false },
    ]);
    expect(visibleAt(shifted.snapshot, at(10))).toEqual([["q#0"], ["p#0", "p#1"]]);
  });

  it("錨が前へ h_i の内側で動く：S の実効 endTime が 570 秒になっても一片は届き、Q の群は錨 570 秒に合流したまま started", () => {
    // 290 秒に釜 1 でアドホック麺茹で（280 秒）。Boil_Sync が S と U を 570 秒へ揃える（S は −30 秒）。
    // Q の serveAt 600 秒は錨 570 秒からちょうど h_i（30 秒）——窓の縁で合流のまま残る。
    const shifted = step(accepted.state, startAdhoc("u", 1, 280, at(290)));
    expect(endTimesOf(shifted.snapshot)).toContainEqual(["timer-s#0", 570]);
    expect(shifted.state.acceptedSlices).toEqual(EXTERNAL.slices);
    expect(planOf(shifted.snapshot)).toEqual([
      ["q#0", ["0", "1"], 300, 570],
      ["p#0", ["0"], 600, null],
      ["p#1", ["1"], 600, null],
    ]);
    expect(groupsAt(shifted.snapshot, at(290))).toEqual([
      { anchor: 570, items: ["q#0"], started: true },
      { anchor: null, items: ["p#0", "p#1"], started: false },
    ]);
    expect(visibleAt(shifted.snapshot, at(290))).toEqual([["q#0"], ["p#0", "p#1"]]);
    // Q の Prep_Lead は来ている（290 ≥ 240）が、指す釜 1 をアドホック麺茹でが占めたので提案は出ない（AC 2.7）。
    expect(suggestionsAt(shifted.snapshot, at(290))).toEqual([]);
  });

  it("錨が前へ h_i の外まで動く：S の実効 endTime が 547 秒になり一片が届かなくなると、その一片は残るが合流ではなく（anchor null）、群は started でない（正当な後続の batch）", () => {
    // 290 秒に釜 1 でアドホック麺茹で（240 秒）。Boil_Sync が S と U を 547 秒へ揃える（S は −53 秒）。
    // Q の serveAt 600 秒は錨 547 秒から 53 秒——h_i（30 秒）の外で、もう合流ではない。採用済み一片の Q（startAt
    // 300 秒）はまだ過ぎておらず、押し出しでもない（間に合う釜が 2 つ空いていない）ので一片はそのまま残る。
    const shifted = step(accepted.state, startAdhoc("u", 1, 240, at(290)));
    expect(endTimesOf(shifted.snapshot)).toContainEqual(["timer-s#0", 547]);
    expect(shifted.state.acceptedSlices).toEqual(EXTERNAL.slices);
    expect(planOf(shifted.snapshot)).toEqual([
      ["q#0", ["0", "1"], 300, null],
      ["p#0", ["0"], 600, null],
      ["p#1", ["1"], 600, null],
    ]);
    // 合流していない群は started でない。表示は開始済みを要求しない——先頭の群として見えるが、後続の P は解禁されない。
    expect(groupsAt(shifted.snapshot, at(290))).toEqual([
      { anchor: null, items: ["q#0"], started: false },
      { anchor: null, items: ["p#0", "p#1"], started: false },
    ]);
    expect(visibleAt(shifted.snapshot, at(290))).toEqual([["q#0"]]);
    expect(suggestionsAt(shifted.snapshot, at(290))).toEqual([]);
  });
});
