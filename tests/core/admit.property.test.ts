// tests/core/admit.property.test.ts — 受け入れゲート admit（src/engine/admit.ts）の property test。
//
// 対象は online-cook-scheduling の Property 4（確定計画は単調に改善する）・Property 5（同値の外部計画は
// 棄却される）・Property 7（接頭辞採用の feasibility は自己完結する）。純粋関数ゆえ既定 pool で走る。
//
// **生成器が「改善する外部計画」を作れることが、この 3 つの property の生命線である。** 一度も採用が
// 起きない場面ばかりだと `admit` が常に空を返し、3 つとも空虚に通ってしまう。外部ソルバーを持たずに
// 改善する計画（feasible かつ現行より真に良い計画）を作る手は 3 つあり、すべてを使う。
//
//   1. **別のパラメータで組んだ自前解。** 同じ解放表の上で feasible でありながら、slot 選択と提供時刻の
//      揃え方が現在のパラメータの自前解と食い違う（commit.property.test.ts が採ったのと同じ手）。
//   2. **Table_Group を 1 つ落として組んだ自前解**（`externalPlan`）。落とした group が釜を取らないので、
//      残りの group はより早い時刻へ入る——**現行 Committed_Plan の対応部分和より真に良い一片**が
//      確実に生まれる。同時にこれは段 2 が効く場面も作る：落とした group は尾部で後ろへ倒れるため、
//      部分和が改善しても合成後の総和が悪化する経路を踏む。
//   3. **茹で時間の短い順に組んだ自前解**（`shortestFirstPlan`）。最短処理時間優先は自前解（到着順）が
//      到達しない解であり、**合成後の総和まで真に良い**——すなわち段 2 を通る計画が得られる。
//
// **3 を欠くと採用がほとんど起きない。** 2 だけで組んだ生成器の実測は 200 場面中 5 件であった（段 2 が
// 大半を棄却する）。とくに Property 5 は「到着列を先に流してから同値を投げる」設計ゆえ、採用が起きない
// 場面では Committed_Plan と Baseline_Plan が一致し、比較基準の取り違えを検出できない。3 を混ぜ、
// 釜が少ない場面へ重みを置き、注文数を釜数より多く寄せた結果、採用は 200 場面中 91 件になった
// （末尾の番犬がこの下限を守る）。
//
// **到着列は 3 と 2 を必ずこの順に含む。** 3（総和まで改善する計画）が採用された後に 2（部分和だけを
// 改善して総和を悪化させる計画）が届く並びが、Property 4 の急所である。どちらか一方だけを振る形では
// この並びが場面集合に入らず、段 2 の比較基準を Baseline_Plan に取り違えた実装が 300 回の試行を
// すり抜けることがあった（実測：一方だけの形では 3 回に 1 回検出できなかった）。
//
// Property 4 は**到着列に対する主張**である。1 回の `admit` ではなく、複数回の受領を順に適用して
// 「E1 を採用した後に、E1 より劣る E2 が届いても確定計画が悪化しない」を見る（以前の requirements
// レビューが見つけた退行の形がこれである）。ゆえに到着列は同じ素材から作った複数の候補が順に届く。
//
// **採用されてはならない計画も 2 通り混ぜる**（Property 7 の急所）。どちらも改善判定を素通りしながら
// ハード制約を破る計画であり、段 1 の検査だけがこれを止める。
//
//   - **前へずらした計画**（`shifted` の負方向）。待ちが縮むので真に良いが、解放表より前に始まる。
//   - **2 本の計画を一片ごとに継ぎ合わせた計画**（`spliced`）。一片ごとには解放時刻を侵さないが、
//     束ねると同一 slot を二重に予約しうる。
//
// 到着時刻は now = NOW に固定する。now を進めると外部計画の開始時刻が過去になり（計画は NOW の解放表の
// 上で組まれている）ハード制約 (c) が全部を落とす——採用が一度も起きない場面ばかりになり、上記の空虚が
// そのまま起きる。時間の経過による陳腐化は committedSchedule 側の関心事であり Property 6 の持ち場である。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { admit } from "../../src/engine/admit";
import { committedSchedule } from "../../src/engine/commit";
import { initialRelease, type AcceptedSlice, type CookSchedule } from "../../src/engine/schedule";
import { scoreSchedule, type ScheduleParams } from "../../src/engine/objective";
import { tableMembers } from "../../src/engine/project";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
} from "../../src/domain/store";
import {
  KNOWN_NOODLE_TYPES,
  NOW,
  allPlacements,
  exceedsSlotCount,
  externalPlan,
  genOrderSpec,
  genParams,
  genRunning,
  hasOverlapOnSameSlot,
  shortestFirstPlan,
  startsBeforeRelease,
  timerOn,
  toPending,
} from "./scheduleScenes";

