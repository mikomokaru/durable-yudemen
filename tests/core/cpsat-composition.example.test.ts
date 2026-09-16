// tests/core/cpsat-composition.example.test.ts — **CP-SAT モードの合成と採否**を固定する。
//
// **Validates: cpsat-planner-integration R1.4, R5.4, R5.9**
//
// 2026-09-13 に 2 つを変えた。どちらも「計画器の選択」で engine の規則が変わるという形で、
// **既定（TS）の試験群では一切踏まれない経路**である。ゆえにここで明示的に主張する。
//
//   段 1（R5.4）：CP-SAT モードの `admit` は**有効性の検査だけ**で採る。改善判定を課さない。
//   段 3（R1.4）：CP-SAT モードの確定計画は、**尾部を自前解で埋めない**。
//
// **段 3 で外すのは「新しい TS 提案の生成」だけである。** 採用済み一片の有効な残存配置は保つ
// （R5.9）——求解に失敗した瞬間に前回の提案まで消えるのは別の欠陥である。その区別をここで固定する。
import { describe, expect, it } from "vitest";
import { admit } from "../../src/engine/admit";
import { committedSchedule } from "../../src/engine/commit";
import { baselineSchedule, initialRelease, type CookSchedule } from "../../src/engine/schedule";
import { initialLifts } from "../../src/engine/lift";
import { tableMembers } from "../../src/engine/project";
import { EMPTY_SHOWN_PLAN } from "../../src/engine/stability";
import { occupiedSlotsOf, type NoodlePreset } from "../../src/domain/store";
import type { OrderItem } from "../../src/domain/order";
import type { EpochMillis } from "../../src/engine/types";
import { schedulingDefaults } from "../storeConfigDefaults";

const NOW = 1_700_000_000_000 as EpochMillis;
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "REG", boilSeconds: { extraHard: 150, hard: 270, normal: 420, soft: 540 } },
];
const TS = { ...schedulingDefaults(2), planner: "ts" as const };
const CPSAT = { ...schedulingDefaults(2), planner: "cpsat" as const };

