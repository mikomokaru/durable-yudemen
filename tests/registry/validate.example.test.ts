// tests/registry/validate.example.test.ts — validateProvisioningInput の accept/reject 例示テスト（タスク2.7）。
//
// レジストリ入口の拒否型検証 validateProvisioningInput の判定だけを、具体例と境界値で確かめる。
// 純粋関数の受理／拒否（理由付き）のみを検証し、HTTP 面（400 応答・イデア put 不変の配線）には触れない
// ——それは Workers pool 統合テスト（タスク10.7）の責務。ここでは次を例示で確認する:
//   1. 正常入力（storeOverride / policyFields / roster）は受理される。
//   2. 未知フィールドは "unknown-field" で拒否される（黙って捨てない）。
//   3. 型不一致（非オブジェクト・非数値・非整数・非文字列）は "type-mismatch" で拒否される。
//   4. 値域外は各数値フィールドの境界で拒否され（just-in-range 受理・just-out-of-range 拒否）、理由は "out-of-range"。
//   5. 必須欠落（ModedValue の mode/value・NoodlePreset の noodleType/boilSeconds・boilSeconds の硬さ）は
//      "missing-required" で拒否される。
//
// 値域の正本は src/domain/store.ts の定数（UNIT_COUNT_* / ARMS_* / TOLERANCE_RATIO_*）。境界は定数から導く
// （数字をハードコードせず、値域の変更に追随する）。

import { describe, expect, it } from "vitest";
import {
  validateProvisioningInput,
  type ProvisioningVerdict,
  type Rejection,
  type RejectionReason,
} from "../../src/registry/validate";
import {
  UNIT_COUNT_MIN,
  UNIT_COUNT_MAX,
  ARMS_MIN,
  ARMS_MAX,
  TOLERANCE_RATIO_MIN,
  TOLERANCE_RATIO_MAX,
} from "../../src/domain/store";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";

// ── テスト用の妥当なフィクスチャ ──

/** 全 4 硬さが正の整数秒の妥当な boilSeconds。 */
const validBoilSeconds = () => ({ extraHard: 45, hard: 52, normal: 60, soft: 75 });

/** 妥当な NoodlePreset。 */
const validPreset = () => ({ noodleType: "Thin", boilSeconds: validBoilSeconds() });

// ── アサーション補助 ──

/** verdict が拒否であることを確かめ、拒否列を取り出す（受理なら明示的に失敗）。 */
function expectRejected(verdict: ProvisioningVerdict): readonly Rejection[] {
  expect(verdict.accepted).toBe(false);
  if (verdict.accepted) throw new Error("受理された：拒否を期待していた");
  return verdict.rejections;
}

/** 指定 path・reason の拒否がちょうど 1 件含まれることを確かめる。 */
function expectRejection(
  verdict: ProvisioningVerdict,
  path: string,
  reason: RejectionReason,
): void {
  const rejections = expectRejected(verdict);
  const matched = rejections.filter((r) => r.path === path && r.reason === reason);
  expect(matched).toHaveLength(1);
}

// 数値フィールドの値域表（境界テストを定数から導く）。
const NUMERIC_RANGES = [
  { field: "unitCount", min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX },
  { field: "arms", min: ARMS_MIN, max: ARMS_MAX },
  { field: "toleranceRatio", min: TOLERANCE_RATIO_MIN, max: TOLERANCE_RATIO_MAX },
] as const;

describe("validateProvisioningInput — 正常入力の受理", () => {
  it("空の Store_Override を受理する（全フィールド optional・欠落は拒否しない）", () => {
    expect(validateProvisioningInput({ target: "storeOverride", raw: {} })).toEqual({ accepted: true });
  });

  it("全フィールドを値域内で持つ Store_Override を受理する", () => {
    const raw = {
      unitCount: UNIT_COUNT_MIN,
      arms: ARMS_MAX,
      toleranceRatio: TOLERANCE_RATIO_MAX,
      noodlePresets: [validPreset()],
    };
    expect(validateProvisioningInput({ target: "storeOverride", raw })).toEqual({ accepted: true });
  });

  it("空の PolicyFields を受理する", () => {
    expect(validateProvisioningInput({ target: "policyFields", raw: {} })).toEqual({ accepted: true });
  });

  it("mode/value を備えた PolicyFields（数値・配列とも）を受理する", () => {
    const raw = {
      unitCount: { mode: "enforced", value: UNIT_COUNT_MAX },
      toleranceRatio: { mode: "default", value: TOLERANCE_RATIO_MIN },
      noodlePresets: { mode: "enforced", value: [validPreset()] },
    };
    expect(validateProvisioningInput({ target: "policyFields", raw })).toEqual({ accepted: true });
  });

  it("空の Roster を受理する（名簿が空でも型として妥当）", () => {
    expect(validateProvisioningInput({ target: "roster", raw: [] })).toEqual({ accepted: true });
  });

  it("非空 identity 文字列の配列（重複・非 ASCII を含む）Roster を受理する", () => {
    const raw = ["alice@example.com", "本部@example.jp", "alice@example.com"];
    expect(validateProvisioningInput({ target: "roster", raw })).toEqual({ accepted: true });
  });
});

