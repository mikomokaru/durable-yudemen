// tests/shell/apply-projection.property.test.ts — Property 22（投影適用は version 単調・到着順に依存しない）。
//
// 本テストは Workers pool（@cloudflare/vitest-pool-workers の cloudflareTest）で実 StoreTimerDO を駆動し、
// applyProjection の単調ガード（要件5.4 / 5.9）を検証する。
//   - 投影押し込みの列（version 順は任意＝到着順は fast-check が run ごとにシャッフルする）について、
//     最終永続投影は列中の最大 version の投影に等しい（到着順に依存しない・last-write-wins）。
//   - version が永続済み version 未満（stale）の押し込みは状態を変えず、永続済み version をエコーする。
//
// applyProjection は単調ガードを永続層（SSOT）の version に照らして判定するため、実 DO の storage を
// runInDurableObject で読んで確定済み投影を突き合わせる。加えて「単調ガードの純粋判定」を独立の純粋
// property としても持ち、到着順非依存（最終＝最大 version）をライブラリ・storage 非依存に固める。

import { env, runInDurableObject } from "cloudflare:test";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import { configResidualDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * 投影の永続キー。store-timer-do.ts の PROJECTION_KEY と一致させる（そこでは private 定数）。
 * 実 DO の storage を直接読んで「確定済み投影」を突き合わせるため、テスト側でも同じ文字列を用いる。
 */
const PROJECTION_KEY = "projection";

// ── 投影の生成母集団（値域内の健全な StoreConfig を振る）──
// applyProjection は到達＝検証済み（要件4.6 の帰結）ゆえ再検証しないが、現実の投影に倣い値域内で振る。
// config を run/要素ごとに変えることで、stale 押し込みが「状態を変えない」ことを検出可能にする。

/** 全 4 硬さの正の整数秒（FirmnessSeconds 相当）。 */
const genBoilSeconds = fc.record({
  extraHard: fc.integer({ min: 1, max: 300 }),
  hard: fc.integer({ min: 1, max: 300 }),
  normal: fc.integer({ min: 1, max: 300 }),
  soft: fc.integer({ min: 1, max: 300 }),
});

/** NoodlePreset（麺種＋硬さ別秒）。 */
const genNoodlePreset: fc.Arbitrary<NoodlePreset> = fc.record({
  noodleType: fc.string({ minLength: 1, maxLength: 8 }),
  boilSeconds: genBoilSeconds,
});

/** 非空の麺種プリセット列（NonEmptyArray を型で担保）。 */
const genNoodlePresets: fc.Arbitrary<NonEmptyArray<NoodlePreset>> = fc
  .tuple(genNoodlePreset, fc.array(genNoodlePreset, { maxLength: 2 }))
  .map(([head, tail]) => [head, ...tail] as NonEmptyArray<NoodlePreset>);

/** 値域内の完全な StoreConfig（重み・許容幅・レイアウトは本テストの関心外ゆえ既定で埋める）。 */
const genConfig: fc.Arbitrary<StoreConfig> = fc
  .record({
    unitCount: fc.integer({ min: 1, max: 4 }),
    arms: fc.integer({ min: 1, max: 10 }),
    toleranceRatio: fc.integer({ min: 1, max: 50 }),
    noodlePresets: genNoodlePresets,
  })
  .map((fields) => ({ ...fields, ...configResidualDefaults(fields.unitCount) }));

/** Roster（identity 集合）。非 ASCII・重複に近い文字列も含めて振る（ワイヤに出ない内部値）。 */
const genRoster = fc.array(fc.string({ maxLength: 12 }), { maxLength: 4 });

/**
 * 投影の押し込み列を生成する。version は列内で一意（unique）にし、到着順は fast-check が run ごとに
 * 任意に振る。一意ゆえ「永続済み未満（stale）＝退ける」「以上＝適用」が明確に分かれ、最大 version が
 * ただ一つに定まる（最終永続投影の突き合わせ先が一意）。config / roster / active は要素ごとに独立に振る。
 */
const genProjectionSequence: fc.Arbitrary<readonly StoreProjection[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 6 })
  .chain((versions) =>
    fc.tuple(
      ...versions.map((version) =>
        fc.record({
          config: genConfig,
          roster: genRoster,
          active: fc.boolean(),
          version: fc.constant(version),
        }),
      ),
    ),
  );

/** 一意の storeId を run ごとに採番する（DO 状態の run 間持ち越しを防ぎ、各 run を独立させる）。 */
let storeSeq = 0;
function freshStoreId(): string {
  storeSeq += 1;
  return `apply-projection-${storeSeq}-${crypto.randomUUID()}`;
}

