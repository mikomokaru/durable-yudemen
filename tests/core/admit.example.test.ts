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
import type { ScheduleParams } from "../../src/engine/objective";
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
  };
}

/** 長い麺の A（卓 t-a）と短い麺の B（卓 t-b）。到着は同時ゆえ自前解は卓 id 順に A → B と置く。 */
const LONG = order("o-long", "Long", "t-a");
const SHORT = order("o-short", "Short", "t-b");
const PENDING: readonly PendingOrder[] = [LONG, SHORT];

/**
 * 外部計画の一片を組む。**score は嘘（0）を載せる。**
 *
 * 外部が主張した部分和は判定に用いられない（engine 自身の採点が唯一の権威）。嘘を載せておけば、
 * 誤って主張を信じる実装に変えたときこのファイルが落ちる。
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
    score: 0,
  };
}

/** 外部から届いた計画（総和の主張も 0＝嘘のまま）。 */
function plan(...slices: readonly ReturnType<typeof slice>[]): CookSchedule {
  return { slices, score: 0 };
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
    expect(COMMITTED.slices.map((each) => [each.tableKey, each.score])).toEqual([
      ["t-a", 600],
      ["t-b", 660],
    ]);
    expect(COMMITTED.score).toBe(1260);
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
    // score は engine が算出した値に差し替わる（外部の主張 0 ではない）。
    expect(admitted).toEqual([{ ...arrived.slices[0]!, score: 60 }]);

    // 尾部は**再実行**される。外部が A に与えた開始時刻（+120 秒）ではなく、採用した接頭辞の解放表から
    // 引き直した +60 秒に入る——切り貼りではないことがここに現れる。
    const composed = committedSchedule(admitted, PENDING, BLOCKED, NOW, PRESETS, PARAMS);
    expect(composed.slices.map((each) => [each.tableKey, each.placements[0]!.startAt])).toEqual([
      ["t-b", NOW],
      ["t-a", NOW + 60 * SECOND],
    ]);
    expect(composed.score).toBe(720);
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
    const wouldBe = committedSchedule(
      [{ ...arrived.slices[0]!, score: 560 }],
      PENDING,
      BLOCKED,
      NOW,
      PRESETS,
      PARAMS,
    );
    expect(wouldBe.score).toBe(1720);
    expect(wouldBe.score).toBeGreaterThan(COMMITTED.score);
  });

  it("遊ばせずに同じ順序へ入れ替える計画は採用される（棄却が順序の変更そのものに掛かっていない）", () => {
    // 同じ「B を先に」だが遊びが無い。合成後は 720 < 1260 ゆえ採用される。
    const arrived = plan(
      slice("t-b", [{ order: SHORT, startAt: NOW, serveAt: NOW + 60 * SECOND }]),
    );

    expect(gate(arrived)).toEqual([{ ...arrived.slices[0]!, score: 60 }]);
  });
});

describe("admit — 外部の申告を検証する", () => {
  it("主張された score は判定に用いない（engine の採点が悪化と見れば棄却する）", () => {
    // score は 0 と主張しているが、engine の採点では 760 秒待ち＝現行の 660 より悪い。
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
          score: 0,
        },
      ],
      score: 0,
    };

    expect(gate(intruder)).toEqual([]);
  });
});

describe("admit — 同値と空", () => {
  it("現行 Committed_Plan をそのまま渡すと空の採用列を返す（同値は棄却）", () => {
    expect(gate(COMMITTED)).toEqual([]);
  });

  it("空の計画は空の採用列を返す", () => {
    expect(gate({ slices: [], score: 0 })).toEqual([]);
  });

  it("自前解と同値の計画（Solver_Worker の骨格が返す形）も棄却される", () => {
    const same = baselineSchedule(PENDING, initialRelease(BLOCKED, NOW, 6), PRESETS, PARAMS);

    expect(gate(same)).toEqual([]);
  });
});
