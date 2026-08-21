// tests/client/reachability.property.test.ts — 到達不能理由の分類の property テスト（V-1・タスク3）。
//
// 検証対象は classifyReachability（純粋）だけである。fetch も URL も出てこない——叩く先
// （`/entry/stores`）とリダイレクト抑止の指定は作用の端 probeReachability の性質であり、V-2 が踏む。
//
// 主張は分類表の再実装ではなく**不変**に置く。表をテスト側に写せば同じ判断が二箇所になり、両方を
// 同時に間違えたときに何も検出できない。ゆえに「redirected は常に signInRequired」「noAccess は
// 200 かつ本文が店舗リストとして読めたときだけ現れる（＝ { parsed: false } は noAccess へ落ちない）」
// のように、枝と結果の関係を全域で縛る。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseStoreChoices } from "../../src/client/connection";
import type { UnreachableReason } from "../../src/client/connection";
import { classifyReachability } from "../../src/client/connectivity";
import type { ObservedBody, ProbeObservation } from "../../src/client/connectivity";

// ── 生成器 ──────────────────────────────────────────────────────────────
// 直和の 3 枝 × status の値域 × storeId の在不在を偏りなく踏む。

/** 許容形の storeId（[a-z0-9-]・長さ 1〜12）。store-path.property.test.ts と同じ許容集合に倣う。 */
const genStoreId: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(""));

/**
 * HTTP status の値域。分類が名指す値（200 / 403）と、その周辺（3xx を含む生 status・4xx・5xx・0）を
 * 明示的に混ぜる。`redirect: "manual"` の下では 3xx は redirected 枝になるが、**responded 枝に 302 が
 * 現れても signInRequired へ化けない**ことを踏むために値域には残す。
 */
const genStatus: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(0, 200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 500, 503),
  fc.integer({ min: 100, max: 599 }),
);

/** 店舗リストの要素（storeId / name を持つ妥当な形）。 */
function genChoice(storeId: fc.Arbitrary<string>): fc.Arbitrary<unknown> {
  return fc.record({ storeId, name: fc.string({ maxLength: 8 }) });
}

/**
 * 200 本文として読めた値。**当該 storeId の在不在を両方踏む**ため、リストへ対象を差し込む枝を持つ。
 * あわせて「配列だが店舗の形でない」「そもそも配列でない」枝を混ぜ、分類不能の畳み込みを踏む。
 */
function genBodyValue(storeId: string): fc.Arbitrary<unknown> {
  const genOther = genChoice(genStoreId.filter((id) => id !== storeId));
  const genList = fc.array(genOther, { maxLength: 4 }).chain((others) =>
    fc.oneof(
      // storeId 不在のリスト（空配列を含む）。
      fc.constant<unknown>(others),
      // storeId 在のリスト（任意の位置へ差し込む）。
      genChoice(fc.constant(storeId)).chain((target) =>
        fc
          .nat({ max: others.length })
          .map<unknown>((at) => [...others.slice(0, at), target, ...others.slice(at)]),
      ),
    ),
  );

  return fc.oneof(
    genList,
    // 配列だが店舗の形でない要素（parseStoreChoices が静かに除く）。
    fc.array(fc.oneof(fc.string(), fc.integer(), fc.constant(null)), { maxLength: 3 }),
    // そもそも配列でない本文（分類不能・要件3.3）。
    fc.string(),
    fc.integer(),
    fc.constant(null),
    fc.constant(true),
    fc.record({ stores: fc.array(genStoreId, { maxLength: 2 }) }),
  );
}

/** 本文の読み取り結果。読めなかった枝（`{ parsed: false }`）を必ず含む。 */
function genObservedBody(storeId: string): fc.Arbitrary<ObservedBody> {
  return fc.oneof(
    fc.constant<ObservedBody>({ parsed: false }),
    genBodyValue(storeId).map<ObservedBody>((value) => ({ parsed: true, value })),
  );
}

interface Probe {
  readonly observation: ProbeObservation;
  readonly storeId: string;
}

/** 観測 × storeId の組。直和の 3 枝を等しく引く。 */
const genProbe: fc.Arbitrary<Probe> = genStoreId.chain((storeId) =>
  fc.oneof(
    fc.constant<Probe>({ observation: { kind: "redirected" }, storeId }),
    fc.constant<Probe>({ observation: { kind: "failed" }, storeId }),
    fc
      .record({ status: genStatus, body: genObservedBody(storeId) })
      .map<Probe>(({ status, body }) => ({
        observation: { kind: "responded", status, body },
        storeId,
      })),
  ),
);

const REASONS: readonly UnreachableReason[] = ["offline", "noAccess", "signInRequired"];

