// tests/core/digest.example.test.ts — digestInput が「何を見て、何を見ないか」の代表例。
//
// Property 9（要求の抑制）は指紋の一致と要求の対応だけを見る。指紋そのものが**正しい事実を見ているか**は
// あちらの主張の外にあるので（常に同じ値を返す実装でもあの同値は成り立つ）、ここで押さえる。
// 見るべきは 2 種類——列挙順のような「事実でない値」に反応しないこと、計画を動かす事実に反応すること。

import { describe, expect, it } from "vitest";
import { digestInput } from "../../src/engine/digest";
import { PLAN_TARGET_LIMIT } from "../../src/engine/schedule";
import type { Timer } from "../../src/engine/timer";
import type { SlotId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import type { NonEmptyArray } from "../../src/domain/timer";
import {
  DEFAULT_NOODLE_PRESETS,
  DEFAULT_SLOT_OFFSETS,
  defaultUnitOrigins,
  type NoodlePreset,
} from "../../src/domain/store";
import type { SettleParams } from "../../src/engine/settle";
import { nonEmpty } from "../nonEmpty";
import { NOW, timerOn } from "./scheduleScenes";

const PARAMS: SettleParams = {
  arms: 2,
  toleranceRatio: 10,
  noodlePresets: DEFAULT_NOODLE_PRESETS,
  orderSyncWeight: 3,
  tableSyncWeight: 2,
  affinityWeight: 1,
  orderSyncToleranceSeconds: 30,
  tableSyncToleranceSeconds: 60,
  affinityToleranceDistance: 14,
  unitOrigins: defaultUnitOrigins(2),
  slotOffsets: DEFAULT_SLOT_OFFSETS,
};

/** 麺種 1 件のプリセットを差し替える（他の麺種は据え置く）。 */
function withBoilSeconds(noodleType: string, normalSeconds: number): readonly NoodlePreset[] {
  return DEFAULT_NOODLE_PRESETS.map((preset) =>
    preset.noodleType === noodleType
      ? { noodleType, boilSeconds: { ...preset.boilSeconds, normal: normalSeconds } }
      : preset,
  );
}

/** 釜の並び（非空配列）。境界での検証は済んだ値として扱う。 */
function slots(...slotIds: readonly string[]): NonEmptyArray<SlotId> {
  return nonEmpty(slotIds.map((slotId) => slotId as SlotId));
}

/** 品目 1 件。arrivalTime は index から決定的に振る（正準順序が並びを一意にする）。 */
function order(externalOrderId: string, itemIndex: number, arrivalTime: number): PendingOrder {
  return {
    externalOrderId,
    itemIndex,
    noodleType: "Thin",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  };
}

const PENDING: readonly PendingOrder[] = [
  order("o-1", 0, NOW - 300_000),
  order("o-1", 1, NOW - 300_000),
  order("o-2", 0, NOW - 100_000),
];

const RUNNING: readonly Timer[] = [
  timerOn({ slot: 0, endOffset: 60_000, boiled: false }, 0),
  timerOn({ slot: 3, endOffset: 120_000, boiled: false }, 1),
];

describe("engine/digest — digestInput", () => {
  it("列挙順に依存しない（待ち行列・Timer・slotIds の並びは事実ではない）", () => {
    const baseline = digestInput(PENDING, RUNNING, PARAMS);

    expect(digestInput([...PENDING].reverse(), [...RUNNING].reverse(), PARAMS)).toBe(baseline);
    // 同じ 2 釜を占める Timer の slotIds の並び替えも指紋を動かさない。
    const multiSlot: Timer = { ...RUNNING[0]!, slotIds: slots("0", "1") };
    const swapped: Timer = { ...RUNNING[0]!, slotIds: slots("1", "0") };
    expect(digestInput(PENDING, [multiSlot], PARAMS)).toBe(digestInput(PENDING, [swapped], PARAMS));
  });

  it("計画対象外（上限を超えた品目）の増減は指紋を動かさない", () => {
    const targets = Array.from({ length: PLAN_TARGET_LIMIT }, (_unused, index) =>
      order(`o-${String(index).padStart(3, "0")}`, 0, NOW - 600_000 + index),
    );
    const overflow = order("o-999", 0, NOW);

    expect(digestInput([...targets, overflow], RUNNING, PARAMS)).toBe(
      digestInput(targets, RUNNING, PARAMS),
    );
  });

  it("計画を動かす事実には反応する（待ち行列の内容・実効 endTime・パラメータ）", () => {
    const baseline = digestInput(PENDING, RUNNING, PARAMS);

    // 待ち行列の内容（起点・卓・茹で加減・件数）。
    expect(digestInput([...PENDING.slice(0, 2)], RUNNING, PARAMS)).not.toBe(baseline);
    expect(digestInput([order("o-1", 0, NOW), ...PENDING.slice(1)], RUNNING, PARAMS)).not.toBe(
      baseline,
    );
    expect(
      digestInput([{ ...PENDING[0]!, tableId: null }, ...PENDING.slice(1)], RUNNING, PARAMS),
    ).not.toBe(baseline);

    // 実効 endTime（Boil_Sync の調整後の値が釜の解放時刻という所与の事実）。
    const adjusted: readonly Timer[] = [{ ...RUNNING[0]!, adjustment: 5_000 }, RUNNING[1]!];
    expect(digestInput(PENDING, adjusted, PARAMS)).not.toBe(baseline);

    // 占める釜。
    const moved: readonly Timer[] = [{ ...RUNNING[0]!, slotIds: slots("5") }, RUNNING[1]!];
    expect(digestInput(PENDING, moved, PARAMS)).not.toBe(baseline);

    // 採点パラメータとレイアウト。
    expect(digestInput(PENDING, RUNNING, { ...PARAMS, affinityWeight: 2 })).not.toBe(baseline);
    expect(
      digestInput(PENDING, RUNNING, { ...PARAMS, unitOrigins: defaultUnitOrigins(3) }),
    ).not.toBe(baseline);

    // 麺プリセット。茹で時間は startAt と serveAt を結ぶ唯一の値ゆえ、差し替えれば同じ待ち行列から別の
    // 計画が出る（PENDING は Thin・normal で揃えてある）。
    expect(
      digestInput(PENDING, RUNNING, { ...PARAMS, noodlePresets: withBoilSeconds("Thin", 61) }),
    ).not.toBe(baseline);
    // 計画対象の麺種がプリセットから消える差し替えも計画を変える（その品目は配置されなくなる）。
    expect(
      digestInput(PENDING, RUNNING, {
        ...PARAMS,
        noodlePresets: DEFAULT_NOODLE_PRESETS.filter((preset) => preset.noodleType !== "Thin"),
      }),
    ).not.toBe(baseline);
    // 同一麺種が二度現れる設定では、どちらが先かが計画を変える（引き当ては先頭一致）。
    const shadowing: readonly NoodlePreset[] = [
      ...withBoilSeconds("Thin", 61),
      DEFAULT_NOODLE_PRESETS[0]!,
    ];
    const shadowed: readonly NoodlePreset[] = [
      DEFAULT_NOODLE_PRESETS[0]!,
      ...withBoilSeconds("Thin", 61),
    ];
    expect(digestInput(PENDING, RUNNING, { ...PARAMS, noodlePresets: shadowing })).not.toBe(
      digestInput(PENDING, RUNNING, { ...PARAMS, noodlePresets: shadowed }),
    );
  });

  it("計画を動かさない値には反応しない（引かない麺種・プリセットの並び・Boil_Sync のパラメータ）", () => {
    const baseline = digestInput(PENDING, RUNNING, PARAMS);

    // 待ち行列が引かない麺種の茹で時間（PENDING は Thin だけを引く）。畳めば設定差し替えのたびに
    // 改善しえない要求が出る。
    expect(
      digestInput(PENDING, RUNNING, { ...PARAMS, noodlePresets: withBoilSeconds("Medium", 91) }),
    ).toBe(baseline);

    // プリセットの列挙順は事実ではない（別の麺種どうしの並び替え）。
    expect(
      digestInput(PENDING, RUNNING, {
        ...PARAMS,
        noodlePresets: [...DEFAULT_NOODLE_PRESETS].reverse(),
      }),
    ).toBe(baseline);

    // toleranceRatio が計画へ届く経路は running の実効 endTime ただ一つで、それは既に畳んである。
    // 二重に畳めば「解放表が動かないパラメータ変更」で要求が出る。
    expect(digestInput(PENDING, RUNNING, { ...PARAMS, toleranceRatio: 25 })).toBe(baseline);
  });

  it("計画が読む値には反応する（arms は Arms_Overflow で採点に効く・slotSpan は割当に効く）", () => {
    const baseline = digestInput(PENDING, RUNNING, PARAMS);

    expect(digestInput(PENDING, RUNNING, { ...PARAMS, arms: 4 })).not.toBe(baseline);

    const wider = PENDING.map((order, index) =>
      index === 0 ? { ...order, slotSpan: order.slotSpan + 1 } : order,
    );
    expect(digestInput(wider, RUNNING, PARAMS)).not.toBe(baseline);
  });

  it("整数（32bit 非負）で閉じる — 改善判定と同じ規律で丸め誤差を持ち込まない", () => {
    const digest = digestInput(PENDING, RUNNING, PARAMS);

    expect(Number.isInteger(digest)).toBe(true);
    expect(digest).toBeGreaterThanOrEqual(0);
    expect(digest).toBeLessThanOrEqual(0xffff_ffff);
  });

  it("同じ入力なら同じ指紋（now を入力に取らない — 時間の経過だけで動けば抑制が一度も働かない）", () => {
    expect(digestInput(PENDING, RUNNING, PARAMS)).toBe(digestInput(PENDING, RUNNING, PARAMS));
  });
});
