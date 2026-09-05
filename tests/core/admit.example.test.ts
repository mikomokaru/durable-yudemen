// tests/core/admit.example.test.ts — 受け入れゲート admit（src/engine/admit.ts）の回帰テスト。
//
// Property 4・5・7 は「単調に改善する」「同値は棄却」「接頭辞は feasible」を全域で言うが、**2 段の判定が
// どちらの段で落としたか**は言わない。ここで固定するのはその区別である（タスク 18.8）。
//
//   1. 接頭辞の一部が陳腐化し、1 番目だけが採用されて尾部が再実行される（段 1 の枝刈り）
//   2. 部分和は改善するのに合成後の総和が悪化し、接頭辞を短くせず全棄却される（段 2 の単調性の担保）
//
// 加えて、外部が申告した値を engine が信じないことを 2 つ固定する——主張された score（採点は engine 自身の
// scoreSchedule ただ一つ）と、主張された serveAt（startAt と serveAt を結ぶのは品目の茹で時間ただ一つ）。
//
// **場面は「使える釜が 1 つだけ」に作る。** 釜が余っていれば全品目が並列に入り、計画の良し悪しに差が
// 生まれない（段 2 が効く場面が作れない）。unitCount の下限は 1 ＝ 6 釜ゆえ、5 釜を遠い未来まで走る
// 開始済み Timer で塞ぐ。ハード制約 (c) が解放表を通してこれを所与とすることの実演にもなっている。
//
// 茹で時間はテスト専用のプリセットで与える（既定プリセットは 45〜140 秒で、長短の差が計画の順序に
// 効く場面を作りにくい）。「長い麺 600 秒」「短い麺 60 秒」の 2 種だけを持つ店を置く。

import { describe, expect, it } from "vitest";
import { admit } from "../../src/engine/admit";
import { committedSchedule } from "../../src/engine/commit";
import {
  baselineSchedule,
  initialRelease,
  type AcceptedSlice,
  type CookSchedule,
} from "../../src/engine/schedule";
import { scoreSchedule, type ScheduleParams } from "../../src/engine/objective";
import { initialLifts } from "../../src/engine/lift";
import { tableMembers } from "../../src/engine/project";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const SECOND = 1_000;

/** 茹で時間 600 秒と 60 秒の 2 種だけを持つ店。茹で加減で差を付けない（順序の効果だけを見る）。 */
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
  { noodleType: "Short", boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 } },
];

/** 1 ユニット（6 釜）・重みと許容幅は既定。 */
const PARAMS: ScheduleParams = schedulingDefaults(1);

/** 釜 1〜5 を遠い未来まで塞ぐ開始済み Timer。使える釜は 0 番だけになる。 */
const BLOCKED: readonly Timer[] = [1, 2, 3, 4, 5].map((slot) =>
  createTimer({
    id: `t-blocked-${slot}` as TimerId,
    slotIds: nonEmpty([String(slot) as SlotId]),
    noodleType: "Long" as NoodleType,
    firmness: "normal",
    startTime: NOW,
    endTime: (NOW + 10_000 * SECOND) as EpochMillis,
    seq: slot,
  }),
);

/** 待ち行列の 1 品目（1 注文 1 品目・卓は注文ごとに別）。 */
function order(externalOrderId: string, noodleType: string, tableId: string): PendingOrder {
  return {
    externalOrderId,
    itemIndex: 0,
    noodleType,
    firmness: "normal",
    tableId,
    arrivalTime: NOW,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  };
}

/** 長い麺の A（卓 t-a）と短い麺の B（卓 t-b）。到着は同時ゆえ自前解は卓 id 順に A → B と置く。 */
const LONG = order("o-long", "Long", "t-a");
const SHORT = order("o-short", "Short", "t-b");
const PENDING: readonly PendingOrder[] = [LONG, SHORT];

/**
 * 外部計画の一片を組む。点数は載せない——計画は点数を持たず、採点は比較の時点で engine が行う
 * （lift-group-planning 判断 7）。
 */
function slice(
  tableKey: string,
  items: readonly { order: PendingOrder; startAt: number; serveAt: number }[],
) {
  return {
    tableKey,
    placements: items.map((item) => ({
      externalOrderId: item.order.externalOrderId,
      itemIndex: item.order.itemIndex,
      slotIds: nonEmpty(["0" as SlotId]),
      startAt: item.startAt as EpochMillis,
      serveAt: item.serveAt as EpochMillis,
      // 走行中の仲間が居ない卓の計画。合流の所属は無い（AC 9.9）。
      anchor: null,
    })),
  };
}

/** 外部から届いた計画。 */
function plan(...slices: readonly ReturnType<typeof slice>[]): CookSchedule {
  return { slices };
}

