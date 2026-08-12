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
import { PLAN_TARGET_LIMIT, baselineSchedule, initialRelease, toCookSchedule } from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import { createTimer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import type { Firmness } from "../../src/domain/firmness";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_000_000 as EpochMillis;

/** slot 1 個を占める Timer。endTime と boiledAt / adjustment だけを振る。 */
function timerOn(input: {
  id: string;
  slot: string;
  endTime: number;
  boiledAt?: number | null;
  adjustment?: number;
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
  });
}

describe("initialRelease — slot の最早解放時刻", () => {
  it("running / boiled / 空き slot がそれぞれの解放時刻になる", () => {
    // slot 0: 走行中（30 秒後に上がる）／slot 1: 茹で上がり済み（10 秒前に上がった）／slot 2..5: 空き。
    const running = timerOn({ id: "t-running", slot: "0", endTime: NOW + 30_000 });
    const boiled = timerOn({ id: "t-boiled", slot: "1", endTime: NOW - 10_000, boiledAt: NOW - 10_000 });

    const release = initialRelease([running, boiled], NOW, 6);

    expect(release).toEqual([NOW + 30_000, NOW, NOW, NOW, NOW, NOW]);
    // boiled の釜は今すぐ空いている（解放済み）。
    expect(release[1]).toBeLessThanOrEqual(NOW);
  });

  it("解放時刻は実効 endTime（endTime + adjustment）で立つ", () => {
    // Boil_Sync が 5 秒早めた Timer。オリジナル endTime ではなく実効値が釜の解放時刻を決める。
    const adjusted = timerOn({ id: "t-adjusted", slot: "0", endTime: NOW + 30_000, adjustment: -5_000 });

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
const PARAMS: ScheduleParams = schedulingDefaults(1);

/** 空の厨房（6 slot すべてが今すぐ空いている）。 */
const EMPTY_KITCHEN = initialRelease([], NOW, 6);

/** Pending_Order 1 件。既定プリセットの茹で時間は Thin 60 秒 / Medium 90 秒 / Thick 120 秒（normal）。 */
function pendingItem(input: {
  orderId: string;
  itemIndex?: number;
  noodleType?: string;
  firmness?: Firmness;
  tableId?: string | null;
  arrivalTime?: number;
}): PendingOrder {
  return {
    externalOrderId: input.orderId,
    itemIndex: input.itemIndex ?? 0,
    noodleType: input.noodleType ?? "Thin",
    firmness: input.firmness ?? "normal",
    tableId: input.tableId ?? null,
    arrivalTime: input.arrivalTime ?? NOW,
  };
}

/** 配置を照合しやすい形へ（slot 番号・開始と提供の相対秒）。 */
function readable(placement: { externalOrderId: string; itemIndex: number; slotIds: readonly string[]; startAt: number; serveAt: number }) {
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

    const schedule = baselineSchedule(pending, EMPTY_KITCHEN, DEFAULT_NOODLE_PRESETS, PARAMS);

    expect(schedule.slices).toHaveLength(1);
    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      // 全 slot が同時に空いているため affinity では差が付かず、slot index 昇順で断つ。
      { item: "o-1#0", slots: ["0"], startSeconds: 0, serveSeconds: 60 },
    ]);
    // Σ Wait_Time = 60 秒。単独品目にソフト制約の超過は生じない。
    expect(schedule.score).toBe(60);
    expect(schedule.slices[0]!.score).toBe(60);
  });

  it("プリセットに無い麺種は配置されない（計画にも現れない）", () => {
    // 設定の差し替えを跨いだ待ち行列にだけ現れ得る形。既定の茹で時間を当てて嘘の計画を作らない。
    const pending = [pendingItem({ orderId: "o-1", noodleType: "Ghost" })];

    expect(baselineSchedule(pending, EMPTY_KITCHEN, DEFAULT_NOODLE_PRESETS, PARAMS)).toEqual({
      slices: [],
      score: 0,
    });
  });

  it("Pending_Order が空なら空の計画", () => {
    expect(baselineSchedule([], EMPTY_KITCHEN, DEFAULT_NOODLE_PRESETS, PARAMS)).toEqual({ slices: [], score: 0 });
  });
});

