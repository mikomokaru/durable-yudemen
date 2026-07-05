// tests/registry/compose.example.test.ts — composeEffectiveConfig の example / edge-case テスト（タスク10.6）。
//
// 合成の「値決定」だけを具体例で確かめる純粋テスト。HTTP 面・入口検証には触れない
//   （入口の拒否判定は validateProvisioningInput の責務でタスク2.7、400 応答の配線はタスク10.7 が検証する）。
// ここでは Policy 群・Store_Override を明示フィクスチャで組み、期待する StoreConfig 出力を厳密に照合する:
//   1. 空 Policy 群・空 Override → 全フィールドが DEFAULT_*（出力完全性・要件4.5）。
//   2. Override のみ（Policy なし）→ Override の値がそのまま現れる（値域内）。
//   3. priority 昇順畳み込み（default）→ 高い priority（後に畳む・数の大きい層）が勝つ。
//   4. enforced 支配 → 低い priority（数の小さい層）の enforced が後続 default/enforced と Override を無視して勝つ（要件4.2 / 4.3）。
//   5. default 上書き → default フィールドは後の層・Override が上書きできる。
//   6. 配列丸ごと置換 → 勝った層の noodlePresets が要素まで完全一致する（層をまたぐマージなし・要件4.4）。
//   7. Store_Override 復活 → enforced がある間は Override を無視し、統制を外すと保持された Override が復活する（要件4.7）。
//
// 値域の正本は src/domain/store.ts の DEFAULT_* 定数。数値はすべて対応検証関数の値域内に収める（出口クランプに依存しない例示）。

import { describe, expect, it } from "vitest";
import { composeEffectiveConfig } from "../../src/registry/compose";
import type { Policy, PolicyFields, StoreOverride } from "../../src/registry/ideal";
import {
  type NoodlePreset,
  type StoreConfig,
  DEFAULT_UNIT_COUNT,
  DEFAULT_ARMS,
  DEFAULT_TOLERANCE_RATIO,
  DEFAULT_NOODLE_PRESETS,
} from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";

// ── フィクスチャ補助 ──

/** priority・fields を与えて Policy を組む（chainId / name は合成の値決定に無関係ゆえ固定）。 */
function policy(policyId: string, priority: number, fields: PolicyFields): Policy {
  return { policyId, chainId: "chain-1", name: policyId, priority, fields };
}

/** 値域内の妥当な麺プリセット（noodleType 別に区別できるよう種別名を引数化）。 */
function preset(noodleType: string, normal: number): NoodlePreset {
  return { noodleType, boilSeconds: { extraHard: normal - 15, hard: normal - 8, normal, soft: normal + 15 } };
}

/** noodlePresets 用の非空配列（丸ごと置換の単位）。 */
function presets(...items: NoodlePreset[]): NonEmptyArray<NoodlePreset> {
  return items as unknown as NonEmptyArray<NoodlePreset>;
}

describe("composeEffectiveConfig — 縮退（空入力）", () => {
  it("空 Policy 群・空 Override は全フィールドが DEFAULT_*", () => {
    const result = composeEffectiveConfig([], {});
    const expected: StoreConfig = {
      unitCount: DEFAULT_UNIT_COUNT,
      arms: DEFAULT_ARMS,
      toleranceRatio: DEFAULT_TOLERANCE_RATIO,
      noodlePresets: DEFAULT_NOODLE_PRESETS,
    };
    expect(result).toEqual(expected);
  });

  it("一部フィールドだけ主張されると、残りは DEFAULT_* で埋まる（出力完全性）", () => {
    const result = composeEffectiveConfig([policy("p1", 1, { unitCount: { mode: "default", value: 4 } })], {});
    expect(result.unitCount).toBe(4); // 主張された層の値
    expect(result.arms).toBe(DEFAULT_ARMS); // 未主張 → 既定
    expect(result.toleranceRatio).toBe(DEFAULT_TOLERANCE_RATIO);
    expect(result.noodlePresets).toEqual(DEFAULT_NOODLE_PRESETS);
  });
});

describe("composeEffectiveConfig — Override のみ（Policy なし）", () => {
  it("Override の値がそのまま現れる（値域内）", () => {
    const override: StoreOverride = {
      unitCount: 2,
      arms: 5,
      toleranceRatio: 25,
      noodlePresets: presets(preset("Store-Special", 90)),
    };
    const result = composeEffectiveConfig([], override);
    expect(result).toEqual(override);
  });
});

