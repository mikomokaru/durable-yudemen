// tests/core/digest.example.test.ts — digestInput が「何を見て、何を見ないか」の代表例。
//
// Property 9（要求の抑制）は指紋の一致と要求の対応だけを見る。指紋そのものが**正しい事実を見ているか**は
// あちらの主張の外にあるので（常に同じ値を返す実装でもあの同値は成り立つ）、ここで押さえる。
// 見るべきは 2 種類——列挙順のような「事実でない値」に反応しないこと、計画を動かす事実に反応すること。

import { describe, expect, it } from "vitest";
import { digestInput } from "../../src/engine/digest";
import { PLAN_TARGET_LIMIT } from "../../src/engine/schedule";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis, SlotId } from "../../src/engine/types";
import { ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
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
  liftIntervalSeconds: 45,
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
function order(externalOrderId: string, itemIndex: number, arrivalTime: number): OrderItem {
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
    completedAt: null,
    interruptedAt: null,
  };
}

const PENDING: readonly OrderItem[] = [
  order("o-1", 0, NOW - 300_000),
  order("o-1", 1, NOW - 300_000),
  order("o-2", 0, NOW - 100_000),
];

const RUNNING: readonly Timer[] = [
  timerOn({ slot: 0, endOffset: 60_000, boiled: false, tableId: null }, 0),
  timerOn({ slot: 3, endOffset: 120_000, boiled: false, tableId: null }, 1),
];