/** ゲートの場面。admit の 7 引数と、検査に要る slot 数・外部計画の到着列が揃う。 */
interface AdmitScene {
  readonly pending: readonly PendingOrder[];
  readonly running: readonly Timer[];
  readonly now: EpochMillis;
  readonly slotCount: number;
  readonly params: ScheduleParams;
  /** 外部から順に届く計画（2〜12 本）。 */
  readonly arrivals: readonly CookSchedule[];
}

const genAdmitScene: fc.Arbitrary<AdmitScene> = fc
  .oneof(
    // 釜が少ない場面へ寄せる（釜が余っていれば全品目が並列に入り、順序が総和に効かない＝改善する計画が
    // 存在しない）。全域も残す——ユニット数が判定に効かないことは他の property の持ち場である。
    { arbitrary: fc.constant(UNIT_COUNT_MIN), weight: 3 },
    { arbitrary: fc.integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX }), weight: 1 },
  )
  .chain((unitCount) => {
    const slotCount = unitCount * SLOTS_PER_UNIT;
    return fc.record({
      slotCount: fc.constant(slotCount),
      params: genParams(unitCount),
      // 開始済み Timer は釜を塞ぐ。計画対象が釜を取り合う場面（改善の余地がある場面）を作る主要な手ゆえ
      // 1 本以上を必ず置く。
      running: fc.array(genRunning(slotCount), { minLength: 1, maxLength: 5 }),
      // 品目数が釜数を超える場面を多く踏む（順序が総和に効かなければ改善する計画は存在しない）。
      // 注文は 3〜8 件・品目は 1〜4 件ゆえ計画対象は 64 件を超えない（上限の境界は Property 15 の持ち場）。
      orders: fc.array(genOrderSpec(KNOWN_NOODLE_TYPES), { minLength: 3, maxLength: 8 }),
      // 1 組の到着列を組む素。別パラメータで組んだ計画を 2 通り（茹で時間の短い順・Table_Group を 1 つ
      // 落とす）流し、そこから派生させた版を足す。
      seeds: fc.array(
        fc.record({
          params: genParams(unitCount),
          /**
           * 派生版（ずらした計画・継ぎ接ぎ）の素にどちらを採るか。**茹で時間の短い順**は段 2 まで通る
           * 改善を生み、**Table_Group を 1 つ落とす**手は部分和だけが改善して段 2 で落ちる計画を生む。
           */
          shortestFirst: fc.boolean(),
          /** 落とす Table_Group の位置（自前解の一片数で割った剰余。一片数と等しいなら落とさない）。 */
          dropPick: fc.nat({ max: 12 }),
          /** 同じ計画を丸ごと後ろへずらした版を、この遅延（ミリ秒）で追加する（Property 4 の急所）。 */
          delays: fc.array(fc.constantFrom(1_000, 5_000, 60_000), { maxLength: 2 }),
          /** 同じ計画を丸ごと前へずらした版を、この前倒し量（ミリ秒）で追加する（Property 7 の急所）。 */
          hastens: fc.array(fc.constantFrom(1_000, 60_000), { maxLength: 1 }),
          /** もう 1 通りの作り方で組んだ計画と一片ごとに継ぎ合わせた版を追加するか（Property 7 の急所）。 */
          splice: fc.boolean(),
        }),
        { minLength: 1, maxLength: 2 },
      ),
    });
  })
  .map(({ slotCount, params, running: runningSpecs, orders, seeds }) => {
    const running = runningSpecs.map(timerOn);
    const pending = toPending(orders);
    // 各 seed の到着列は「総和まで改善する計画 → 部分和だけ改善する計画 → 派生版」の順（順序が主張の
    // 一部である・上記の Property 4 の急所）。
    const arrivals = seeds.flatMap((seed) => {
      const shortest = shortestFirstPlan(pending, running, slotCount, seed.params);
      const dropped = externalPlan(pending, running, slotCount, seed.params, seed.dropPick);
      const plan = seed.shortestFirst ? shortest : dropped;
      const other = seed.shortestFirst ? dropped : shortest;
      return [
        // 継ぎ接ぎは列の先頭に置く。後ろへ回すと、先に採用された良い計画が改善判定の壁になって
        // 継ぎ接ぎの一片が (d) で落ち、二重予約が段 1 に届かない。
        ...(seed.splice ? [spliced(plan, other)] : []),
        shortest,
        dropped,
        ...seed.delays.map((delay) => shifted(plan, delay)),
        ...seed.hastens.map((hasten) => shifted(plan, -hasten)),
      ];
    });
    return { pending, running, now: NOW, slotCount, params, arrivals };
  });

