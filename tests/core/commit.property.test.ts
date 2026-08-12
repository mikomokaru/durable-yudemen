// tests/core/commit.property.test.ts — 確定計画の合成 committedSchedule（src/engine/commit.ts）の property test。
//
// 対象は online-cook-scheduling の Property 20（合成後の計画は feasible）と Property 6（陳腐化した unit は
// Baseline で置き換わる）。純粋関数ゆえ workerd に依らず既定 pool で走る。
//
// **生成器が一部だけを陳腐化させることが、この 2 つの property の生命線である。** 全部が陳腐化する
// （接頭辞が空＝ただの自前解）／全部が生き残る（尾部が空）場面しか踏まないと、design が警戒した穴——
// 採用接頭辞と自前解の尾部を切り貼りすると同一 slot の時間帯が重複しうる——を検査できない。ゆえに
// 陳腐化させる一片の位置を採用済み列の長さに対して振り、0 件目（全滅）から末尾（無傷）までを一様に踏む。
//
// 場面の作り方:
//   1. 世界 W1（注文・開始済み Timer・パラメータ）を生成する。
//   2. **別のパラメータで組んだ自前解を「採用済み計画」に見立てる。** 同じ解放表の上で feasible で
//      ありながら、slot 選択と開始時刻が現在のパラメータの自前解と食い違う——外部計画が届いたのと
//      同じ状況を、外部ソルバーを持たずに作れる。
//   3. 待ち行列を 1 箇所だけ変える（当該一片の品目を 1 件除く＝人が開始した／キャンセルされた、または
//      当該 Table_Group へ新着を 1 件足す）。変えるのは狙った一片の Table_Group だけなので、それより
//      前の一片は無傷で生き残る。
//   4. now を 0〜30 秒進める（推奨開始時刻を過ぎた一片が接頭辞を切る経路も踏む）。
//
// **開始済み Timer 集合は W1 から動かさない。** 採用済み計画が現在の Running_Timer に対して feasible で
// あることは Acceptance_Gate の (c) が請け負う判定であり、committedSchedule が保証する事柄ではない
// （合成は (a)(b) と過去開始しか見ない）。動かせば「入力が既に infeasible」な場面を作るだけで、
// 合成の正しさは検査できない。
//
// 麺種は既知のみで振る。茹で時間が引けない品目は配置されないため採用済み一片の品目集合が当該
// Table_Group より小さくなり、狙っていない一片まで陳腐化してしまう（陳腐化の位置を制御できなくなる）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { committedSchedule } from "../../src/engine/commit";
import {
  advanceRelease,
  baselineSchedule,
  initialRelease,
  type AcceptedSlice,
  type SlotRelease,
} from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS, SLOTS_PER_UNIT, UNIT_COUNT_MAX, UNIT_COUNT_MIN } from "../../src/domain/store";
import {
  KNOWN_NOODLE_TYPES,
  NOW,
  allPlacements,
  exceedsSlotCount,
  genItemSpec,
  genOrderSpec,
  genParams,
  genRunning,
  hasOverlapOnSameSlot,
  startsBeforeRelease,
  timerOn,
  toPending,
} from "./scheduleScenes";

/**
 * 合成の場面。committedSchedule の 6 引数と、検査に要る slot 数・陳腐化させた位置が揃う。
 *
 * pending の品目数は 64 件を下回るよう作る（注文 ≤ 5・品目 ≤ 4）。計画対象＝全 pending になるので、
 * 期待値の側で上限の切り捨てを再現する必要がなくなる（64 件境界は Property 15 の持ち場である）。
 */
interface CommitScene {
  /** 採用済み計画（計画順）。別パラメータの自前解を外部計画に見立てたもの。 */
  readonly accepted: readonly AcceptedSlice[];
  /** 現在の待ち行列（採用時から 1 箇所だけ変えてある）。 */
  readonly pending: readonly PendingOrder[];
  readonly running: readonly Timer[];
  readonly now: EpochMillis;
  readonly slotCount: number;
  readonly params: ScheduleParams;
  /** 陳腐化させた一片の index。accepted.length なら陳腐化させていない。 */
  readonly staleAt: number;
}