/** 卓が 1 つの待ち行列（実データの `table_no` はすべて `1`）。 */
function queue(count: number): readonly OrderItem[] {
  return Array.from({ length: count }, (_, index) => ({
    externalOrderId: `POS-${index}`,
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

/** engine 自身の解。外部計画としても、TS 合成の期待値としても使う。 */
function own(pending: readonly OrderItem[], params: typeof TS | typeof CPSAT): CookSchedule {
  return baselineSchedule(
    pending,
    initialRelease([], NOW, params.unitOrigins.length * 6),
    tableMembers([]),
    initialLifts([]),
    PRESETS,
    params,
    NOW,
    occupiedSlotsOf([]),
    null,
  );
}

describe("段 3（R1.4）：CP-SAT モードは尾部を自前解で埋めない", () => {
  it("採用済みが空なら、確定計画は**空**である（TS モードでは埋まる）", () => {
    const pending = queue(5);
    const ts = committedSchedule([], pending, [], NOW, PRESETS, TS, null);
    const cpsat = committedSchedule([], pending, [], NOW, PRESETS, CPSAT, null);

    // TS は自前解で埋める——この差が R1.4 の言う「暗黙の補完」そのものである。
    expect(ts.slices.length).toBeGreaterThan(0);
    expect(ts.slices.flatMap((slice) => slice.placements)).toHaveLength(5);
    // CP-SAT は埋めない。画面は「提案なし」になる。
    expect(cpsat.slices).toEqual([]);
  });

  it("**採用済みの残存配置は保つ**（R5.9・失敗した瞬間に前回の提案まで消さない）", () => {
    const pending = queue(5);
    const accepted = own(pending, CPSAT).slices;
    expect(accepted.length).toBeGreaterThan(0);

    const kept = committedSchedule(accepted, pending, [], NOW, PRESETS, CPSAT, null);
    // 採用済みがそのまま残る。**埋めないことと、消すことは別である。**
    expect(kept.slices.flatMap((slice) => slice.placements)).toHaveLength(5);
  });
});

describe("段 1（R5.4）：CP-SAT モードの admit は有効性の検査だけで採る", () => {
  it("**同値の計画**を、CP-SAT モードは採り、TS モードは棄却する", () => {
    const pending = queue(5);
    // 現行の確定計画と同一の計画が届いた場面。TS の改善判定は「同値は棄却」である。
    const committed = committedSchedule([], pending, [], NOW, PRESETS, TS, null);
    const arrived: CookSchedule = { slices: committed.slices };

    expect(admit(arrived, committed, pending, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, TS)).toEqual([]);
    expect(
      admit(arrived, committed, pending, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, CPSAT),
    ).toHaveLength(committed.slices.length);
  });

  it("**部分計画を採る**（2026-09-13・卓の完全被覆は要求しない）", () => {
    const pending = queue(7);
    const committed = committedSchedule([], pending, [], NOW, PRESETS, TS, null);
    // 先頭 5 件だけを置いた計画（卓の対象 7 件のうち 5 件）。CP-SAT が天井で切った形である。
    const partial: CookSchedule = {
      slices: committed.slices.map((slice) => ({
        tableKey: slice.tableKey,
        placements: slice.placements.slice(0, 5),
      })),
    };

    // TS モードは陳腐化として落とす（同一卓の同時提供の主張が新着で崩れるため）。
    expect(admit(partial, committed, pending, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, TS)).toEqual([]);
    // CP-SAT モードは採る。**部分計画では同時提供の主張を初めから持たないので、
    // それを要求しないことは保証を失うことではない。**
    expect(
      admit(partial, committed, pending, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, CPSAT),
    ).toHaveLength(partial.slices.length);
  });

  it("**計画対象に無い品目を置いた計画は、CP-SAT モードでも採らない**（陳腐化A は残す）", () => {
    const pending = queue(5);
    const committed = committedSchedule([], pending, [], NOW, PRESETS, TS, null);
    // 1 件を「計画対象に無い品目」へ差し替える。置いた品目が正本に在ることは引き続き要求する。
    const foreign: CookSchedule = {
      slices: committed.slices.map((slice) => ({
        tableKey: slice.tableKey,
        placements: slice.placements.map((placement, index) =>
          index === 0 ? { ...placement, externalOrderId: "POS-not-a-target" } : placement,
        ),
      })),
    };

    expect(admit(foreign, committed, pending, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, CPSAT)).toEqual(
      [],
    );
  });

  it("**採用済みが無い状態（`committed` が空）から最初の 1 件を採る**（2026-09-13 の配備で踏んだ）", () => {
    const pending = queue(5);
    // 段 3 で尾部の補完を外したので、採用済みが無い間の確定計画は**空**である。
    const committed = committedSchedule([], pending, [], NOW, PRESETS, CPSAT, null);
    expect(committed.slices).toEqual([]);

    const arrived = own(pending, CPSAT);
    expect(arrived.slices.length).toBeGreaterThan(0);

    // 比べる相手が存在しないのだから、そこで落とせば**最初の 1 件が永久に採られない**。
    expect(
      admit(arrived, committed, pending, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, CPSAT),
    ).toHaveLength(arrived.slices.length);
    // TS モードは従来どおり落とす（比べる基準が無い一片は「真に良い」と言えない）。
    expect(admit(arrived, committed, pending, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, TS)).toEqual([]);
  });
});

describe("(d) を外しても、置けない品目を置いた計画は陳腐化A が落とす", () => {
  // `placeableTargets` が除外する理由は 2 つだけである（`isPlaceable`）。
  //   ・茹で時間を引けない（プリセットに無い麺種）
  //   ・単体で上げ窓の上限を超える（slotSpan > arms + HELPER_ARMS）
  // どちらも `targets` から消えるので、それを指す配置は陳腐化A で落ちる。
  for (const [name, mutate] of [
    ["茹で時間を引けない麺種", (item: OrderItem) => ({ ...item, noodleType: "NOT-IN-PRESETS" })],
    ["単体で上げ窓の上限を超える占有", (item: OrderItem) => ({ ...item, slotSpan: 5 })],
  ] as const) {
    it(`${name}を置いた計画は、CP-SAT モードでも採らない`, () => {
      const pending = queue(4);
      const committed = committedSchedule([], pending, [], NOW, PRESETS, TS, null);
      const arrived: CookSchedule = { slices: committed.slices };
      // 待ち行列の 1 件を「置けない品目」に差し替える。計画はその品目を置いたままになる。
      const withUnplaceable = [mutate(pending[0]!), ...pending.slice(1)];

      expect(
        admit(arrived, committed, withUnplaceable, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, CPSAT),
      ).toEqual([]);
    });
  }
});
