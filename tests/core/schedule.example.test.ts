// engine/schedule の回帰テスト——slot 解放表（initialRelease・要件3.3）・自前解（baselineSchedule・要件4）・
// 外部計画の生値の関門（toCookSchedule・AC 10.3）。
//
// baselineSchedule 側は Property 1・2・15 が「feasible である」「順序に依らない」「64 件で切れる」を全域で
// 言うが、**どんな計画を出すか**は言わない（どの釜を選び、提供時刻をどこへ揃え、開始時刻を何秒逆算するか）。
// ゆえに代表シナリオ 4 つを具体値で固定する（要件3.4 / 4.2 / 11.2）。
//
// 解放表は貪欲法の初期状態であり、「同一 slot の時間帯を重複させない」というハード制約を
// 所与として織り込む唯一の経路である。ゆえに 3 つの slot の姿——走行中・茹で上がり済み・空き——が
// それぞれ期待どおりの時刻になることを固定する。とくに boiled は釜としては空いている
// （湯切りで麺が上がる。Complete は UI 上の確認であって占有ではない）。

import { describe, it, expect } from "vitest";
import {
  PLAN_TARGET_LIMIT,
  baselineSchedule,
  initialRelease,
  isStale,
  keepsAnchor,
  placeableTargets,
  planTargets,
  toCookSchedule,
  type Placement,
} from "../../src/engine/schedule";
import { scoreSchedule, type ScheduleParams } from "../../src/engine/objective";
import { recommend } from "../../src/engine/recommend";
import {
  changeCost,
  shownPlanOf,
  type ChangeContext,
  type ShownItem,
} from "../../src/engine/stability";
import {
  advanceLifts,
  initialLifts,
  liftCap,
  liftsOf,
  loadWith,
  type LiftTable,
} from "../../src/engine/lift";
import { tableMembers } from "../../src/engine/project";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import type { Firmness } from "../../src/domain/firmness";
import {
  DEFAULT_NOODLE_PRESETS,
  HELPER_ARMS,
  occupiedSlotsOf,
  type NoodlePreset,
} from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";
import {
  changeCostOf,
  EXPIRY_PARAMS,
  EXPIRY_PRESETS,
  mixedScene,
  startOffsets,
} from "./expiryScenes";

const NOW = 1_000_000 as EpochMillis;

/** slot 1 個を占める Timer。endTime と boiledAt / adjustment だけを振る。 */
function timerOn(input: {
  id: string;
  slot: string;
  endTime: number;
  boiledAt?: number | null;
  adjustment?: number;
  /** 由来する卓。走行中の仲間として計画の錨になる（lift-group-planning）。 */
  tableId?: string;
}) {
  return createTimer({
    id: input.id as TimerId,
    slotIds: nonEmpty([input.slot as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: "normal",
    startTime: (input.endTime - 60_000) as EpochMillis,
    endTime: input.endTime as EpochMillis,
    seq: 0,
    boiledAt: (input.boiledAt ?? null) as EpochMillis | null,
    adjustment: input.adjustment ?? 0,
    orderItem:
      input.tableId === undefined
        ? null
        : { externalOrderId: `run-${input.id}`, itemIndex: 0, tableId: input.tableId },
  });
}

describe("initialRelease — slot の最早解放時刻", () => {
  it("running / boiled / 空き slot がそれぞれの解放時刻になる", () => {
    // slot 0: 走行中（30 秒後に上がる）／slot 1: 茹で上がり済み（10 秒前に上がった）／slot 2..5: 空き。
    const running = timerOn({ id: "t-running", slot: "0", endTime: NOW + 30_000 });
    const boiled = timerOn({
      id: "t-boiled",
      slot: "1",
      endTime: NOW - 10_000,
      boiledAt: NOW - 10_000,
    });

    const release = initialRelease([running, boiled], NOW, 6);

    expect(release).toEqual([NOW + 30_000, NOW, NOW, NOW, NOW, NOW]);
    // boiled の釜は今すぐ空いている（解放済み）。
    expect(release[1]).toBeLessThanOrEqual(NOW);
  });

  it("解放時刻は実効 endTime（endTime + adjustment）で立つ", () => {
    // Boil_Sync が 5 秒早めた Timer。オリジナル endTime ではなく実効値が釜の解放時刻を決める。
    const adjusted = timerOn({
      id: "t-adjusted",
      slot: "0",
      endTime: NOW + 30_000,
      adjustment: -5_000,
    });

    expect(initialRelease([adjusted], NOW, 6)[0]).toBe(NOW + 25_000);
  });

  it("複数 slot を占める Timer はそのすべての slot を塞ぐ", () => {
    const wide = createTimer({
      id: "t-wide" as TimerId,
      slotIds: nonEmpty(["2" as SlotId, "3" as SlotId]),
      noodleType: "Thick" as NoodleType,
      firmness: "normal",
      startTime: NOW as EpochMillis,
      endTime: (NOW + 120_000) as EpochMillis,
      seq: 0,
    });

    expect(initialRelease([wide], NOW, 6)).toEqual([
      NOW,
      NOW,
      NOW + 120_000,
      NOW + 120_000,
      NOW,
      NOW,
    ]);
  });

  it("表の外を指す slot は解放表に現れない（存在しない釜は計画の置き場所にならない）", () => {
    const outside = timerOn({ id: "t-outside", slot: "9", endTime: NOW + 30_000 });

    expect(initialRelease([outside], NOW, 6)).toEqual([NOW, NOW, NOW, NOW, NOW, NOW]);
  });
});

/** 既定値の採点パラメータ（1 ユニット＝6 slot・既定レイアウト）。8 項目は StoreConfig の残余と同型である。 */
// 許容 10%（h_i = 60 秒）を前提にした場面。既定は 5% に下がった（2026-09-07）
const PARAMS: ScheduleParams = { ...schedulingDefaults(1), toleranceRatio: 10 };

/** 空の厨房（6 slot すべてが今すぐ空いている）。 */
const EMPTY_KITCHEN = initialRelease([], NOW, 6);
/** 走行中の仲間が居ない卓の成員表。 */
const NO_MEMBERS = tableMembers([]);
/** 上がりの無い上げ表（走行中なし）。 */
const NO_LIFTS = initialLifts([]);

/** Pending_Order 1 件。既定プリセットの茹で時間は Thin 60 秒 / Medium 90 秒 / Thick 120 秒（normal）。 */
function pendingItem(input: {
  orderId: string;
  itemIndex?: number;
  noodleType?: string;
  firmness?: Firmness;
  tableId?: string | null;
  arrivalTime?: number;
  slotSpan?: number;
}): OrderItem {
  return {
    externalOrderId: input.orderId,
    itemIndex: input.itemIndex ?? 0,
    noodleType: input.noodleType ?? "Thin",
    firmness: input.firmness ?? "normal",
    tableId: input.tableId ?? null,
    arrivalTime: input.arrivalTime ?? NOW,
    slotSpan: input.slotSpan ?? 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  };
}

/** 配置を照合しやすい形へ（slot 番号・開始と提供の相対秒）。 */
function readable(placement: {
  externalOrderId: string;
  itemIndex: number;
  slotIds: readonly string[];
  startAt: number;
  serveAt: number;
}) {
  return {
    item: `${placement.externalOrderId}#${placement.itemIndex}`,
    slots: [...placement.slotIds],
    startSeconds: (placement.startAt - NOW) / 1000,
    serveSeconds: (placement.serveAt - NOW) / 1000,
  };
}

describe("baselineSchedule — 単独オーダー 1 品目", () => {
  it("今すぐ開始し、slot は index の小さいほうから採る", () => {
    const pending = [pendingItem({ orderId: "o-1" })];

    const schedule = baselineSchedule(
      pending,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    expect(schedule.slices).toHaveLength(1);
    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      // 全 slot が同時に空いているため affinity では差が付かず、slot index 昇順で断つ。
      { item: "o-1#0", slots: ["0"], startSeconds: 0, serveSeconds: 60 },
    ]);
    // Σ Wait_Time = 60 秒。単独品目にソフト制約の超過は生じない。採点は計画の外（比較の時点）で行う。
    expect(
      scoreSchedule(
        schedule.slices,
        pending,
        { members: NO_MEMBERS, lifts: NO_LIFTS, change: null },
        PARAMS,
      ),
    ).toEqual({
      total: 60,
      bySlice: [60],
    });
  });

  it("プリセットに無い麺種は配置されない（計画にも現れない）", () => {
    // 設定の差し替えを跨いだ待ち行列にだけ現れ得る形。既定の茹で時間を当てて嘘の計画を作らない。
    const pending = [pendingItem({ orderId: "o-1", noodleType: "Ghost" })];

    expect(
      baselineSchedule(
        pending,
        EMPTY_KITCHEN,
        NO_MEMBERS,
        NO_LIFTS,
        DEFAULT_NOODLE_PRESETS,
        PARAMS,
        NOW,
        occupiedSlotsOf([]),
        null,
      ),
    ).toEqual({
      slices: [],
    });
  });

  it("Pending_Order が空なら空の計画", () => {
    expect(
      baselineSchedule(
        [],
        EMPTY_KITCHEN,
        NO_MEMBERS,
        NO_LIFTS,
        DEFAULT_NOODLE_PRESETS,
        PARAMS,
        NOW,
        occupiedSlotsOf([]),
        null,
      ),
    ).toEqual({
      slices: [],
    });
  });
});

describe("baselineSchedule — 同卓 3 品目（同一オーダー 2 品目）", () => {
  // 卓 t-1 に 2 オーダー。オーダー A は Thin（60 秒）と Thick（120 秒）、オーダー B は Medium（90 秒）。
  const pending = [
    pendingItem({ orderId: "A", itemIndex: 0, noodleType: "Thin", tableId: "t-1" }),
    pendingItem({ orderId: "A", itemIndex: 1, noodleType: "Thick", tableId: "t-1" }),
    pendingItem({ orderId: "B", itemIndex: 0, noodleType: "Medium", tableId: "t-1" }),
  ];

  it("提供時刻が群の錨に一致し、茹での短い品目は開始が後ろへ逆算される", () => {
    const schedule = baselineSchedule(
      pending,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    expect(schedule.slices).toHaveLength(1);
    expect(schedule.slices[0]!.tableKey).toBe("t-1");
    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      // 茹での長い Thick が最も早く空く釜（slot 0）へ。錨は「解放 + 茹で」の最大 120 秒で、全員が
      // そこに揃う——Thin は 60 秒、Medium は 30 秒、開始を後ろへ逆算する（許容幅の内側に散らさない）。
      { item: "A#0", slots: ["2"], startSeconds: 60, serveSeconds: 120 },
      { item: "A#1", slots: ["0"], startSeconds: 0, serveSeconds: 120 },
      { item: "B#0", slots: ["1"], startSeconds: 30, serveSeconds: 120 },
    ]);
  });

  it("揃った群は卓の遅れもオーダーの超過も 0、slot も隣接ゆえ affinity 0（Σ Wait_Time だけが残る）", () => {
    const schedule = baselineSchedule(
      pending,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    // 全員 120 秒に揃うので卓の遅れ 0・オーダー内の差 0。slot 0・1・2 は縦横/斜め隣接で affinity 0。
    // 同じ窓に 3 本は arms 2 を 1 本超え、手伝いの費用（Lift_Overflow）1 本 × 45 秒相当が total にだけ載る
    // （lift-group-planning AC 9.6・9.7）。ゆえに bySlice は Σ Wait_Time = 120 × 3 = 360、total は 360 + 45 = 405。
    expect(
      scoreSchedule(
        schedule.slices,
        pending,
        { members: NO_MEMBERS, lifts: NO_LIFTS, change: null },
        PARAMS,
      ),
    ).toEqual({
      total: 405,
      bySlice: [360],
    });
  });
});

describe("baselineSchedule — 釜が埋まっている", () => {
  it("最も早く空く釜を選び、開始時刻がその解放時刻まで後ろへ倒れる", () => {
    // 6 slot すべてが走行中。slot 5 が最も早く（20 秒後に）空く。
    const running = [
      timerOn({ id: "t-0", slot: "0", endTime: NOW + 120_000 }),
      timerOn({ id: "t-1", slot: "1", endTime: NOW + 100_000 }),
      timerOn({ id: "t-2", slot: "2", endTime: NOW + 80_000 }),
      timerOn({ id: "t-3", slot: "3", endTime: NOW + 60_000 }),
      timerOn({ id: "t-4", slot: "4", endTime: NOW + 40_000 }),
      timerOn({ id: "t-5", slot: "5", endTime: NOW + 20_000 }),
    ];
    const pending = [pendingItem({ orderId: "o-1", noodleType: "Thin" })];

    const schedule = baselineSchedule(
      pending,
      initialRelease(running, NOW, 6),
      tableMembers(running),
      initialLifts(running),
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf(running),
      null,
    );

    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "o-1#0", slots: ["5"], startSeconds: 20, serveSeconds: 80 },
    ]);
    // Wait_Time は 80 秒（釜が空くのを待った 20 秒を含む）。走行中の卓なし Timer は成員にならない。
    // Lift_Overflow は店舗全体の表で数える（AC 9.6）：走行中 20/40/60 秒の窓 [20,65) は 3 本で 1 本超過、
    // 80/80/100/120 秒の窓 [80,125) は配置を含めて 4 本で 2 本超過。3 × 45 = 135 が total にだけ載る。
    expect(
      scoreSchedule(
        schedule.slices,
        pending,
        { members: tableMembers(running), lifts: initialLifts(running), change: null },
        PARAMS,
      ),
    ).toEqual({ total: 80 + 135, bySlice: [80] });
  });
});

