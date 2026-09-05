// tests/client/liftGroups.example.test.ts — 群の導出・連鎖・釜の組の境界（lift-group-display）。
//
// **Validates: Requirements 1.3, 1.7, 1.8, 1.9, 2.1〜2.4, 2.7, 2.9, 2.10, 4.3〜4.5, 4.7, 4.9**
//
// 性質テストは「全域でこうなる」を言うが、線がどこに引かれているかは言わない。ここは線そのものを名指しで
// 固定する——レビューの再現（茹で 510 / 360 / 330 秒の同卓 3 品）で濃く押せるのが店舗全体で先頭 arms 本だけで
// あること（判断 21・実機の 9 品の差し戻しを含む）、連鎖が「1 本目が始まった」（`anchor` が未来）で解禁される
// こと、錨の茹で上がりの転移で後続が隠れること、釜の組が距離と index で断たれること。群の所属（`group`）と錨
// （`anchor`）は engine が推奨に載せる値で、ここではそれを手書きする（判断 20）。client は卓も serveAt も Timer も
// 群の判定に読まない。腕の本数 `arms` は既定の 2（EMPTY_VIEW）で、場面ごとに 1 や 3 へ振る。

import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type ClientTimer, type ClientView } from "../../src/client/connection";
import {
  liftGroups,
  pairSlots,
  slotSuggestions,
  visibleGroups,
} from "../../src/client/components/liftGroups";
import type { CookRecommendation } from "../../src/domain/messages";
import type { PendingOrder } from "../../src/domain/order";
import { defaultUnitOrigins, type NoodlePreset } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import { nonEmpty } from "../nonEmpty";

const T0 = 1_700_000_000_000;
const SECOND = 1000;

/** 茹で 510 / 360 / 330 秒の 3 麺種（レビューの再現・観測事実 14）。 */
const PRESETS: NonEmptyArray<NoodlePreset> = [
  { noodleType: "Long", boilSeconds: { extraHard: 510, hard: 510, normal: 510, soft: 510 } },
  { noodleType: "Mid", boilSeconds: { extraHard: 360, hard: 360, normal: 360, soft: 360 } },
  { noodleType: "Short", boilSeconds: { extraHard: 330, hard: 330, normal: 330, soft: 330 } },
];

function order(overrides: Partial<PendingOrder> & { externalOrderId: string }): PendingOrder {
  return {
    itemIndex: 0,
    noodleType: "Long",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime: T0 - 60 * SECOND,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    ...overrides,
  };
}

/** 推奨。群の所属 `group` と錨 `anchor` は engine が付ける値（anchor の既定は null＝合流していない）。 */
function recommendation(
  externalOrderId: string,
  slotIds: readonly string[],
  startAt: number,
  group: string,
  anchor: number | null = null,
): CookRecommendation {
  return { externalOrderId, itemIndex: 0, slotIds: nonEmpty(slotIds), startAt, group, anchor };
}

function timer(overrides: Partial<ClientTimer> & { id: string; endTime: number }): ClientTimer {
  return {
    slotIds: nonEmpty(["0"]),
    noodleType: "Long",
    firmness: "normal",
    startTime: overrides.endTime - 510 * SECOND,
    origin: "server",
    ...overrides,
  };
}

function view(overrides: Partial<ClientView>): ClientView {
  return {
    ...EMPTY_VIEW,
    connectivity: "up",
    sync: "synced",
    unitCount: 1,
    unitOrigins: defaultUnitOrigins(1),
    noodlePresets: PRESETS,
    ...overrides,
  };
}

/** 同卓 3 品（開始予定 0 / 150 / 180 秒・serveAt は 510 秒で揃う）。engine は 3 品を一つの群 g1 に置く。 */
const THREE = [
  order({ externalOrderId: "long", noodleType: "Long" }),
  order({ externalOrderId: "mid", noodleType: "Mid" }),
  order({ externalOrderId: "short", noodleType: "Short" }),
];
const THREE_PLAN = [
  recommendation("long", ["0"], T0, "g1"),
  recommendation("mid", ["1"], T0 + 150 * SECOND, "g1"),
  recommendation("short", ["2"], T0 + 180 * SECOND, "g1"),
];