describe("composeEffectiveConfig — priority 昇順畳み込み（default）", () => {
  it("同一フィールドを default 主張する 2 層は、priority が大きい（後に畳む）層が勝つ", () => {
    const low = policy("p-low", 1, { unitCount: { mode: "default", value: 1 } });
    const high = policy("p-high", 2, { unitCount: { mode: "default", value: 4 } });
    // 入力順に依存しないことも確かめる（畳み込みは priority 昇順で決まる）。
    expect(composeEffectiveConfig([low, high], {}).unitCount).toBe(4);
    expect(composeEffectiveConfig([high, low], {}).unitCount).toBe(4);
  });

  it("同着 priority は policyId 昇順で安定化する（後の policyId が勝つ default）", () => {
    const a = policy("aaa", 5, { arms: { mode: "default", value: 3 } });
    const b = policy("bbb", 5, { arms: { mode: "default", value: 7 } });
    // policyId 昇順（aaa → bbb）に畳むため、後に来る bbb の default が勝つ。
    expect(composeEffectiveConfig([a, b], {}).arms).toBe(7);
    expect(composeEffectiveConfig([b, a], {}).arms).toBe(7);
  });
});

describe("composeEffectiveConfig — enforced 支配（要件4.2 / 4.3）", () => {
  it("低い priority の enforced が、後続の default/enforced と Override を無視して勝つ", () => {
    const enforcedLow = policy("p1", 1, { unitCount: { mode: "enforced", value: 2 } });
    const laterDefault = policy("p2", 2, { unitCount: { mode: "default", value: 4 } });
    const laterEnforced = policy("p3", 3, { unitCount: { mode: "enforced", value: 1 } });
    const override: StoreOverride = { unitCount: 3 };
    const result = composeEffectiveConfig([enforcedLow, laterDefault, laterEnforced], override);
    expect(result.unitCount).toBe(2); // 最小 priority の enforced が確定・以後ロック
  });
});

describe("composeEffectiveConfig — default 上書き", () => {
  it("default フィールドは Override が上書きできる（ロックされていない）", () => {
    const def = policy("p1", 1, { arms: { mode: "default", value: 4 } });
    const result = composeEffectiveConfig([def], { arms: 9 });
    expect(result.arms).toBe(9); // 最終層 Override が default を上書き
  });

  it("default フィールドは後の層（より大きい priority）が上書きできる", () => {
    const early = policy("p1", 1, { toleranceRatio: { mode: "default", value: 10 } });
    const late = policy("p2", 2, { toleranceRatio: { mode: "default", value: 40 } });
    expect(composeEffectiveConfig([early, late], {}).toleranceRatio).toBe(40);
  });
});

describe("composeEffectiveConfig — 配列丸ごと置換（要件4.4）", () => {
  it("複数層が noodlePresets を主張すると、勝った層の配列が要素まで完全一致する（マージなし）", () => {
    const winner = presets(preset("Winner-A", 60), preset("Winner-B", 120));
    const loser = presets(preset("Loser-X", 45), preset("Loser-Y", 80), preset("Loser-Z", 100));
    const low = policy("p-low", 1, { noodlePresets: { mode: "default", value: loser } });
    const high = policy("p-high", 2, { noodlePresets: { mode: "default", value: winner } });
    const result = composeEffectiveConfig([low, high], {});
    expect(result.noodlePresets).toEqual(winner); // 要素マージが起きない（丸ごと置換）
    expect(result.noodlePresets).toHaveLength(2);
  });
});

describe("composeEffectiveConfig — Store_Override 復活（要件4.7）", () => {
  it("enforced がある間は Override を無視し、統制を外すと Override が復活する", () => {
    const override: StoreOverride = { unitCount: 4 };
    const enforced = policy("p1", 1, { unitCount: { mode: "enforced", value: 1 } });
    // 統制中：enforced の値が勝ち、Override は無視される。
    expect(composeEffectiveConfig([enforced], override).unitCount).toBe(1);
    // 統制解除（当該フィールドの enforced 主張を取り除く）：保持されていた Override が復活する。
    const unenforced = policy("p1", 1, {});
    expect(composeEffectiveConfig([unenforced], override).unitCount).toBe(4);
  });
});