describe("baselineSchedule — 64 件境界で Table_Group が割れる", () => {
  // 先に届いた単独品目 63 件と、後から届いた 3 品目の卓。境界は卓の 1 品目目で切れる。
  const solo = Array.from({ length: PLAN_TARGET_LIMIT - 1 }, (_unused, index) =>
    pendingItem({
      orderId: `s-${String(index).padStart(2, "0")}`,
      arrivalTime: NOW - 100_000 + index,
    }),
  );
  const table = [0, 1, 2].map((itemIndex) =>
    pendingItem({ orderId: "o-big", itemIndex, tableId: "t-big", arrivalTime: NOW }),
  );

  it("計画対象に入った品目のみで PlanSlice を成す（残りは計画に現れない）", () => {
    const schedule = baselineSchedule(
      [...solo, ...table],
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );
    const placed = schedule.slices.flatMap((slice) => slice.placements);
    const split = schedule.slices.find((slice) => slice.tableKey === "t-big");

    expect(placed).toHaveLength(PLAN_TARGET_LIMIT);
    expect(split?.placements.map((placement) => placement.itemIndex)).toEqual([0]);
  });

  it("割れた卓のソフト制約は対象品目の間だけで評価される（部分和は Wait_Time のみ）", () => {
    const schedule = baselineSchedule(
      [...solo, ...table],
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );
    const split = schedule.slices.find((slice) => slice.tableKey === "t-big")!;
    const placement = split.placements[0]!;

    // 計画に入らなかった 2 品目は同卓・同一オーダーの差の計算に現れない。1 品目だけの一片ゆえ
    // 提供時刻差も slot 対も存在せず、部分和は当該品目の Wait_Time に一致する。
    const score = scoreSchedule(
      [split],
      [...solo, ...table],
      { members: NO_MEMBERS, lifts: NO_LIFTS, change: null },
      PARAMS,
    );
    expect(score.bySlice[0]).toBe(Math.floor((placement.serveAt - NOW) / 1000));
  });
});

// toCookSchedule — 外部から届いた生値の関門（AC 10.3）。固定するのは「形が立てば通る」ことと、
// **1 箇所の不正が全体を落とす**こと（部分採用をしない）。釜の重複・茹で時間との整合は admit の担当ゆえ
// ここでは見ない（admit.example.test.ts が固定している）。
describe("toCookSchedule — 外部計画の生値の検証", () => {
  /** 妥当な計画の生値（JSON を跨いだ後の形＝ブランドも非空の保証も落ちた素の値）。 */
  function rawPlan(): unknown {
    return {
      score: 120,
      slices: [
        {
          tableKey: "t-1",
          score: 70,
          placements: [
            {
              externalOrderId: "o-1",
              itemIndex: 0,
              slotIds: ["0"],
              startAt: NOW,
              serveAt: NOW + 60_000,
              anchor: null,
            },
          ],
        },
        {
          tableKey: "t-2",
          score: 50,
          placements: [
            {
              externalOrderId: "o-2",
              itemIndex: 1,
              slotIds: ["1", "2"],
              startAt: NOW,
              serveAt: NOW + 90_000,
              // 走行中の仲間 90 秒に合流したという主張（真偽はここでは見ない・admit の (e)）。
              anchor: NOW + 90_000,
            },
          ],
        },
      ],
    };
  }

  it("妥当な生値は CookSchedule へ写り、余剰フィールド（外部が添えた score を含む）は落ちる", () => {
    const raw = rawPlan() as { slices: { placements: Record<string, unknown>[] }[] };
    raw.slices[0]!.placements[0]!.injected = "外部の混ぜ物";

    const plan = toCookSchedule(raw);

    expect(plan).not.toBeNull();
    expect(plan).not.toHaveProperty("score");
    expect(plan!.slices.map((slice) => slice.tableKey)).toEqual(["t-1", "t-2"]);
    expect(plan!.slices[1]!.placements[0]!.slotIds).toEqual(["1", "2"]);
    expect(plan!.slices[0]!.placements[0]).toEqual({
      externalOrderId: "o-1",
      itemIndex: 0,
      slotIds: ["0"],
      startAt: NOW,
      serveAt: NOW + 60_000,
      anchor: null,
    });
    expect(plan!.slices[1]!.placements[0]!.anchor).toBe(NOW + 90_000);
  });

  it("anchor は明示の主張を要る——欠如・非整数は全体を落とし、null は合流無しとして通る（AC 9.9）", () => {
    // 欠如を「合流していない」と読み替えれば、契約を知らない外部解が黙って合流無しの計画として通る。
    const missing = rawPlan() as { slices: { placements: Record<string, unknown>[] }[] };
    delete missing.slices[1]!.placements[0]!.anchor;
    expect(toCookSchedule(missing)).toBeNull();

    const fractional = rawPlan() as { slices: { placements: { anchor: unknown }[] }[] };
    fractional.slices[1]!.placements[0]!.anchor = NOW + 90_000.5;
    expect(toCookSchedule(fractional)).toBeNull();

    const text = rawPlan() as { slices: { placements: { anchor: unknown }[] }[] };
    text.slices[1]!.placements[0]!.anchor = "600";
    expect(toCookSchedule(text)).toBeNull();

    const none = rawPlan() as { slices: { placements: { anchor: unknown }[] }[] };
    none.slices[1]!.placements[0]!.anchor = null;
    expect(toCookSchedule(none)!.slices[1]!.placements[0]!.anchor).toBeNull();
  });

  it("slotIds が空の配置は全体を落とす（Placement は非空を型で要求する）", () => {
    const raw = rawPlan() as { slices: { placements: { slotIds: readonly string[] }[] }[] };
    raw.slices[0]!.placements[0]!.slotIds = [];

    expect(toCookSchedule(raw)).toBeNull();
  });

  it("後方の一片の 1 配置が不正でも全体を落とす（妥当な接頭辞を残さない）", () => {
    const raw = rawPlan() as { slices: { placements: { itemIndex: number }[] }[] };
    raw.slices[1]!.placements[0]!.itemIndex = 0.5;

    expect(toCookSchedule(raw)).toBeNull();
  });

  it("score は読まない（小数でも通る）。object でない生値は落とす", () => {
    // 計画は点数を持たない（採点は比較の時点の導出）。読まない値を検証すれば、検証だけを理由に計画が落ちる。
    const fractional = rawPlan() as { score: number };
    fractional.score = 1.5;

    expect(toCookSchedule(fractional)).not.toBeNull();
    expect(toCookSchedule("計画ではない文字列")).toBeNull();
    expect(toCookSchedule(null)).toBeNull();
  });
});