function suggestionsAt(current: ClientView, corrected: number) {
  return slotSuggestions(visibleGroups(liftGroups(current, corrected)), current, corrected);
}

describe("Feature: lift-group-display — 同卓 3 品で濃いのは店舗全体で先頭 arms 本だけ（判断 21・レビューの再現）", () => {
  const current = view({ pendingOrders: THREE, recommendations: THREE_PLAN });

  it("3 品は一つの群 g1（serveAt は 510 秒で揃う）に束なり、0 秒では 510 秒の品目だけが head（他 2 品はまだ現れない）", () => {
    const groups = liftGroups(current, T0);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ group: "g1", anchor: null, started: false });
    expect(groups[0]!.items.map((item) => item.order.externalOrderId)).toEqual([
      "long",
      "mid",
      "short",
    ]);
    // serveAt は表示用の再計算（startAt + 茹で秒・AC 1.1）。群の鍵ではないが、計画が揃えた値がここで読める。
    expect(groups[0]!.items.map((item) => item.suggestion.serveAt)).toEqual([
      T0 + 510 * SECOND,
      T0 + 510 * SECOND,
      T0 + 510 * SECOND,
    ]);
    const bySlot = suggestionsAt(current, T0);
    expect(bySlot.get(0)).toEqual([
      { role: "head", item: expect.objectContaining({ order: THREE[0] }) },
    ]);
    // mid（150 秒）・short（180 秒）は Prep_Lead の前で、薄くも現れない。
    expect(bySlot.has(1)).toBe(false);
    expect(bySlot.has(2)).toBe(false);
  });

  it("180 秒経って全品の startAt が過ぎると head は先頭 arms 2 本（510 秒と 360 秒の品目）で、330 秒の品目は member（濃くならない）", () => {
    const bySlot = suggestionsAt(current, T0 + 180 * SECOND);
    expect(bySlot.get(0)).toEqual([
      { role: "head", item: expect.objectContaining({ order: THREE[0] }) },
    ]);
    expect(bySlot.get(1)).toEqual([
      { role: "head", item: expect.objectContaining({ order: THREE[1] }) },
    ]);
    expect(bySlot.get(2)).toEqual([
      { role: "member", item: expect.objectContaining({ order: THREE[2] }) },
    ]);
  });

  it("arms 1 なら head は 510 秒の品目だけで、startAt が過ぎた 360 秒の品目も member のまま", () => {
    const bySlot = suggestionsAt({ ...current, arms: 1 }, T0 + 180 * SECOND);
    expect(bySlot.get(0)?.[0]).toMatchObject({ role: "head" });
    expect(bySlot.get(1)?.[0]).toMatchObject({ role: "member" });
    expect(bySlot.get(2)?.[0]).toMatchObject({ role: "member" });
  });

  it("同じ startAt の 9 品（実機の差し戻し）は arms 2 で head 2 本・member 7 本。先頭は到着順で決まり、表示の数は arms に依らない", () => {
    // 同卓の 9 品がすべて 0 秒に置かれ、各 1 釜（釜 0〜8・2 ユニット）。到着は 1 秒刻みで n0 が最初。
    const nine = Array.from({ length: 9 }, (_, index) =>
      order({ externalOrderId: `n${index}`, arrivalTime: T0 - 60 * SECOND + index * SECOND }),
    );
    const plan = nine.map((each, index) =>
      recommendation(each.externalOrderId, [String(index)], T0, "g1"),
    );
    const crowded = view({
      unitCount: 2,
      unitOrigins: defaultUnitOrigins(2),
      pendingOrders: nine,
      recommendations: plan,
    });
    const rolesOf = (bySlot: ReturnType<typeof suggestionsAt>) =>
      [...bySlot.entries()]
        .sort(([slot], [other]) => slot - other)
        .map(([, list]) => list.map((suggestion) => suggestion.role));
    expect(rolesOf(suggestionsAt(crowded, T0))).toEqual([
      ["head"],
      ["head"],
      ["member"],
      ["member"],
      ["member"],
      ["member"],
      ["member"],
      ["member"],
      ["member"],
    ]);
    // 放置して時間が経っても 2 本のまま（後続は startAt が過ぎても濃くならない・AC 2.3 / 2.4）。
    expect(rolesOf(suggestionsAt(crowded, T0 + 600 * SECOND))).toEqual(
      rolesOf(suggestionsAt(crowded, T0)),
    );
    // arms 3 なら 3 本、arms 1 なら 1 本。9 件の表示は変わらない（AC 2.11）。
    expect(rolesOf(suggestionsAt({ ...crowded, arms: 3 }, T0)).flat()).toEqual([
      ...Array<"head">(3).fill("head"),
      ...Array<"member">(6).fill("member"),
    ]);
    expect(rolesOf(suggestionsAt({ ...crowded, arms: 1 }, T0)).flat()).toEqual([
      "head",
      ...Array<"member">(8).fill("member"),
    ]);
  });

  it("Prep_Lead の 60 秒前に薄く（member）現れ、startAt が来て枠が空いていれば head になる。仲間は 60 秒前まで現れない", () => {
    expect(suggestionsAt(current, T0 - 61 * SECOND).size).toBe(0);
    // 最早の品目でも startAt の前は member——薄いものは押せない（判断 5 は撤回・判断 21）。
    expect(suggestionsAt(current, T0 - 60 * SECOND).get(0)?.[0]).toMatchObject({ role: "member" });
    expect(suggestionsAt(current, T0 - SECOND).get(0)?.[0]).toMatchObject({ role: "member" });
    expect(suggestionsAt(current, T0).get(0)?.[0]).toMatchObject({ role: "head" });
    // mid の startAt は 150 秒。89 秒では現れず、90 秒で member として現れ、150 秒に arms 2 の 2 本目の枠が
    // 空いているので head になる。arms 1 なら枠が無く、150 秒でも member のまま。
    expect(suggestionsAt(current, T0 + 89 * SECOND).has(1)).toBe(false);
    expect(suggestionsAt(current, T0 + 90 * SECOND).get(1)?.[0]).toMatchObject({ role: "member" });
    expect(suggestionsAt(current, T0 + 149 * SECOND).get(1)?.[0]).toMatchObject({ role: "member" });
    expect(suggestionsAt(current, T0 + 150 * SECOND).get(1)?.[0]).toMatchObject({ role: "head" });
    expect(suggestionsAt({ ...current, arms: 1 }, T0 + 150 * SECOND).get(1)?.[0]).toMatchObject({
      role: "member",
    });
    // short（180 秒）は arms 2 の枠が埋まっているので、startAt が来ても member。
    expect(suggestionsAt(current, T0 + 180 * SECOND).get(2)?.[0]).toMatchObject({ role: "member" });
  });
});

