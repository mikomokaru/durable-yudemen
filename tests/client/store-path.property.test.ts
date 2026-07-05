// tests/client/store-path.property.test.ts — storeId のパス往復の property テスト（タスク6.3）。
//
// 本ファイルは per-store-provisioning の宛先同定（addressing）の往復性質を検証する。
// storeIdFromPath（パス → storeId）と timerSocketUrl（storeId → WS URL）は、同定と認可を
// 分離する設計の核であり、URL から読んだ storeId と同一の storeId で接続することを一箇所で担保する。
//
// timerSocketUrl は window.location を読む作用の端。本テストは workerd（Workers pool）で走り
// window を持たないため、決定的な location shim を注入して URL 構成を検証する（存在しなければ
// 一時的に定義し、後始末で復元する）。検証は宛先パスの含有（`/s/{id}/ws`）で行う。

import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeIdFromPath, timerSocketUrl } from "../../src/client/connection";

// ── ジェネレータ（許容文字集合 [a-z0-9-]・長さ 1〜64 の妥当 storeId） ──
// slug.property.test.ts と同じ許容形。境界長 1・64 を含めて偏りなく引く。

/** 許容文字集合 [a-z0-9-] の 1 文字。 */
const genAllowedChar: fc.Arbitrary<string> = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789-".split(""),
);

/** 許容文字のみ・長さ 1〜64 の妥当 storeId（境界長 1・64 を含む）。 */
const genValidStoreId: fc.Arbitrary<string> = fc
  .array(genAllowedChar, { minLength: 1, maxLength: 64 })
  .map((chars) => chars.join(""));

// ── window.location の shim（timerSocketUrl は作用の端であり window を読む） ──
// Workers pool（workerd）には window が無いため、決定的な location を一時的に据える。
// https を与え wss が選ばれることも合わせて確かめられるようにする。

const TEST_HOST = "timer.example.com";
// biome/oxlint: テスト用 shim ゆえ any を許容する（本番コードには持ち込まない）。
let savedWindow: unknown;

beforeAll(() => {
  savedWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    location: { protocol: "https:", host: TEST_HOST },
  };
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = savedWindow;
});

describe("client/connection — Property 2: storeId のパス往復", () => {
  // Feature: per-store-provisioning, Property 2: storeId のパス往復
  // 妥当な storeId id について storeIdFromPath("/s/" + id + "/") は id に等しく、
  // timerSocketUrl(id) が構成する WS URL は宛先パス `/s/{id}/ws` を持つ。URL から読んだ storeId と
  // 同一の storeId で接続することを、往復（抽出 → 構成）の両端で確かめる。
  // **Validates: Requirements 1.3**
  it("Property 2: storeIdFromPath は id を復元し、timerSocketUrl は /s/{id}/ws を宛先に持つ", () => {
    fc.assert(
      fc.property(genValidStoreId, (id) => {
        // パス往復 — `/s/{id}/` から読み戻した storeId は元の id に一致する。
        expect(storeIdFromPath(`/s/${id}/`)).toBe(id);

        // 構成した WS URL は宛先パス `/s/{id}/ws` を含む（同一 storeId で接続する）。
        const url = timerSocketUrl(id);
        expect(url).toContain(`/s/${id}/ws`);
        // https オリジンでは wss スキームが選ばれ、同一オリジンの WS 宛先を指す。
        expect(url).toBe(`wss://${TEST_HOST}/s/${id}/ws`);
      }),
      { numRuns: 200 },
    );
  });
});