/**
 * 比較の時点の採点（走行中の卓なし Timer は成員にならない）。
 *
 * BLOCKED の 5 本は 10000 秒に同じ窓で上がるので、走行中だけで Lift_Overflow (5 − arms 2) × 45 = 135 が立つ。
 * 店舗全体の項ゆえどの計画の total にも同じ定数として載り（AC 9.6・9.7）、比較には効かない。
 */
const RUNNING_ONLY_OVERFLOW = (5 - PARAMS.arms) * PARAMS.liftIntervalSeconds;
function scoreOf(schedule: CookSchedule) {
  return scoreSchedule(
    schedule.slices,
    PENDING,
    tableMembers(BLOCKED),
    initialLifts(BLOCKED),
    PARAMS,
  );
}

/** 現行 Committed_Plan（採用済みが無い＝自前解そのもの）。 */
const COMMITTED = committedSchedule([], PENDING, BLOCKED, NOW, PRESETS, PARAMS);

/** ゲートへ通す。 */
function gate(arrived: CookSchedule) {
  return admit(arrived, COMMITTED, PENDING, BLOCKED, NOW, PRESETS, PARAMS);
}

describe("admit — 場面の前提", () => {
  it("自前解は A（600 秒）を先に置き、B（60 秒）を釜が空くまで待たせる", () => {
    // 卓 id 順に A → B。使える釜は 0 番だけゆえ B は A が上がってから始まる。
    expect(COMMITTED.slices.map((each) => each.tableKey)).toEqual(["t-a", "t-b"]);
    expect(scoreOf(COMMITTED)).toEqual({
      total: 1260 + RUNNING_ONLY_OVERFLOW,
      bySlice: [600, 660],
    });
  });
});

describe("admit — 段 1（接頭辞の枝刈り）", () => {
  it("接頭辞の一部が陳腐化すると 1 番目のみ採用され、尾部は再実行される", () => {
    // 外部は待ち行列に C（卓 t-c）が居た時点で計画を組んだ。届くまでに C はキャンセルされている。
    const cancelled = order("o-gone", "Short", "t-c");
    const arrived = plan(
      slice("t-b", [{ order: SHORT, startAt: NOW, serveAt: NOW + 60 * SECOND }]),
      slice("t-c", [{ order: cancelled, startAt: NOW + 60 * SECOND, serveAt: NOW + 120 * SECOND }]),
      slice("t-a", [{ order: LONG, startAt: NOW + 120 * SECOND, serveAt: NOW + 720 * SECOND }]),
    );

    const admitted = gate(arrived);

    // 1 番目だけが採用される（2 番目が陳腐化A で落ち、3 番目は接頭辞ゆえ道連れになる）。
    expect(admitted).toEqual([arrived.slices[0]!]);

    // 尾部は**再実行**される。外部が A に与えた開始時刻（+120 秒）ではなく、採用した接頭辞の解放表から
    // 引き直した +60 秒に入る——切り貼りではないことがここに現れる。
    const composed = committedSchedule(admitted, PENDING, BLOCKED, NOW, PRESETS, PARAMS);
    expect(composed.slices.map((each) => [each.tableKey, each.placements[0]!.startAt])).toEqual([
      ["t-b", NOW],
      ["t-a", NOW + 60 * SECOND],
    ]);
    expect(scoreOf(composed).total).toBe(720 + RUNNING_ONLY_OVERFLOW);
  });
});

describe("admit — 段 2（合成後の総和による全体判定）", () => {
  // 部分和だけを見ていれば通る計画が、合成後の総和では悪化する。段 2 が無ければ確定計画は劣化しうる。
  it("部分和は改善するが合成後の総和が悪化する計画は全棄却される", () => {
    // B を 500 秒も遊ばせてから茹でる計画。B 自身の待ちは 660 秒 → 560 秒へ改善するが、その 560 秒まで
    // 釜が塞がるため A が +560 秒まで始められず、総和は 1260 → 1720 へ悪化する。
    const arrived = plan(
      slice("t-b", [{ order: SHORT, startAt: NOW + 500 * SECOND, serveAt: NOW + 560 * SECOND }]),
    );

    // 段 1 は通る（部分和 560 < 660）。それでも段 2 が全棄却する。
    expect(gate(arrived)).toEqual([]);

    // 悪化の事実を固定する（棄却の理由が「悪化」であって陳腐化や制約違反ではないこと）。
    const wouldBe = committedSchedule([arrived.slices[0]!], PENDING, BLOCKED, NOW, PRESETS, PARAMS);
    expect(scoreOf(wouldBe).total).toBe(1720 + RUNNING_ONLY_OVERFLOW);
    expect(scoreOf(wouldBe).total).toBeGreaterThan(scoreOf(COMMITTED).total);
  });

  it("遊ばせずに同じ順序へ入れ替える計画は採用される（棄却が順序の変更そのものに掛かっていない）", () => {
    // 同じ「B を先に」だが遊びが無い。合成後は 720 < 1260 ゆえ採用される。
    const arrived = plan(
      slice("t-b", [{ order: SHORT, startAt: NOW, serveAt: NOW + 60 * SECOND }]),
    );

    expect(gate(arrived)).toEqual([arrived.slices[0]!]);
  });
});