describe("baselineSchedule — 同時に上げる群（lift-group-planning）", () => {
  it("走行中の仲間が錨になり、未着手の品目はその提供時刻へ揃う（1 本目を入れた後も群が崩れない）", () => {
    // 卓 t-1 の 1 本目が釜 5 で走行中（200 秒後に上がる）。残りの Thin（60 秒）は 140 秒後に始めて 200 秒に揃う。
    const running = [timerOn({ id: "t-first", slot: "5", endTime: NOW + 200_000, tableId: "t-1" })];
    const pending = [
      pendingItem({ orderId: "A", itemIndex: 1, noodleType: "Thin", tableId: "t-1" }),
    ];

    const schedule = baselineSchedule(
      pending,
      initialRelease(running, NOW, 6),
      tableMembers(running),
      initialLifts(running),
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf(running),
      null,
    );

    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "A#1", slots: ["0"], startSeconds: 140, serveSeconds: 200 },
    ]);
    // 合流の所属は配置が持つ（AC 9.9）——錨は合流先の走行中の実効 endTime。
    expect(schedule.slices[0]!.placements[0]!.anchor).toBe(NOW + 200_000);
  });

  it("走行中が earliest から h_i 以内なら earliest に置き、錨はその走行中（判断 18・AC 9.9）", () => {
    // 仲間は 65 秒後に上がる。Thin（60 秒・h_i = 6 秒）は今始めれば 60 秒——5 秒の差は窓の内側なので待たずに
    // 始め、serveAt は 60 秒のまま、所属（anchor）は 65 秒の走行中になる。
    const running = [timerOn({ id: "t-first", slot: "5", endTime: NOW + 65_000, tableId: "t-1" })];
    const pending = [
      pendingItem({ orderId: "A", itemIndex: 1, noodleType: "Thin", tableId: "t-1" }),
    ];

    const schedule = baselineSchedule(
      pending,
      initialRelease(running, NOW, 6),
      tableMembers(running),
      initialLifts(running),
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf(running),
      null,
    );

    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "A#1", slots: ["0"], startSeconds: 0, serveSeconds: 60 },
    ]);
    expect(schedule.slices[0]!.placements[0]!.anchor).toBe(NOW + 65_000);
  });

  it("届かない品目があれば群ごと錨より後ろへずれる（走行中との差は減点として残る・AC 3.4）", () => {
    // 1 本目は 30 秒後に上がるが、残りの Thick（120 秒）は今始めても 120 秒後。錨は max(30, 120) = 120。
    const running = [timerOn({ id: "t-first", slot: "5", endTime: NOW + 30_000, tableId: "t-1" })];
    const pending = [
      pendingItem({ orderId: "A", itemIndex: 1, noodleType: "Thick", tableId: "t-1" }),
      pendingItem({ orderId: "A", itemIndex: 2, noodleType: "Thin", tableId: "t-1" }),
    ];

    const schedule = baselineSchedule(
      pending,
      initialRelease(running, NOW, 6),
      tableMembers(running),
      initialLifts(running),
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf(running),
      null,
    );

    // 未着手の 2 本は互いに揃い（120 秒）、走行中の 30 秒には届かない。届かない batch は合流ではない（anchor null）。
    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "A#1", slots: ["0"], startSeconds: 0, serveSeconds: 120 },
      { item: "A#2", slots: ["1"], startSeconds: 60, serveSeconds: 120 },
    ]);
    expect(schedule.slices[0]!.placements.map((p) => p.anchor)).toEqual([null, null]);
  });

  it("boiled の仲間（実効 endTime が過去）は錨を過去へ引き下げない", () => {
    const running = [
      timerOn({
        id: "t-done",
        slot: "5",
        endTime: NOW - 10_000,
        boiledAt: NOW - 10_000,
        tableId: "t-1",
      }),
    ];
    const pending = [
      pendingItem({ orderId: "A", itemIndex: 1, noodleType: "Thin", tableId: "t-1" }),
    ];

    const schedule = baselineSchedule(
      pending,
      initialRelease(running, NOW, 6),
      tableMembers(running),
      initialLifts(running),
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf(running),
      null,
    );

    // 錨は max(過去, 今 + 60 秒) = 60 秒。今すぐ始める。
    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "A#1", slots: ["0"], startSeconds: 0, serveSeconds: 60 },
    ]);
  });

  it("slotSpan 2 の品目は 2 釜を占め、同じ卓の 1 釜の品目と提供時刻が揃う", () => {
    const pending = [
      pendingItem({ orderId: "A", itemIndex: 0, noodleType: "Thin", tableId: "t-1", slotSpan: 2 }),
      pendingItem({ orderId: "A", itemIndex: 1, noodleType: "Thick", tableId: "t-1" }),
    ];

    const schedule = baselineSchedule(
      pending,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    // 長い Thick が最も早く空く釜（全部同時に空くので slot 0）へ、Thin は続く 2 釜（1・2）を占める。
    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "A#0", slots: ["1", "2"], startSeconds: 60, serveSeconds: 120 },
      { item: "A#1", slots: ["0"], startSeconds: 0, serveSeconds: 120 },
    ]);
  });

  it("釜容量（slotSpan の合計）を超える卓は batch に割れ、batch は上げ窓に載る本数で窓に割れ、跨ぎは減点になる", () => {
    // 6 釜の店に、同じ卓の Thin が 7 本。6 本で 1 batch、7 本目は釜が空く 60 秒後に始まる。
    // batch の 6 本は上げ窓（arms 2 + 手伝い 2 = 4 本・L 45 秒）で 4 本と 2 本に割れ、後の 2 本は次の窓 105 秒へ
    // （判断 20）。7 本目は釜が空く 60 秒から茹でて 120 秒——[105,150) の窓は 2 + 1 = 3 本で上限内。
    const pending = Array.from({ length: 7 }, (_unused, itemIndex) =>
      pendingItem({ orderId: "A", itemIndex, noodleType: "Thin", tableId: "t-1" }),
    );

    const schedule = baselineSchedule(
      pending,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );
    const serveSeconds = schedule.slices[0]!.placements.map(
      (placement) => (placement.serveAt - NOW) / 1000,
    );

    expect(serveSeconds).toEqual([60, 60, 60, 60, 105, 105, 120]);
    // 跨ぎの差は卓の遅れとして計上される（最遅 120 秒から 4 本 × 60 秒 + 2 本 × 15 秒 = 270 秒 × w_table 2 = 540）。
    // arms を十分大きくして Lift_Overflow を消し、卓同期項の寄与だけを w_table の有無の差で取り出す。
    const roomy = { ...PARAMS, arms: 7 };
    const withLag = scoreSchedule(
      schedule.slices,
      pending,
      { members: NO_MEMBERS, lifts: NO_LIFTS, change: null },
      roomy,
    ).total;
    const withoutLag = scoreSchedule(
      schedule.slices,
      pending,
      { members: NO_MEMBERS, lifts: NO_LIFTS, change: null },
      {
        ...roomy,
        tableSyncWeight: 0,
      },
    ).total;
    expect(withLag - withoutLag).toBe(2 * (60 * 4 + 15 * 2));
  });

  describe("走行中の仲間が在る卓は、錨に合流できる品目で最初の batch を組む（判断 16・ADR-0007・AC 1.8〜1.10）", () => {
    /** 2 釜を占めて走行中の仲間（1 本目）。 */
    function wideRunning(input: {
      id: string;
      slots: readonly string[];
      endTime: number;
      tableId: string;
    }) {
      return createTimer({
        id: input.id as TimerId,
        slotIds: nonEmpty(input.slots.map((slot) => slot as SlotId)),
        noodleType: "Thin" as NoodleType,
        firmness: "normal",
        startTime: (input.endTime - 60_000) as EpochMillis,
        endTime: input.endTime as EpochMillis,
        seq: 0,
        orderItem: { externalOrderId: `run-${input.id}`, itemIndex: 0, tableId: input.tableId },
      });
    }

    it("レビューの再現: 6 釜・同卓 4 品・各 2 釜。1 本目を始めた後も残りは走行中の錨に合流し、始めたまとまりが崩れない", () => {
      const items = [1, 2, 3].map((itemIndex) =>
        pendingItem({ orderId: "A", itemIndex, noodleType: "Thin", tableId: "t-1", slotSpan: 2 }),
      );
      // 開始前（4 品・走行中なし）は容量 6 で 3 品と 1 品の batch に割れ、3 品（6 本分）は上げ窓の上限 4 本で
      // 2 品（60 秒）と 1 品（105 秒）に割れる。4 品目は釜が空く 60 秒から茹でて 120 秒（[105,150) は 2 + 2 = 4 本）。
      const before = baselineSchedule(
        [
          pendingItem({
            orderId: "A",
            itemIndex: 0,
            noodleType: "Thin",
            tableId: "t-1",
            slotSpan: 2,
          }),
          ...items,
        ],
        EMPTY_KITCHEN,
        NO_MEMBERS,
        NO_LIFTS,
        DEFAULT_NOODLE_PRESETS,
        PARAMS,
        NOW,
        occupiedSlotsOf([]),
        null,
      );
      expect(before.slices[0]!.placements.map((p) => (p.serveAt - NOW) / 1000)).toEqual([
        60, 60, 105, 120,
      ]);

      // 1 本目（A#0）を釜 0・1 で始めた（60 秒後に上がる）。
      const running = [
        wideRunning({ id: "t-first", slots: ["0", "1"], endTime: NOW + 60_000, tableId: "t-1" }),
      ];
      const after = baselineSchedule(
        items,
        initialRelease(running, NOW, 6),
        tableMembers(running),
        initialLifts(running),
        DEFAULT_NOODLE_PRESETS,
        PARAMS,
        NOW,
        occupiedSlotsOf(running),
        null,
      );
      // A#1・A#2 は空いている 4 釜で走行中の錨（60 秒）に合流し、A#3 だけが釜の空く 60 秒後に回る。
      // 従来は 3 品が一つの batch に入り、全員が 60 秒後へ押し出されていた。
      // 合流分の候補は錨の 60 秒だが、その窓には走行中の 2 本が在り、合流分 4 本分を足すと上限 4 を超える。
      // pack（2 品を次の窓 105 秒へ）と split（1 品を 60 秒に手伝いで足し、1 品を 105 秒へ）を比べ、卓の遅れが
      // 小さい pack を置く（390 対 435・判断 20「同時に上げる方」）。A#3 は 120 秒の候補から [105,150) の 4 本を
      // 避けて 150 秒へ。
      expect(after.slices[0]!.placements.map(readable)).toEqual([
        { item: "A#1", slots: ["2", "3"], startSeconds: 45, serveSeconds: 105 },
        { item: "A#2", slots: ["4", "5"], startSeconds: 45, serveSeconds: 105 },
        { item: "A#3", slots: ["0", "1"], startSeconds: 90, serveSeconds: 150 },
      ]);
      // 合流分は窓で後ろへ動いても走行中の錨（60 秒）を所属に持ち、後続の batch は持たない（AC 9.9・判断 20）。
      expect(after.slices[0]!.placements.map((p) => p.anchor)).toEqual([
        NOW + 60_000,
        NOW + 60_000,
        null,
      ]);
    });

    it("(a) 全釜使用中: 錨 510 秒・茹で 330 秒なら、30 秒後に空く釜でも 180 秒に投入できて合流する", () => {
      const presets: readonly NoodlePreset[] = [
        { noodleType: "Slow", boilSeconds: { extraHard: 330, hard: 330, normal: 330, soft: 330 } },
      ];
      const running = [
        timerOn({ id: "t-sibling", slot: "5", endTime: NOW + 510_000, tableId: "t-1" }),
        ...[0, 1, 2, 3, 4].map((slot) =>
          timerOn({ id: `t-other-${slot}`, slot: String(slot), endTime: NOW + 30_000 }),
        ),
      ];
      const pending = [
        pendingItem({ orderId: "A", itemIndex: 1, noodleType: "Slow", tableId: "t-1" }),
      ];

      const schedule = baselineSchedule(
        pending,
        initialRelease(running, NOW, 6),
        tableMembers(running),
        initialLifts(running),
        presets,
        PARAMS,
        NOW,
        occupiedSlotsOf(running),
        null,
      );

      expect(schedule.slices[0]!.placements.map(readable)).toEqual([
        { item: "A#1", slots: ["0"], startSeconds: 180, serveSeconds: 510 },
      ]);
    });

    it("(b) 茹で時間が混在: 錨までの残りより長い茹での品目は合流せず、残りの batch に回る", () => {
      // 仲間は 100 秒後に上がる。Thin（60 秒）は 40 秒後に始めて合流できるが、Thick（120 秒）は届かない。
      const running = [
        timerOn({ id: "t-sibling", slot: "5", endTime: NOW + 100_000, tableId: "t-1" }),
      ];
      const pending = [
        pendingItem({ orderId: "A", itemIndex: 1, noodleType: "Thick", tableId: "t-1" }),
        pendingItem({ orderId: "A", itemIndex: 2, noodleType: "Thin", tableId: "t-1" }),
      ];

      const schedule = baselineSchedule(
        pending,
        initialRelease(running, NOW, 6),
        tableMembers(running),
        initialLifts(running),
        DEFAULT_NOODLE_PRESETS,
        PARAMS,
        NOW,
        occupiedSlotsOf(running),
        null,
      );

      // Thin は錨（100 秒）へ合流。Thick は残りの batch で max(earliest 120, 錨 100) = 120 秒に置かれる。
      expect(schedule.slices[0]!.placements.map(readable)).toEqual([
        { item: "A#2", slots: ["0"], startSeconds: 40, serveSeconds: 100 },
        { item: "A#1", slots: ["1"], startSeconds: 0, serveSeconds: 120 },
      ]);
      expect(schedule.slices[0]!.placements.map((p) => p.anchor)).toEqual([NOW + 100_000, null]);
    });

    it("(c) 1 品が複数釜: 2 釜のうち片方が投入時刻までに空かなければ合流しない", () => {
      // 仲間は 60 秒後に上がる。Thin 2 釜（60 秒）の投入時刻は今。今空いているのは釜 4 だけ（0〜3 は 30 秒後）。
      const running = [
        timerOn({ id: "t-sibling", slot: "5", endTime: NOW + 60_000, tableId: "t-1" }),
        ...[0, 1, 2, 3].map((slot) =>
          timerOn({ id: `t-other-${slot}`, slot: String(slot), endTime: NOW + 30_000 }),
        ),
      ];
      const pending = [
        pendingItem({
          orderId: "A",
          itemIndex: 1,
          noodleType: "Thin",
          tableId: "t-1",
          slotSpan: 2,
        }),
      ];

      const schedule = baselineSchedule(
        pending,
        initialRelease(running, NOW, 6),
        tableMembers(running),
        initialLifts(running),
        DEFAULT_NOODLE_PRESETS,
        PARAMS,
        NOW,
        occupiedSlotsOf(running),
        null,
      );

      // 合流できず、残りの batch として max(earliest 90, 錨 60) = 90 秒に置かれる。
      const placement = readable(schedule.slices[0]!.placements[0]!);
      expect(placement.slots).toHaveLength(2);
      expect(placement).toMatchObject({ item: "A#1", startSeconds: 30, serveSeconds: 90 });

      // 対照: 2 釜とも今空いていれば合流する（釜 3 の走行中を外す）。合流先の錨は 60 秒だが、店舗全体では
      // 30 秒に 3 本・60 秒に 1 本が上がり、窓 [30,75) に 2 本分を足すと上限 4 を超える——半開ゆえ 75 秒で抜ける
      // （所属は錨の 60 秒のまま・判断 20）。
      const roomier = running.filter((timer) => timer.id !== "t-other-3");
      const joined = baselineSchedule(
        pending,
        initialRelease(roomier, NOW, 6),
        tableMembers(roomier),
        initialLifts(roomier),
        DEFAULT_NOODLE_PRESETS,
        PARAMS,
        NOW,
        occupiedSlotsOf(roomier),
        null,
      );
      expect(readable(joined.slices[0]!.placements[0]!)).toEqual({
        item: "A#1",
        slots: ["3", "4"],
        startSeconds: 15,
        serveSeconds: 75,
      });
      expect(joined.slices[0]!.placements[0]!.anchor).toBe(NOW + 60_000);
    });
  });
});