describe("client/connectivity — V-1: classifyReachability の全域", () => {
  // Feature: signin-required-misreported-as-offline, V-1: 観測の直和 3 枝 × status の値域 × storeId の
  // 在不在の全域で、分類は決定的に 3 値のいずれかへ落ち、枝と結果の関係が保たれる。とくに
  // redirected は常に signInRequired であり、{ parsed: false } は noAccess へ落ちない。
  // **Validates: Requirements 1.1, 1.3, 2.1, 2.2, 2.3, 2.4, 3.1, 3.3, 3.4**
  it("V-1: 分類は全域で決定的な 3 値であり、枝と結果の関係が保たれる", () => {
    fc.assert(
      fc.property(genProbe, ({ observation, storeId }) => {
        const reason = classifyReachability(observation, storeId);

        // 値集合は 3 値のまま。4 値目を持たない（要件3.4）。
        expect(REASONS).toContain(reason);
        // 純粋（同一入力に同一出力）。
        expect(classifyReachability(observation, storeId)).toBe(reason);

        // redirected は status も本文も持たない——常に signInRequired（要件1.1 / 1.3）。
        if (observation.kind === "redirected") {
          expect(reason).toBe("signInRequired");
        }

        // fetch 自体の失敗は到達できていない事実のみ（要件3.3）。
        if (observation.kind === "failed") {
          expect(reason).toBe("offline");
        }

        if (observation.kind === "responded") {
          // 403 は本文の読み取り結果に依らず signInRequired（要件2.1 / 2.2）。
          if (observation.status === 403) {
            expect(reason).toBe("signInRequired");
          }

          // 200 かつ本文が読めなかった → 分類不能ゆえ offline。**noAccess へ落ちない**（要件3.3 / 2.4）。
          if (observation.status === 200 && !observation.body.parsed) {
            expect(reason).toBe("offline");
          }

          // 200 かつ店舗リストとして読めて当該 storeId が在る → 認可あり＝一過性の断（要件2.3）。
          if (observation.status === 200 && observation.body.parsed) {
            const value = observation.body.value;
            if (
              Array.isArray(value) &&
              parseStoreChoices(value).some((choice) => choice.storeId === storeId)
            ) {
              expect(reason).toBe("offline");
            }
          }

          // 200 でも 403 でもない status は分類不能（3xx の生 status が signInRequired へ化けない）。
          if (observation.status !== 200 && observation.status !== 403) {
            expect(reason).toBe("offline");
          }
        }

        // noAccess が現れるのは「200 かつ本文が店舗リストとして読めた」ときだけ。読めなかったことを
        // 権限の不在にすり替えないことを、結果の側から縛る（要件2.4 / 3.3）。
        if (reason === "noAccess") {
          expect(observation.kind).toBe("responded");
          if (observation.kind === "responded") {
            expect(observation.status).toBe(200);
            expect(observation.body.parsed).toBe(true);
            if (observation.body.parsed) {
              expect(Array.isArray(observation.body.value)).toBe(true);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("client/connectivity — classifyReachability の分類表", () => {
  const STORE_ID = "yamaokaya-1263";
  const list = [
    { storeId: STORE_ID, name: "Yamaokaya 1263" },
    { storeId: "other-1", name: "Other" },
  ];

  it("redirected（Access の 302・宛先は観測不能）→ signInRequired", () => {
    expect(classifyReachability({ kind: "redirected" }, STORE_ID)).toBe("signInRequired");
  });

  it("403（Worker 自身の拒否）→ signInRequired。本文が読めていなくても変わらない", () => {
    expect(
      classifyReachability({ kind: "responded", status: 403, body: { parsed: false } }, STORE_ID),
    ).toBe("signInRequired");
  });

  it("200 かつ storeId 在 → offline（認可あり・WS 断は一過性）", () => {
    expect(
      classifyReachability(
        { kind: "responded", status: 200, body: { parsed: true, value: list } },
        STORE_ID,
      ),
    ).toBe("offline");
  });

  it("200 かつ storeId 不在 → noAccess（認証は通るがこの店舗の権限なし）", () => {
    expect(
      classifyReachability(
        { kind: "responded", status: 200, body: { parsed: true, value: [list[1]] } },
        STORE_ID,
      ),
    ).toBe("noAccess");
  });

  it("200 かつ空配列 → noAccess（読めて不在だった）", () => {
    expect(
      classifyReachability(
        { kind: "responded", status: 200, body: { parsed: true, value: [] } },
        STORE_ID,
      ),
    ).toBe("noAccess");
  });

  it("200 だが本文が読めなかった → offline（空配列と同一視しない）", () => {
    expect(
      classifyReachability({ kind: "responded", status: 200, body: { parsed: false } }, STORE_ID),
    ).toBe("offline");
  });

  it("404 / その他の非 2xx → offline（分類不能）", () => {
    expect(
      classifyReachability({ kind: "responded", status: 404, body: { parsed: false } }, STORE_ID),
    ).toBe("offline");
    expect(
      classifyReachability({ kind: "responded", status: 500, body: { parsed: false } }, STORE_ID),
    ).toBe("offline");
  });

  it("failed（fetch 自体の throw）→ offline", () => {
    expect(classifyReachability({ kind: "failed" }, STORE_ID)).toBe("offline");
  });
});
