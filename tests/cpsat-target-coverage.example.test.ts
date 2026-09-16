// tests/cpsat-target-coverage.example.test.ts — **CP-SAT の対象上限と、一片の卓の完全被覆が
// 噛み合っていない**ことを機械で押さえる（2026-09-13・7-B の再生で発見）。
//
// **上限の値を直書きしない。** `CPSAT_TARGET_LIMIT` は測定窓や改訂で動く値であり、直書きすると
// 「上限が動いた」だけで試験が落ちて、主張（被覆の規則）と無関係な保守が生まれる。
//
// 主張は 1 つだけである。
//
//   1 つの Table_Group に計画対象が上限より多くあるとき、`cpsatTargets` が返す上限ぶんだけを置いた
//   外部計画は、**その計画がどれほど良くても** `admit` に採用されない。
//
// 理由は `isStale`（schedule.ts）の 1 行にある。
//
//   if (group.length !== slice.placements.length) return true;   // 陳腐化
//
// 一片はその卓の計画対象を 1 つ残らず置いていなければならない。`cpsatTargets` は先頭 `CPSAT_TARGET_LIMIT`
// 件で切る。ゆえに「卓が 1 つ・対象が上限より多い」局面では、CP-SAT の一片は必ず段 1 で落ちる。
//
// **これは engine の欠陥ではない。** 完全被覆は plan-stability の不変条件（同一卓の配置は互いの
// 開始時刻を前提に提供時刻を揃える）であり、崩せば TS 側の保証も動く。噛み合っていないのは
// 「6 件で切る」という CP-SAT 側の切り方である。
//
// 本番の実測（2026-09-13 01:44〜02:44 UTC・189 店舗・3,671 求解）では、pending > 6 の求解が
// 3,653 件（99.5%）で、185 店舗は全求解が該当した。実データ 2 系統（noodle_plan_histories 1,919 行・
// kenbaiki_orders 300 行）の `table_no` はすべて `1` である。
import { describe, expect, it } from "vitest";
import { admit } from "../src/engine/admit";
import { committedSchedule } from "../src/engine/commit";
import {
  baselineSchedule,
  initialRelease,
  isStale,
  type CookSchedule,
} from "../src/engine/schedule";
import { initialLifts } from "../src/engine/lift";
import { tableMembers, tableKeyOf } from "../src/engine/project";
import { cpsatTargets, CPSAT_TARGET_LIMIT } from "../src/cpsat/request";
import { EMPTY_SHOWN_PLAN } from "../src/engine/stability";
import { occupiedSlotsOf, type NoodlePreset } from "../src/domain/store";
import { pendingOrders, type OrderItem } from "../src/domain/order";
import type { EpochMillis } from "../src/engine/types";
import { schedulingDefaults } from "./storeConfigDefaults";

const NOW = 1_700_000_000_000 as EpochMillis;
/** 実マスタに近い茹で時間（大橋レギュラー麺・normal 420 秒）。 */
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "REG", boilSeconds: { extraHard: 150, hard: 270, normal: 420, soft: 540 } },
];
/** 2 ユニット＝12 釜。本番 10 店中 9 店の構成である。 */
/** 被覆の規則は計画器に依らない。TS 側で主張する（CP-SAT 側は別途 `planner: "cpsat"` で検査する）。 */
const PARAMS = { ...schedulingDefaults(2), planner: "ts" as const };

/** 卓が 1 つの待ち行列。実データの `table_no` はすべて `1` ゆえ、これが本番の形である。 */
function singleTableQueue(count: number): readonly OrderItem[] {
  return Array.from({ length: count }, (_, index) => ({
    externalOrderId: `POS-${String(index).padStart(4, "0")}`,
    itemIndex: 0,
    noodleType: "REG",
    firmness: "normal" as const,
    tableId: "1",
    arrivalTime: (NOW - (count - index) * 30_000) as EpochMillis,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  }));
}

/**
 * CP-SAT が出す形の計画を作る——ただし中身は **engine 自身の最良の解**である。
 *
 * 作り物の悪い計画で落ちたのでは「悪いから落ちた」と区別がつかない。engine が同じ 6 件に対して
 * 出す解をそのまま外部計画として持ち込めば、落ちる理由は被覆だけに絞られる。
 */
function bestSixItemPlan(pending: readonly OrderItem[]): {
  readonly targets: readonly OrderItem[];
  readonly arrived: CookSchedule;
} {
  const targets = cpsatTargets(pending, PRESETS, PARAMS.unitOrigins.length * 6, NOW, PARAMS);
  const schedule = baselineSchedule(
    targets,
    initialRelease([], NOW, PARAMS.unitOrigins.length * 6),
    tableMembers([]),
    initialLifts([]),
    PRESETS,
    PARAMS,
    NOW,
    occupiedSlotsOf([]),
    null,
  );
  return { targets, arrived: schedule };
}

describe("CP-SAT の対象上限と卓の完全被覆", () => {
  it("`cpsatTargets` は天井で切る。**切った計画は卓の完全被覆を満たさず陳腐化する**", () => {
    const pending = singleTableQueue(CPSAT_TARGET_LIMIT + 1);
    const live = pendingOrders(pending, [], NOW);
    const { targets, arrived } = bestSixItemPlan(live);

    expect(targets).toHaveLength(CPSAT_TARGET_LIMIT);
    expect(arrived.slices).toHaveLength(1);
    expect(arrived.slices[0]?.tableKey).toBe(tableKeyOf(live[0]!));
    // **TS モード（全件被覆を要求する）では、切った計画は陳腐化する。**
    expect(isStale(arrived.slices[0]!, live, true)).toBe(true);
    // **CP-SAT モードでは陳腐化しない**（2026-09-13・部分被覆を許す）。
    expect(isStale(arrived.slices[0]!, live, false)).toBe(false);
  });

  it("同じ計画が、対象がちょうど上限の局面では陳腐化しない", () => {
    const pending = singleTableQueue(CPSAT_TARGET_LIMIT);
    const live = pendingOrders(pending, [], NOW);
    const { targets, arrived } = bestSixItemPlan(live);

    expect(targets).toHaveLength(CPSAT_TARGET_LIMIT);
    expect(isStale(arrived.slices[0]!, live, true)).toBe(false);
  });

  it("**卓の対象を全件置かない計画は、いまも段 1 で落ちる**（被覆の規則は変えていない）", () => {
    const pending = singleTableQueue(CPSAT_TARGET_LIMIT + 1);
    const live = pendingOrders(pending, [], NOW);
    const { arrived } = bestSixItemPlan(live);
    const committed = committedSchedule([], live, [], NOW, PRESETS, PARAMS, null);
    // 先頭 1 件を落とした計画＝卓の対象を全件置いていない。
    const partial = {
      slices: arrived.slices.map((slice) => ({
        tableKey: slice.tableKey,
        placements: slice.placements.slice(1),
      })),
    };

    expect(admit(partial, committed, live, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, PARAMS)).toEqual([]);
  });
});
