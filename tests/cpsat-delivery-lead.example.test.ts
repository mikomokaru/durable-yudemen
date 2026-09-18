// tests/cpsat-delivery-lead.example.test.ts — **計画は「今」ではなく「受領の見込み時刻」から置く**
// ことを機械で押さえる（2026-09-14・本番の採用 0 の本体）。
//
// **Validates: cpsat-planner-integration R5.4, R6.2**
//
// 何が起きていたか。CP-SAT は計画を組んだ時刻の「今」から置き始める。DO がそれを受け取るのは
// Queue → 求解 → 復路の後で、本番実測で 2.6〜6.6 秒あとである（60 分・n=320・p50 2,648 /
// p90 4,498 / p99 5,905 / max 6,619 ms）。受領時刻で解放表は `now` に床を張るので、先頭の配置は
// **過去開始**になり `feasibleRelease` が落とす。実データの `table_no` は全行 `1`——一片は卓 1 つに
// まとまるので、それが計画全体の棄却になる。本番 322 件すべてが `rejected` だった。
//
// **掃引では踏めなかった。** 計画と採否を同じ `now` で見ていたからである（`--deliver-delay` を
// 足して再現した）。ここに 2 本置くのは、同じ食い違いを次は機械が止めるためである。
//
// **守りは 2 段ある。**
//   第一線 `CPSAT_DELIVERY_LEAD_MS`（生成側）——モデルが置ける最も早い開始時刻を先へ送る。
//   第二線 R5.5 の補正（受領側・design 第 5.3 節 手順 4）——実際の遅れの分だけ全配置を後ろへ
//     ずらし、物理条件を再検証する。上限 30 秒を超えれば補正せず棄却する。
//
// 第一線だけでは、遅れが lead を超えた裾が全件棄却に戻る。第二線だけでは、すべての受領が補正を
// 要することになり「solver が最適性を証明した解」から毎回ずれる。**両方を固定する。**
//
// **計画の中身は engine 自身の解である。** 作り物の悪い計画で落ちたのでは「悪いから落ちた」と
// 区別がつかない。落ちる理由を時刻だけに絞る。
import { describe, expect, it } from "vitest";
import { admitDetailed, type AdmitStage } from "../src/engine/admit";
import { committedSchedule } from "../src/engine/commit";
import {
  baselineSchedule,
  initialRelease,
  MAX_RETIME_MS,
  type CookSchedule,
} from "../src/engine/schedule";
import { initialLifts } from "../src/engine/lift";
import { tableMembers } from "../src/engine/project";
import { CPSAT_DELIVERY_LEAD_MS, cpsatTargets } from "../src/cpsat/request";
import { EMPTY_SHOWN_PLAN } from "../src/engine/stability";
import { occupiedSlotsOf, type NoodlePreset } from "../src/domain/store";
import { pendingOrders, type OrderItem } from "../src/domain/order";
import type { EpochMillis } from "../src/engine/types";
import { schedulingDefaults } from "./storeConfigDefaults";

const NOW = 1_700_000_000_000 as EpochMillis;
/** 本番実測の最大の遅れ（2026-09-14・60 分・n=320）。 */
const OBSERVED_MAX_LAG_MS = 6_619;
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "REG", boilSeconds: { extraHard: 150, hard: 270, normal: 420, soft: 540 } },
];
/** **CP-SAT モードの規則で採否を見る**（R1.4・R5.4）。本番の `PLANNER_BACKEND` と同じ。 */
const PARAMS = { ...schedulingDefaults(2), planner: "cpsat" as const };

/** 卓が 1 つの待ち行列（実データの `table_no` はすべて `1`）。 */
function singleTableQueue(count: number): readonly OrderItem[] {
  return Array.from({ length: count }, (_, index) => ({
    externalOrderId: `POS-${String(index).padStart(4, "0")}`,
    itemIndex: 0,
    noodleType: "REG",
    firmness: "normal" as const,
    tableId: "1",
    arrivalTime: (NOW - (count - index) * 30_000) as EpochMillis,
    portions: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
  }));
}