describe("Feature: lift-group-display — 連鎖は「1 本目が始まった」で解禁される（判断 16・19・20）", () => {
  /** 別卓の群 G2（開始予定 200 秒・Prep_Lead は 140 秒）。 */
  const other = order({ externalOrderId: "other", tableId: "t-2", noodleType: "Mid" });
  const otherPlan = recommendation("other", ["3"], T0 + 200 * SECOND, "g2");

  it("先頭の群が started でない間、後の群は Prep_Lead が来ても出ない", () => {
    const current = view({
      pendingOrders: [...THREE, other],
      recommendations: [...THREE_PLAN, otherPlan],
    });
    const groups = liftGroups(current, T0 + 180 * SECOND);
    expect(groups.map((group) => group.group)).toEqual(["g1", "g2"]);
    expect(visibleGroups(groups).map((group) => group.group)).toEqual(["g1"]);
    expect(suggestionsAt(current, T0 + 180 * SECOND).has(3)).toBe(false);
  });

  it("1 本目を始める（残りが走行中の錨 510 秒に合流した snapshot）と群は started になり、次の先頭 arms 本が濃くなり、後の群も薄く出る", () => {
    // long を釜 0 で始めた snapshot：推奨から消え、残り 2 品は錨（走行中の実効 endTime 510 秒）に合流して届く。
    // G2（t-2・serveAt 560 秒）にはもう 1 品 extra（Short・開始予定 230 秒）が在り、その推奨は走行中の釜 0 を指す。
    const anchor = T0 + 510 * SECOND;
    const extra = order({ externalOrderId: "extra", tableId: "t-2", noodleType: "Short" });
    const extraPlan = recommendation("extra", ["0"], T0 + 230 * SECOND, "g2");
    const current = view({
      pendingOrders: [THREE[1]!, THREE[2]!, other, extra],
      recommendations: [
        recommendation("mid", ["1"], T0 + 150 * SECOND, "g1", anchor),
        recommendation("short", ["2"], T0 + 180 * SECOND, "g1", anchor),
        otherPlan,
        extraPlan,
      ],
      timers: [timer({ id: "long", endTime: anchor })],
    });
    const groups = liftGroups(current, T0 + 180 * SECOND);
    expect(groups[0]).toMatchObject({ group: "g1", anchor, started: true });
    expect(visibleGroups(groups).map((group) => group.group)).toEqual(["g1", "g2"]);
    // extra は表示できる群 G2 の品目である（釜 0 に出ないのが「群に無い」ことの帰結でないと言うため）。
    expect(groups[1]!.items.map((item) => item.order.externalOrderId)).toEqual(["other", "extra"]);
    const bySlot = suggestionsAt(current, T0 + 180 * SECOND);
    // 180 秒には mid（150 秒）・short（180 秒）の startAt が来ており、店舗全体の先頭 arms 2 本として濃い。
    // G2 の other（200 秒）は Prep_Lead（140 秒）が来て薄く現れるが、startAt の前なので後続（AC 2.3）。
    expect(bySlot.get(1)?.[0]).toMatchObject({ role: "head" });
    expect(bySlot.get(2)?.[0]).toMatchObject({ role: "head" });
    expect(bySlot.get(3)?.[0]).toMatchObject({ role: "member" });
    // extra の Prep_Lead（170 秒）は来ているが、指す釜 0 は走行中——占有された釜には導出の段で何も出ない
    // （slotDisplay が idle でない釜に載せないこととは別に、全釜 idle の判定が推奨そのものを落とす・AC 2.7）。
    expect(bySlot.has(0)).toBe(false);
  });

  it("同じ釜に 2 件以上の提案が並ぶとき、配列は startAt 昇順である（AC 2.11・受信順に依らない）", () => {
    // G1（started・錨 600 秒）の残り 2 品が釜 1 を指す（rest1 は 240 秒・rest2 は 270 秒で serveAt 600 秒に揃う）。
    // 別卓の G2（g2・開始予定 300 秒）も釜 1 を指す。推奨は startAt の降順で受信させ、並びが導出の側で決まることを見る。
    const anchor = T0 + 600 * SECOND;
    const rest1 = order({ externalOrderId: "rest1", noodleType: "Mid" });
    const rest2 = order({ externalOrderId: "rest2", noodleType: "Short" });
    const g2 = order({ externalOrderId: "g2", tableId: "t-2", noodleType: "Short" });
    const current = view({
      pendingOrders: [g2, rest2, rest1],
      recommendations: [
        recommendation("g2", ["1"], T0 + 300 * SECOND, "g2"),
        recommendation("rest2", ["1"], T0 + 270 * SECOND, "g1", anchor),
        recommendation("rest1", ["1"], T0 + 240 * SECOND, "g1", anchor),
      ],
      timers: [timer({ id: "mate", endTime: anchor })],
    });
    const onSlot1 = suggestionsAt(current, T0 + 300 * SECOND).get(1) ?? [];
    expect(onSlot1.map((suggestion) => suggestion.item.order.externalOrderId)).toEqual([
      "rest1",
      "rest2",
      "g2",
    ]);
    expect(onSlot1.map((suggestion) => suggestion.item.suggestion.startAt)).toEqual([
      T0 + 240 * SECOND,
      T0 + 270 * SECOND,
      T0 + 300 * SECOND,
    ]);
    // 濃いのは店舗全体で先頭 arms 2 本——並び（群の順・品目の順）の先頭の rest1・rest2。G2 の g2 は startAt が
    // 過ぎていても 3 本目で後続（判断 21）。arms 1 なら rest1 だけ。
    expect(onSlot1.map((suggestion) => suggestion.role)).toEqual(["head", "head", "member"]);
    const onSlot1WithOneArm =
      suggestionsAt({ ...current, arms: 1 }, T0 + 300 * SECOND).get(1) ?? [];
    expect(onSlot1WithOneArm.map((suggestion) => suggestion.role)).toEqual([
      "head",
      "member",
      "member",
    ]);
  });

  it("started は anchor と Corrected_Now だけで決まる——anchor null・anchor が過去・anchor ちょうどは偽で、Timer の一致は読まない", () => {
    const serveAt = T0 + 510 * SECOND;
    const startedWith = (anchor: number | null, timers: readonly ClientTimer[]) =>
      liftGroups(
        view({
          pendingOrders: [THREE[1]!, THREE[2]!],
          recommendations: [
            recommendation("mid", ["1"], T0 + 150 * SECOND, "g1", anchor),
            recommendation("short", ["2"], T0 + 180 * SECOND, "g1", anchor),
          ],
          timers,
        }),
        T0,
      )[0]!.started;
    // 合流していない（anchor null）群は、serveAt に一致する走行中 Timer が在っても started でない（AC 1.7）。
    expect(startedWith(null, [timer({ id: "coincidence", endTime: serveAt })])).toBe(false);
    // 錨が過去（茹で上がり）・ちょうど今は started でない。錨が未来なら、Timer が一つも無くても started である
    // ——途中接続した端末が Timer を持たなくても同じ結論に達する（判断 20）。
    expect(startedWith(T0 - SECOND, [])).toBe(false);
    expect(startedWith(T0, [])).toBe(false);
    expect(startedWith(T0 + SECOND, [])).toBe(true);
    // 錨は serveAt に一致しなくてよい（合流した品目の serveAt は錨と h_i 以内でずれる・lift-group-planning 判断 18）。
    expect(startedWith(serveAt - 5 * SECOND, [timer({ id: "mate", endTime: serveAt })])).toBe(true);
  });

  it("茹で上がりの転移：599 秒では G2 が見え、600 秒（錨）で G1 が started でなくなり G2 は隠れ、G1 の残りが先頭として濃く残る", () => {
    // 錨は 600 秒。G1 の残り 1 品（開始予定 240 秒・茹で 360 秒）と、別卓の G2（開始予定 300 秒）。
    const anchor = T0 + 600 * SECOND;
    const rest = order({ externalOrderId: "rest", noodleType: "Mid" });
    const g2 = order({ externalOrderId: "g2", tableId: "t-2", noodleType: "Short" });
    const current = view({
      pendingOrders: [rest, g2],
      recommendations: [
        recommendation("rest", ["1"], T0 + 240 * SECOND, "g1", anchor),
        recommendation("g2", ["2"], T0 + 300 * SECOND, "g2"),
      ],
      timers: [timer({ id: "mate", endTime: anchor })],
    });
    // 599 秒には rest（240 秒）と g2（300 秒）の両方の startAt が来ており、2 本とも arms 2 の内側で濃い。
    const at599 = suggestionsAt(current, T0 + 599 * SECOND);
    expect(at599.get(1)?.[0]).toMatchObject({ role: "head" });
    expect(at599.get(2)?.[0]).toMatchObject({ role: "head" });
    const at600 = suggestionsAt(current, T0 + 600 * SECOND);
    expect(liftGroups(current, T0 + 600 * SECOND)[0]!.started).toBe(false);
    expect(at600.get(1)?.[0]).toMatchObject({ role: "head" });
    expect(at600.has(2)).toBe(false);
  });
});