// 上げ窓（lift-group-planning Requirement 9・判断 20・ADR-0009）。lift.example が表の数え方と firstFit を固定し、
// ここは **自前解がどこへ置くか**——pack / split の局所費用（AC 9.8）・大盛の 2 本分（AC 9.11）・置けない品目
// （AC 9.12）——を具体値で固定する。既定は arms 2・L 45 秒・手伝い 2 本（上限 4 本）。
describe("baselineSchedule — 上げ窓（lift-group-planning Requirement 9）", () => {
  /** 同じ卓の Thin（60 秒）n 本。到着は同時。 */
  function family(count: number, slotSpan = 1): readonly OrderItem[] {
    return Array.from({ length: count }, (_unused, itemIndex) =>
      pendingItem({ orderId: "F", itemIndex, noodleType: "Thin", tableId: "t-1", slotSpan }),
    );
  }

  /** 提供の相対秒（配置の並び順）。 */
  function serveSecondsOf(schedule: { slices: readonly { placements: readonly Placement[] }[] }) {
    return schedule.slices.flatMap((slice) =>
      slice.placements.map((placement) => (placement.serveAt - NOW) / 1000),
    );
  }

  /**
   * 各配置を含むすべての窓の負荷が上限以下か（AC 7.8）。当該配置を除いた表に当該配置を足して数える
   * （loadWith は t を含む窓だけを見る）。
   */
  function withinLiftCap(
    placements: readonly Placement[],
    lifts: LiftTable,
    params: ScheduleParams,
  ): boolean {
    return placements.every((placement) => {
      const others = advanceLifts(
        lifts,
        liftsOf(placements.filter((other) => other !== placement)),
      );
      return (
        loadWith(others, placement.serveAt, placement.slotIds.length, params) <= liftCap(params)
      );
    });
  }

  it("4 人家族（同じ卓 4 本・arms 2）は手伝いを頼んで同じ窓に 4 本載る（AC 7.9・判断 20）", () => {
    // pack（4 本を 60 秒に・手伝いの費用 2 本 × 45 = 90）と split（2 本ずつ）を比べる。表が空なので split の残りも
    // 同じ窓に入り両者は同じ配置——同点は pack（AC 9.8）。分けて次の窓へ送る形（卓の遅れ 270）は選ばれない。
    const schedule = baselineSchedule(
      family(4),
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    expect(serveSecondsOf(schedule)).toEqual([60, 60, 60, 60]);
    expect(liftCap(PARAMS)).toBe(2 + HELPER_ARMS);
    expect(withinLiftCap(schedule.slices[0]!.placements, NO_LIFTS, PARAMS)).toBe(true);
  });

  it("9 本・6 釜・arms 2・間隔 45 秒：窓あたり 4 本までで 45 秒以上離れた窓に並び、「全部 now」にならない（AC 7.9）", () => {
    // 釜容量で 6 本と 3 本の batch に割れ、6 本の列は上限 4 で 4 本（60 秒）と 2 本（次の窓 105 秒）に割れる。
    // 3 本目の batch は釜が空く 60 秒から茹でて 120 秒が候補だが、[105,150) の 2 本に 3 本を足すと上限を超え、
    // pack（3 本を 150 秒へ）が split（2 本を 120 秒・1 本を 150 秒）より卓の遅れが小さいので 150 秒に揃う。
    const schedule = baselineSchedule(
      family(9),
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );
    const placements = schedule.slices[0]!.placements;

    expect(serveSecondsOf(schedule)).toEqual([60, 60, 60, 60, 105, 105, 150, 150, 150]);
    expect(withinLiftCap(placements, NO_LIFTS, PARAMS)).toBe(true);
    // 全部 now ではない——釜が空いていても窓が埋まっていれば startAt は未来になる（判断 20）。
    expect(placements.filter((placement) => placement.startAt <= NOW)).toHaveLength(4);
    // 上がりの時刻は 45 秒以上離れた窓に並ぶ。
    const windows = [...new Set(serveSecondsOf(schedule))].sort((a, b) => a - b);
    for (let i = 1; i < windows.length; i++)
      expect(windows[i]! - windows[i - 1]!).toBeGreaterThanOrEqual(45);
  });

  it("9 本・12 釜（釜が足りる）なら 4・4・1 の 3 窓に割れる（t・t + 45・t + 90・判断 20）", () => {
    // 釜が足りれば 9 本が一つの列になり、上限 4 の接頭辞で 4・4・1 に割れて 60 / 105 / 150 秒に並ぶ。
    const roomy = schedulingDefaults(2);
    const schedule = baselineSchedule(
      family(9),
      initialRelease([], NOW, 12),
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      roomy,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    expect(serveSecondsOf(schedule)).toEqual([60, 60, 60, 60, 105, 105, 105, 105, 150]);
    expect(withinLiftCap(schedule.slices[0]!.placements, NO_LIFTS, roomy)).toBe(true);
  });

  it("大盛（slotSpan 2）は 2 本分として窓に数える（AC 9.11）", () => {
    // 大盛 1 品 + Thin 3 本（合計 5 本分）。上限 4 に収まる最長の接頭辞は大盛 + Thin 2 本（4 本分）で 60 秒、
    // 残る Thin 1 本は次の窓 105 秒へ。大盛を 1 本と数えれば 4 品が同じ窓に載ってしまう。
    const pending = [
      pendingItem({ orderId: "F", itemIndex: 0, noodleType: "Thin", tableId: "t-1", slotSpan: 2 }),
      ...[1, 2, 3].map((itemIndex) =>
        pendingItem({ orderId: "F", itemIndex, noodleType: "Thin", tableId: "t-1" }),
      ),
    ];

    const schedule = baselineSchedule(
      pending,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "F#0", slots: ["0", "1"], startSeconds: 0, serveSeconds: 60 },
      { item: "F#1", slots: ["2"], startSeconds: 0, serveSeconds: 60 },
      { item: "F#2", slots: ["3"], startSeconds: 0, serveSeconds: 60 },
      { item: "F#3", slots: ["4"], startSeconds: 45, serveSeconds: 105 },
    ]);
  });

  it("slotSpan が arms + 手伝いを超える品目は配置しない——arms 1 で 4 釜の品目は待ち行列に残る（AC 9.12）", () => {
    // 上限 3 本にどの窓でも入らない品目は、茹で時間が引けない品目と同じく置かない。同じ卓の他の品目は置かれる。
    const narrow = { ...PARAMS, arms: 1 };
    const pending = [
      pendingItem({ orderId: "F", itemIndex: 0, noodleType: "Thin", tableId: "t-1", slotSpan: 4 }),
      pendingItem({ orderId: "F", itemIndex: 1, noodleType: "Thin", tableId: "t-1" }),
    ];

    const schedule = baselineSchedule(
      pending,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      narrow,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "F#1", slots: ["0"], startSeconds: 0, serveSeconds: 60 },
    ]);
    // 4 釜の品目だけの卓なら一片そのものが立たない。
    expect(
      baselineSchedule(
        [pending[0]!],
        EMPTY_KITCHEN,
        NO_MEMBERS,
        NO_LIFTS,
        DEFAULT_NOODLE_PRESETS,
        narrow,
        NOW,
        occupiedSlotsOf([]),
        null,
      ),
    ).toEqual({ slices: [] });
  });

  it("arms 1 の大盛は split の接頭辞が空なので単独で pack する——品目は不可分（AC 9.8）", () => {
    // 大盛（2 本分）は arms 1 を超えるが上限 3 には収まる。arms に収まる非空の接頭辞が無いので split は候補にならず、
    // pack（手伝いを頼んで 60 秒）を置く。同じ卓の Thin も同じ列で 3 本分に収まり同じ窓に載る。
    const narrow = { ...PARAMS, arms: 1 };
    const pending = [
      pendingItem({ orderId: "F", itemIndex: 0, noodleType: "Thin", tableId: "t-1", slotSpan: 2 }),
      pendingItem({ orderId: "F", itemIndex: 1, noodleType: "Thin", tableId: "t-1" }),
    ];

    const schedule = baselineSchedule(
      pending,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      narrow,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "F#0", slots: ["0", "1"], startSeconds: 0, serveSeconds: 60 },
      { item: "F#1", slots: ["2"], startSeconds: 0, serveSeconds: 60 },
    ]);
    expect(
      baselineSchedule(
        [pending[0]!],
        EMPTY_KITCHEN,
        NO_MEMBERS,
        NO_LIFTS,
        DEFAULT_NOODLE_PRESETS,
        narrow,
        NOW,
        occupiedSlotsOf([]),
        null,
      ).slices[0]!.placements.map(readable),
    ).toEqual([{ item: "F#0", slots: ["0", "1"], startSeconds: 0, serveSeconds: 60 }]);
  });

  it("split が勝つ場面：走行中 1 本の窓に 2 本を足し、残り 2 本を次の窓へ（w_table 1・AC 9.8）", () => {
    // 他の卓の走行中が 60 秒に 1 本。同じ卓の Thin 4 本（4 本分）は候補 60 秒の窓に入らない（1 + 4 > 4）。
    // pack は 4 本を 105 秒へ（待ち 420・手伝い 2 本 = 90 → 510）。split は 2 本を 60 秒に足し（3 本・手伝い 1 = 45）、
    // 残り 2 本を 105 秒へ（待ち 330・卓の遅れ 90 × w_table 1 → 465）。w_table 1 なら split が安い。
    // 既定の w_table 2 なら卓の遅れが 180 になり pack が勝つ（判断 20「同時に上げる方」）。
    const running = [timerOn({ id: "t-other", slot: "5", endTime: NOW + 60_000 })];
    const lifts = initialLifts(running);
    const release = initialRelease(running, NOW, 6);
    const place = (tableSyncWeight: number) =>
      serveSecondsOf(
        baselineSchedule(
          family(4),
          release,
          tableMembers(running),
          lifts,
          DEFAULT_NOODLE_PRESETS,
          {
            ...PARAMS,
            tableSyncWeight,
          },
          NOW,
          occupiedSlotsOf(running),
          null,
        ),
      );

    expect(place(1)).toEqual([60, 60, 105, 105]);
    expect(place(2)).toEqual([105, 105, 105, 105]);
  });

  it("窓は店舗全体で数える——別の卓の上がりが同じ窓に在れば、次の卓の候補は後ろへ動く（AC 9.3）", () => {
    // 卓 t-1 の 4 本が 60 秒の窓を埋める。卓 t-2 の Thin 1 本は釜が空いていても 60 秒には上がれず 105 秒へ
    // （釜が空いていても窓が埋まっていれば startAt は未来になる・判断 20）。
    const pending = [
      ...family(4),
      pendingItem({
        orderId: "G",
        itemIndex: 0,
        noodleType: "Thin",
        tableId: "t-2",
        arrivalTime: NOW + 1,
      }),
    ];

    const schedule = baselineSchedule(
      pending,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );

    expect(schedule.slices.map((slice) => slice.tableKey)).toEqual(["t-1", "t-2"]);
    expect(schedule.slices[1]!.placements.map(readable)).toEqual([
      { item: "G#0", slots: ["4"], startSeconds: 45, serveSeconds: 105 },
    ]);
  });
});