describe("admit — 外部の申告を検証する", () => {
  it("走行中の仲間が無い卓で錨を主張する計画は feasible と認めず、棄却する（AC 9.10 (a)）", () => {
    // 上の「遊ばせずに入れ替える」計画は採用される。同じ配置に `anchor` を書き足しただけの計画は、卓 t-b に
    // 走行中の仲間が無く在りうる錨が無いので棄却される——`recommend` は `anchor` を無条件に運び、client は
    // `anchor > now` で「開始済み」を読むため、検証しなければ外部計画が任意の錨で「開始済み」を作れる。
    const adopted = plan(
      slice("t-b", [{ order: SHORT, startAt: NOW, serveAt: NOW + 60 * SECOND }]),
    );
    expect(gate(adopted)).toEqual([adopted.slices[0]!]);
    const [only] = adopted.slices[0]!.placements;
    const claimed: CookSchedule = {
      slices: [
        {
          tableKey: "t-b",
          placements: [{ ...only!, anchor: (NOW + 60 * SECOND) as EpochMillis }],
        },
      ],
    };
    expect(gate(claimed)).toEqual([]);
  });

  it("採点は engine が比較の時点で行う（悪化と見れば棄却する）", () => {
    // engine の採点では 760 秒待ち＝現行の 660 より悪い。外部が何を主張していても計画は点数を運ばない。
    const arrived = plan(
      slice("t-b", [{ order: SHORT, startAt: NOW + 700 * SECOND, serveAt: NOW + 760 * SECOND }]),
    );

    expect(gate(arrived)).toEqual([]);
  });

  it("serveAt が茹で時間と食い違う計画はハード制約で棄却される", () => {
    // 「60 秒の麺を 1 秒で上げる」と主張する計画。目的関数値は最小になるが、物理的に成立していない。
    const arrived = plan(slice("t-b", [{ order: SHORT, startAt: NOW, serveAt: NOW + 1 * SECOND }]));

    expect(gate(arrived)).toEqual([]);
  });

  it("開始済み Timer が塞いだ釜へ割り込む計画は棄却される（ハード制約 (c)）", () => {
    // 釜 1 は 10000 秒後まで塞がっている。そこへ今から入れる計画は解放表が落とす。
    const intruder: CookSchedule = {
      slices: [
        {
          tableKey: "t-b",
          placements: [
            {
              externalOrderId: SHORT.externalOrderId,
              itemIndex: 0,
              slotIds: nonEmpty(["1" as SlotId]),
              startAt: NOW,
              serveAt: (NOW + 60 * SECOND) as EpochMillis,
              anchor: null,
            },
          ],
        },
      ],
    };

    expect(gate(intruder)).toEqual([]);
  });
});

describe("admit — slotSpan は釜番号で数える（レビュー指摘・AC 4.2）", () => {
  /** 2 釜を要する短い麺。空いている釜は 0 番だけなので、正しく数えれば今は置けない。 */
  const WIDE: PendingOrder = { ...SHORT, slotSpan: 2 };
  const PENDING_WIDE: readonly PendingOrder[] = [LONG, WIDE];
  const COMMITTED_WIDE = committedSchedule([], PENDING_WIDE, BLOCKED, NOW, PRESETS, PARAMS);

  function wide(slotIds: readonly SlotId[]): CookSchedule {
    return {
      slices: [
        {
          tableKey: "t-b",
          placements: [
            {
              externalOrderId: WIDE.externalOrderId,
              itemIndex: 0,
              slotIds: nonEmpty([...slotIds]),
              startAt: NOW,
              serveAt: (NOW + 60 * SECOND) as EpochMillis,
              anchor: null,
            },
          ],
        },
      ],
    };
  }

  it("場面の前提: 自前解は 2 釜目が空くまで待つ", () => {
    const placement = COMMITTED_WIDE.slices
      .flatMap((slice) => slice.placements)
      .find((candidate) => candidate.externalOrderId === WIDE.externalOrderId)!;
    expect(placement.slotIds).toHaveLength(2);
    expect(placement.startAt).toBeGreaterThan(NOW);
  });

  it('["0","00"] は表記が違うだけの同じ釜であり、2 釜を満たさない', () => {
    const arrived = wide(["0" as SlotId, "00" as SlotId]);
    expect(admit(arrived, COMMITTED_WIDE, PENDING_WIDE, BLOCKED, NOW, PRESETS, PARAMS)).toEqual([]);
  });

  it('["0","0"] も同じく棄却される', () => {
    const arrived = wide(["0" as SlotId, "0" as SlotId]);
    expect(admit(arrived, COMMITTED_WIDE, PENDING_WIDE, BLOCKED, NOW, PRESETS, PARAMS)).toEqual([]);
  });
});