describe("Feature: lift-group-display — 群に入らない推奨・group だけが鍵・全釜 idle（AC 1.2・1.3・2.7）", () => {
  it("品目が待ち行列に無い・麺種がプリセットに無い推奨は群に入らない", () => {
    const retired = order({ externalOrderId: "retired", noodleType: "Retired" });
    const current = view({
      pendingOrders: [THREE[0]!, retired],
      recommendations: [
        THREE_PLAN[0]!,
        recommendation("retired", ["1"], T0, "g1"),
        recommendation("absent", ["2"], T0, "g1"),
      ],
    });
    const groups = liftGroups(current, T0);
    expect(
      groups.flatMap((group) => group.items.map((item) => item.order.externalOrderId)),
    ).toEqual(["long"]);
  });

  it("卓なしの品目は engine が 1 品 1 群に置く——同じ serveAt でも group が違えば束ならず、錨が無いので 1 本ずつ現れる", () => {
    const a = order({ externalOrderId: "a", tableId: null });
    const b = order({ externalOrderId: "b", tableId: null });
    const current = view({
      pendingOrders: [a, b],
      recommendations: [recommendation("a", ["0"], T0, "ga"), recommendation("b", ["1"], T0, "gb")],
    });
    const groups = liftGroups(current, T0);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.anchor === null && !group.started)).toBe(true);
    // 先頭の群だけが見える（合流していない群は started を持たないので 1 本ずつ現れる）。
    expect(visibleGroups(groups)).toHaveLength(1);
  });

  it("群の鍵は group だけ——同じ卓・同じ serveAt でも group が違えば別の群、serveAt が違っても group が同じなら一つの群", () => {
    // 同じ卓 t-1・同じ serveAt 510 秒の 2 品を、engine が別の群に置いた snapshot。
    const split = view({
      pendingOrders: [THREE[0]!, THREE[1]!],
      recommendations: [
        recommendation("long", ["0"], T0, "g1"),
        recommendation("mid", ["1"], T0 + 150 * SECOND, "g2"),
      ],
    });
    expect(liftGroups(split, T0).map((group) => group.group)).toEqual(["g1", "g2"]);
    // serveAt が 510 秒と 540 秒でずれていても、同じ group なら一つの群（client は serveAt の等号を見ない）。
    const skewed = view({
      pendingOrders: [THREE[0]!, THREE[1]!],
      recommendations: [
        recommendation("long", ["0"], T0, "g1"),
        recommendation("mid", ["1"], T0 + 180 * SECOND, "g1"),
      ],
    });
    const groups = liftGroups(skewed, T0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((item) => item.suggestion.serveAt)).toEqual([
      T0 + 510 * SECOND,
      T0 + 540 * SECOND,
    ]);
  });

  it("複数釜の推奨は一部の釜が埋まっていればどの釜にも出ず、boiled の釜も埋まっている", () => {
    const wide = order({ externalOrderId: "wide", slotSpan: 2 });
    const plan = recommendation("wide", ["0", "1"], T0, "g1");
    const idle = view({ pendingOrders: [wide], recommendations: [plan] });
    expect([...suggestionsAt(idle, T0).keys()].sort()).toEqual([0, 1]);
    // 釜 1 が茹で上がり（endTime ≤ corrected）でも Complete までは埋まっている。担当外のアドホック Timer でも同じ。
    const boiled = view({
      pendingOrders: [wide],
      recommendations: [plan],
      timers: [timer({ id: "b", slotIds: nonEmpty(["1"]), endTime: T0 - SECOND })],
    });
    expect(suggestionsAt(boiled, T0).size).toBe(0);
  });
});