describe("keepsAnchor — pack の単位の検査（lift-group-planning AC 9.10・ハード制約 (e)・task 21.6）", () => {
  // Feature: lift-group-planning, 判断 16 / 17 / 20
  // **Validates: Requirements 1.11, 5.3, 9.9, 9.10**
  //
  // 一片の配置を pack（同じ anchor・同じ serveAt）と 1 品の単位にまとめ、pack から順に解放表と上げ表へ載せながら
  // (a) 錨は仲間に在る (b) 手前に散らさない (c) 集合として合流できた (d) 延期の理由は窓だけ、を pack に、押し出しを
  // 1 品に検査する。tasks.md 21.6 の回帰 6 件と、単位の順（pack を先に載せる）の根拠となる場面を固定する。
  const SECS = 1_000;
  /** Thin 60 秒（h_i 6 秒）に、茹で 300 秒（h_i 30 秒）と 600 秒（h_i 60 秒）を足した店。 */
  const PRESETS: readonly NoodlePreset[] = [
    ...DEFAULT_NOODLE_PRESETS,
    { noodleType: "Mid", boilSeconds: { extraHard: 300, hard: 300, normal: 300, soft: 300 } },
    { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
  ];
  const boilSecondsOf: Record<string, number> = {
    Thin: 60,
    Medium: 90,
    Thick: 120,
    Mid: 300,
    Long: 600,
  };

  /** 卓 t-1 の走行中の仲間（1 釜）。 */
  function sibling(id: string, slot: string, endSeconds: number) {
    return timerOn({ id, slot, endTime: NOW + endSeconds * SECS, tableId: "t-1" });
  }
  /** 遠い未来まで釜を塞ぐ、卓の無い走行中。 */
  function blocked(slot: string) {
    return timerOn({ id: `blocked-${slot}`, slot, endTime: NOW + 10_000 * SECS });
  }
  /** 卓 t-1 の未着手。 */
  function item(itemIndex: number, noodleType: string, slotSpan = 1): OrderItem {
    return pendingItem({ orderId: "F", itemIndex, noodleType, tableId: "t-1", slotSpan });
  }
  /** 外部計画の配置。serveAt は startAt + 茹で時間。 */
  function place(
    order: OrderItem,
    slots: readonly string[],
    startSeconds: number,
    anchorSeconds: number | null,
  ): Placement {
    return {
      externalOrderId: order.externalOrderId,
      itemIndex: order.itemIndex,
      slotIds: nonEmpty(slots.map((slot) => slot as SlotId)),
      startAt: (NOW + startSeconds * SECS) as EpochMillis,
      serveAt: (NOW + (startSeconds + boilSecondsOf[order.noodleType]!) * SECS) as EpochMillis,
      anchor: anchorSeconds === null ? null : ((NOW + anchorSeconds * SECS) as EpochMillis),
    };
  }
  /** 走行中と未着手から、一片を置く前の表で述語を引く。 */
  function keeps(running: readonly Timer[], pending: readonly OrderItem[]) {
    return (placements: readonly Placement[]) =>
      keepsAnchor(
        placements,
        initialRelease(running, NOW, 6),
        initialLifts(running),
        tableMembers(running).get("t-1") ?? null,
        pending,
        PRESETS,
        PARAMS,
      );
  }
  /** 自前解の一片（卓 t-1 だけを置く）。 */
  function own(running: readonly Timer[], pending: readonly OrderItem[]) {
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
    ).slices[0]!.placements;
  }

  it("自前解の pack を受け入れる——走行中 3 本が 54・54・66 秒、残り 2 品の候補 60 秒は pack の span 2 で 99 秒（AC 9.10 (d)）", () => {
    // 1 品ずつなら 60 秒の窓に入る（3 + 1 = 4）が、pack の span 2 では 60 秒を含む窓 [54,99) が 5 本になる。pack の
    // 最早は 99 秒で、自前解はそこへ置く。検証も pack 全体の span で firstFit するので、この一片は守っている。
    const running = [sibling("s1", "3", 54), sibling("s2", "4", 54), sibling("s3", "5", 66)];
    const pending = [item(0, "Thin"), item(1, "Thin")];
    const placements = own(running, pending);
    expect(placements.map(readable)).toEqual([
      { item: "F#0", slots: ["0"], startSeconds: 39, serveSeconds: 99 },
      { item: "F#1", slots: ["1"], startSeconds: 39, serveSeconds: 99 },
    ]);
    expect(placements.map((p) => p.anchor)).toEqual([NOW + 54 * SECS, NOW + 54 * SECS]);
    expect(keeps(running, pending)(placements)).toBe(true);
    // 同じ 2 品を 1 品ずつの firstFit（60 秒）に置いた計画は、pack の span 2 では 60 秒に入らないので守っていない。
    expect(
      keeps(running, pending)([place(pending[0]!, ["0"], 0, 54), place(pending[1]!, ["1"], 0, 54)]),
    ).toBe(false);
  });

  it("走行中 4 本が 60 秒に上がる表で残りを 105 秒に置く一片は守る——窓による延期は押し出しではない", () => {
    const running = ["2", "3", "4", "5"].map((slot) => sibling(`s${slot}`, slot, 60));
    const pending = [item(0, "Thin")];
    const keep = keeps(running, pending);
    expect(own(running, pending).map(readable)).toEqual([
      { item: "F#0", slots: ["0"], startSeconds: 45, serveSeconds: 105 },
    ]);
    expect(keep([place(pending[0]!, ["0"], 45, 60)])).toBe(true);
    // 錨を主張しなくても同じ——合流できた品目を候補 60 秒からの firstFit（105 秒）に置く配置は押し出しではない。
    expect(keep([place(pending[0]!, ["0"], 45, null)])).toBe(true);
    // firstFit より後ろ（150 秒）は、錨を主張しても (d) で、主張しなくても押し出しで守っていない。
    expect(keep([place(pending[0]!, ["0"], 90, 60)])).toBe(false);
    expect(keep([place(pending[0]!, ["0"], 90, null)])).toBe(false);
  });

  it("合流できない品目に錨を付けた配置（茹で 600 秒を 60 秒の仲間へ anchor: 60）は棄却する（AC 9.10 (c)）", () => {
    const running = [sibling("s", "5", 60)];
    const pending = [item(0, "Long")];
    const keep = keeps(running, pending);
    expect(keep([place(pending[0]!, ["0"], 0, 60)])).toBe(false);
    // 錨を名乗らない同じ配置は正当な後続——600 秒の品目は 60 + 60 秒までに上がれず、保護の対象ではない。
    expect(keep([place(pending[0]!, ["0"], 0, null)])).toBe(true);
  });

  it("仲間 60 秒・茹で 300 秒と 600 秒（どちらも合流不能）を後の batch で 600 秒に揃える配置は押し出しではない", () => {
    const running = [sibling("s", "5", 60)];
    const pending = [item(0, "Mid"), item(1, "Long")];
    const placements = [place(pending[1]!, ["0"], 0, null), place(pending[0]!, ["1"], 300, null)];
    expect(keeps(running, pending)(placements)).toBe(true);
    // 自前解も同じ形（Group_Anchor は max(earliest, 走行中の最遅) = 600 秒）。
    expect(own(running, pending).map((p) => (p.serveAt - NOW) / 1000)).toEqual([600, 600]);
  });

  it("空き 1 釜に Thin を [0,60]・[60,120] と順に置いて両方に anchor: 60 を付けた計画は棄却する——(c) は集合の検査", () => {
    // 手前の単位（[0,60] の pack）で釜 0 は 60 秒まで埋まるので、[60,120] の earliestOwn は 120 秒 > 60 + 6 秒。
    const running = [sibling("s", "5", 60), ...["1", "2", "3", "4"].map(blocked)];
    const pending = [item(0, "Thin"), item(1, "Thin")];
    const keep = keeps(running, pending);
    expect(keep([place(pending[0]!, ["0"], 0, 60), place(pending[1]!, ["0"], 60, 60)])).toBe(false);
    // 後の品が錨を名乗らなければ正当な後続の batch。
    expect(keep([place(pending[0]!, ["0"], 0, 60), place(pending[1]!, ["0"], 60, null)])).toBe(
      true,
    );
  });

  it("Thin と茹で 600 秒の品目を両方 600 秒に置き Thin に anchor: 60 を付けた計画は棄却する——(d) は延期の理由の検査", () => {
    // 600 秒の品目は合流不能で pack に入らず、Thin だけの pack の firstFit は 60 秒。後続品のために合流分を遅らせた
    // 配置は錨を主張しても合流分と認めない（主張だけで免除すれば、押し出した配置に仲間の endTime を書くだけで
    // (e) を素通りする・21.5 のレビュー P1）。
    const running = [sibling("s", "5", 60), ...["2", "3", "4"].map(blocked)];
    const pending = [item(0, "Thin"), item(1, "Long")];
    const keep = keeps(running, pending);
    expect(keep([place(pending[1]!, ["0"], 0, null), place(pending[0]!, ["1"], 540, 60)])).toBe(
      false,
    );
    // 同じ計画で Thin の錨を外しても押し出しとして棄却する。
    expect(keep([place(pending[1]!, ["0"], 0, null), place(pending[0]!, ["1"], 540, null)])).toBe(
      false,
    );
    // Thin を 60 秒に合流させ、600 秒の品目を後に置く形は守っている（自前解の形）。
    expect(keep([place(pending[0]!, ["0"], 0, 60), place(pending[1]!, ["1"], 0, null)])).toBe(true);
  });

  it("上げ窓が pack を batch の 1 品より後ろへ動かしても押し出しではない——pack を先に載せてから 1 品を見る（単位の順）", () => {
    // 走行中 3 本が 60 秒に上がり（仲間 1 本・他卓 2 本）、釜 1 は 40 秒に空く。Thin 3 品：2 品は釜 0・2 から 60 秒の
    // 候補に届くが pack の span 2 は [40,85)・[60,105) の窓に入らず 105 秒へ。3 品目は釜 1 から 100 秒で届かず、
    // batch の候補 100 秒がそのまま窓に入る。serveAt 順に載せると 3 品目（100 秒）が pack（105 秒）より先に載り、
    // pack の釜 0 を「空いていた」と読んで押し出しと判定してしまう——自前解は合流の判定を batch より先に行う。
    const running = [
      sibling("s", "5", 60),
      timerOn({ id: "other-3", slot: "3", endTime: NOW + 60 * SECS, tableId: "t-2" }),
      timerOn({ id: "other-4", slot: "4", endTime: NOW + 60 * SECS, tableId: "t-2" }),
      timerOn({ id: "busy-1", slot: "1", endTime: NOW + 40 * SECS }),
    ];
    const pending = [item(0, "Thin"), item(1, "Thin"), item(2, "Thin")];
    const placements = own(running, pending);
    expect(placements.map(readable)).toEqual([
      { item: "F#0", slots: ["0"], startSeconds: 45, serveSeconds: 105 },
      { item: "F#1", slots: ["2"], startSeconds: 45, serveSeconds: 105 },
      { item: "F#2", slots: ["1"], startSeconds: 40, serveSeconds: 100 },
    ]);
    expect(placements.map((p) => p.anchor)).toEqual([NOW + 60 * SECS, NOW + 60 * SECS, null]);
    expect(keeps(running, pending)(placements)).toBe(true);
  });

  it("先に合流した品目の釜がその上がりで空けば、次の品目はその釜から後の仲間に届く——合流の判定は置いた後の表で繰り返す", () => {
    // 仲間が 66 秒（釜 5）と 170 秒（釜 4）に上がる。Thin（h_i 6 秒）は釜 0 から [0,60] で 66 秒の仲間に届く。
    // Thick（120 秒・h_i 12 秒）は釜 5 が空く 66 秒からでは 186 秒で 170 秒の仲間に届かず、釜 1（100 秒に空く）からも
    // 届かないが、Thin が上がった釜 0 からなら [60,180] で届く。合流の判定を一度で終えると Thick は batch
    // （Group_Anchor 170 秒からの候補 220 秒）へ回り、置いた後の表で見れば合流できたので押し出しになる（Property 17
    // の実測・仲間 41.85 秒と 145 秒の縮小例）。
    const running = [
      sibling("s1", "5", 66),
      sibling("s2", "4", 170),
      timerOn({ id: "busy-1", slot: "1", endTime: NOW + 100 * SECS }),
      ...["2", "3"].map(blocked),
    ];
    const pending = [item(0, "Thin"), item(1, "Thick")];
    const placements = own(running, pending);
    expect(placements.map(readable)).toEqual([
      { item: "F#0", slots: ["0"], startSeconds: 0, serveSeconds: 60 },
      { item: "F#1", slots: ["0"], startSeconds: 60, serveSeconds: 180 },
    ]);
    expect(placements.map((p) => p.anchor)).toEqual([NOW + 66 * SECS, NOW + 170 * SECS]);
    expect(keeps(running, pending)(placements)).toBe(true);
    // 一度の判定で Thick を batch（170 秒の錨から 220 秒）へ回した形は、置いた後の表で合流できたので押し出し。
    expect(
      keeps(
        running,
        pending,
      )([place(pending[0]!, ["0"], 0, 66), place(pending[1]!, ["0"], 100, null)]),
    ).toBe(false);
  });
});