describe("admit — 同値と空", () => {
  it("現行 Committed_Plan をそのまま渡すと空の採用列を返す（同値は棄却）", () => {
    expect(gate(COMMITTED)).toEqual([]);
  });

  it("空の計画は空の採用列を返す", () => {
    expect(gate({ slices: [] })).toEqual([]);
  });

  it("自前解と同値の計画（Solver_Worker の骨格が返す形）も棄却される", () => {
    const same = baselineSchedule(
      PENDING,
      initialRelease(BLOCKED, NOW, 6),
      tableMembers(BLOCKED),
      initialLifts(BLOCKED),
      PRESETS,
      PARAMS,
    );

    expect(gate(same)).toEqual([]);
  });
});

describe("admit — 揃った群を 1 ms 崩した外部計画は通らない（lift-group-planning・ADR-0006）", () => {
  // 同じ卓に短い麺 2 本。自前解は 2 本を同じ提供時刻に揃える。
  const twin = [
    order("o-x", "Short", "t-x"),
    { ...order("o-y", "Short", "t-x"), externalOrderId: "o-y" },
  ];
  const committed = committedSchedule([], twin, BLOCKED, NOW, PRESETS, PARAMS);
  const members = tableMembers(BLOCKED);
  const gateTwin = (arrived: CookSchedule) =>
    admit(arrived, committed, twin, BLOCKED, NOW, PRESETS, PARAMS);

  it("前提: 自前解は 2 本を同じ serveAt に揃える", () => {
    const placements = committed.slices.flatMap((each) => each.placements);
    expect(new Set(placements.map((placement) => placement.serveAt)).size).toBe(1);
  });

  it("揃った配置の 1 本を 1 ms 早めた計画は、採点で真に良くならず棄却される", () => {
    const [first, second] = committed.slices[0]!.placements;
    const nudged: CookSchedule = {
      slices: [
        {
          tableKey: "t-x",
          placements: [
            first!,
            {
              ...second!,
              startAt: (second!.startAt - 1) as EpochMillis,
              serveAt: (second!.serveAt - 1) as EpochMillis,
            },
          ],
        },
      ],
    };
    // 1 ms のずれは卓の遅れとして 1 秒（× w_table）に数えられ、wait の節約（高々 1 秒）を上回る。
    const lifts = initialLifts(BLOCKED);
    const before = scoreSchedule(committed.slices, twin, members, lifts, PARAMS).total;
    const after = scoreSchedule(nudged.slices, twin, members, lifts, PARAMS).total;
    expect(after).toBeGreaterThan(before);
    expect(gateTwin(nudged)).toEqual([]);
  });

  // Feature: lift-group-planning, AC 7.2 の但し書き（21.7 レビュー P2）
  // **Validates: Requirements 7.2, 9.6, 9.7**
  it("走行中が窓の境界に在り 1 ms 早めた計画の total が真に下がっても、部分和が悪いので段 1 (d) で棄却される", () => {
    // 釜 2・3 は遠い未来まで塞ぎ、釜 4 は T − L（15 秒）・釜 5 は T + 1 秒（61 秒）に上がる卓なしの走行中。
    // 釜 0・1 が空くので自前解は 2 本を T = 60 秒に揃える（Σ span 2 ≤ arms 2）。
    const running: readonly Timer[] = [
      ["t-blocked-2", 2, 10_000],
      ["t-blocked-3", 3, 10_000],
      ["t-before-window", 4, 60 - PARAMS.liftIntervalSeconds],
      ["t-after-window", 5, 61],
    ].map(([id, slot, endSeconds], seq) =>
      createTimer({
        id: id as TimerId,
        slotIds: nonEmpty([String(slot) as SlotId]),
        noodleType: "Long" as NoodleType,
        firmness: "normal",
        startTime: NOW,
        endTime: (NOW + (endSeconds as number) * SECOND) as EpochMillis,
        seq,
      }),
    );
    const aligned = committedSchedule([], twin, running, NOW, PRESETS, PARAMS);
    const [first, second] = aligned.slices[0]!.placements;
    expect(first!.serveAt).toBe(NOW + 60 * SECOND);
    expect(second!.serveAt).toBe(NOW + 60 * SECOND);
    const nudged: CookSchedule = {
      slices: [
        {
          tableKey: "t-x",
          placements: [
            first!,
            {
              ...second!,
              startAt: (second!.startAt - 1) as EpochMillis,
              serveAt: (second!.serveAt - 1) as EpochMillis,
            },
          ],
        },
      ],
    };
    // 揃え：窓 [60,105) に 60・60・61 の 3 本で Lift_Overflow 45 → total 120 + 45。散らし：[15,60) に 15・59.999 の
    // 2 本・[60,105) に 60・61 の 2 本で 0 → total 121。部分和は 120 → 121 と真に悪い（lag 2 − wait 1）が total は下がる。
    const before = scoreSchedule(
      aligned.slices,
      twin,
      tableMembers(running),
      initialLifts(running),
      PARAMS,
    );
    const after = scoreSchedule(
      nudged.slices,
      twin,
      tableMembers(running),
      initialLifts(running),
      PARAMS,
    );
    expect(before).toEqual({ total: 165, bySlice: [120] });
    expect(after).toEqual({ total: 121, bySlice: [121] });
    expect(after.total).toBeLessThan(before.total);
    // それでも通らない——段 1 (d) が比べるのは部分和であり、ADR-0006 の「1 ms 崩した計画は通らない」はここが担う。
    expect(admit(nudged, aligned, twin, running, NOW, PRESETS, PARAMS)).toEqual([]);
  });
});

