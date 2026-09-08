// tests/core/commit.example.test.ts — 確定計画の合成 committedSchedule（src/engine/commit.ts）の例示。
//
// Feature: lift-group-planning（コードレビュー指摘・2026-09-05）
// **Validates: Requirements 4.1, 4.6**
//
// 採用済み一片は採用時の制約の上に組まれている。v9 は slotSpan を読まずに 1 釜で組んだので、v10 へ
// 移行した後もそのまま維持されると「2 釜の品目を 1 釜で始める」推奨が出続ける。合成は永続を書き換えず、
// 現在の slotSpan で再検証して食い違う一片から先を自前解で置き換える。

import { describe, expect, it } from "vitest";
import { committedSchedule } from "../../src/engine/commit";
import type { AcceptedSlice } from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { OrderItem } from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const SECOND = 1_000;
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Thin", boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 } },
];
const PARAMS: ScheduleParams = schedulingDefaults(1);

/** 大盛（2 釜）の 1 品目。 */
const WIDE: OrderItem = {
  externalOrderId: "o-wide",
  itemIndex: 0,
  noodleType: "Thin",
  firmness: "normal",
  tableId: "t-a",
  arrivalTime: NOW,
  slotSpan: 2,
  itemName: null,
  sizeName: null,
  completedAt: null,
  interruptedAt: null,
};

/** v9 で採用された一片——品目は同じだが 1 釜で組まれている（v9 は slotSpan を読まなかった）。 */
const FROM_V9: AcceptedSlice = {
  tableKey: "t-a",
  placements: [
    {
      externalOrderId: WIDE.externalOrderId,
      itemIndex: 0,
      slotIds: nonEmpty(["0" as SlotId]),
      startAt: (NOW + 30 * SECOND) as EpochMillis,
      serveAt: (NOW + 90 * SECOND) as EpochMillis,
      anchor: null,
    },
  ],
};

describe("committedSchedule — 採用済み一片を現在の slotSpan で再検証する", () => {
  it("1 釜で組まれた採用済み一片は維持されず、自前解が 2 釜で置き直す", () => {
    const schedule = committedSchedule([FROM_V9], [WIDE], [], NOW, PRESETS, PARAMS, null);
    const placements = schedule.slices.flatMap((slice) => slice.placements);

    expect(placements).toHaveLength(1);
    expect(placements[0]!.slotIds).toHaveLength(2);
    expect(new Set(placements[0]!.slotIds).size).toBe(2);
    // 採用時の開始時刻（30 秒後）は引き継がれない——釜が空いているので今始める。
    expect(placements[0]!.startAt).toBe(NOW);
  });

  it("slotSpan を満たす採用済み一片はそのまま維持される（比較対照）", () => {
    const fits: AcceptedSlice = {
      tableKey: "t-a",
      placements: [
        { ...FROM_V9.placements[0]!, slotIds: nonEmpty(["0" as SlotId, "1" as SlotId]) },
      ],
    };
    const schedule = committedSchedule([fits], [WIDE], [], NOW, PRESETS, PARAMS, null);
    expect(schedule.slices).toEqual([fits]);
  });
});

