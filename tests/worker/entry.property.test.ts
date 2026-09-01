// tests/worker/entry.property.test.ts — Entry（`/`）の行き先解決の property テスト（Property 18）。
//
// 本ファイルは per-store-provisioning の行き先解決（resolveEntryDestination）の Property 18 を検証する。
// resolveEntryDestination / EntryDestination は cloudflare:workers・jose に依存しない純粋な型・関数として
// src/worker-entry.ts に隔離されており（src/worker.ts は DO の re-export 経由で cloudflare:workers を、
// Access 検証で jose を引き込むため既定 pool でロードできない）、本テストはそこから直接 import して
// DO ランタイムなしに検証する（worker-auth.ts と同じ隔離。src/worker.ts は互換のため re-export する）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveEntryDestination } from "../../src/worker-entry";

// ── ジェネレータ群 ──

/** 許容文字集合 [a-z0-9-] の 1 文字（slug.property.test.ts / store-path.property.test.ts と同じ許容形）。 */
const genAllowedChar: fc.Arbitrary<string> = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789-".split(""),
);

/**
 * storeId（登録順の要素）。採番スラッグの実像に寄せて `[a-z0-9-]`・長さ 1〜64 の文字列を生成する
 * （resolveEntryDestination は storeId の中身を検査しないが、現実の入力像で踏む）。
 */
const genStoreId: fc.Arbitrary<string> = fc
  .array(genAllowedChar, { minLength: 1, maxLength: 64 })
  .map((chars) => chars.join(""));

/** 登録順の店舗リスト（0 店舗・1 店舗・複数店舗を偏りなく踏む）。重複 storeId も許容する（先頭選択に影響しないため）。 */
const genStores: fc.Arbitrary<readonly string[]> = fc.array(genStoreId, {
  minLength: 0,
  maxLength: 12,
});

describe("worker-entry — Property 18: Entry の行き先解決", () => {
  // Feature: per-store-provisioning, Property 18: Entry の行き先解決
  // 要素数 1 のとき当該店舗の Store_Path へのリダイレクト（＝先頭 storeId への redirect）。
  // **Validates: Requirements 7.3**
  it("Property 18a: 要素数 1 は当該店舗へリダイレクトする（要件7.3）", () => {
    fc.assert(
      fc.property(genStoreId, (id) => {
        expect(resolveEntryDestination([id])).toEqual({ kind: "redirect", storeId: id });
      }),
      { numRuns: 200 },
    );
  });

  // Feature: per-store-provisioning, Property 18: Entry の行き先解決
  // 複数店舗のとき既定店（登録順の先頭）へリダイレクトする。全リストの受け渡しは GET /entry/stores が
  // 別に担うため、resolveEntryDestination は宛先（先頭）の選定のみを担い、先頭以外を宛先に選ばない。
  // **Validates: Requirements 7.4**
  it("Property 18b: 複数店舗は登録順の先頭へリダイレクトする（要件7.4）", () => {
    fc.assert(
      fc.property(fc.array(genStoreId, { minLength: 2, maxLength: 12 }), (stores) => {
        expect(resolveEntryDestination(stores)).toEqual({ kind: "redirect", storeId: stores[0] });
      }),
      { numRuns: 200 },
    );
  });

  // Feature: per-store-provisioning, Property 18: Entry の行き先解決
  // 0 店舗のとき「接続先なし」を返す（いかなる店舗へもフォールバックしない）。
  // **Validates: Requirements 7.5**
  it("Property 18c: 0 店舗は「接続先なし」を返す（要件7.5）", () => {
    expect(resolveEntryDestination([])).toEqual({ kind: "none" });
  });

  // Feature: per-store-provisioning, Property 18: Entry の行き先解決
  // フォールバックしない不変条件を全基数（0・1・複数）で通しで踏む：非空なら宛先は必ず先頭 storeId に
  // 等しく、先頭以外を捏造しない。空なら必ず none（どこかへ落とす経路を持たない）。
  // **Validates: Requirements 7.3, 7.4, 7.5**
  it("Property 18d: 宛先は常に先頭 storeId であり先頭以外へフォールバックしない（要件7.3/7.4/7.5）", () => {
    fc.assert(
      fc.property(genStores, (stores) => {
        const destination = resolveEntryDestination(stores);
        if (stores.length === 0) {
          // 空 → 接続先なし。redirect を返さない。
          expect(destination).toEqual({ kind: "none" });
        } else {
          // 非空 → 先頭 storeId への redirect に限られる（先頭以外を宛先に選ばない）。
          expect(destination.kind).toBe("redirect");
          if (destination.kind === "redirect") {
            expect(destination.storeId).toBe(stores[0]);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