describe("admit — 始めたまとまりを崩す計画は feasible ではない（判断 16・ADR-0007・ハード制約 (e)）", () => {
  // レビューの再現：6 釜・同卓 4 品・各 2 釜・茹で 360 秒・1 本目（釜 0・1）が走行中で 360 秒後に上がる。
  const SIX_MINUTES = 360;
  const WIDE_PRESETS: readonly NoodlePreset[] = [
    {
      noodleType: "Wide",
      boilSeconds: {
        extraHard: SIX_MINUTES,
        hard: SIX_MINUTES,
        normal: SIX_MINUTES,
        soft: SIX_MINUTES,
      },
    },
  ];
  const FIRST: Timer = createTimer({
    id: "t-first" as TimerId,
    slotIds: nonEmpty(["0" as SlotId, "1" as SlotId]),
    noodleType: "Wide" as NoodleType,
    firmness: "normal",
    startTime: NOW,
    endTime: (NOW + SIX_MINUTES * SECOND) as EpochMillis,
    seq: 0,
    orderItem: { externalOrderId: "o-table", itemIndex: 0, tableId: "t-1" },
  });
  const REST: readonly PendingOrder[] = [1, 2, 3].map((itemIndex) => ({
    externalOrderId: "o-table",
    itemIndex,
    noodleType: "Wide",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime: NOW,
    slotSpan: 2,
    itemName: null,
    sizeName: null,
  }));
  const COMMITTED_WIDE = committedSchedule([], REST, [FIRST], NOW, WIDE_PRESETS, PARAMS);

  /** 合流分の投入時刻（秒）。錨の窓 [360,405) には走行中の 2 本分が在り、4 本分の pack は次の窓 405 秒に上がる。 */
  const JOINED_START = 45;
  function placement(itemIndex: number, slots: readonly string[], startSeconds: number) {
    return {
      externalOrderId: "o-table",
      itemIndex,
      slotIds: nonEmpty(slots.map((slot) => slot as SlotId)),
      startAt: (NOW + startSeconds * SECOND) as EpochMillis,
      serveAt: (NOW + (startSeconds + SIX_MINUTES) * SECOND) as EpochMillis,
      // 錨の次の窓に上がる配置は走行中の 1 本目（360 秒に上がる）へ合流する。後ろに置く配置は合流ではない。
      anchor: startSeconds === JOINED_START ? FIRST.endTime : null,
    };
  }
  /** 旧挙動：残り 3 品を全員 360 秒後へ遅らせる（走行中の釜 0・1 が空くのを待つ）。feasible ではある。 */
  const DELAY_ALL: CookSchedule = {
    slices: [
      {
        tableKey: "t-1",
        placements: [
          placement(1, ["2", "3"], SIX_MINUTES),
          placement(2, ["4", "5"], SIX_MINUTES),
          placement(3, ["0", "1"], SIX_MINUTES),
        ],
      },
    ],
  };

  /** 採用済みの悪い一片：2 品は合流させ（405 秒の pack）、3 品目を 1080 秒（釜が空いてさらに 360 秒後）に置く。 */
  const COMMITTED_LATE = committedSchedule(
    [
      {
        tableKey: "t-1",
        placements: [
          placement(1, ["2", "3"], JOINED_START),
          placement(2, ["4", "5"], JOINED_START),
          placement(3, ["0", "1"], 2 * SIX_MINUTES),
        ],
      },
    ],
    REST,
    [FIRST],
    NOW,
    WIDE_PRESETS,
    PARAMS,
  );

  it("場面の前提: 自前解は 2 品を走行中の錨に合流させ（上げ窓で錨の次の窓 405 秒へ）、1 品を後に置く", () => {
    // 合流の候補は錨の 360 秒だが、その窓には走行中の 2 本分が在り、合流分 4 本分を足すと上限 4 を超える。pack が
    // 次の窓 405 秒へ動く（判断 20）。所属（anchor）は錨のまま。3 品目は釜が空く 360 秒から茹でて 720 秒。
    const serveSeconds = COMMITTED_WIDE.slices[0]!.placements.map(
      (candidate) => (candidate.serveAt - NOW) / 1000,
    );
    expect(serveSeconds).toEqual([SIX_MINUTES + 45, SIX_MINUTES + 45, 2 * SIX_MINUTES]);
    expect(COMMITTED_WIDE.slices[0]!.placements.map((candidate) => candidate.anchor)).toEqual([
      FIRST.endTime,
      FIRST.endTime,
      null,
    ]);
  });

  it("目的関数（最遅参照）は全員を遅らせる計画を真に良いと採点する——採点では守れない", () => {
    const members = tableMembers([FIRST]);
    const lifts = initialLifts([FIRST]);
    const joined = scoreSchedule(COMMITTED_WIDE.slices, REST, members, lifts, PARAMS).total;
    const delayed = scoreSchedule(DELAY_ALL.slices, REST, members, lifts, PARAMS).total;
    expect(delayed).toBeLessThan(joined);
  });

  it("合流できる 2 品を押し出した計画は feasible と認めず、棄却する", () => {
    expect(admit(DELAY_ALL, COMMITTED_WIDE, REST, [FIRST], NOW, WIDE_PRESETS, PARAMS)).toEqual([]);
  });

  it("合流させたまま 3 品目だけ後ろに置く計画は feasible であり、悪い確定計画に対しては採用される", () => {
    // 採用済みの一片（COMMITTED_LATE）は 2 品を錨に合流させ（keepsAnchor を守る）、3 品目だけを 1080 秒に置いていて、
    // 目的関数の上で合流の形（3 品目は 720 秒）より悪い。合流の形は (e) で落ちず、改善として採用される。一方
    // DELAY_ALL は目的関数の上ではさらに良いが、(e) で feasible ではない。
    // （全員を 1080 秒に置く一片は、合流できる 2 品を押し出しているので合成が捨て、比較基準にならない。）
    const keep: CookSchedule = {
      slices: [
        {
          tableKey: "t-1",
          placements: [
            placement(1, ["2", "3"], JOINED_START),
            placement(2, ["4", "5"], JOINED_START),
            placement(3, ["0", "1"], SIX_MINUTES),
          ],
        },
      ],
    };
    const members = tableMembers([FIRST]);
    const lifts = initialLifts([FIRST]);
    expect(scoreSchedule(DELAY_ALL.slices, REST, members, lifts, PARAMS).total).toBeLessThan(
      scoreSchedule(keep.slices, REST, members, lifts, PARAMS).total,
    );
    expect(admit(keep, COMMITTED_LATE, REST, [FIRST], NOW, WIDE_PRESETS, PARAMS)).toEqual(
      keep.slices,
    );
    expect(admit(DELAY_ALL, COMMITTED_LATE, REST, [FIRST], NOW, WIDE_PRESETS, PARAMS)).toEqual([]);
  });

  it("錨の主張が現在の仲間の実効 endTime に無い計画は feasible と認めず、棄却する（AC 9.10 (a)）", () => {
    // 上と同じ「合流させたまま 3 品目だけ後ろに置く」形（正しい錨なら採用される）で、合流分の `anchor` だけを
    // 走行中の 1 本目の実効 endTime（360 秒）から 1 秒ずらす。serveAt は錨に一致したままで散らしでも押し出しでも
    // ないが、錨は等号で運ぶ約束（判断 17・19）なので、主張が仲間に無い一片は feasible ではない。
    const misclaimed: CookSchedule = {
      slices: [
        {
          tableKey: "t-1",
          placements: [
            {
              ...placement(1, ["2", "3"], JOINED_START),
              anchor: (FIRST.endTime + SECOND) as EpochMillis,
            },
            {
              ...placement(2, ["4", "5"], JOINED_START),
              anchor: (FIRST.endTime + SECOND) as EpochMillis,
            },
            placement(3, ["0", "1"], SIX_MINUTES),
          ],
        },
      ],
    };
    expect(admit(misclaimed, COMMITTED_LATE, REST, [FIRST], NOW, WIDE_PRESETS, PARAMS)).toEqual([]);
  });
  it("押し出した配置に仲間の endTime を錨として書いても合流分とは認めず、棄却する（AC 9.10 (c)(d)・21.5 レビュー P1）", () => {
    // DELAY_ALL の 3 配置すべて、または合流できる 2 品だけに `anchor: 360 秒` を付けた計画。錨は現在の仲間に在る
    // （(a) は通る）が、pack として見れば 3 品目は 360 + 36 秒までに上がれず（(c)）、2 品の pack の firstFit は 405 秒で
    // 720 秒ではない（(d)）。錨の主張だけで合流分と読めば、押し出す配置が一つも残らず keepsAnchor を素通りして
    // 採用されていた（実測：anchor null は 0 件・主張ありは 1 件）。
    const claimed = (itemIndices: readonly number[]): CookSchedule => ({
      slices: [
        {
          tableKey: "t-1",
          placements: DELAY_ALL.slices[0]!.placements.map((candidate) =>
            itemIndices.includes(candidate.itemIndex)
              ? Object.assign({}, candidate, { anchor: FIRST.endTime })
              : candidate,
          ),
        },
      ],
    });
    for (const arrived of [claimed([1, 2, 3]), claimed([1, 2])]) {
      expect(admit(arrived, COMMITTED_WIDE, REST, [FIRST], NOW, WIDE_PRESETS, PARAMS)).toEqual([]);
      expect(admit(arrived, COMMITTED_LATE, REST, [FIRST], NOW, WIDE_PRESETS, PARAMS)).toEqual([]);
    }
  });
});