describe("validateProvisioningInput — 未知フィールドの拒否", () => {
  it("Store_Override の未知フィールドを unknown-field で拒否する", () => {
    const verdict = validateProvisioningInput({
      target: "storeOverride",
      raw: { unitCount: UNIT_COUNT_MIN, surprise: 1 },
    });
    expectRejection(verdict, "storeOverride.surprise", "unknown-field");
  });

  it("PolicyFields の ModedValue 内の未知フィールドを unknown-field で拒否する", () => {
    const verdict = validateProvisioningInput({
      target: "policyFields",
      raw: { arms: { mode: "default", value: ARMS_MIN, extra: true } },
    });
    expectRejection(verdict, "arms.extra", "unknown-field");
  });

  it("NoodlePreset の未知フィールドを unknown-field で拒否する", () => {
    const verdict = validateProvisioningInput({
      target: "storeOverride",
      raw: { noodlePresets: [{ ...validPreset(), color: "red" }] },
    });
    expectRejection(verdict, "noodlePresets[0].color", "unknown-field");
  });
});

describe("validateProvisioningInput — 型不一致の拒否", () => {
  it("Store_Override 自体が非オブジェクトなら type-mismatch で拒否する", () => {
    expectRejection(
      validateProvisioningInput({ target: "storeOverride", raw: "not-an-object" }),
      "storeOverride",
      "type-mismatch",
    );
  });

  it("数値フィールドに文字列が来たら type-mismatch で拒否する（storeOverride）", () => {
    expectRejection(
      validateProvisioningInput({ target: "storeOverride", raw: { unitCount: "3" } }),
      "unitCount",
      "type-mismatch",
    );
  });

  it("整数でない数値は type-mismatch で拒否する（クランプしない）", () => {
    expectRejection(
      validateProvisioningInput({ target: "storeOverride", raw: { arms: 2.5 } }),
      "arms",
      "type-mismatch",
    );
  });

  it("PolicyFields の ModedValue が非オブジェクトなら type-mismatch で拒否する", () => {
    expectRejection(
      validateProvisioningInput({ target: "policyFields", raw: { unitCount: 3 } }),
      "unitCount",
      "type-mismatch",
    );
  });

  it("mode が enforced|default 以外なら out-of-range で拒否する", () => {
    expectRejection(
      validateProvisioningInput({
        target: "policyFields",
        raw: { unitCount: { mode: "forced", value: UNIT_COUNT_MIN } },
      }),
      "unitCount.mode",
      "out-of-range",
    );
  });

  it("noodlePresets が配列でなければ type-mismatch で拒否する", () => {
    expectRejection(
      validateProvisioningInput({ target: "storeOverride", raw: { noodlePresets: {} } }),
      "noodlePresets",
      "type-mismatch",
    );
  });

  it("Roster が配列でなければ type-mismatch で拒否する", () => {
    expectRejection(
      validateProvisioningInput({ target: "roster", raw: "alice@example.com" }),
      "roster",
      "type-mismatch",
    );
  });

  it("Roster の要素が非文字列なら type-mismatch で拒否する", () => {
    expectRejection(
      validateProvisioningInput({ target: "roster", raw: ["alice", 42] }),
      "roster[1]",
      "type-mismatch",
    );
  });
});

