// tests/worker/admin-auth.property.test.ts — Provisioning_API 認可の純粋ロジックの property テスト。
//
// 本ファイルは per-store-provisioning の認可判定（src/worker-auth.ts）の Property 21 を検証する。
// timingSafeEqual / isAdminAuthorized は cloudflare:workers に依存しない純粋関数として src/worker-auth.ts
// に隔離されており（src/worker.ts は DO re-export 経由で cloudflare:workers を引き込むため既定 pool で
// ロードできない）、本テストはそこから直接 import して DO ランタイムなしに検証する。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isAdminAuthorized, timingSafeEqual } from "../../src/worker-auth";

// ── ジェネレータ群（一致・同一長の不一致・長さ差の不一致を偏りなく踏む） ──

/** 素の文字列（非 ASCII・空・制御文字も含む網羅入力。charCodeAt は UTF-16 単位で走査される）。 */
const genBase: fc.Arbitrary<string> = fc.string({ maxLength: 32 });

/**
 * 2 文字列の組。次の 3 系統を混ぜて、timingSafeEqual の全分岐（一致・長さ差・同一長の 1 文字差）を踏む。
 *   1) 完全一致（同一参照値）— true を期待
 *   2) 独立な 2 文字列 — 多くは不一致で、長さ差も踏む
 *   3) 同一長で 1 文字だけ改変 — 長さ差ゼロの不一致（早期 return なしの全走査を要求する経路）
 */
const genPair: fc.Arbitrary<readonly [string, string]> = fc.oneof(
  genBase.map((s) => [s, s] as const),
  fc.tuple(genBase, genBase),
  fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 32 }),
      fc.nat(),
      fc.integer({ min: 0, max: 0xffff }),
    )
    .map(([s, idx, code]) => {
      const pos = idx % s.length;
      const original = s.charCodeAt(pos);
      // 元の符号と衝突したら 1 ずらして、必ず 1 文字だけ異なる同一長の文字列を作る。
      const replacement = code === original ? (code + 1) & 0xffff : code;
      const mutated = s.slice(0, pos) + String.fromCharCode(replacement) + s.slice(pos + 1);
      return [s, mutated] as const;
    }),
);

/**
 * Authorization ヘッダ値の候補（null は「ヘッダ不在」を表す）。
 * "Bearer <任意>"・素の任意文字列・空・不在を混ぜ、空 ADMIN_TOKEN 下で常に不許可であることを踏む。
 */
const genAuthHeader: fc.Arbitrary<string | null> = fc.oneof(
  fc.string({ maxLength: 40 }).map((t) => `Bearer ${t}`),
  fc.string({ maxLength: 40 }),
  fc.constant(""),
  fc.constant(null),
);

describe("worker-auth — Property 21: 定数時間トークン比較の正当性", () => {
  // Feature: per-store-provisioning, Property 21: 定数時間トークン比較の正当性
  // 任意の 2 文字列 a・b について timingSafeEqual(a, b) は a === b と同値の真偽を返す（長さ差も
  // 不一致へ織り込む）。定数時間性はタイミング計測では検証できないため、ここでは「同値性」と
  // 「早期 return に頼らず長さ差・同一長差の双方を不一致へ畳むこと」を機能面から検証する。
  // **Validates: Requirements 8.1, 8.2**
  it("Property 21a: timingSafeEqual(a, b) は a === b と同値である", () => {
    fc.assert(
      fc.property(genPair, ([a, b]) => {
        expect(timingSafeEqual(a, b)).toBe(a === b);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: per-store-provisioning, Property 21: 定数時間トークン比較の正当性
  // ADMIN_TOKEN が空文字のとき、isAdminAuthorized は任意の Authorization（"Bearer x"・素の文字列・
  // 空・ヘッダ不在のいずれ）に対して常に偽を返す（未設定は無認証公開へ畳まない安全側の既定・要件8.2）。
  // **Validates: Requirements 8.1, 8.2**
  it("Property 21b: ADMIN_TOKEN が空のとき isAdminAuthorized は任意の Authorization で常に偽", () => {
    fc.assert(
      fc.property(genAuthHeader, (authValue) => {
        const headers: Record<string, string> = {};
        if (authValue !== null) headers.Authorization = authValue;
        const request = new Request("https://registry.example/admin/stores", { headers });
        expect(isAdminAuthorized(request, { ADMIN_TOKEN: "" })).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