describe("admit — 後続品のために合流分を遅らせた計画は棄却する（AC 9.10 (d)・design Component 10）", () => {
  // 仲間の Short（60 秒）が釜 5 で 60 秒に上がる。釜 2〜4 は塞がり、釜 0・1 が空いている。同卓（t-c）に Short と Long。
  const SIBLING: Timer = createTimer({
    id: "t-sibling" as TimerId,
    slotIds: nonEmpty(["5" as SlotId]),
    noodleType: "Short" as NoodleType,
    firmness: "normal",
    startTime: NOW,
    endTime: (NOW + 60 * SECOND) as EpochMillis,
    seq: 9,
    orderItem: { externalOrderId: "o-first", itemIndex: 0, tableId: "t-c" },
  });
  const RUNNING: readonly Timer[] = [
    SIBLING,
    ...BLOCKED.filter((timer) => timer.slotIds[0] !== "1" && timer.slotIds[0] !== "5"),
  ];
  const SHORT_C = order("o-short-c", "Short", "t-c");
  const LONG_C = order("o-long-c", "Long", "t-c");
  const PENDING_C: readonly PendingOrder[] = [SHORT_C, LONG_C];

  function place(
    target: PendingOrder,
    slot: string,
    startSeconds: number,
    anchorSeconds: number | null,
  ) {
    const boilSeconds = target.noodleType === "Long" ? 600 : 60;
    return {
      externalOrderId: target.externalOrderId,
      itemIndex: 0,
      slotIds: nonEmpty([slot as SlotId]),
      startAt: (NOW + startSeconds * SECOND) as EpochMillis,
      serveAt: (NOW + (startSeconds + boilSeconds) * SECOND) as EpochMillis,
      anchor: anchorSeconds === null ? null : ((NOW + anchorSeconds * SECOND) as EpochMillis),
    };
  }
  function planC(...placements: readonly ReturnType<typeof place>[]): CookSchedule {
    return { slices: [{ tableKey: "t-c", placements }] };
  }
  function gateC(arrived: CookSchedule) {
    return admit(arrived, COMMITTED_C, PENDING_C, RUNNING, NOW, PRESETS, PARAMS);
  }
  function totalOf(schedule: CookSchedule) {
    return scoreSchedule(
      schedule.slices,
      PENDING_C,
      tableMembers(RUNNING),
      initialLifts(RUNNING),
      PARAMS,
    ).total;
  }
  /** 採用済みの悪い一片：Short は 60 秒に合流、Long は 100 秒に始めて 700 秒（改善の余地を残す）。 */
  const COMMITTED_C = committedSchedule(
    [{ tableKey: "t-c", placements: [place(SHORT_C, "0", 0, 60), place(LONG_C, "1", 100, null)] }],
    PENDING_C,
    RUNNING,
    NOW,
    PRESETS,
    PARAMS,
  );

  it("場面の前提: 採用済みの一片は維持され、Short を合流させたまま Long を 60 秒に始める計画は改善として採用される", () => {
    expect(
      COMMITTED_C.slices[0]!.placements.map((candidate) => (candidate.serveAt - NOW) / 1000),
    ).toEqual([60, 700]);
    const better = planC(place(SHORT_C, "0", 0, 60), place(LONG_C, "1", 60, null));
    expect(gateC(better)).toEqual(better.slices);
  });

  it("Short を Long と同じ 660 秒へ遅らせて anchor: 60 を付けた計画は、目的関数の上では改善でも (d) で棄却する", () => {
    // Long は合流不能で pack に入らず、Short だけの pack の候補は 60 秒・firstFit も 60 秒。660 秒は窓の延期ではない。
    const delayed = planC(place(LONG_C, "1", 60, null), place(SHORT_C, "0", 600, 60));
    expect(totalOf(delayed)).toBeLessThan(totalOf(COMMITTED_C));
    expect(gateC(delayed)).toEqual([]);
  });

  it("同じ計画で Short の錨を外しても、合流できた Short を押し出しているので棄却する", () => {
    const delayed = planC(place(LONG_C, "1", 60, null), place(SHORT_C, "0", 600, null));
    expect(totalOf(delayed)).toBeLessThan(totalOf(COMMITTED_C));
    expect(gateC(delayed)).toEqual([]);
  });
});