const genCommitScene: fc.Arbitrary<CommitScene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) => {
    const slotCount = unitCount * SLOTS_PER_UNIT;
    return fc.record({
      slotCount: fc.constant(slotCount),
      params: genParams(unitCount),
      // 採用済み計画を組むときのパラメータ。現在のものと違ってよい（外部計画の見立て）。
      plannedParams: genParams(unitCount),
      running: fc.array(genRunning(slotCount), { maxLength: 4 }),
      // 注文は 2〜6 件。品目数を釜の数（6〜24）と競合させ、接頭辞と尾部が同じ釜を取り合う場面
      // ——切り貼りなら時間帯が重複する場面——を高い頻度で作る。
      orders: fc.array(genOrderSpec(KNOWN_NOODLE_TYPES), { minLength: 2, maxLength: 6 }),
      // 陳腐化させる位置。採用済み列の長さで割った剰余を採るので、0 件目から末尾（＝無傷）まで一様に散る。
      stalePick: fc.nat({ max: 12 }),
      // 陳腐化のさせ方。単独 Table_Group には新着を足せないので、その場合は除去へ倒す。
      mutation: fc.constantFrom<"consume" | "arrive">("consume", "arrive"),
      newcomer: genItemSpec(KNOWN_NOODLE_TYPES),
      // 推奨開始時刻の経過。**0 に重みを寄せる。** 先頭の一片は釜が空いていれば startAt が now に張り付く
      // ため、少しでも進めると必ず過去開始で接頭辞が空になる。0 を厚くしないと「一部だけ陳腐化」の場面が
      // 生成器から消える（実測：一様に振ると接頭辞が空の場面が 72%、0 を厚くすると 45%）。
      elapsed: fc.constantFrom(0, 0, 0, 0, 0, 1, 30_000),
    });
  })
  .map(({ slotCount, params, plannedParams, running: runningSpecs, orders, stalePick, mutation, newcomer, elapsed }) => {
    const running = runningSpecs.map(timerOn);
    const planned = toPending(orders);
    const accepted = baselineSchedule(
      planned,
      initialRelease(running, NOW, slotCount),
      DEFAULT_NOODLE_PRESETS,
      plannedParams,
    ).slices;

    const staleAt = stalePick % (accepted.length + 1);
    return {
      accepted,
      pending: staleAt < accepted.length ? stale(planned, accepted[staleAt]!, mutation, newcomer) : planned,
      running,
      now: (NOW + elapsed) as EpochMillis,
      slotCount,
      params,
      staleAt,
    };
  });

/**
 * 狙った一片を陳腐化させる（他の一片には触れない）。
 *
 * - `consume` — 当該一片の品目 1 件を待ち行列から除く（陳腐化A：対象が計画対象から消えた）。
 * - `arrive` — 当該 Table_Group へ計画が知らない品目を 1 件足す（陳腐化B）。単独グループ
 *   （tableId を持たない品目）には足せないので、そのときは除去へ倒す。
 */
function stale(
  pending: readonly PendingOrder[],
  slice: AcceptedSlice,
  mutation: "consume" | "arrive",
  newcomer: { readonly noodleType: string; readonly firmness: PendingOrder["firmness"] },
): readonly PendingOrder[] {
  const tableId = slice.tableKey.startsWith("\u0000") ? null : slice.tableKey;
  if (mutation === "consume" || tableId === null) {
    const victim = slice.placements[0]!;
    return pending.filter(
      (order) => order.externalOrderId !== victim.externalOrderId || order.itemIndex !== victim.itemIndex,
    );
  }
  return [
    ...pending,
    {
      externalOrderId: "o-newcomer",
      itemIndex: 0,
      noodleType: newcomer.noodleType,
      firmness: newcomer.firmness,
      tableId,
      arrivalTime: NOW,
    },
  ];
}

/**
 * 生き残る接頭辞の長さ。**実装の述語を呼ばずに求める。**
 *
 * 陳腐化の位置は生成器が知っている（staleAt）。過去開始で切れる位置はテスト側の素朴な算術で出る。
 * 早いほうが接頭辞を断つ。
 */