describe("Feature: lift-group-display — 釜の組（pairSlots・判断 10）", () => {
  const empty = view({});

  it("slotSpan 1 は押した釜だけ。起点の釜が埋まっていれば slotSpan 1 でも null", () => {
    expect(pairSlots(3, 1, empty)).toEqual(["3"]);
    const taken = view({
      timers: [timer({ id: "t", slotIds: nonEmpty(["3"]), endTime: T0 + 60 * SECOND })],
    });
    expect(pairSlots(3, 1, taken)).toBeNull();
    expect(pairSlots(3, 2, taken)).toBeNull();
  });

  it("最も近い空き釜を近い順に、同距離は index で断つ（既定の台：横 10・縦 10・斜め 14）", () => {
    // 釜 0 から：釜 1（横）と釜 2（縦）が 10 で同距離 → index の小さい釜 1。次は釜 2、その次に斜めの釜 3。
    expect(pairSlots(0, 2, empty)).toEqual(["0", "1"]);
    expect(pairSlots(0, 3, empty)).toEqual(["0", "1", "2"]);
    expect(pairSlots(0, 4, empty)).toEqual(["0", "1", "2", "3"]);
    // 釜 1 が埋まっていれば釜 2、次は斜めの釜 3。
    const taken = view({
      timers: [timer({ id: "t", slotIds: nonEmpty(["1"]), endTime: T0 + 60 * SECOND })],
    });
    expect(pairSlots(0, 2, taken)).toEqual(["0", "2"]);
    expect(pairSlots(0, 3, taken)).toEqual(["0", "2", "3"]);
  });

  it("許容距離の内側に足りなければ null（既定 14 は斜め隣接まで・2 マス直線の 20 は届かない）", () => {
    // 釜 0 の隣接（1・2・3）が埋まると、残りは釜 4（縦 2 マス＝20）と釜 5（24）で内側に無い。
    const boxed = view({
      timers: [timer({ id: "t", slotIds: nonEmpty(["1", "2", "3"]), endTime: T0 + 60 * SECOND })],
    });
    expect(pairSlots(0, 2, boxed)).toBeNull();
    // 許容距離を広げれば釜 4 が組める（距離は config の許容距離で測る・AC 4.7）。
    expect(pairSlots(0, 2, { ...boxed, affinityToleranceDistance: 20 })).toEqual(["0", "4"]);
    // 5 釜要る品目は、6 釜のうち 1 つでも許容距離の外なら組めない（釜 0 から釜 4・5 は 20・24）。
    expect(pairSlots(0, 5, empty)).toBeNull();
  });

  it("担当ユニットを跨いでよい——距離が近ければ別の台の釜も組む（既定の台の離隔では届かない）", () => {
    const two = view({ unitCount: 2, unitOrigins: defaultUnitOrigins(2) });
    // 釜 1（x=1）から隣の台の釜 6（x=4）は 30。既定の 14 では届かず、同じ台の釜 0・3 が組まれる。
    expect(pairSlots(1, 3, two)).toEqual(["1", "0", "3"]);
    // 許容距離 30 なら、同じ台の釜（0・3 が 10、2 が 14、5 が 20、4 が 24）を使い切った後に釜 6（30）が組まれる。
    const wide = { ...two, affinityToleranceDistance: 30 };
    expect(pairSlots(1, 6, wide)).toEqual(["1", "0", "3", "2", "5", "4"]);
    // 釜 4・5 が埋まれば釜 6 が繰り上がる。釜 8（x=4, y=1）は 34 で内側に無く、6 釜要る品目は組めない。
    const taken = {
      ...wide,
      timers: [timer({ id: "t", slotIds: nonEmpty(["4", "5"]), endTime: T0 + SECOND })],
    };
    expect(pairSlots(1, 5, taken)).toEqual(["1", "0", "3", "2", "6"]);
    expect(pairSlots(1, 6, taken)).toBeNull();
  });
});