describe("baselineSchedule — 自前解が前回を残す（plan-stability Requirement 3・design Component 5・task 4）", () => {
  // Feature: plan-stability, Component 5
  // **Validates: Requirements 3.1, 3.2, 3.3, 5.6, 5.7**
  //
  // 前回配信対象として確定した提案（Shown_Plan）が在れば、釜の選択はその釜を第一候補にし、列の pack / split の局所比較に
  // 変更費用（先頭の変更を含む 4 種）を足し、前回のまとまりを保つ分割を第 3 候補に置く。ハード制約は前回より優先する。
  const SECS = 1_000;
  /** Thin 60 秒に、茹で 600 秒（h_i 60 秒）を足した店。 */
  const PRESETS: readonly NoodlePreset[] = [
    ...DEFAULT_NOODLE_PRESETS,
    { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
  ];
  const boilSecondsOf: Record<string, number> = { Thin: 60, Medium: 90, Thick: 120, Long: 600 };

  /** 前回の提案の 1 品目（釜・開始秒・錨秒・同じ群だった相手）。serveAt は startAt + 茹で時間。 */
  function shown(
    order: OrderItem,
    slots: readonly string[],
    startSeconds: number,
    options: { readonly anchorSeconds?: number; readonly mates?: readonly OrderItem[] } = {},
  ): ShownItem {
    return {
      externalOrderId: order.externalOrderId,
      itemIndex: order.itemIndex,
      slotIds: nonEmpty(slots.map((slot) => slot as SlotId)),
      startAt: (NOW + startSeconds * SECS) as EpochMillis,
      serveAt: (NOW + (startSeconds + boilSecondsOf[order.noodleType]!) * SECS) as EpochMillis,
      anchor:
        options.anchorSeconds === undefined
          ? null
          : ((NOW + options.anchorSeconds * SECS) as EpochMillis),
      mates: (options.mates ?? []).map((mate) => `${mate.externalOrderId}\u0000${mate.itemIndex}`),
    };
  }
  /** 比較の文脈——旧 Shown_Plan・遷移後の Timer・比較の時点 NOW。 */
  function changeContextOf(
    shownPlan: readonly ShownItem[],
    running: readonly Timer[],
    pending: readonly OrderItem[],
  ): ChangeContext {
    return { shown: shownPlan, running, now: NOW, pending, presets: PRESETS };
  }
  /** 自前解（NOW の解放表・卓の成員表・上げ表から）。 */
  function plan(
    pending: readonly OrderItem[],
    running: readonly Timer[],
    params: ScheduleParams,
    changeContext: ChangeContext | null,
  ) {
    return baselineSchedule(
      pending,
      initialRelease(running, NOW, 6),
      tableMembers(running),
      initialLifts(running),
      PRESETS,
      params,
      NOW,
      occupiedSlotsOf(running),
      changeContext,
    );
  }
  /** 遠い未来まで釜を塞ぐ、卓の無い走行中。 */
  function blocked(slot: string, endSeconds = 10_000) {
    return timerOn({ id: `blocked-${slot}`, slot, endTime: NOW + endSeconds * SECS });
  }

  it("前回の釜が候補の時刻までに空いていればそれを採る（AC 3.1）——前回が無ければ index 最小の釜", () => {
    const item = pendingItem({ orderId: "o-1" });
    const previous = [shown(item, ["3"], 0)];

    expect(plan([item], [], PARAMS, null).slices[0]!.placements.map(readable)).toEqual([
      { item: "o-1#0", slots: ["0"], startSeconds: 0, serveSeconds: 60 },
    ]);
    expect(
      plan([item], [], PARAMS, changeContextOf(previous, [], [item])).slices[0]!.placements.map(
        readable,
      ),
    ).toEqual([{ item: "o-1#0", slots: ["3"], startSeconds: 0, serveSeconds: 60 }]);
  });

  it("batch でも品目ごとに前回の釜を採り、残りは既存の対応づけで埋める（AC 3.1）", () => {
    // 同卓 3 品。前回は A 釜 4・B 釜 5。C は前回に無い（新規）ので、残った釜のうち既存の規則（index 最小）で釜 0。
    const a = pendingItem({ orderId: "A", tableId: "t-1" });
    const b = pendingItem({ orderId: "B", tableId: "t-1", arrivalTime: NOW + 1 });
    const c = pendingItem({ orderId: "C", tableId: "t-1", arrivalTime: NOW + 2 });
    const previous = [shown(a, ["4"], 0, { mates: [b] }), shown(b, ["5"], 0, { mates: [a] })];

    const schedule = plan([a, b, c], [], PARAMS, changeContextOf(previous, [], [a, b, c]));

    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "A#0", slots: ["4"], startSeconds: 0, serveSeconds: 60 },
      { item: "B#0", slots: ["5"], startSeconds: 0, serveSeconds: 60 },
      { item: "C#0", slots: ["0"], startSeconds: 0, serveSeconds: 60 },
    ]);
  });

  it("前回の釜が候補の時刻までに空かなければ既存の規則へ落ち、釜の変更費用 L を払う（AC 3.1・3.3・Error Handling）", () => {
    // 前回は釜 3。釜 3 は卓の無い走行中が 30 秒後まで占める——候補（今すぐ始めて 60 秒）に間に合わないので釜 0。
    // 待たせて釜 3 を守る配置は候補にならない（ハード制約と業務費用が前回より先）。
    const item = pendingItem({ orderId: "o-1" });
    const running = [blocked("3", 30)];
    const previous = [shown(item, ["3"], 0)];
    const changeContext = changeContextOf(previous, running, [item]);

    const schedule = plan([item], running, PARAMS, changeContext);

    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "o-1#0", slots: ["0"], startSeconds: 0, serveSeconds: 60 },
    ]);
    // 釜の変更 L = 45 だけが付く（時刻は同じ・前回の釜は走行中が占めるので先頭ではなかった）。
    expect(
      changeCost({ schedule, recommendations: recommend(schedule) }, changeContext, PARAMS),
    ).toBe(PARAMS.liftIntervalSeconds);
  });

  it("業務費用が同点の pack と split：前回が無ければ pack、前回が分割ならそのまとまりを保つ（AC 3.2・同点は前回を保つ側）", () => {
    // 同卓 A・B（Thin）。卓の無い走行中 2 本が 60 秒に上がり（釜 0・1）、上限 arms 1 + 2 = 3 に対して 60 秒の窓の
    // 負荷は 2。pack（2 本）は 105 秒へ、split は A を 60 秒・B を 105 秒に置く。w_table 1 では両者の局所費用が
    // 同点（255 秒）で、前回の無い計画は pack を採る。
    const params: ScheduleParams = { ...PARAMS, arms: 1, tableSyncWeight: 1 };
    const a = pendingItem({ orderId: "A", tableId: "t-1" });
    const b = pendingItem({ orderId: "B", tableId: "t-1", arrivalTime: NOW + 1 });
    const running = [blocked("0", 60), blocked("1", 60)];

    expect(plan([a, b], running, params, null).slices[0]!.placements.map(readable)).toEqual([
      { item: "A#0", slots: ["2"], startSeconds: 45, serveSeconds: 105 },
      { item: "B#0", slots: ["3"], startSeconds: 45, serveSeconds: 105 },
    ]);

    // 前回は A を今（60 秒に上がる）・B を 45 秒後に示していた（別の群）。前回のまとまりを保つ分割がそのまま候補になり、
    // pack は A の先頭消失（2L）と時刻の移動（L）を払うので、分割を保つ。
    const previous = [shown(a, ["2"], 0), shown(b, ["3"], 45)];
    const schedule = plan([a, b], running, params, changeContextOf(previous, running, [a, b]));
    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "A#0", slots: ["2"], startSeconds: 0, serveSeconds: 60 },
      { item: "B#0", slots: ["3"], startSeconds: 45, serveSeconds: 105 },
    ]);
    expect(
      changeCost(
        { schedule, recommendations: recommend(schedule) },
        changeContextOf(previous, running, [a, b]),
        params,
      ),
    ).toBe(0);
  });

  describe("局所費用に先頭の変更 (a) を含む——arms 1・L 45・茹で 600 秒・走行中 2 本が 600 秒（design Component 5 の回帰）", () => {
    // 卓 t-1 の走行中 2 本（釜 0・1）が 600 秒に上がる。残りの A・B（600 秒）は錨 600 秒に合流し、同じ列（候補 600 秒）
    // になる。上限 3 に対して 600 秒の窓の負荷は 2 なので、pack（2 本）は 645 秒へ動き、split は A を 600 秒・B を
    // 645 秒に置く。業務費用は pack が 45 秒良い（待ち +45・卓の遅れ −90）。前回の提案は A を今・B を 45 秒後。
    const a = pendingItem({ orderId: "A", noodleType: "Long", tableId: "t-1" });
    const b = pendingItem({
      orderId: "B",
      noodleType: "Long",
      tableId: "t-1",
      arrivalTime: NOW + 1,
    });
    const running = [
      timerOn({ id: "s0", slot: "0", endTime: NOW + 600 * SECS, tableId: "t-1" }),
      timerOn({ id: "s1", slot: "1", endTime: NOW + 600 * SECS, tableId: "t-1" }),
    ];
    const previous = [
      shown(a, ["2"], 0, { anchorSeconds: 600, mates: [b] }),
      shown(b, ["3"], 45, { anchorSeconds: 600, mates: [a] }),
    ];
    const arms1: ScheduleParams = { ...PARAMS, arms: 1 };

    it("前回が無ければ業務費用で pack を採り、両方が 45 秒後になる", () => {
      expect(plan([a, b], running, arms1, null).slices[0]!.placements.map(readable)).toEqual([
        { item: "A#0", slots: ["2"], startSeconds: 45, serveSeconds: 645 },
        { item: "B#0", slots: ["3"], startSeconds: 45, serveSeconds: 645 },
      ]);
    });

    it("前回 A が先頭なら pack を採らない——業務の利益 45 秒 < 先頭消失 90 秒（(b)(c)(d) だけでは守れない）", () => {
      const changeContext = changeContextOf(previous, running, [a, b]);
      const schedule = plan([a, b], running, arms1, changeContext);
      expect(schedule.slices[0]!.placements.map(readable)).toEqual([
        { item: "A#0", slots: ["2"], startSeconds: 0, serveSeconds: 600 },
        { item: "B#0", slots: ["3"], startSeconds: 45, serveSeconds: 645 },
      ]);
      // 前回と同じ計画ゆえ変更費用 0（釜・順・まとまり・時刻・先頭のすべて）。
      expect(
        changeCost({ schedule, recommendations: recommend(schedule) }, changeContext, arms1),
      ).toBe(0);
    });

    it("業務の利益が変更費用を上回れば変わる（性質 5.7）——w_table 4 では pack の利益 135 秒 > 先頭消失 90 秒", () => {
      const heavier: ScheduleParams = { ...arms1, tableSyncWeight: 4 };
      const changeContext = changeContextOf(previous, running, [a, b]);
      const schedule = plan([a, b], running, heavier, changeContext);
      expect(schedule.slices[0]!.placements.map(readable)).toEqual([
        { item: "A#0", slots: ["2"], startSeconds: 45, serveSeconds: 645 },
        { item: "B#0", slots: ["3"], startSeconds: 45, serveSeconds: 645 },
      ]);
      expect(
        changeCost({ schedule, recommendations: recommend(schedule) }, changeContext, heavier),
      ).toBe(2 * heavier.liftIntervalSeconds);
    });
  });

  it("同じ入力で続けて計画すると前回と同じ計画になり、変更費用は 0（性質 5.6）", () => {
    // 走行中の仲間が在る卓と無い卓、大盛（2 釜）、容量分割を踏む場面。
    const pending = [
      pendingItem({ orderId: "F", itemIndex: 0, noodleType: "Thick", tableId: "t-1" }),
      pendingItem({ orderId: "F", itemIndex: 1, tableId: "t-1", slotSpan: 2 }),
      pendingItem({ orderId: "F", itemIndex: 2, noodleType: "Medium", tableId: "t-1" }),
      pendingItem({ orderId: "G", tableId: "t-2", arrivalTime: NOW + 1 }),
      pendingItem({ orderId: "G", itemIndex: 1, tableId: "t-2", arrivalTime: NOW + 1 }),
    ];
    const running = [
      timerOn({ id: "s0", slot: "0", endTime: NOW + 40 * SECS, tableId: "t-1" }),
      blocked("1", 20),
    ];
    const first = plan(pending, running, PARAMS, null);
    const changeContext = changeContextOf(shownPlanOf(first, recommend(first)), running, pending);

    const second = plan(pending, running, PARAMS, changeContext);

    expect(second).toEqual(first);
    expect(
      changeCost({ schedule: second, recommendations: recommend(second) }, changeContext, PARAMS),
    ).toBe(0);
  });

  it("容量超過の接頭辞が前回のまとまりを割る場面でも、前回のまとまりを保つ分割が候補になり同じ計画に戻る（性質 5.6 の回帰）", () => {
    // Property 5.6 の反例（seed -1215411271 を縮めたもの）。卓 t-2 は Thick 極硬（100 秒・2 釜）・Thin 柔らか 2 品
    // （75 秒・2 釜と 1 釜）で Σ span 5 が上限 4 を超える。前回の無い計画は正準順序の接頭辞 [Thick, 柔らか#0]（span 4）を
    // pack して 121 秒に揃え、柔らか#1 を 100 秒に置く。再計画では茹で時間が同値の柔らか 2 品の並びを前回の startAt
    // （#1 が 25 秒・#0 が 46 秒）で断つため接頭辞が [Thick, 柔らか#1] に変わり、前回同じ群だった Thick と柔らか#0 が
    // 接頭辞の内と外に割れる——業務費用は同点のまま Thick が 2 秒へ動き、変更費用 31 秒を自前解自身が作っていた。
    const arrival = NOW - 600 * SECS;
    const pending = [
      pendingItem({ orderId: "o-0", firmness: "normal", arrivalTime: arrival }),
      pendingItem({ orderId: "o-1", firmness: "extraHard", tableId: "t-1", arrivalTime: arrival }),
      pendingItem({
        orderId: "o-1",
        itemIndex: 1,
        firmness: "extraHard",
        tableId: "t-1",
        arrivalTime: arrival,
      }),
      pendingItem({
        orderId: "o-2",
        firmness: "soft",
        tableId: "t-2",
        arrivalTime: arrival,
        slotSpan: 2,
      }),
      pendingItem({
        orderId: "o-2",
        itemIndex: 1,
        firmness: "soft",
        tableId: "t-2",
        arrivalTime: arrival,
      }),
      pendingItem({
        orderId: "o-2",
        itemIndex: 2,
        firmness: "normal",
        arrivalTime: arrival,
        slotSpan: 2,
      }),
      pendingItem({
        orderId: "o-3",
        noodleType: "Thick",
        firmness: "extraHard",
        tableId: "t-2",
        arrivalTime: arrival,
        slotSpan: 2,
      }),
      pendingItem({
        orderId: "o-3",
        itemIndex: 1,
        noodleType: "Thick",
        firmness: "extraHard",
        arrivalTime: arrival,
      }),
    ];
    const params: ScheduleParams = {
      ...schedulingDefaults(2),
      arms: 2,
      tableSyncWeight: 1,
      orderSyncWeight: 0,
      affinityWeight: 0,
      liftIntervalSeconds: 21,
    };
    const planWide = (changeContext: ChangeContext | null) =>
      baselineSchedule(
        pending,
        initialRelease([], NOW, 12),
        NO_MEMBERS,
        NO_LIFTS,
        PRESETS,
        params,
        NOW,
        occupiedSlotsOf([]),
        changeContext,
      );
    const first = planWide(null);
    const changeContext = changeContextOf(shownPlanOf(first, recommend(first)), [], pending);

    const second = planWide(changeContext);

    expect(first.slices.at(-1)!.placements.map(readable)).toEqual([
      { item: "o-2#0", slots: ["8", "9"], startSeconds: 46, serveSeconds: 121 },
      { item: "o-2#1", slots: ["10"], startSeconds: 25, serveSeconds: 100 },
      { item: "o-3#0", slots: ["6", "7"], startSeconds: 21, serveSeconds: 121 },
    ]);
    expect(second).toEqual(first);
    expect(
      changeCost({ schedule: second, recommendations: recommend(second) }, changeContext, params),
    ).toBe(0);
  });

  it("合流した群で 1 本だけ窓に残っていた前回の配置は、前回の提供時刻ごとの塊で再現され同じ計画に戻る（性質 5.6 / 5.7 の回帰）", () => {
    // Property 5.7 の反例（seed 205718488 を縮めたもの）。走行中 3 本（うち 1 本が卓 t-2）が 75.751 秒に上がる表で
    // arms 3・L 5：卓 t-2 の 4 品は全員が錨 75.751 秒に合流でき、窓の残り 2 本分に 1 本だけが入って残りは 80.751 秒。
    // 前回の無い計画は正準順序の split（接頭辞 3 本が 80.751 秒・余りの o-3#0 が 75.751 秒）。再計画では茹で時間が同値の
    // o-0#0 と o-3#0 の並びを前回の startAt で断つため接頭辞と余りが入れ替わり、split は o-0#0 を 75.751 秒に置く形に
    // なる。4 品は同じ群（mates）なので「前回のまとまりを保つ分割」は pack と同じで、前回の配置が候補に無く、業務費用
    // 5 秒・変更費用 1 秒の両方で劣る pack が採られていた。前回の serveAt ごとの塊で置く候補がそれを再現する。
    const arrival = NOW - 600 * SECS;
    const pending = [
      pendingItem({ orderId: "o-0", firmness: "hard", tableId: "t-2", arrivalTime: arrival }),
      pendingItem({ orderId: "o-1", firmness: "soft", tableId: "t-2", arrivalTime: arrival }),
      pendingItem({ orderId: "o-1", itemIndex: 1, firmness: "extraHard", arrivalTime: arrival }),
      pendingItem({
        orderId: "o-2",
        noodleType: "Medium",
        firmness: "extraHard",
        tableId: "t-2",
        arrivalTime: arrival,
      }),
      pendingItem({ orderId: "o-3", firmness: "hard", tableId: "t-2", arrivalTime: arrival }),
      pendingItem({ orderId: "o-3", itemIndex: 1, firmness: "extraHard", arrivalTime: arrival }),
    ];
    const running = [
      timerOn({ id: "r0", slot: "0", endTime: NOW + 75_751, tableId: "t-2" }),
      timerOn({ id: "r1", slot: "1", endTime: NOW + 75_751 }),
      timerOn({ id: "r2", slot: "2", endTime: NOW + 75_751 }),
    ];
    const params: ScheduleParams = {
      ...schedulingDefaults(3),
      arms: 3,
      toleranceRatio: 1,
      tableSyncWeight: 0,
      orderSyncWeight: 0,
      affinityWeight: 0,
      liftIntervalSeconds: 5,
    };
    const planWide = (changeContext: ChangeContext | null) =>
      baselineSchedule(
        pending,
        initialRelease(running, NOW, 18),
        tableMembers(running),
        initialLifts(running),
        PRESETS,
        params,
        NOW,
        occupiedSlotsOf(running),
        changeContext,
      );
    const first = planWide(null);
    const changeContext = changeContextOf(shownPlanOf(first, recommend(first)), running, pending);

    const second = planWide(changeContext);

    expect(first.slices.at(-1)!.placements.map(readable)).toEqual([
      { item: "o-0#0", slots: ["5"], startSeconds: 28.751, serveSeconds: 80.751 },
      { item: "o-1#0", slots: ["6"], startSeconds: 5.751, serveSeconds: 80.751 },
      { item: "o-2#0", slots: ["7"], startSeconds: 5.751, serveSeconds: 80.751 },
      { item: "o-3#0", slots: ["8"], startSeconds: 23.751, serveSeconds: 75.751 },
    ]);
    expect(second).toEqual(first);
    expect(
      changeCost({ schedule: second, recommendations: recommend(second) }, changeContext, params),
    ).toBe(0);
  });

  it("列の局所比較で勝つ候補が全体では劣るとき、前回に忠実な計画が残る（総費用で 2 本を比べる・性質 5.6 の回帰）", () => {
    // Property 5.6 の反例（seed 741737030 を縮めたもの）。w_table 4・arms 2・L 62・走行中 3 本（50.2 / 54.3 / 199 秒）。
    // 卓 t-1 は Thick 極硬（100 秒・2 釜）と Thin 柔らか 2 品（75 秒・2 釜と 1 釜）で Σ span 5 が上限 4 を超える。
    // 前回の無い計画は接頭辞 [Thick, 柔らか#0] を 261 秒に pack し、柔らか#1 を 116.334 秒に置く。再計画では同値の
    // 並びを前回の startAt で断つため接頭辞が [Thick, 柔らか#1] になり、その分割（Thick 137 秒・柔らか#0 178.334 秒）は
    // 卓の一片で 370 秒改善して局所では勝つが、後続の単独品 o-2#2 を窓が 71 → 154 秒へ押し、変更費用 444 秒を足すと
    // 前回より 218 秒悪い（7460 対 7242）。前回に忠実な計画と総費用で比べるので、前回の計画が残る。
    const arrival = NOW - 600 * SECS;
    const pending = [
      pendingItem({
        orderId: "o-0",
        noodleType: "Medium",
        firmness: "extraHard",
        arrivalTime: arrival + 1,
      }),
      pendingItem({
        orderId: "o-0",
        itemIndex: 1,
        firmness: "extraHard",
        tableId: "t-2",
        arrivalTime: arrival + 1,
      }),
      pendingItem({
        orderId: "o-0",
        itemIndex: 2,
        noodleType: "Thick",
        firmness: "extraHard",
        tableId: "t-1",
        arrivalTime: arrival + 1,
        slotSpan: 2,
      }),
      pendingItem({
        orderId: "o-0",
        itemIndex: 3,
        firmness: "extraHard",
        arrivalTime: arrival + 1,
      }),
      // プリセットに無い麺種は置かれないが、卓 t-2 の群を先頭に並べる（反例そのまま）。
      pendingItem({
        orderId: "o-1",
        noodleType: "Ghost",
        firmness: "extraHard",
        tableId: "t-2",
        arrivalTime: arrival,
      }),
      pendingItem({
        orderId: "o-2",
        firmness: "soft",
        tableId: "t-1",
        arrivalTime: arrival + 2,
        slotSpan: 2,
      }),
      pendingItem({
        orderId: "o-2",
        itemIndex: 1,
        firmness: "soft",
        tableId: "t-1",
        arrivalTime: arrival + 2,
      }),
      pendingItem({
        orderId: "o-2",
        itemIndex: 2,
        firmness: "extraHard",
        arrivalTime: arrival + 2,
      }),
    ];
    // 走行中 3 本は同じ釜 0 に載る（反例そのまま。釜は 1 つしか塞がず、上げ表に 3 本の上がりが載る）。
    const running = [
      timerOn({ id: "r0", slot: "0", endTime: NOW + 50_201 }),
      timerOn({ id: "r1", slot: "0", endTime: NOW + 54_334, tableId: "t-2" }),
      timerOn({ id: "r2", slot: "0", endTime: NOW + 199_000, tableId: "t-2" }),
    ];
    const params: ScheduleParams = {
      ...schedulingDefaults(2),
      arms: 2,
      toleranceRatio: 1,
      tableSyncWeight: 4,
      orderSyncWeight: 0,
      affinityWeight: 0,
      liftIntervalSeconds: 62,
    };
    const planWide = (changeContext: ChangeContext | null) =>
      baselineSchedule(
        pending,
        initialRelease(running, NOW, 12),
        tableMembers(running),
        initialLifts(running),
        PRESETS,
        params,
        NOW,
        occupiedSlotsOf(running),
        changeContext,
      );
    const first = planWide(null);
    const changeContext = changeContextOf(shownPlanOf(first, recommend(first)), running, pending);

    const second = planWide(changeContext);

    const t1 = first.slices.find((slice) => slice.tableKey === "t-1")!;
    expect(t1.placements.map(readable)).toEqual([
      { item: "o-0#2", slots: ["6", "7"], startSeconds: 161, serveSeconds: 261 },
      { item: "o-2#0", slots: ["8", "9"], startSeconds: 186, serveSeconds: 261 },
      { item: "o-2#1", slots: ["10"], startSeconds: 41.334, serveSeconds: 116.334 },
    ]);
    expect(second).toEqual(first);
    expect(
      changeCost({ schedule: second, recommendations: recommend(second) }, changeContext, params),
    ).toBe(0);
  });
});

