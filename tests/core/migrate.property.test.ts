// tests/core/migrate.property.test.ts — Property 13（migrate の version 不整合・移行失敗で元データ不変）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/engine/migrate";
import { CURRENT_SCHEMA_VERSION } from "../../src/engine/types";

/** version > 現行スキーマの永続データ。timers/nextSeq の妥当性に関わらず UnsupportedSchemaVersion になる。 */
const genUnsupported = fc.integer({ min: CURRENT_SCHEMA_VERSION + 1, max: 100_000 }).map((version) => ({
  raw: { version, timers: [], nextSeq: 0 } as unknown,
  expected: "UnsupportedSchemaVersion" as const,
}));

/** スナップショットとして解釈できない壊れたデータ。MigrationFailed になる。 */
const genCorrupt = fc
  .oneof(
    // 非オブジェクトのプリミティブ（null/undefined は「未保存」扱いなので除く）。
    fc.oneof(fc.integer(), fc.string({ minLength: 1 }), fc.boolean()),
    // version は妥当だが timers が配列でない。
    fc.record({ version: fc.constant(1), timers: fc.oneof(fc.string(), fc.integer(), fc.constant({})), nextSeq: fc.nat() }),
    // version・timers は形を満たすが、要素 Timer が壊れている（id が文字列でない）。
    fc.record({ version: fc.constant(1), timers: fc.constant([{ id: 123 }]), nextSeq: fc.nat() }),
    // timers は妥当だが nextSeq が負または非整数。
    fc.record({ version: fc.constant(1), timers: fc.constant([]), nextSeq: fc.constantFrom(-1, -5, 1.5, 2.7) }),
  )
  .map((raw) => ({ raw: raw as unknown, expected: "MigrationFailed" as const }));

describe("core/migrate", () => {
  // Feature: yude-men-timer, Property 13: migrate は version 不整合時に元データ不変でエラーを返す。
  // version > 1 で UnsupportedSchemaVersion、壊れたデータで MigrationFailed、いずれも入力不変。
  it("Property 13: version 不整合・移行失敗でエラーを返し、入力 raw を一切変更しない", () => {
    fc.assert(
      fc.property(fc.oneof(genUnsupported, genCorrupt), ({ raw, expected }) => {
        const before = structuredClone(raw);
        const result = migrate(raw);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure.code).toBe(expected);
        }
        // 失敗時も入力データを一切変更しない（移行を確定しない・要件11.5 / 11.6）。
        expect(raw).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });
});
