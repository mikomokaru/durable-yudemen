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
import { baselineSchedule, initialRelease, type CookSchedule } from "../../src/engine/schedule";
import { scoreSchedule, type ScheduleParams } from "../../src/engine/objective";
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
    })),
  };
}

/** 外部から届いた計画。 */
function plan(...slices: readonly ReturnType<typeof slice>[]): CookSchedule {
  return { slices };
}

/** 比較の時点の採点（走行中の卓なし Timer は成員にならない）。 */
function scoreOf(schedule: CookSchedule) {
  return scoreSchedule(schedule.slices, PENDING, tableMembers(BLOCKED), PARAMS);
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
    expect(scoreOf(COMMITTED)).toEqual({ total: 1260, bySlice: [600, 660] });
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
    expect(scoreOf(composed).total).toBe(720);
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
    expect(scoreOf(wouldBe).total).toBe(1720);
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
    const before = scoreSchedule(committed.slices, twin, members, PARAMS).total;
    const after = scoreSchedule(nudged.slices, twin, members, PARAMS).total;
    expect(after).toBeGreaterThan(before);
    expect(gateTwin(nudged)).toEqual([]);
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

  function placement(itemIndex: number, slots: readonly string[], startSeconds: number) {
    return {
      externalOrderId: "o-table",
      itemIndex,
      slotIds: nonEmpty(slots.map((slot) => slot as SlotId)),
      startAt: (NOW + startSeconds * SECOND) as EpochMillis,
      serveAt: (NOW + (startSeconds + SIX_MINUTES) * SECOND) as EpochMillis,
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

  it("場面の前提: 自前解は 2 品を今（走行中の錨に合流）、1 品を後に置く", () => {
    const serveSeconds = COMMITTED_WIDE.slices[0]!.placements.map(
      (candidate) => (candidate.serveAt - NOW) / 1000,
    );
    expect(serveSeconds).toEqual([SIX_MINUTES, SIX_MINUTES, 2 * SIX_MINUTES]);
  });

  it("目的関数（最遅参照）は全員を遅らせる計画を真に良いと採点する——採点では守れない", () => {
    const members = tableMembers([FIRST]);
    const joined = scoreSchedule(COMMITTED_WIDE.slices, REST, members, PARAMS).total;
    const delayed = scoreSchedule(DELAY_ALL.slices, REST, members, PARAMS).total;
    expect(delayed).toBeLessThan(joined);
  });

  it("合流できる 2 品を押し出した計画は feasible と認めず、棄却する", () => {
    expect(admit(DELAY_ALL, COMMITTED_WIDE, REST, [FIRST], NOW, WIDE_PRESETS, PARAMS)).toEqual([]);
  });

  it("合流させたまま 3 品目だけ後ろに置く計画は feasible であり、悪い確定計画に対しては採用される", () => {
    // 採用済みの一片は 2 品を錨に合流させ（keepsAnchor を守る）、3 品目だけを 1080 秒（釜が空いてさらに
    // 360 秒後）に置いていて、目的関数の上で合流の形（3 品目は 720 秒）より悪い。合流の形は (e) で落ちず、
    // 改善として採用される。一方 DELAY_ALL は目的関数の上ではさらに良いが、(e) で feasible ではない。
    // （全員を 1080 秒に置く一片は、合流できる 2 品を押し出しているので合成が捨て、比較基準にならない。）
    const late = [
      placement(1, ["2", "3"], 0),
      placement(2, ["4", "5"], 0),
      placement(3, ["0", "1"], 2 * SIX_MINUTES),
    ];
    const committedLate = committedSchedule(
      [{ tableKey: "t-1", placements: late }],
      REST,
      [FIRST],
      NOW,
      WIDE_PRESETS,
      PARAMS,
    );
    const keep: CookSchedule = {
      slices: [
        {
          tableKey: "t-1",
          placements: [
            placement(1, ["2", "3"], 0),
            placement(2, ["4", "5"], 0),
            placement(3, ["0", "1"], SIX_MINUTES),
          ],
        },
      ],
    };
    const members = tableMembers([FIRST]);
    expect(scoreSchedule(DELAY_ALL.slices, REST, members, PARAMS).total).toBeLessThan(
      scoreSchedule(keep.slices, REST, members, PARAMS).total,
    );
    expect(admit(keep, committedLate, REST, [FIRST], NOW, WIDE_PRESETS, PARAMS)).toEqual(
      keep.slices,
    );
    expect(admit(DELAY_ALL, committedLate, REST, [FIRST], NOW, WIDE_PRESETS, PARAMS)).toEqual([]);
  });
});