/**
 * 単調ガードの純粋判定 — applyProjection のガードと同値のモデル。
 * 永続済みが無い、または受領 version が永続済み version 以上のとき適用する（＝未満のとき退ける）。
 */
function guardApplies(incomingVersion: number, persistedVersion: number | undefined): boolean {
  return persistedVersion === undefined || incomingVersion >= persistedVersion;
}

describe("shell/applyProjection — version 単調ガード", () => {
  // Feature: per-store-provisioning, Property 22: 投影適用は version 単調（到着順に依存しない）
  // **Validates: Requirements 5.4, 5.9**
  //
  // 実 StoreTimerDO を Workers pool で駆動し、任意順の投影押し込み列について
  //   (a) 各押し込み後の永続投影は「それまでに受領した最大 version の投影」に一致する、
  //   (b) stale 押し込み（version < 永続済み）は状態を変えず永続済み version をエコーする、
  //   (c) 全押し込み後の最終永続投影は列中の最大 version の投影に等しい（到着順に依存しない）、
  // を検査する。単調ガードの照合基準は永続層（SSOT）ゆえ storage を直接読んで突き合わせる。
  it("Property 22: 実 DO 押し込みは version 単調（最終＝最大 version・stale は状態を変えない）", async () => {
    await fc.assert(
      fc.asyncProperty(genProjectionSequence, async (sequence) => {
        const id = env.STORE_TIMER_DO.idFromName(freshStoreId());
        const stub = env.STORE_TIMER_DO.get(id);

        await runInDurableObject(stub, async (instance: StoreTimerDO, state) => {
          // 到着順（sequence の並び）に沿って押し込みつつ、確定済み投影の期待値を並走モデルで追う。
          let expectedPersisted: StoreProjection | undefined = undefined;

          for (const projection of sequence) {
            // 逐次 await は意図的。単調ガードは永続層の確定 version に照らして到着順に判定するため、
            // 並列化せず 1 件ずつ押し込んで確定済み投影を突き合わせる（順序依存の SSOT 意味論そのもの）。
            // oxlint-disable-next-line no-await-in-loop
            const echoed = await instance.applyProjection(projection);

            // ガード判定（コードと同値のモデル）。永続済み未満なら退け、以上／未永続なら適用する。
            const applies = guardApplies(projection.version, expectedPersisted?.version);
            const previous = expectedPersisted;
            expectedPersisted = applies ? projection : expectedPersisted;

            // エコーは確定済み version（適用時は自身の version、退けた時は永続済み version）。
            expect(echoed.version).toBe(expectedPersisted!.version);

            // 永続層（SSOT）の投影は確定済み投影に一致する。
            // oxlint-disable-next-line no-await-in-loop
            const stored = (await state.storage.get(PROJECTION_KEY)) as StoreProjection | undefined;
            expect(stored).toEqual(expectedPersisted);

            // stale 押し込みは状態を変えない（退けた直前の永続投影のまま）。
            if (!applies) {
              expect(stored).toEqual(previous);
            }
          }

          // 最終永続投影は列中の最大 version の投影に等しい（到着順に依存しない・version 一意ゆえ一意に定まる）。
          const maxProjection = sequence.reduce((best, current) =>
            current.version > best.version ? current : best,
          );
          const finalStored = (await state.storage.get(PROJECTION_KEY)) as StoreProjection | undefined;
          expect(finalStored).toEqual(maxProjection);
          expect(expectedPersisted).toEqual(maxProjection);
        });
      }),
      { numRuns: 100 },
    );
  });

  // Feature: per-store-provisioning, Property 22: 投影適用は version 単調（到着順に依存しない）
  // **Validates: Requirements 5.4, 5.9**
  //
  // 単調ガードの純粋判定（storage・DO 非依存）。任意順の version 列を畳み込むと、退けは「永続済み未満」に
  // ちょうど一致し、最終確定 version は列中の最大に等しい（到着順に依存しない）。実 DO の property を支える
  // 順序非依存性を、ライブラリ・storage の作用なしに固める。
  it("Property 22（純粋）: 単調ガードは version 未満を退け最終は最大 version（到着順非依存）", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 10 }),
        (versions) => {
          let persisted: number | undefined = undefined;

          for (const version of versions) {
            const applies = guardApplies(version, persisted);
            // ガードの純粋判定は「永続済みが無い、または受領 version が永続済み以上」と同値。
            expect(applies).toBe(persisted === undefined || version >= persisted);
            if (applies) persisted = version;
          }

          // 畳み込み後の確定 version は列の最大（並び＝到着順に依存しない）。
          expect(persisted).toBe(Math.max(...versions));
        },
      ),
      { numRuns: 200 },
    );
  });
});