/**
 * 計画を丸ごと時間軸上でずらす。ずらす向きで別々の急所を生成器に載せる（`serveAt − startAt` は
 * どちらの向きでも不変ゆえ、茹で時間の検査は通る）。
 *
 * **後ろへ（正）— Property 4 の急所。** 遅らせた計画は元の計画より真に劣るが、Baseline_Plan より良い
 * ままでありうる。ゆえに「E1 を採用した後に、E1 より劣る E2 が届く」場面が必ず場面集合に入り、比較基準を
 * Baseline_Plan に取り違えた実装ではそれが採用されて確定計画が悪化する（以前の requirements レビューが
 * 見つけた退行の形そのもの）。feasibility は保つ——開始時刻は解放時刻より後ろへ動くだけである。
 *
 * **前へ（負）— Property 7 の急所。** 前倒しした計画は待ちが縮むので**真に良い**（改善判定と段 2 を
 * 素通りする）一方、解放表より前に始まるのでハード制約 (c) を破る。これを止めるのは段 1 が解放時刻と
 * 開始時刻を比べる検査ただ一つであり、その検査を欠いた実装は「実行不能だが総和は小さい」計画を採用する。
 *
 * score は元の値のまま残す（外部が主張する値は engine の判定に用いられない——engine 自身の採点が
 * 唯一の権威であることを、嘘の score を載せた計画を流すことで踏む）。
 */
function shifted(plan: CookSchedule, millis: number): CookSchedule {
  return {
    ...plan,
    slices: plan.slices.map((slice) => ({
      ...slice,
      placements: slice.placements.map((placement) => ({
        ...placement,
        startAt: (placement.startAt + millis) as EpochMillis,
        serveAt: (placement.serveAt + millis) as EpochMillis,
      })),
    })),
  };
}

/**
 * 2 本の計画を一片ごとに交互に継ぎ合わせた計画。**一片ごとには feasible でありながら、束ねると同一 slot を
 * 二重に予約しうる計画**を作る手である（外部ソルバーが別々の探索結果を継ぎ接いで送ってくる形）。
 *
 * 両者は同じ解放表の上で組まれているため、どの一片も単体では解放時刻を侵さない。ゆえにこれが落ちるのは
 * 段 1 が**採った一片の占有で解放表を進める**からであって、一片ごとの検査からは出ない。
 *
 * 一片は tableKey で引き当てるので、同じ Table_Group が二度現れることはない（重複は別の理由で棄却される
 * ため、ここで混ぜると何を見ているのか分からなくなる）。score は継ぎ合わせる前の値のまま残す
 * （外部が主張する値は engine の判定に用いられない）。
 */
function spliced(first: CookSchedule, second: CookSchedule): CookSchedule {
  const bySecond = new Map(second.slices.map((slice) => [slice.tableKey, slice]));
  return {
    ...first,
    slices: first.slices.map((slice, index) =>
      index % 2 === 0 ? slice : (bySecond.get(slice.tableKey) ?? slice),
    ),
  };
}

/** 現在の採用済み計画から確定計画を導く（admit の比較基準そのもの）。 */
/** 比較の時点の採点（計画は点数を持たない・卓の成員表は場面の走行中から引く）。 */
function scoreOf(scene: AdmitScene, schedule: CookSchedule): number {
  return scoreSchedule(schedule.slices, scene.pending, tableMembers(scene.running), scene.params)
    .total;
}

function committedOf(scene: AdmitScene, accepted: readonly AcceptedSlice[]): CookSchedule {
  return committedSchedule(
    accepted,
    scene.pending,
    scene.running,
    scene.now,
    DEFAULT_NOODLE_PRESETS,
    scene.params,
  );
}

/** 1 本の外部計画をゲートへ通す。採用があれば採用済み計画は返された接頭辞へ置き換わる。 */
function receive(
  scene: AdmitScene,
  accepted: readonly AcceptedSlice[],
  arrived: CookSchedule,
): { readonly accepted: readonly AcceptedSlice[]; readonly admitted: readonly AcceptedSlice[] } {
  const admitted = admit(
    arrived,
    committedOf(scene, accepted),
    scene.pending,
    scene.running,
    scene.now,
    DEFAULT_NOODLE_PRESETS,
    scene.params,
  );
  return { accepted: admitted.length > 0 ? admitted : accepted, admitted };
}

/** 到着列を順に流して、どこかで採用が起きるか（番犬が数える場面の定義）。 */
function admitsSomewhere(scene: AdmitScene): boolean {
  let accepted: readonly AcceptedSlice[] = [];
  return scene.arrivals.some((arrived) => {
    const received = receive(scene, accepted, arrived);
    accepted = received.accepted;
    return received.admitted.length > 0;
  });
}