describe("baselineSchedule — 同卓 3 品目（同一オーダー 2 品目）", () => {
  // 卓 t-1 に 2 オーダー。オーダー A は Thin（60 秒）と Thick（120 秒）、オーダー B は Medium（90 秒）。
  const pending = [
    pendingItem({ orderId: "A", itemIndex: 0, noodleType: "Thin", tableId: "t-1" }),
    pendingItem({ orderId: "A", itemIndex: 1, noodleType: "Thick", tableId: "t-1" }),
    pendingItem({ orderId: "B", itemIndex: 0, noodleType: "Medium", tableId: "t-1" }),
  ];

  it("提供時刻が許容幅内に揃い、茹での短い品目は開始が後ろへ逆算される", () => {
    const schedule = baselineSchedule(pending, EMPTY_KITCHEN, DEFAULT_NOODLE_PRESETS, PARAMS);

    expect(schedule.slices).toHaveLength(1);
    expect(schedule.slices[0]!.tableKey).toBe("t-1");
    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      // 茹での長い Thick が最も早く空く釜（slot 0）へ。Thin は 30 秒遅らせて提供を 90 秒へ寄せる
      // （錨は「解放 + 茹で」の最大 120 秒。許容幅 30 秒まで手前が許されるので 90 秒で足りる）。
      { item: "A#0", slots: ["2"], startSeconds: 30, serveSeconds: 90 },
      { item: "A#1", slots: ["0"], startSeconds: 0, serveSeconds: 120 },
      { item: "B#0", slots: ["1"], startSeconds: 0, serveSeconds: 90 },
    ]);
  });

  it("同一オーダー・同卓の超過はともに 0、slot も隣接ゆえ affinity 0（Σ Wait_Time だけが残る）", () => {
    const schedule = baselineSchedule(pending, EMPTY_KITCHEN, DEFAULT_NOODLE_PRESETS, PARAMS);

    // オーダー A の提供差 30 秒 = 許容ちょうど、卓の提供差 30 秒 ≤ 60 秒。slot 0・1・2 は縦横/斜め隣接。
    // ゆえに全ソフト制約項が 0 で、値は Σ Wait_Time = 90 + 120 + 90 = 300 秒に一致する。
    expect(schedule.score).toBe(300);
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

    const schedule = baselineSchedule(pending, initialRelease(running, NOW, 6), DEFAULT_NOODLE_PRESETS, PARAMS);

    expect(schedule.slices[0]!.placements.map(readable)).toEqual([
      { item: "o-1#0", slots: ["5"], startSeconds: 20, serveSeconds: 80 },
    ]);
    // Wait_Time は 80 秒（釜が空くのを待った 20 秒を含む）。
    expect(schedule.score).toBe(80);
  });
});

describe("baselineSchedule — 64 件境界で Table_Group が割れる", () => {
  // 先に届いた単独品目 63 件と、後から届いた 3 品目の卓。境界は卓の 1 品目目で切れる。
  const solo = Array.from({ length: PLAN_TARGET_LIMIT - 1 }, (_unused, index) =>
    pendingItem({ orderId: `s-${String(index).padStart(2, "0")}`, arrivalTime: NOW - 100_000 + index }),
  );
  const table = [0, 1, 2].map((itemIndex) =>
    pendingItem({ orderId: "o-big", itemIndex, tableId: "t-big", arrivalTime: NOW }),
  );

  it("計画対象に入った品目のみで PlanSlice を成す（残りは計画に現れない）", () => {
    const schedule = baselineSchedule([...solo, ...table], EMPTY_KITCHEN, DEFAULT_NOODLE_PRESETS, PARAMS);
    const placed = schedule.slices.flatMap((slice) => slice.placements);
    const split = schedule.slices.find((slice) => slice.tableKey === "t-big");

    expect(placed).toHaveLength(PLAN_TARGET_LIMIT);
    expect(split?.placements.map((placement) => placement.itemIndex)).toEqual([0]);
  });

  it("割れた卓のソフト制約は対象品目の間だけで評価される（部分和は Wait_Time のみ）", () => {
    const schedule = baselineSchedule([...solo, ...table], EMPTY_KITCHEN, DEFAULT_NOODLE_PRESETS, PARAMS);
    const split = schedule.slices.find((slice) => slice.tableKey === "t-big")!;
    const placement = split.placements[0]!;

    // 計画に入らなかった 2 品目は同卓・同一オーダーの差の計算に現れない。1 品目だけの一片ゆえ
    // 提供時刻差も slot 対も存在せず、部分和は当該品目の Wait_Time に一致する。
    expect(split.score).toBe(Math.floor((placement.serveAt - NOW) / 1000));
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
            { externalOrderId: "o-1", itemIndex: 0, slotIds: ["0"], startAt: NOW, serveAt: NOW + 60_000 },
          ],
        },
        {
          tableKey: "t-2",
          score: 50,
          placements: [
            { externalOrderId: "o-2", itemIndex: 1, slotIds: ["1", "2"], startAt: NOW, serveAt: NOW + 90_000 },
          ],
        },
      ],
    };
  }

  it("妥当な生値は CookSchedule へ写り、余剰フィールドは落ちる", () => {
    const raw = rawPlan() as { slices: { placements: Record<string, unknown>[] }[] };
    raw.slices[0]!.placements[0]!.injected = "外部の混ぜ物";

    const plan = toCookSchedule(raw);

    expect(plan).not.toBeNull();
    expect(plan!.score).toBe(120);
    expect(plan!.slices.map((slice) => slice.tableKey)).toEqual(["t-1", "t-2"]);
    expect(plan!.slices[1]!.placements[0]!.slotIds).toEqual(["1", "2"]);
    expect(plan!.slices[0]!.placements[0]).toEqual({
      externalOrderId: "o-1",
      itemIndex: 0,
      slotIds: ["0"],
      startAt: NOW,
      serveAt: NOW + 60_000,
    });
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

  it("整数でない score・object でない生値はいずれも落とす", () => {
    const fractional = rawPlan() as { score: number };
    fractional.score = 1.5;

    expect(toCookSchedule(fractional)).toBeNull();
    expect(toCookSchedule("計画ではない文字列")).toBeNull();
    expect(toCookSchedule(null)).toBeNull();
  });
});