/** `at` を最も早い開始時刻として、対象に engine 自身の解を組む（＝外部計画として持ち込む形）。 */
function planFrom(live: readonly OrderItem[], at: EpochMillis): CookSchedule {
  const slotCount = PARAMS.unitOrigins.length * 6;
  return baselineSchedule(
    cpsatTargets(live, PRESETS, slotCount, at, PARAMS),
    initialRelease([], at, slotCount),
    tableMembers([]),
    initialLifts([]),
    PRESETS,
    PARAMS,
    at,
    occupiedSlotsOf([]),
    null,
  );
}

/** `arrived` を `at` に受領したときの採否（採用数・段・当てた補正の幅）。 */
function decideAt(
  arrived: CookSchedule,
  pending: readonly OrderItem[],
  at: EpochMillis,
): { readonly accepted: number; readonly stage: AdmitStage; readonly retimedByMs: number } {
  const live = pendingOrders(pending, [], at);
  const committed = committedSchedule([], live, [], at, PRESETS, PARAMS, null);
  const outcome = admitDetailed(
    arrived,
    committed,
    live,
    [],
    EMPTY_SHOWN_PLAN,
    at,
    PRESETS,
    PARAMS,
  );
  return {
    accepted: outcome.slices.length,
    stage: outcome.stage,
    retimedByMs: outcome.retimedByMs,
  };
}

describe("受領までの遅れと、計画が置き始める時刻", () => {
  const pending = singleTableQueue(12);
  const live = pendingOrders(pending, [], NOW);

  it("**見込みの遅れだけ先から置いた計画は、補正なしで採用される**（第一線・lead）", () => {
    expect(CPSAT_DELIVERY_LEAD_MS).toBeGreaterThanOrEqual(OBSERVED_MAX_LAG_MS);
    const arrived = planFrom(live, (NOW + CPSAT_DELIVERY_LEAD_MS) as EpochMillis);
    const decided = decideAt(arrived, pending, (NOW + OBSERVED_MAX_LAG_MS) as EpochMillis);

    expect(decided.accepted).toBeGreaterThan(0);
    // **補正は当たっていない。** lead が先にずらしてあるので、過去開始が起きていない。
    expect(decided.retimedByMs).toBe(0);
    expect(decided.stage).toBe("complete");
  });

  it("**「今」から置いた計画は、遅れた分だけ後ろへずらして採用される**（第二線・R5.5 の補正）", () => {
    const arrived = planFrom(live, NOW);
    // 同じ時刻に届けば補正は要らない。
    expect(decideAt(arrived, pending, NOW)).toMatchObject({ retimedByMs: 0, stage: "complete" });

    // 実測の最大の遅れで届くと先頭が過去開始になる。**補正がその分だけ後ろへずらして通す。**
    const late = decideAt(arrived, pending, (NOW + OBSERVED_MAX_LAG_MS) as EpochMillis);
    expect(late.accepted).toBeGreaterThan(0);
    expect(late.retimedByMs).toBe(OBSERVED_MAX_LAG_MS);
    expect(late.stage).toBe("complete");
  });

  it("**補正の上限（30 秒）を超える遅れは補正せず棄却する**（段が言える）", () => {
    const arrived = planFrom(live, NOW);
    const tooLate = decideAt(arrived, pending, (NOW + MAX_RETIME_MS + 1) as EpochMillis);

    expect(tooLate.accepted).toBe(0);
    expect(tooLate.stage).toBe("retime-too-large");
  });

  it("**TS モードには補正を当てない**（巻き戻しの経路の挙動を変えない）", () => {
    const arrived = planFrom(live, NOW);
    const at = (NOW + OBSERVED_MAX_LAG_MS) as EpochMillis;
    const liveAt = pendingOrders(pending, [], at);
    const tsParams = { ...PARAMS, planner: "ts" as const };
    const committed = committedSchedule([], liveAt, [], at, PRESETS, tsParams, null);
    const outcome = admitDetailed(
      arrived,
      committed,
      liveAt,
      [],
      EMPTY_SHOWN_PLAN,
      at,
      PRESETS,
      tsParams,
    );

    expect(outcome.retimedByMs).toBe(0);
    // 過去開始のまま解放表と噛み合わないので、TS モードでは従来どおり落ちる。
    expect(outcome.slices).toEqual([]);
  });
});