describe("planTargets — 期限切れの品目は計画対象に入らない（pending-order-expiry AC 2.1・性質 5.4）", () => {
  const pad = (index: number) => String(index).padStart(3, "0");
  /** 到着順の先頭を占める期限切れ 64 件（枠と同じ数・すべて NOW でちょうど切れる）。 */
  const dead = Array.from({ length: PLAN_TARGET_LIMIT }, (_unused, index) =>
    pendingItem({ orderId: `dead-${pad(index)}`, arrivalTime: NOW - ORDER_LIFETIME_MS }),
  );
  /** その後に届いた生きている 65 件（1 件は枠から溢れる）。 */
  const alive = Array.from({ length: PLAN_TARGET_LIMIT + 1 }, (_unused, index) =>
    pendingItem({ orderId: `live-${pad(index)}`, arrivalTime: NOW - 100_000 + index }),
  );

  it("絞ってから切る：計画対象は生きている品目の先頭 64 件で、期限切れは何件先頭に在っても枠を食わない", () => {
    expect(planTargets([...dead, ...alive], NOW)).toEqual(alive.slice(0, PLAN_TARGET_LIMIT));
  });

  it("入力の並びに依らない：期限切れを後ろに置いても同じ計画対象", () => {
    expect(planTargets([...alive, ...dead], NOW)).toEqual(alive.slice(0, PLAN_TARGET_LIMIT));
  });

  it("now だけが違えば同じ待ち行列から違う計画対象が出る：1 ms 手前では先頭 64 件は期限切れ側で埋まる", () => {
    const justBefore = planTargets([...dead, ...alive], (NOW - 1) as EpochMillis);
    expect(justBefore).toHaveLength(PLAN_TARGET_LIMIT);
    expect(justBefore.every((order) => order.externalOrderId.startsWith("dead-"))).toBe(true);
  });

  it("自前解も同じ 64 件を置く（期限切れは配置に現れない）", () => {
    const schedule = baselineSchedule(
      [...dead, ...alive],
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );
    const placed = schedule.slices.flatMap((slice) => slice.placements);
    expect(placed).toHaveLength(PLAN_TARGET_LIMIT);
    expect(new Set(placed.map((placement) => placement.externalOrderId))).toEqual(
      new Set(alive.slice(0, PLAN_TARGET_LIMIT).map((order) => order.externalOrderId)),
    );
  });
});