describe("engine/admit — Acceptance_Gate", () => {
  // Feature: online-cook-scheduling, Property: 4 — 確定計画は単調に改善する
  // **Validates: Requirements 6.2**
  //
  // 到着列を順に適用し、各受領の前後で合成後の総和が悪化しないことを見る。unit 単位の (d) 判定だけでは
  // これは出ない——各一片の部分和が改善しても、その接頭辞を前提に再実行した尾部が悪化しうる。担保するのは
  // 段 2 の全体判定であり、比較基準が現行 Committed_Plan であることがその要である。
  it("Property 4: 外部計画の到着列を通しても合成後の総和は悪化しない", () => {
    fc.assert(
      fc.property(genAdmitScene, (scene) => {
        let accepted: readonly AcceptedSlice[] = [];
        for (const arrived of scene.arrivals) {
          const before = scoreOf(scene, committedOf(scene, accepted));
          accepted = receive(scene, accepted, arrived).accepted;
          expect(scoreOf(scene, committedOf(scene, accepted))).toBeLessThanOrEqual(before);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property: 5 — 同値の外部計画は棄却される
  // **Validates: Requirements 6.2, 6.6**
  //
  // 現行 Committed_Plan をそのまま外部計画として渡す（同値な計画の最も直截な作り方）。同値は棄却ゆえ
  // 採用列は空で、後続の settle が Persist も Broadcast も出さない状態になる。
  //
  // **到着列を先に流してから見る。** 採用済み計画を持たない状態でだけ見ると Committed_Plan が自前解と
  // 一致し、比較基準を Baseline_Plan に取り違えた実装でも通ってしまう（両者が同じ値だから）。
  // 採用が起きた後は Committed_Plan と Baseline_Plan が恒常的に食い違い、取り違えがここで露わになる。
  it("Property 5: Committed_Plan と同値の外部計画は空の採用列を返す", () => {
    fc.assert(
      fc.property(genAdmitScene, (scene) => {
        let accepted: readonly AcceptedSlice[] = [];
        for (const arrived of scene.arrivals) accepted = receive(scene, accepted, arrived).accepted;

        const committed = committedOf(scene, accepted);
        expect(receive(scene, accepted, committed).admitted).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property: 7 — 接頭辞採用の feasibility は自己完結する
  // **Validates: Requirements 6.2, 6.3**
  //
  // 採用された接頭辞は、それだけを開始済み Timer の解放表へ適用してハード制約を満たす——後方の一片が
  // 採られたかどうかに依存しない。段 1 が解放表を一片ごとに進めながら判定することの帰結である。
  // （合成後の計画が feasible であることは別の主張で、Property 20 が commit 側で見ている。）
  //
  // **主張に歯を与えるのは、到着列に混ぜた 2 通りの「採用されてはならない計画」である。** 改善する計画は
  // どれも自前解から組むため元より feasible で、それだけを流してもこの主張は空虚に通る。前へずらした計画は
  // 解放時刻より前に始まり、継ぎ接ぎは同一 slot を二重に予約する——どちらも改善判定を素通りするので、
  // 止めるのは段 1 の検査だけである。
  it("Property 7: 採用された接頭辞は単体でハード制約を満たす", () => {
    fc.assert(
      fc.property(genAdmitScene, (scene) => {
        const release = initialRelease(scene.running, scene.now, scene.slotCount);
        let accepted: readonly AcceptedSlice[] = [];
        for (const arrived of scene.arrivals) {
          const received = receive(scene, accepted, arrived);
          accepted = received.accepted;

          const placements = allPlacements(received.admitted);
          expect(hasOverlapOnSameSlot(placements)).toBe(false);
          expect(exceedsSlotCount(placements, scene.slotCount)).toBe(false);
          expect(startsBeforeRelease(placements, release)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  // 生成器が採用の起きる場面を含むことの確認。含まなければ上の 3 本は「`admit` が常に空を返す」ことだけを
  // 見ていることになり、Property 4 の単調性（採用後の確定計画）も Property 5 の比較基準（採用後に
  // Committed_Plan と Baseline_Plan が食い違う状態）も通らない。
  it("生成器は採用が起きる場面（到着列のどこかで採用される場面）を含む", () => {
    const scenes = fc.sample(genAdmitScene, { numRuns: 200, seed: 20_260_626 });
    const accepted = scenes.filter((scene) => admitsSomewhere(scene));

    // 固定 seed の実測は 200 場面中 91 件（強化前の生成器は 5 件だった）。下限は余裕を持って置く。
    expect(accepted.length).toBeGreaterThanOrEqual(40);
  });
});