describe("validateProvisioningInput — 値域外の拒否（各数値フィールドの境界）", () => {
  for (const { field, min, max } of NUMERIC_RANGES) {
    it(`${field}: 境界内（${min}・${max}）は受理、境界外（${min - 1}・${max + 1}）は out-of-range で拒否（storeOverride）`, () => {
      // just-in-range（両端）は受理。
      expect(validateProvisioningInput({ target: "storeOverride", raw: { [field]: min } })).toEqual({
        accepted: true,
      });
      expect(validateProvisioningInput({ target: "storeOverride", raw: { [field]: max } })).toEqual({
        accepted: true,
      });
      // just-out-of-range（両端の 1 つ外）は拒否。
      expectRejection(
        validateProvisioningInput({ target: "storeOverride", raw: { [field]: min - 1 } }),
        field,
        "out-of-range",
      );
      expectRejection(
        validateProvisioningInput({ target: "storeOverride", raw: { [field]: max + 1 } }),
        field,
        "out-of-range",
      );
    });

    it(`${field}: PolicyFields でも境界外は value パスの out-of-range で拒否する`, () => {
      expectRejection(
        validateProvisioningInput({
          target: "policyFields",
          raw: { [field]: { mode: "enforced", value: max + 1 } },
        }),
        `${field}.value`,
        "out-of-range",
      );
    });
  }

  it("noodlePresets の空配列を out-of-range で拒否する（開始 UI が 1 つ以上の選択肢を要する）", () => {
    expectRejection(
      validateProvisioningInput({ target: "storeOverride", raw: { noodlePresets: [] } }),
      "noodlePresets",
      "out-of-range",
    );
  });

  it("boilSeconds の 0 以下の秒を out-of-range で拒否する", () => {
    const preset = { noodleType: "Thin", boilSeconds: { ...validBoilSeconds(), normal: 0 } };
    expectRejection(
      validateProvisioningInput({ target: "storeOverride", raw: { noodlePresets: [preset] } }),
      "noodlePresets[0].boilSeconds.normal",
      "out-of-range",
    );
  });

  it("noodleType が空文字列なら out-of-range で拒否する", () => {
    const preset = { noodleType: "", boilSeconds: validBoilSeconds() };
    expectRejection(
      validateProvisioningInput({ target: "storeOverride", raw: { noodlePresets: [preset] } }),
      "noodlePresets[0].noodleType",
      "out-of-range",
    );
  });

  it("Roster の空文字列要素を out-of-range で拒否する", () => {
    expectRejection(
      validateProvisioningInput({ target: "roster", raw: ["alice", ""] }),
      "roster[1]",
      "out-of-range",
    );
  });
});

describe("validateProvisioningInput — 必須欠落の拒否", () => {
  it("ModedValue の mode 欠落を missing-required で拒否する", () => {
    expectRejection(
      validateProvisioningInput({ target: "policyFields", raw: { unitCount: { value: UNIT_COUNT_MIN } } }),
      "unitCount.mode",
      "missing-required",
    );
  });

  it("ModedValue の value 欠落を missing-required で拒否する", () => {
    expectRejection(
      validateProvisioningInput({ target: "policyFields", raw: { arms: { mode: "enforced" } } }),
      "arms.value",
      "missing-required",
    );
  });

  it("NoodlePreset の noodleType 欠落を missing-required で拒否する", () => {
    expectRejection(
      validateProvisioningInput({
        target: "storeOverride",
        raw: { noodlePresets: [{ boilSeconds: validBoilSeconds() }] },
      }),
      "noodlePresets[0].noodleType",
      "missing-required",
    );
  });

  it("NoodlePreset の boilSeconds 欠落を missing-required で拒否する", () => {
    expectRejection(
      validateProvisioningInput({
        target: "storeOverride",
        raw: { noodlePresets: [{ noodleType: "Thin" }] },
      }),
      "noodlePresets[0].boilSeconds",
      "missing-required",
    );
  });

  it("boilSeconds の硬さ欠落（各 4 硬さ）を missing-required で拒否する", () => {
    for (const missing of FIRMNESS_ORDER) {
      const boilSeconds: Record<string, number> = validBoilSeconds();
      delete boilSeconds[missing];
      const preset = { noodleType: "Thin", boilSeconds };
      expectRejection(
        validateProvisioningInput({ target: "storeOverride", raw: { noodlePresets: [preset] } }),
        `noodlePresets[0].boilSeconds.${missing}`,
        "missing-required",
      );
    }
  });
});