describe("committedSchedule — 採用済み一片は現在の錨で再検証する（判断 17・keepsAnchor）", () => {
  // Feature: lift-group-planning, 判断 17
  // **Validates: Requirements 4.8, 5.3**
  //
  // 走行中の仲間（卓 t-a・釜 5・基底 endTime 600 秒）。錨は実効 endTime（endTime + adjustment）で、
  // Boil_Sync が adjustment を動かすと採用済み一片の前提（採用時の錨）が崩れる。
  const SECS = 1_000;
  function sibling(adjustment: number, endSeconds = 600) {
    return createTimer({
      id: "t-sibling" as TimerId,
      slotIds: nonEmpty(["5" as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: (NOW + (endSeconds - 60) * SECS) as EpochMillis,
      endTime: (NOW + endSeconds * SECS) as EpochMillis,
      seq: 1,
      adjustment,
      orderItem: { externalOrderId: "o-first", itemIndex: 0, tableId: "t-a" },
    });
  }
  /** 同じ卓の未着手（Thin 60 秒・1 釜）。 */
  const REST: OrderItem = { ...WIDE, externalOrderId: "o-rest", slotSpan: 1 };
  /** 採用時の錨 600 秒に合流した一片（釜 0・540 秒に始めて 600 秒に上がる）。 */
  const JOINED_AT_600: AcceptedSlice = {
    tableKey: "t-a",
    placements: [
      {
        externalOrderId: REST.externalOrderId,
        itemIndex: 0,
        slotIds: nonEmpty(["0" as SlotId]),
        startAt: (NOW + 540 * SECS) as EpochMillis,
        serveAt: (NOW + 600 * SECS) as EpochMillis,
        anchor: (NOW + 600 * SECS) as EpochMillis,
      },
    ],
  };
  function serveSecondsOf(
    running: readonly Timer[],
    accepted: readonly AcceptedSlice[] = [JOINED_AT_600],
  ) {
    const schedule = committedSchedule(accepted, [REST], running, NOW, PRESETS, PARAMS, null);
    return schedule.slices
      .flatMap((slice) => slice.placements)
      .map((p) => (p.serveAt - NOW) / 1000);
  }

  it("錨が動いていなければ一片は維持される", () => {
    expect(serveSecondsOf([sibling(0)])).toEqual([600]);
  });

  it("錨が h_i の内側で +Δ 動いても、配置の錨（600 秒）は現在の仲間に無く、一片は捨てられて自前解が新しい錨（605 秒）へ置き直す", () => {
    // Thin 60 秒の h_i は 6 秒。serveAt 600 秒は錨 605 秒から手前 5 秒——散らしではないが、`anchor: 600` は
    // 現在の仲間の実効 endTime に等しくない（AC 9.10 (a)）。錨は等号で運ぶ約束であり、近似では運ばない（判断 17）。
    expect(serveSecondsOf([sibling(5 * SECS)])).toEqual([605]);
  });

  it("錨が +Δ 動くと合流分は錨より手前になり、一片は捨てられて自前解が新しい錨（630 秒）へ揃え直す", () => {
    expect(serveSecondsOf([sibling(30 * SECS)])).toEqual([630]);
  });

  it("錨が −Δ 動いてもまだ合流できるなら押し出しになり、一片は捨てられて新しい錨（570 秒）へ揃え直す", () => {
    expect(serveSecondsOf([sibling(-30 * SECS)])).toEqual([570]);
  });

  it("錨が早まって本当に合流できなくなった品目の一片は、正当な後続の batch として維持される", () => {
    // 仲間が 30 秒後に上がる（基底 60 秒・−30 秒）。Thin 60 秒はもう届かない。一片は 90 秒に置いていた。
    const late: AcceptedSlice = {
      tableKey: "t-a",
      placements: [
        {
          ...JOINED_AT_600.placements[0]!,
          startAt: (NOW + 30 * SECS) as EpochMillis,
          serveAt: (NOW + 90 * SECS) as EpochMillis,
          anchor: null,
        },
      ],
    };
    expect(serveSecondsOf([sibling(-30 * SECS, 60)], [late])).toEqual([90]);
  });

  it("容量分割の一片（合流分は錨の次の窓に pack・残りは後続）は維持される", () => {
    // 6 釜。仲間が釜 4・5 を占めて 600 秒に上がる。同卓の 1 釜の品目 5 本：4 本が合流し、5 本目は釜が空いてから始める。
    // 合流分の候補は錨の 600 秒だが、その窓には走行中の 2 本分が在り、4 本を足すと上限 4 を超えるので pack は次の窓
    // 645 秒へ（判断 20・AC 9.10 (d) は pack 全体の span で firstFit した時刻との一致を求める）。5 本目は釜 4 が空く
    // 600 秒からの候補 660 秒が [645,690) の 4 本を避けて 690 秒へ。
    const first = createTimer({
      id: "t-first" as TimerId,
      slotIds: nonEmpty(["4" as SlotId, "5" as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: (NOW + 540 * SECS) as EpochMillis,
      endTime: (NOW + 600 * SECS) as EpochMillis,
      seq: 1,
      orderItem: { externalOrderId: "o-first", itemIndex: 0, tableId: "t-a" },
    });
    const items = [1, 2, 3, 4, 5].map((itemIndex) => ({
      ...REST,
      externalOrderId: "o-rest",
      itemIndex,
    }));
    const place = (itemIndex: number, slot: string, startSeconds: number) => ({
      externalOrderId: "o-rest",
      itemIndex,
      slotIds: nonEmpty([slot as SlotId]),
      startAt: (NOW + startSeconds * SECS) as EpochMillis,
      serveAt: (NOW + (startSeconds + 60) * SECS) as EpochMillis,
      // 錨の次の窓 645 秒に上がる配置は仲間（600 秒）へ合流。釜が空いてから始める 5 本目は合流ではない。
      anchor: startSeconds + 60 === 645 ? ((NOW + 600 * SECS) as EpochMillis) : null,
    });
    const split: AcceptedSlice = {
      tableKey: "t-a",
      placements: [
        place(1, "0", 585),
        place(2, "1", 585),
        place(3, "2", 585),
        place(4, "3", 585),
        place(5, "4", 630),
      ],
    };
    const schedule = committedSchedule([split], items, [first], NOW, PRESETS, PARAMS, null);
    expect(schedule.slices).toEqual([split]);
  });

  it("外部解が自前解と別の合流集合を選んでも、押し出しが無ければ維持される", () => {
    // 空きは釜 0 だけ（釜 1〜4 は遠い未来まで塞ぐ）。同卓の A・B のうち 1 本しか合流できない。自前解は正準順の
    // A を選ぶが、外部解が B を合流させ A を釜 5 の空く 600 秒に回す一片は、A が B の後では合流できないので守っている。
    const blocked = [1, 2, 3, 4].map((slot) =>
      createTimer({
        id: `t-blocked-${slot}` as TimerId,
        slotIds: nonEmpty([String(slot) as SlotId]),
        noodleType: "Thin" as NoodleType,
        firmness: "normal",
        startTime: NOW,
        endTime: (NOW + 10_000 * SECS) as EpochMillis,
        seq: 10 + slot,
      }),
    );
    const A: OrderItem = { ...REST, externalOrderId: "o-A", arrivalTime: NOW };
    const B: OrderItem = {
      ...REST,
      externalOrderId: "o-B",
      arrivalTime: (NOW + 1) as EpochMillis,
    };
    const joinB: AcceptedSlice = {
      tableKey: "t-a",
      placements: [
        {
          externalOrderId: "o-B",
          itemIndex: 0,
          slotIds: nonEmpty(["0" as SlotId]),
          startAt: (NOW + 540 * SECS) as EpochMillis,
          serveAt: (NOW + 600 * SECS) as EpochMillis,
          anchor: (NOW + 600 * SECS) as EpochMillis,
        },
        {
          externalOrderId: "o-A",
          itemIndex: 0,
          slotIds: nonEmpty(["5" as SlotId]),
          startAt: (NOW + 600 * SECS) as EpochMillis,
          serveAt: (NOW + 660 * SECS) as EpochMillis,
          anchor: null,
        },
      ],
    };
    const schedule = committedSchedule(
      [joinB],
      [A, B],
      [sibling(0), ...blocked],
      NOW,
      PRESETS,
      PARAMS,
      null,
    );
    expect(schedule.slices).toEqual([joinB]);
    // 対照：自前解は A を合流させる。
    const own = committedSchedule([], [A, B], [sibling(0), ...blocked], NOW, PRESETS, PARAMS, null);
    const joined = own.slices[0]!.placements.find((p) => p.serveAt === NOW + 600 * SECS)!;
    expect(joined.externalOrderId).toBe("o-A");
  });
});

describe("committedSchedule — 採用済み一片は現在の上げ窓の上限で再検証する（AC 9.14・ハード制約 (f)・task 21.8）", () => {
  // Feature: lift-group-planning, 判断 20・ADR-0009
  // **Validates: Requirements 9.4, 9.14**
  //
  // 卓を持たない走行中 Thin（成員にならず、上げ表にだけ載る）が 60 秒に上がる。arms 2 → 上限 4・L 45 秒。
  // ラジアルからの開始は上限を検査しない（AC 8.3）ので、採用時に収まっていた窓が後から埋まりうる。
  function others(count: number): readonly Timer[] {
    return Array.from({ length: count }, (_, index) =>
      createTimer({
        id: `t-other-${index}` as TimerId,
        slotIds: nonEmpty([String(5 - index) as SlotId]),
        noodleType: "Thin" as NoodleType,
        firmness: "normal",
        startTime: NOW,
        endTime: (NOW + 60 * SECOND) as EpochMillis,
        seq: 20 + index,
      }),
    );
  }
  const ONE: OrderItem = { ...WIDE, externalOrderId: "o-one", slotSpan: 1 };
  /** 釜 0 で serveSeconds に上がる採用済み一片（合流の所属は無い）。 */
  function acceptedAt(serveSeconds: number): AcceptedSlice {
    return {
      tableKey: "t-a",
      placements: [
        {
          externalOrderId: ONE.externalOrderId,
          itemIndex: 0,
          slotIds: nonEmpty(["0" as SlotId]),
          startAt: (NOW + (serveSeconds - 60) * SECOND) as EpochMillis,
          serveAt: (NOW + serveSeconds * SECOND) as EpochMillis,
          anchor: null,
        },
      ],
    };
  }
  function serveSecondsOf(running: readonly Timer[], accepted: AcceptedSlice): number[] {
    return committedSchedule([accepted], [ONE], running, NOW, PRESETS, PARAMS, null)
      .slices.flatMap((slice) => slice.placements)
      .map((placement) => (placement.serveAt - NOW) / 1000);
  }

  it("当該配置を含む窓が無関係な走行中で上限を超えれば陳腐化と見なし、自前解が次の窓へ置き直す", () => {
    // 3 本 + 1 本 = 4 ≤ 4 で維持。4 本 + 1 本 = 5 > 4 で切られ、自前解が firstFit の 105 秒へ置く。
    expect(serveSecondsOf(others(3), acceptedAt(60))).toEqual([60]);
    expect(serveSecondsOf(others(4), acceptedAt(60))).toEqual([105]);
  });

  it("走行中だけで超えている窓は、それを含まない一片を落とさない（AC 9.4）", () => {
    // 5 本が 60 秒の窓 [60,105) は既に 5 > 4 だが、200 秒の一片はその窓に入らない。
    expect(serveSecondsOf(others(5), acceptedAt(200))).toEqual([200]);
  });
});

describe("committedSchedule — 開始を妨げる配置の失効 cannotStart（startable-placement 判断 8・Requirement 3.4 / 3.5）", () => {
  // Feature: startable-placement
  // **Validates: Requirements 3.4, 3.5**
  //
  // 6 釜。採用済み一片は品目 ONE を釜 3 に置く。自前解は解放時刻が同点なら index 最小の釜 0 を採るので、
  // 一片が維持されれば釜 3、切られて尾部が置き直せば釜 0——釜の番号が「維持か置き直しか」を語る。
  // 解放表は boiled の釜を `now` に空く予測で扱う（変えない）ので、feasibility だけなら一片は通る。
  const ONE: OrderItem = { ...WIDE, externalOrderId: "o-one", slotSpan: 1 };
  /** 釜 3 に startSeconds から始める採用済み一片（合流の所属は無い）。 */
  function acceptedOn3(startSeconds: number): AcceptedSlice {
    return {
      tableKey: "t-a",
      placements: [
        {
          externalOrderId: ONE.externalOrderId,
          itemIndex: 0,
          slotIds: nonEmpty(["3" as SlotId]),
          startAt: (NOW + startSeconds * SECOND) as EpochMillis,
          serveAt: (NOW + (startSeconds + 60) * SECOND) as EpochMillis,
          anchor: null,
        },
      ],
    };
  }
  /** 釜 3 に載る卓なしの Timer。boiled なら endTime は過去で boiledAt を持つ（Complete 待ち）。 */
  function timerOn3(boiled: boolean): Timer {
    const endTime = (boiled ? NOW - 10 * SECOND : NOW + 30 * SECOND) as EpochMillis;
    return createTimer({
      id: "t-on-3" as TimerId,
      slotIds: nonEmpty(["3" as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: (endTime - 60 * SECOND) as EpochMillis,
      endTime,
      seq: 30,
      boiledAt: boiled ? endTime : null,
    });
  }
  function placementOf(running: readonly Timer[], accepted: AcceptedSlice, now: EpochMillis) {
    const schedule = committedSchedule([accepted], [ONE], running, now, PRESETS, PARAMS, null);
    const placements = schedule.slices.flatMap((slice) => slice.placements);
    expect(placements).toHaveLength(1);
    return {
      slot: placements[0]!.slotIds[0],
      startSeconds: (placements[0]!.startAt - NOW) / SECOND,
      kept: schedule.slices.length === 1 && schedule.slices[0] === accepted,
    };
  }

  it("(a) startAt === now で boiled の釜に置かれた採用済み一片は接頭辞から落ち、尾部が置き直す", () => {
    // 釜 3 は 10 秒前に上がった boiled（解放表では `now` に空く予測）。一片は「今」釜 3 に置く——押せない釜。
    expect(placementOf([timerOn3(true)], acceptedOn3(0), NOW)).toEqual({
      slot: "0",
      startSeconds: 0,
      kept: false,
    });
  });

  it("(b) startAt === now で Timer の無い釜に置かれた採用済み一片は維持される", () => {
    expect(placementOf([], acceptedOn3(0), NOW)).toEqual({
      slot: "3",
      startSeconds: 0,
      kept: true,
    });
  });

  it("(c) 過去に受領した将来配置は、時刻の到来で startAt === now になったとき釜がまだ boiled なら、その遷移で落ちる", () => {
    // 30 秒後に釜 3 で始める一片。受領の時点（now）では開始時刻が先で、boiled の釜はそれまでに Complete される予測に
    // 立って維持される（判断 2・Timer の有無を見ない）。
    expect(placementOf([timerOn3(true)], acceptedOn3(30), NOW)).toEqual({
      slot: "3",
      startSeconds: 30,
      kept: true,
    });
    // 30 秒後の遷移：開始時刻が来たのに釜 3 はまだ boiled——落ちて尾部が置き直す（自前解は今の解放表で釜 0 に今）。
    const later = (NOW + 30 * SECOND) as EpochMillis;
    expect(placementOf([timerOn3(true)], acceptedOn3(30), later)).toEqual({
      slot: "0",
      startSeconds: 30,
      kept: false,
    });
    // 対照：同じ遷移で釜 3 が Complete されていれば維持される。
    expect(placementOf([], acceptedOn3(30), later)).toEqual({
      slot: "3",
      startSeconds: 30,
      kept: true,
    });
  });

  it("(d) startAt < now（過去開始）は釜に Timer が無くても従来どおり落ちる", () => {
    expect(placementOf([], acceptedOn3(-1), NOW)).toEqual({
      slot: "0",
      startSeconds: 0,
      kept: false,
    });
  });

  it("(e) 走行中の Timer でも同じ——startAt === now で釜に Timer が在れば落ちる。開始時刻が先なら見ない", () => {
    // 走行中（30 秒後に上がる）の釜 3 に「今」置く一片は押せない。解放表では釜 3 は 30 秒後に空くので、尾部は釜 0 に今。
    expect(placementOf([timerOn3(false)], acceptedOn3(0), NOW)).toEqual({
      slot: "0",
      startSeconds: 0,
      kept: false,
    });
    // 30 秒後に釜 3 で始める一片は、走行中がちょうど 30 秒後に上がるので維持される（Timer の有無は見ない）。
    expect(placementOf([timerOn3(false)], acceptedOn3(30), NOW)).toEqual({
      slot: "3",
      startSeconds: 30,
      kept: true,
    });
  });
});

describe("committedSchedule — 採用済み一片は置ける品目に限って計画対象と比べる（plan-stability Requirement 7・task 3′.1）", () => {
  // Feature: plan-stability
  // **Validates: Requirements 7.3, 7.4, 7.5**
  //
  // 6 釜・走行中なし。卓 t-m に Thin の M と、プリセットに無い麺種 G。採用済み一片は M を釜 3 に今置く（自前解なら釜 0）。
  const M: OrderItem = { ...WIDE, externalOrderId: "o-m", slotSpan: 1, tableId: "t-m" };
  const G: OrderItem = { ...M, externalOrderId: "o-g", noodleType: "Ghost" };
  const GHOST_PRESET: NoodlePreset = {
    noodleType: "Ghost",
    boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 },
  };
  const ACCEPTED_M: AcceptedSlice = {
    tableKey: "t-m",
    placements: [
      {
        externalOrderId: M.externalOrderId,
        itemIndex: 0,
        slotIds: nonEmpty(["3" as SlotId]),
        startAt: NOW,
        serveAt: (NOW + 60 * SECOND) as EpochMillis,
        anchor: null,
      },
    ],
  };

  it("未知麺種 G を含む卓の採用済み一片は、置ける品目 M が一致すれば維持される", () => {
    const schedule = committedSchedule([ACCEPTED_M], [M, G], [], NOW, PRESETS, PARAMS, null);
    expect(schedule.slices).toEqual([ACCEPTED_M]);
  });

  it("設定変更で G が置けるようになると、その一片は欠落で落ち、自前解が M と G を置き直す（AC 7.5）", () => {
    const presets = [...PRESETS, GHOST_PRESET];
    const schedule = committedSchedule([ACCEPTED_M], [M, G], [], NOW, presets, PARAMS, null);
    const placements = schedule.slices.flatMap((slice) => slice.placements);
    expect(schedule.slices[0]).not.toBe(ACCEPTED_M);
    expect(placements.map((placement) => placement.externalOrderId).sort()).toEqual(["o-g", "o-m"]);
    // 置き直しの証拠：M は採用済みの釜 3 ではなく自前解の釜（G と揃えて釜 0・1 のどちらか）。
    expect(
      placements.find((placement) => placement.externalOrderId === "o-m")!.slotIds,
    ).not.toEqual(["3"]);
  });

  it("単体で上限を超える span 5 も同じ——arms 2（上限 4）では集合に無く維持、arms 3（上限 5）では欠落で落ちる", () => {
    const wide: OrderItem = { ...M, externalOrderId: "o-wide", slotSpan: 5 };
    expect(
      committedSchedule([ACCEPTED_M], [M, wide], [], NOW, PRESETS, PARAMS, null).slices,
    ).toEqual([ACCEPTED_M]);
    const relaxed = committedSchedule(
      [ACCEPTED_M],
      [M, wide],
      [],
      NOW,
      PRESETS,
      { ...PARAMS, arms: 3 },
      null,
    );
    const placements = relaxed.slices.flatMap((slice) => slice.placements);
    expect(relaxed.slices[0]).not.toBe(ACCEPTED_M);
    expect(placements.map((placement) => placement.externalOrderId).sort()).toEqual([
      "o-m",
      "o-wide",
    ]);
  });
});