describe("engine/digest — digestInput（order-lifecycle AC 4.1：正本を受け、内側で未調理に絞る）", () => {
  it("調理中の品目（自分を指す生きた Timer が在る）は指紋に現れず、完了しても現れない", () => {
    const cooking = timerOn({ slot: 4, endOffset: 90_000, boiled: false, tableId: null }, 2);
    const referencing = {
      ...cooking,
      orderItem: { externalOrderId: "o-2", itemIndex: 0, tableId: null },
    };
    const withoutItem = digestInput(PENDING.slice(0, 2), [...RUNNING, referencing], PARAMS, NOW);
    expect(digestInput(PENDING, [...RUNNING, referencing], PARAMS, NOW)).toBe(withoutItem);
    // done（Timer が消え completedAt が在る）も計画対象に無い。
    const done = [...PENDING.slice(0, 2), { ...PENDING[2]!, completedAt: NOW }];
    expect(digestInput(done, RUNNING, PARAMS, NOW)).toBe(
      digestInput(PENDING.slice(0, 2), RUNNING, PARAMS, NOW),
    );
    // 開始そのものは指紋を変える（Timer が増え、計画対象が減る）——抑制が効きすぎない。
    expect(digestInput(PENDING, [...RUNNING, referencing], PARAMS, NOW)).not.toBe(
      digestInput(PENDING, RUNNING, PARAMS, NOW),
    );
  });

  it("列挙順に依存しない（待ち行列・Timer・slotIds の並びは事実ではない）", () => {
    const baseline = digestInput(PENDING, RUNNING, PARAMS, NOW);

    expect(digestInput([...PENDING].reverse(), [...RUNNING].reverse(), PARAMS, NOW)).toBe(baseline);
    // 同じ 2 釜を占める Timer の slotIds の並び替えも指紋を動かさない。
    const multiSlot: Timer = { ...RUNNING[0]!, slotIds: slots("0", "1") };
    const swapped: Timer = { ...RUNNING[0]!, slotIds: slots("1", "0") };
    expect(digestInput(PENDING, [multiSlot], PARAMS, NOW)).toBe(
      digestInput(PENDING, [swapped], PARAMS, NOW),
    );
  });

  it("計画対象外（上限を超えた品目）の増減は指紋を動かさない", () => {
    const targets = Array.from({ length: PLAN_TARGET_LIMIT }, (_unused, index) =>
      order(`o-${String(index).padStart(3, "0")}`, 0, NOW - 600_000 + index),
    );
    const overflow = order("o-999", 0, NOW);

    expect(digestInput([...targets, overflow], RUNNING, PARAMS, NOW)).toBe(
      digestInput(targets, RUNNING, PARAMS, NOW),
    );
  });

  it("計画を動かす事実には反応する（待ち行列の内容・実効 endTime・パラメータ）", () => {
    const baseline = digestInput(PENDING, RUNNING, PARAMS, NOW);

    // 待ち行列の内容（起点・卓・茹で加減・件数）。
    expect(digestInput([...PENDING.slice(0, 2)], RUNNING, PARAMS, NOW)).not.toBe(baseline);
    expect(digestInput([order("o-1", 0, NOW), ...PENDING.slice(1)], RUNNING, PARAMS, NOW)).not.toBe(
      baseline,
    );
    expect(
      digestInput([{ ...PENDING[0]!, tableId: null }, ...PENDING.slice(1)], RUNNING, PARAMS, NOW),
    ).not.toBe(baseline);

    // 実効 endTime（Boil_Sync の調整後の値が釜の解放時刻という所与の事実）。
    const adjusted: readonly Timer[] = [{ ...RUNNING[0]!, adjustment: 5_000 }, RUNNING[1]!];
    expect(digestInput(PENDING, adjusted, PARAMS, NOW)).not.toBe(baseline);

    // 占める釜。
    const moved: readonly Timer[] = [{ ...RUNNING[0]!, slotIds: slots("5") }, RUNNING[1]!];
    expect(digestInput(PENDING, moved, PARAMS, NOW)).not.toBe(baseline);

    // 採点パラメータとレイアウト。
    expect(digestInput(PENDING, RUNNING, { ...PARAMS, affinityWeight: 2 }, NOW)).not.toBe(baseline);
    expect(
      digestInput(PENDING, RUNNING, { ...PARAMS, unitOrigins: defaultUnitOrigins(3) }, NOW),
    ).not.toBe(baseline);

    // 麺プリセット。茹で時間は startAt と serveAt を結ぶ唯一の値ゆえ、差し替えれば同じ待ち行列から別の
    // 計画が出る（PENDING は Thin・normal で揃えてある）。
    expect(
      digestInput(PENDING, RUNNING, { ...PARAMS, noodlePresets: withBoilSeconds("Thin", 61) }, NOW),
    ).not.toBe(baseline);
    // 計画対象の麺種がプリセットから消える差し替えも計画を変える（その品目は配置されなくなる）。
    expect(
      digestInput(
        PENDING,
        RUNNING,
        {
          ...PARAMS,
          noodlePresets: DEFAULT_NOODLE_PRESETS.filter((preset) => preset.noodleType !== "Thin"),
        },
        NOW,
      ),
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
    expect(digestInput(PENDING, RUNNING, { ...PARAMS, noodlePresets: shadowing }, NOW)).not.toBe(
      digestInput(PENDING, RUNNING, { ...PARAMS, noodlePresets: shadowed }, NOW),
    );
  });

  it("計画を動かさない値には反応しない（引かない麺種・プリセットの並び・Boil_Sync のパラメータ）", () => {
    const baseline = digestInput(PENDING, RUNNING, PARAMS, NOW);

    // 待ち行列が引かない麺種の茹で時間（PENDING は Thin だけを引く）。畳めば設定差し替えのたびに
    // 改善しえない要求が出る。
    expect(
      digestInput(
        PENDING,
        RUNNING,
        { ...PARAMS, noodlePresets: withBoilSeconds("Medium", 91) },
        NOW,
      ),
    ).toBe(baseline);

    // プリセットの列挙順は事実ではない（別の麺種どうしの並び替え）。
    expect(
      digestInput(
        PENDING,
        RUNNING,
        {
          ...PARAMS,
          noodlePresets: [...DEFAULT_NOODLE_PRESETS].reverse(),
        },
        NOW,
      ),
    ).toBe(baseline);
  });

  it("toleranceRatio は合流の窓 h_i を導くので指紋を変える（lift-group-planning 判断 18）", () => {
    // かつては running の実効 endTime 経由でしか計画に届かず畳まなかったが、合流の窓（茹で時間 × toleranceRatio）
    // が配置を動かすようになった。解放表が動かなくても合流の可否が変わる。
    const baseline = digestInput(PENDING, RUNNING, PARAMS, NOW);
    expect(digestInput(PENDING, RUNNING, { ...PARAMS, toleranceRatio: 25 }, NOW)).not.toBe(
      baseline,
    );
  });

  it("liftIntervalSeconds は上げ窓の長さ L と手伝いの費用を導くので指紋を変える（lift-group-planning 判断 20）", () => {
    // 走行中の上がりが同じでも、窓の長さが変われば firstFit の置き場所も Lift_Overflow の値も動く（AC 9.3・9.6）。
    const baseline = digestInput(PENDING, RUNNING, PARAMS, NOW);
    expect(digestInput(PENDING, RUNNING, { ...PARAMS, liftIntervalSeconds: 60 }, NOW)).not.toBe(
      baseline,
    );
  });

  it("計画が読む値には反応する（arms は Lift_Overflow と pack / split の分岐で効く・slotSpan は割当に効く）", () => {
    const baseline = digestInput(PENDING, RUNNING, PARAMS, NOW);

    expect(digestInput(PENDING, RUNNING, { ...PARAMS, arms: 4 }, NOW)).not.toBe(baseline);

    const wider = PENDING.map((order, index) =>
      index === 0 ? { ...order, slotSpan: order.slotSpan + 1 } : order,
    );
    expect(digestInput(wider, RUNNING, PARAMS, NOW)).not.toBe(baseline);
  });

  it("整数（32bit 非負）で閉じる — 改善判定と同じ規律で丸め誤差を持ち込まない", () => {
    const digest = digestInput(PENDING, RUNNING, PARAMS, NOW);

    expect(Number.isInteger(digest)).toBe(true);
    expect(digest).toBeGreaterThanOrEqual(0);
    expect(digest).toBeLessThanOrEqual(0xffff_ffff);
  });

  it("同じ入力なら同じ指紋（now を入力に取らない — 時間の経過だけで動けば抑制が一度も働かない）", () => {
    expect(digestInput(PENDING, RUNNING, PARAMS, NOW)).toBe(
      digestInput(PENDING, RUNNING, PARAMS, NOW),
    );
  });
});

describe("engine/digest — 期限切れの品目は指紋に現れない（pending-order-expiry AC 2.6）", () => {
  const dead = order("o-dead", 0, NOW - ORDER_LIFETIME_MS);

  it("期限切れの品目の有無は指紋を変えない", () => {
    expect(digestInput([dead, ...PENDING], RUNNING, PARAMS, NOW)).toBe(
      digestInput(PENDING, RUNNING, PARAMS, NOW),
    );
  });

  it("期限切れが先頭に 64 件在っても枠を食わず、生きている品目の指紋のまま", () => {
    const graveyard = Array.from({ length: PLAN_TARGET_LIMIT }, (_unused, index) =>
      order(`dead-${index}`, 0, NOW - ORDER_LIFETIME_MS - index),
    );
    expect(digestInput([...graveyard, ...PENDING], RUNNING, PARAMS, NOW)).toBe(
      digestInput(PENDING, RUNNING, PARAMS, NOW),
    );
  });

  it("now は絞るためだけに使い、畳まない：期限を跨がない範囲で now が進んでも指紋は同じ", () => {
    expect(digestInput(PENDING, RUNNING, PARAMS, (NOW + 60_000) as EpochMillis)).toBe(
      digestInput(PENDING, RUNNING, PARAMS, NOW),
    );
  });

  it("品目が期限を跨げば計画対象が変わり、指紋も変わる（跨いだ後は生きている品目だけの指紋に一致する）", () => {
    const nearly = order("o-old", 0, NOW - ORDER_LIFETIME_MS + 1);
    const later = (NOW + 1) as EpochMillis;
    expect(digestInput([nearly, ...PENDING], RUNNING, PARAMS, NOW)).not.toBe(
      digestInput([nearly, ...PENDING], RUNNING, PARAMS, later),
    );
    expect(digestInput([nearly, ...PENDING], RUNNING, PARAMS, later)).toBe(
      digestInput(PENDING, RUNNING, PARAMS, later),
    );
  });
});