describe("baselineSchedule — 期限切れの旧先頭を文脈から外す（pending-order-expiry AC 2.4・レビュー実走）", () => {
  const scene = mixedScene(NOW);
  /** 場面の自前解。`pending` は変更費用の文脈が対応の相手にする集合（null は前回なし）。 */
  function planWith(pending: readonly OrderItem[] | null) {
    return baselineSchedule(
      scene.pending,
      initialRelease(scene.running, NOW, 6),
      tableMembers(scene.running),
      initialLifts(scene.running),
      EXPIRY_PRESETS,
      EXPIRY_PARAMS,
      NOW,
      occupiedSlotsOf(scene.running),
      pending === null
        ? null
        : {
            shown: scene.shown,
            running: scene.running,
            now: NOW,
            pending,
            presets: EXPIRY_PRESETS,
          },
    );
  }
  const placementsOf = (schedule: ReturnType<typeof planWith>) =>
    schedule.slices.flatMap((slice) => slice.placements);

  it("前回が無ければ業務費用で pack（B・C とも 45 秒後）。期限切れの A は正本に在っても置かれない", () => {
    expect(startOffsets(placementsOf(planWith(null)), NOW)).toEqual([
      ["B", 45],
      ["C", 45],
    ]);
  });

  it("正しい文脈（A を除いた pending）では B が旧 Head で、B を今に残す分割を採る（変更費用 0）", () => {
    const schedule = planWith(scene.live);
    expect(startOffsets(placementsOf(schedule), NOW)).toEqual([
      ["B", 0],
      ["C", 45],
    ]);
    expect(schedule.slices).toEqual(scene.split.slices);
    expect(changeCostOf(schedule, scene, scene.live)).toBe(0);
  });

  it("期限切れの A を文脈に残すと旧 Head が A になり、B の先頭消失が数えられずに pack へ動く（対応の規律が破れる形）", () => {
    expect(startOffsets(placementsOf(planWith(scene.pending)), NOW)).toEqual([
      ["B", 45],
      ["C", 45],
    ]);
    expect(changeCostOf(scene.pack, scene, scene.pending)).toBe(0);
    expect(changeCostOf(scene.pack, scene, scene.live)).toBe(2 * EXPIRY_PARAMS.liftIntervalSeconds);
  });
});

describe("placeableTargets — 置ける品目（plan-stability Requirement 7・startable-placement task 3′.1）", () => {
  // Feature: plan-stability
  // **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**
  const pad = (index: number) => String(index).padStart(3, "0");
  const SECS = 1_000;
  /** 生きている 65 件（1 件は枠から溢れる）。5 件目はプリセットに無い麺種、10 件目は単体で上限（arms 2 + 2 = 4）を超える大盛。 */
  const alive = Array.from({ length: PLAN_TARGET_LIMIT + 1 }, (_unused, index) =>
    pendingItem({
      orderId: `live-${pad(index)}`,
      arrivalTime: NOW - 100_000 + index,
      noodleType: index === 4 ? "Ghost" : "Thin",
      slotSpan: index === 9 ? 5 : 1,
    }),
  );
  const ids = (orders: readonly OrderItem[]) => orders.map((order) => order.externalOrderId);
  const GHOST_PRESET = {
    noodleType: "Ghost",
    boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 },
  };

  it("計画対象を決めた後に絞る：先頭 64 件のうち置けない 2 件が落ち、65 件目は繰り上がらない（AC 7.1）", () => {
    const placeable = placeableTargets(alive, NOW, DEFAULT_NOODLE_PRESETS, PARAMS);
    expect(placeable).toHaveLength(PLAN_TARGET_LIMIT - 2);
    expect(ids(placeable)).not.toContain("live-004");
    expect(ids(placeable)).not.toContain("live-009");
    expect(ids(placeable)).not.toContain(`live-${pad(PLAN_TARGET_LIMIT)}`);
    // 正本の計画対象（指紋・要求が指す範囲）は 64 件のまま。
    expect(planTargets(alive, NOW)).toHaveLength(PLAN_TARGET_LIMIT);
  });

  it("自前解が置く品目集合は置ける品目に一致し、一片は置ける品目に対して isStale が偽（AC 7.4）", () => {
    const placeable = placeableTargets(alive, NOW, DEFAULT_NOODLE_PRESETS, PARAMS);
    const schedule = baselineSchedule(
      alive,
      EMPTY_KITCHEN,
      NO_MEMBERS,
      NO_LIFTS,
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf([]),
      null,
    );
    const placed = schedule.slices.flatMap((slice) => slice.placements);
    expect(new Set(placed.map((placement) => placement.externalOrderId))).toEqual(
      new Set(ids(placeable)),
    );
    for (const slice of schedule.slices) expect(isStale(slice, placeable)).toBe(false);
    // 正本のまま比べると、置けない品目の単独一片が「欠落」で落ちる（自前解はそれを置かない）——Requirement 7 の動機。
    const targets = planTargets(alive, NOW);
    expect(schedule.slices.some((slice) => isStale(slice, targets))).toBe(false);
    expect(targets.filter((order) => !ids(placeable).includes(order.externalOrderId))).toHaveLength(
      2,
    );
  });

  it("設定変更で麺種が置けるようになれば集合が広がり、arms を上げれば大盛も入る（AC 7.5）", () => {
    const withGhost = placeableTargets(
      alive,
      NOW,
      [...DEFAULT_NOODLE_PRESETS, GHOST_PRESET],
      PARAMS,
    );
    expect(ids(withGhost)).toContain("live-004");
    expect(withGhost).toHaveLength(PLAN_TARGET_LIMIT - 1);
    const wideArms = placeableTargets(alive, NOW, DEFAULT_NOODLE_PRESETS, { ...PARAMS, arms: 3 });
    expect(ids(wideArms)).toContain("live-009");
    expect(wideArms).toHaveLength(PLAN_TARGET_LIMIT - 1);
  });

  it("空き不足は除外理由にしない：全釜が遠い将来まで塞がっていても置ける品目は同じ（AC 7.2）", () => {
    const blocked = [0, 1, 2, 3, 4, 5].map((slot) =>
      timerOn({ id: `r${slot}`, slot: String(slot), endTime: NOW + 10_000 * SECS }),
    );
    // 置ける品目は待ち行列と設定だけから決まる（`running` を受けない署名がそれを語る）。自前解は待たせて置く。
    const placeable = placeableTargets(alive, NOW, DEFAULT_NOODLE_PRESETS, PARAMS);
    const schedule = baselineSchedule(
      alive,
      initialRelease(blocked, NOW, 6),
      tableMembers(blocked),
      initialLifts(blocked),
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      NOW,
      occupiedSlotsOf(blocked),
      null,
    );
    const placed = schedule.slices.flatMap((slice) => slice.placements);
    expect(placed).toHaveLength(placeable.length);
    expect(placed.every((placement) => placement.startAt >= NOW + 10_000 * SECS)).toBe(true);
  });
});