function prefixLength(scene: CommitScene): number {
  const lapsed = scene.accepted.findIndex((slice) =>
    slice.placements.some((placement) => placement.startAt < scene.now),
  );
  return Math.min(scene.staleAt, lapsed === -1 ? scene.accepted.length : lapsed);
}

/** 接頭辞の配置で進めた解放表（合成が尾部の初期状態に用いるはずの表）。 */
function releaseAfterPrefix(scene: CommitScene, prefix: readonly AcceptedSlice[]): SlotRelease {
  return prefix.reduce(
    (release, slice) => advanceRelease(release, slice.placements),
    initialRelease(scene.running, scene.now, scene.slotCount),
  );
}

/** 一片の同一性を配置の一致で見る（部分和は合成側が採点し直すため比較に含めない）。 */
const shapeOf = (slice: { readonly tableKey: string; readonly placements: unknown }) => ({
  tableKey: slice.tableKey,
  placements: slice.placements,
});

describe("engine/commit — committedSchedule", () => {
  // Feature: online-cook-scheduling, Property: 20 — 合成後の計画は feasible である
  // **Validates: Requirements 3.3, 6.2, 7.5**
  //
  // 採用接頭辞と自前解の尾部を切り貼りすると同一 slot の時間帯が重複しうる。尾部を接頭辞の解放表から
  // 再実行する実装が正しいことを、この property だけが検証する（接頭辞単体の feasibility は Property 7 の
  // 持ち場であり、自前解単体は Property 1 が見ている）。
  it("Property 20: ハード制約 (a) 重複なし (b) 同時本数 ≤ slot 数 (c) 解放時刻より前に開始しない", () => {
    fc.assert(
      fc.property(genCommitScene, (scene) => {
        const committed = committedSchedule(
          scene.accepted,
          scene.pending,
          scene.running,
          scene.now,
          DEFAULT_NOODLE_PRESETS,
          scene.params,
        );
        const placements = allPlacements(committed.slices);
        const release = initialRelease(scene.running, scene.now, scene.slotCount);

        expect(hasOverlapOnSameSlot(placements)).toBe(false);
        expect(exceedsSlotCount(placements, scene.slotCount)).toBe(false);
        expect(startsBeforeRelease(placements, release)).toBe(false);

        for (const placement of placements) {
          expect(placement.serveAt).toBeGreaterThan(placement.startAt);
        }
      }),
      { numRuns: 400 },
    );
  });

  // Feature: online-cook-scheduling, Property: 6 — 陳腐化した unit は Baseline で置き換わる
  // **Validates: Requirements 7.5**
  //
  // 陳腐化しない一片は計画順の接頭辞としてそのまま維持され、最初に陳腐化した一片以降は、接頭辞が
  // 使わなかった計画対象に対する Baseline_Plan で埋まる。期待値は接頭辞の解放表から baselineSchedule を
  // 呼んで独立に組む（initialRelease / advanceRelease は Property 1 の側で検証済みの部品である）。
  it("Property 6: 接頭辞は維持され、それ以降は Baseline_Plan で埋まる", () => {
    fc.assert(
      fc.property(genCommitScene, (scene) => {
        const committed = committedSchedule(
          scene.accepted,
          scene.pending,
          scene.running,
          scene.now,
          DEFAULT_NOODLE_PRESETS,
          scene.params,
        );

        const prefix = scene.accepted.slice(0, prefixLength(scene));
        const placed = allPlacements(prefix);
        const remaining = scene.pending.filter(
          (order) =>
            !placed.some(
              (placement) =>
                placement.externalOrderId === order.externalOrderId && placement.itemIndex === order.itemIndex,
            ),
        );
        const tail = baselineSchedule(
          remaining,
          releaseAfterPrefix(scene, prefix),
          DEFAULT_NOODLE_PRESETS,
          scene.params,
        );

        expect(committed.slices.map(shapeOf)).toEqual([...prefix, ...tail.slices].map(shapeOf));
      }),
      { numRuns: 400 },
    );
  });
});