describe("admit — 上げ窓の上限 arms + HELPER_ARMS を超える計画は feasible ではない（AC 9.5・ハード制約 (f)・task 21.8）", () => {
  // Feature: lift-group-planning, 判断 20・ADR-0009
  // **Validates: Requirements 9.4, 9.5, 9.14**
  //
  // 6 釜・arms 2（上限 4）・L 45 秒。卓を持たない走行中 Short（成員にならず、上げ表にだけ載る）が 60 秒に上がる。
  // 釜 5 から順に塞ぎ、釜 0 は空けておく（slice は釜 0 に置く）。
  function runningShorts(count: number): readonly Timer[] {
    return Array.from({ length: count }, (_, index) =>
      createTimer({
        id: `t-run-${index}` as TimerId,
        slotIds: nonEmpty([String(5 - index) as SlotId]),
        noodleType: "Short" as NoodleType,
        firmness: "normal",
        startTime: NOW,
        endTime: (NOW + 60 * SECOND) as EpochMillis,
        seq: 10 + index,
      }),
    );
  }
  const ITEM = order("o-p", "Short", "t-p");
  /** 採用済みの悪い一片：釜 0 で 300 秒に上がる（改善の余地を残し、棄却の理由を (f) に限る）。 */
  const LATE: AcceptedSlice = slice("t-p", [
    { order: ITEM, startAt: NOW + 240 * SECOND, serveAt: NOW + 300 * SECOND },
  ]);
  /** 釜 0 で serveSeconds に上がる外部計画。 */
  function at(serveSeconds: number): CookSchedule {
    return plan(
      slice("t-p", [
        {
          order: ITEM,
          startAt: NOW + (serveSeconds - 60) * SECOND,
          serveAt: NOW + serveSeconds * SECOND,
        },
      ]),
    );
  }
  function gateWith(running: readonly Timer[], arrived: CookSchedule, params = PARAMS) {
    const committed = committedSchedule([LATE], [ITEM], running, NOW, PRESETS, params);
    return admit(arrived, committed, [ITEM], running, NOW, PRESETS, params);
  }

  it("走行中 4 本が 60 秒に上がる窓へ 5 本目を置く計画は棄却され、次の窓（105 秒）なら採用される", () => {
    expect(gateWith(runningShorts(4), at(60))).toEqual([]);
    expect(gateWith(runningShorts(4), at(105))).toEqual(at(105).slices);
  });

  it("同じ計画でも arms 3（上限 5）なら採用される——棄却の理由が上限であること", () => {
    expect(gateWith(runningShorts(4), at(60), { ...PARAMS, arms: 3 })).toEqual(at(60).slices);
  });

  it("走行中だけで上限を超えている窓は、それを含まない一片を落とさない（AC 9.4・9.14）", () => {
    // 5 本が 60 秒に上がる窓 [60,105) は既に 5 > 4。200 秒の配置はその窓に入らないので採用され、100 秒は入るので棄却。
    expect(gateWith(runningShorts(5), at(200))).toEqual(at(200).slices);
    expect(gateWith(runningShorts(5), at(100))).toEqual([]);
  });

  it("arms を超えて上限に収まる計画は採点に委ねる——手伝いの費用（Lift_Overflow 45）を払っても改善なら採用される", () => {
    // 走行中 2 本 + 1 本 = 3 ≤ 4。60 秒 + 45 は 300 秒より良い。
    expect(gateWith(runningShorts(2), at(60))).toEqual(at(60).slices);
  });
});
