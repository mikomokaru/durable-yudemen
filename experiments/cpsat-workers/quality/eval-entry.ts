// experiments/cpsat-workers/quality/eval-entry.ts — 7-B の局面作りと比較を行う workerd 側の入口。
//
// **取り込みの変換を持たない。** payload → OrderItem の翻訳は DO の `receiveRecords`（本番経路）
// だけが行い、ここはそれを RPC で呼ぶ。局面（PlanRequest）は DO が自分で組んで SOLVER へ送る
// ものを Node 側で捕まえるので、計画対象の選択規則（R2.3・PLAN_TARGET_LIMIT）も本番のままである。
//
// 比較で使う関数はすべて engine の正本である（`committedSchedule` / `scoreSchedule`）。計画器ごとに
// 別の採点を書かない（評価計画 §4.2）。
import { planCpsat } from "../../../src/cpsat/plan";
import { CPSAT_DELIVERY_LEAD_MS, cpsatTargets } from "../../../src/cpsat/request";
import {
  advanceRelease,
  cannotStart,
  feasibleRelease,
  initialRelease,
  isStale,
  keepsAnchor,
  placeableTargets,
} from "../../../src/engine/schedule";
import { liftsOf, withinLiftCap } from "../../../src/engine/lift";
import { boilMillisOf } from "../../../src/engine/boil";
import { occupiedSlotsOf } from "../../../src/domain/store";
import { admitDetailed } from "../../../src/engine/admit";
import { committedSchedule } from "../../../src/engine/commit";
import { scoreSchedule, type ScheduleParams } from "../../../src/engine/objective";
import { initialLifts } from "../../../src/engine/lift";
import { tableMembers } from "../../../src/engine/project";
import { itemKeyOf, pendingOrders, type OrderItem } from "../../../src/domain/order";
import type { CookSchedule, PlanSlice } from "../../../src/engine/schedule";
import type { Timer } from "../../../src/engine/timer";
import type { ShownPlan } from "../../../src/engine/stability";
import type { NoodlePreset } from "../../../src/domain/store";
import { toRecordOutcome } from "../../../src/ingress/outcome";
import { billWait } from "./bill-wait";
import { schedulingDefaults } from "../../../tests/storeConfigDefaults";

interface EvalEnv {
  readonly STORE_TIMER_DO: DurableObjectNamespace;
}

/** 1 ユニット 6 スロット（domain/store.ts の SLOTS_PER_UNIT）。 */
const SLOTS_PER_UNIT = 6;

/**
 * 採点の内訳。`scoreSchedule` は総和と部分和しか返さないので、**係数を 1 つずつ 0 に置いた
 * 総和との差**で項を取り出す。各項は自分の係数に対して線形なので、この差は厳密にその項である。
 *
 * 再実装しないのが要点である（評価計画 §4.2）。項の定義を書き写せば、engine が式を変えた
 * ときに黙ってずれる。
 */
function breakdown(
  slices: readonly PlanSlice[],
  live: readonly OrderItem[],
  running: readonly Timer[],
  now: number,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
  shown: ShownPlan,
) {
  const members = tableMembers(running);
  const lifts = initialLifts(running);
  const withChange = {
    members,
    lifts,
    change: { shown, running, now: now as never, pending: live, presets },
  };
  const withoutChange = { members, lifts, change: null };
  const total = scoreSchedule(slices, live, withChange, params).total;
  const business = scoreSchedule(slices, live, withoutChange, params).total;
  const zeroed = (patch: Partial<ScheduleParams>) =>
    scoreSchedule(slices, live, withoutChange, { ...params, ...patch }).total;
  const orderSync = business - zeroed({ orderSyncWeight: 0 });
  const tableLag = business - zeroed({ tableSyncWeight: 0 });
  const affinity = business - zeroed({ affinityWeight: 0 });
  // arms を十分大きくすれば Lift_Overflow は 0 になる。他の項は arms を読まない。
  const liftOverflow = business - zeroed({ arms: 10_000 });
  return {
    total,
    businessCost: business,
    changeCost: total - business,
    waitTime: business - orderSync - tableLag - affinity - liftOverflow,
    tableLag,
    orderSync,
    affinity,
    liftOverflow,
    placements: slices.reduce((count, slice) => count + slice.placements.length, 0),
    slices: slices.length,
  };
}

export default {
  async fetch(request: Request, env: EvalEnv): Promise<Response> {
    const url = new URL(request.url);
    const body = (await request.json()) as Record<string, never>;

    if (url.pathname === "/scene") {
      const { storeId, store, records } = body as unknown as {
        storeId: string;
        store: {
          unitCount: number;
          noodlePresets: unknown;
          firmnessCodes: unknown;
          menuItems: unknown;
        };
        records: unknown[];
      };
      const config = {
        unitCount: store.unitCount,
        ...schedulingDefaults(store.unitCount),
        noodlePresets: store.noodlePresets,
        firmnessCodes: store.firmnessCodes,
        menuItems: store.menuItems,
      };
      const stub = env.STORE_TIMER_DO.get(env.STORE_TIMER_DO.idFromName(storeId)) as unknown as {
        applyProjection(projection: unknown): Promise<unknown>;
        receiveRecords(records: unknown): Promise<unknown>;
      };
      await stub.applyProjection({ config, roster: [], active: true, version: 1 });
      // 生値 → Arrival_Record の分類は本番と同じ `toRecordOutcome` を通す（Worker の
      // `classifyRecords` が 1 件ずつ呼んでいるのと同じ関門）。宛先解決だけは置き換える
      // ——局面ごとに新しい DO を使うためで、翻訳には一切関わらない。
      const now = Date.now();
      const outcomes = (records as unknown[]).map((raw) => toRecordOutcome(raw, now));
      const deliverable = outcomes.flatMap((outcome) =>
        outcome.kind === "order" ? [outcome.record] : [],
      );
      const classified: Record<string, number> = {};
      for (const outcome of outcomes)
        classified[outcome.kind] = (classified[outcome.kind] ?? 0) + 1;
      const outcome = await stub.receiveRecords(deliverable);
      return Response.json({ ok: true, outcome, classified, delivered: deliverable.length });
    }

    if (url.pathname === "/compare") {
      const { request: planRequest, unitCount } = body as unknown as {
        request: {
          pending: OrderItem[];
          running: Timer[];
          params: ScheduleParams;
          noodlePresets: NoodlePreset[];
          shownPlan: ShownPlan;
        };
        unitCount: number;
      };
      /**
       * **局面の「今」。** 与えられればそれを使う（`nowMs`・2026-09-16）。
       *
       * `Date.now()` のままだと、絶対時刻の位相で `Math.ceil(now / 1000)` の丸めが変わり、
       * **同じコードでも実行のたびに解が変わる**。`cpsat-head-slot-stability` の判定が
       * 単独実行と全体試験で食い違ったのはこれが原因だった。比較を主張する試験は固定して呼ぶ。
       */
      const now = (body as unknown as { nowMs?: number }).nowMs ?? Date.now();
      const { noodlePresets: presets, shownPlan } = planRequest;
      // `/compare` にも走行中の注入の摘みを持たせる（`/sweep` と同じ入口から読む）。
      // **宣言が無いまま参照していた**——`/sweep` 側の宣言に依存していたわけではなく、
      // この分岐を使うと実行時に落ちる形だった（2026-09-15 に `/sweep` を直して露出した）。
      const injectRunning = (body as unknown as { injectRunning?: number }).injectRunning ?? 0;
      const crowdRunning = (body as unknown as { crowdRunning?: boolean }).crowdRunning === true;
      const runningEndsInMs =
        (body as unknown as { runningEndsInMs?: number }).runningEndsInMs ?? null;
      const runningSameSlot =
        (body as unknown as { runningSameSlot?: boolean }).runningSameSlot === true;
      // 走行中 Timer を作る。待ち行列の先頭から取り、釜を順に占める。
      // 基準は局面の「今」に揃える——別に `Date.now()` を引くと、固定したはずの局面がずれる。
      const now0 = now;
      const injected: Timer[] = Array.from({ length: injectRunning }, (_, index) => {
        const item = planRequest.pending[index];
        // 上げ時刻。`crowdRunning` なら全て同じ窓（45 秒）の内側へ寄せる。
        // `runningEndsInMs` を与えると全員をその残り時間で作る（lead の窓の内側を踏むため）。
        const endsIn =
          runningEndsInMs !== null
            ? runningEndsInMs
            : crowdRunning
              ? 10_000 + index * 1_000
              : 10_000 + index * 120_000;
        return {
          id: `injected-${index}`,
          // **釜の番号は必ず実在する範囲へ畳む（2026-09-14 修正）。**
          // 以前は `index` をそのまま釜番号にしていたので、釜 12 本の店に 14 本注入すると
          // **存在しない釜 12・13** を指すタイマーができ、モデルが `INFEASIBLE` になっていた。
          // それを「釜の数を超えると解けない」と読み違えた——本番の client は実在する釜しか
          // 出さないので、あの状態は起こり得ない。**重複を試したいなら番号を巡回させる。**
          slotIds: [String(runningSameSlot ? 0 : index % (unitCount * SLOTS_PER_UNIT))],
          noodleType: item?.noodleType ?? "REG",
          firmness: "normal",
          startTime: now0 - 60_000,
          endTime: now0 + endsIn,
          adjustment: 0,
          boiledAt: null,
          completedAt: null,
          seq: index,
          orderItem:
            item === undefined
              ? undefined
              : {
                  externalOrderId: item.externalOrderId,
                  itemIndex: item.itemIndex,
                  tableId: item.tableId,
                },
        } as unknown as Timer;
      });
      const running = injectRunning > 0 ? injected : planRequest.running;
      // **CP-SAT モードの規則で採否と合成を見る**（R1.4・R5.4）。本番の `PLANNER_BACKEND` と同じ。
      const params = { ...planRequest.params, planner: "cpsat" as const };
      const tsParams = { ...planRequest.params, planner: "ts" as const };
      const live = pendingOrders(planRequest.pending, running, now as never);
      const change = { shown: shownPlan, running, now: now as never, pending: live, presets };

      // TS 側は engine の自前解そのもの（採用済み接頭辞なし）。DO が確定させている計画と同じ構成である。
      const tsWhole = committedSchedule([], live, running, now as never, presets, tsParams, change);

      let cpsat: {
        schedule: CookSchedule;
        status: string;
        variables: number;
        memoryBytes: number;
        objective: number | null;
      } | null = null;
      let failure: string | null = null;
      try {
        cpsat = await planCpsat(
          {
            ...planRequest,
            planner: "cpsat",
            storeId: "replay",
            requestId: "replay",
            inputKey: "",
          } as never,
          now,
        );
      } catch (error) {
        failure = String(error);
      }

      const slotCount = unitCount * SLOTS_PER_UNIT;
      const targets = cpsatTargets(live, presets, slotCount, now, params);
      const tsHead = committedSchedule(
        [],
        targets,
        running,
        now as never,
        presets,
        tsParams,
        change,
      );

      // 合成の結果に CP-SAT の配置がいくつ残ったか。**段 A の値が TS と同じになる局面は、
      // 接頭辞が丸ごと落ちた（陳腐化・feasibility・開始妨害）ことを意味する。** 数えずに
      // 同値を「差が無い」と読めば、落ちていることに気づけない。
      const composedCpsat =
        cpsat === null
          ? null
          : committedSchedule(
              cpsat.schedule.slices,
              live,
              running,
              now as never,
              presets,
              params,
              change,
            );
      const placementKey = (slices: readonly PlanSlice[]) =>
        new Map(
          slices.flatMap((slice) =>
            slice.placements.map((placement) => [
              `${placement.externalOrderId}#${placement.itemIndex}`,
              `${[...placement.slotIds].join(",")}@${placement.startAt}`,
            ]),
          ),
        );
      const proposed = cpsat === null ? new Map() : placementKey(cpsat.schedule.slices);
      const composedKeys = composedCpsat === null ? new Map() : placementKey(composedCpsat.slices);
      let kept = 0;
      for (const [key, value] of proposed) if (composedKeys.get(key) === value) kept += 1;

      return Response.json({
        ok: true,
        now,
        cpsatProposed: proposed.size,
        cpsatKeptInComposed: kept,
        pendingCount: planRequest.pending.length,
        liveCount: live.length,
        runningCount: running.length,
        targetCount: targets.length,
        shownPlanCount: shownPlan.length,
        failure,
        status: cpsat?.status ?? null,
        variables: cpsat?.variables ?? null,
        reportedObjective: cpsat?.objective ?? null,
        // 段 A：画面に出る全体。CP-SAT の接頭辞に engine の尾部を合成した計画と、TS の全体。
        wholeTs: breakdown(tsWhole.slices, live, running, now, presets, params, shownPlan),
        wholeCpsat:
          composedCpsat === null
            ? null
            : breakdown(composedCpsat.slices, live, running, now, presets, params, shownPlan),
        // 段 B：先頭 6 件だけ。CP-SAT の解と、同じ 6 件に絞った TS の部分計画。
        headTs: breakdown(tsHead.slices, targets, running, now, presets, params, shownPlan),
        headCpsat:
          cpsat === null
            ? null
            : breakdown(cpsat.schedule.slices, targets, running, now, presets, params, shownPlan),
      });
    }
    if (url.pathname === "/sweep") {
      // 対象上限の掃引。**同じ局面**に対して上限だけを変え、費用と採否の両方を見る。
      // 上限を上げる理由は速さではなく「`isStale` の完全被覆を満たせるようにする」ことなので、
      // 遅くなる量だけを測っても判断できない——採用されるようになるかを同時に見る。
      const {
        request: planRequest,
        unitCount,
        limits,
      } = body as unknown as {
        request: {
          pending: OrderItem[];
          running: Timer[];
          params: ScheduleParams;
          noodlePresets: NoodlePreset[];
          shownPlan: ShownPlan;
        };
        unitCount: number;
        limits: number[];
        /** 防壁（変数 8192・制約＋区間 40000）を外して素の劣化を見るか。掃引専用。 */
        unguarded?: boolean;
      };
      const unguarded = (body as unknown as { unguarded?: boolean }).unguarded === true;
      /** 旧形（上げ窓の上限を値段で持つ）で測るか。既定は新しい形（ハード）。 */
      const legacyLiftCap = (body as unknown as { legacyLiftCap?: boolean }).legacyLiftCap === true;
      /** 探索予算（決定的時間）。null は既定の式のまま。掃引専用。 */
      const budgetCap = (body as unknown as { budgetCap?: number | null }).budgetCap ?? null;
      /** 釜の在否を旧い形（`eq` 経由）で組むか。既定は新しい形（bool 1 個）。 */
      const fatSlots = (body as unknown as { fatSlots?: boolean }).fatSlots === true;
      /** 対の項を旧い形（全組）で組むか。既定は新しい形（E4 は広がり・E7 は隣接）。 */
      const fatPairs = (body as unknown as { fatPairs?: boolean }).fatPairs === true;
      /** クラスタ数の上限（掃引専用）。null は制限なし。 */
      const clusterCap = (body as unknown as { clusterCap?: number | null }).clusterCap ?? null;
      /** hint を固定して解き、実行可能であることを確かめるか（検査専用）。 */
      const checkHints = (body as unknown as { checkHints?: boolean }).checkHints === true;
      /**
       * 走行中 Timer を注入する（本数）。**コーパスは開始・完了の履歴を持たないので `running` が
       * 常に空で、操作されている店舗の局面を一度も踏めていない**（1108 の求解失敗 61% はそこで出た）。
       */
      const injectRunning = (body as unknown as { injectRunning?: number }).injectRunning ?? 0;
      /**
       * **受領までの遅れ（ミリ秒）。** 本番では計画を組んだ時刻と DO が受け取る時刻がずれる
       * （Queue → 求解 → 復路で実測 2.1〜4.4 秒・2026-09-14）。掃引はこれまで同じ `now` で
       * 採否を見ていたため、**過去開始になった配置が feasibility で落ちる**局面を一度も踏めて
       * いなかった。0 は従来どおり（遅れなし）。
       */
      const deliverDelayMs = (body as unknown as { deliverDelayMs?: number }).deliverDelayMs ?? 0;
      /** 注入する走行中の残り時間（ミリ秒）。lead の窓の内側で上がる局面を作るために要る。 */
      const runningEndsInMs =
        (body as unknown as { runningEndsInMs?: number }).runningEndsInMs ?? null;
      /** 注入した走行中を全部同じ釜に載せる（占有の衝突を作る）。 */
      const runningSameSlot =
        (body as unknown as { runningSameSlot?: boolean }).runningSameSlot === true;
      /**
       * **連続局面の揺れを測る。** 1 度解いた結果を Shown_Plan として渡してもう一度解き、
       * 何杯が別の釜へ移ったかを数える。コーパスの局面は Shown_Plan が空なので、
       * これをしない限り `slotChangeCost` と hint の効きは**一度も測れない**（2026-09-13）。
       */
      const chainShown = (body as unknown as { chainShown?: boolean }).chainShown === true;
      /** 前回の釜を hint に使わない旧い形で測る（釜の揺れの**負の対照**）。 */
      const legacyHintSlots =
        (body as unknown as { legacyHintSlots?: boolean }).legacyHintSlots === true;
      /** **伝票ごとの待ちを目的にする試作**（手順 2）。
       * 名前は `billWaitObjective`——採点関数 `billWait` を隠すと、束ねたときに
       * 「関数ではない」で落ちる（2026-09-13 に踏んだ）。 */
      const billWaitObjective = (body as unknown as { billWait?: boolean }).billWait === true;
      /** 伝票の内側の広がりの重み（`billWait` のとき）。 */
      const billSpreadWeight =
        (body as unknown as { billSpreadWeight?: number }).billSpreadWeight ?? null;
      /**
       * **TS の解を出発点にする**（実験 1・2・2026-09-13）。
       *   `"hint"` — hint にして普通に解く（実験 2）
       *   `"fix"`  — hint を固定して解き、**TS の解をこの目的関数で採点する**（実験 1）
       */
      const tsSeed = (body as unknown as { tsSeed?: string }).tsSeed ?? null;
      /** **同じ伝票の杯を同じクラスタへ縛る**（構造で同時提供を作る）。 */
      const billCluster = (body as unknown as { billCluster?: boolean }).billCluster === true;
      /** **貪欲 hint を伝票単位で組む**（出発点から揃える）。 */
      const billHint = (body as unknown as { billHint?: boolean }).billHint === true;
      /** 連続 2 回の求解の間に走行中が何本増減するか（釜が埋まり気味の局面の再現）。 */
      const chainRunningDelta =
        (body as unknown as { chainRunningDelta?: number }).chainRunningDelta ?? 0;
      /** Head 近傍の釜を守る重みの倍率（掃引用）。 */
      const headFactor = (body as unknown as { headFactor?: number }).headFactor ?? null;
      /** 購入順の逆転の重み（掃引用）。既定は `defaults.json` の 20。 */
      const inversionCost = (body as unknown as { inversionCost?: number }).inversionCost ?? null;
      /** 貪欲 hint に注文順を守らせるか（既定 true・false は負の対照）。 */
      const unorderedHint = (body as unknown as { unorderedHint?: boolean }).unorderedHint === true;
      /** **hint を固定して解く**（hint 自体がモデルの制約を満たすかの検査）。 */
      const fixHints = (body as unknown as { fixHints?: boolean }).fixHints === true;
      /**
       * **固定解を完全 hint として戻して解き直す**（2026-09-15）。
       *
       * 1 度目は `fixHints` で固定して解く——返れば hint は完全な実行可能解に伸びており、
       * ソルバーは**全変数**の値を返す。2 度目はその解ベクトルをそのまま出発点として
       * 元のモデル（固定なし）へ渡す。普段の hint が置かない補助変数まで埋まるので、
       * 「実行可能な hint を渡しても解が見つからない」現象が探索の入口の問題かどうかが分かる。
       */
      const completeHint = (body as unknown as { completeHint?: boolean }).completeHint === true;
      /**
       * **hint を種別ごとに固定して二分する。** `fixHints` が `INFEASIBLE` を返す局面で、
       * `time`・`slot`・`cluster`・`bill`・`helper` を積み上げながら固定し、
       * **どこを足した時点で実行不能になるか**を見る（2026-09-15）。
       */
      const bisectHint = (body as unknown as { bisectHint?: boolean }).bisectHint === true;
      /**
       * **Head 近傍で動いた釜が「必要な変更」だったかを判定する（`holdHead`・2026-09-15）。**
       *
       * 2 度目の求解で Head 近傍の釜が動いた杯を見つけたら、**その杯の釜だけを前回の釜へ固定**
       * して解き直す（時刻も他の杯も自由）。結果の読み方は次のとおり。
       *
       * - `INFEASIBLE`：前回の釜を維持すると成立しない → **必要な変更**
       * - 解けて目的値が悪い：維持はできたが不利 → **利益を伴う変更**（ソフト制約として許す候補）
       * - 解けて目的値が同等以下：必要な取引ではない → **探索上の後退**
       * - `UNKNOWN`：**未判定**
       */
      const holdHead = (body as unknown as { holdHead?: boolean }).holdHead === true;
      /** 伝票を割ったときの費用。 */
      const billSplitCost = (body as unknown as { billSplitCost?: number }).billSplitCost ?? null;
      /** 注入した走行中の上がりを 1 つの上げ窓へ寄せる（固定分だけで上限を超える局面を作る）。 */
      const crowdRunning = (body as unknown as { crowdRunning?: boolean }).crowdRunning === true;
      /**
       * **局面の「今」。** 与えられればそれを使う（`nowMs`・2026-09-16）。
       *
       * `Date.now()` のままだと、絶対時刻の位相で `Math.ceil(now / 1000)` の丸めが変わり、
       * **同じコードでも実行のたびに解が変わる**。`cpsat-head-slot-stability` の判定が
       * 単独実行と全体試験で食い違ったのはこれが原因だった。比較を主張する試験は固定して呼ぶ。
       */
      const now = (body as unknown as { nowMs?: number }).nowMs ?? Date.now();
      const { noodlePresets: presets, shownPlan } = planRequest;
      // 走行中 Timer を作る。待ち行列の先頭から取り、釜を順に占める。
      // 基準は局面の「今」に揃える——別に `Date.now()` を引くと、固定したはずの局面がずれる。
      const now0 = now;
      // **増分ぶん余分に作る。** 2 度目の求解で走行中を増やすため（`chainRunningDelta`）。
      // ちょうど `injectRunning` 本しか作らないと、増やそうとしても空振りする（2026-09-15 に踏んだ）。
      const injected: Timer[] = Array.from(
        { length: injectRunning + Math.max(0, chainRunningDelta) },
        (_, index) => {
          const item = planRequest.pending[index];
          // 上げ時刻。`crowdRunning` なら全て同じ窓（45 秒）の内側へ寄せる。
          // `runningEndsInMs` を与えると全員をその残り時間で作る（lead の窓の内側を踏むため）。
          const endsIn =
            runningEndsInMs !== null
              ? runningEndsInMs
              : crowdRunning
                ? 10_000 + index * 1_000
                : 10_000 + index * 120_000;
          return {
            id: `injected-${index}`,
            // **釜の番号は必ず実在する範囲へ畳む（2026-09-14 修正）。**
            // 以前は `index` をそのまま釜番号にしていたので、釜 12 本の店に 14 本注入すると
            // **存在しない釜 12・13** を指すタイマーができ、モデルが `INFEASIBLE` になっていた。
            // それを「釜の数を超えると解けない」と読み違えた——本番の client は実在する釜しか
            // 出さないので、あの状態は起こり得ない。**重複を試したいなら番号を巡回させる。**
            slotIds: [String(runningSameSlot ? 0 : index % (unitCount * SLOTS_PER_UNIT))],
            noodleType: item?.noodleType ?? "REG",
            firmness: "normal",
            startTime: now0 - 60_000,
            endTime: now0 + endsIn,
            adjustment: 0,
            boiledAt: null,
            completedAt: null,
            seq: index,
            orderItem:
              item === undefined
                ? undefined
                : {
                    externalOrderId: item.externalOrderId,
                    itemIndex: item.itemIndex,
                    tableId: item.tableId,
                  },
          } as unknown as Timer;
        },
      );
      // 本体が使うのは `injectRunning` 本まで（増分は 2 度目の求解でだけ足す）。
      const running = injectRunning > 0 ? injected.slice(0, injectRunning) : planRequest.running;
      // **CP-SAT モードの規則で採否と合成を見る**（R1.4・R5.4）。本番の `PLANNER_BACKEND` と同じ。
      const params = { ...planRequest.params, planner: "cpsat" as const };
      const tsParams = { ...planRequest.params, planner: "ts" as const };
      const live = pendingOrders(planRequest.pending, running, now as never);
      const change = { shown: shownPlan, running, now: now as never, pending: live, presets };
      const slotCount = unitCount * SLOTS_PER_UNIT;
      const tsWhole = committedSchedule([], live, running, now as never, presets, tsParams, change);
      const tsScore = breakdown(tsWhole.slices, live, running, now, presets, params, shownPlan);

      const results = [];
      // **形は 1 箇所で組む。** 本体と hint 検査が別の形を使うと、検査が本体と違うモデルを見る
      // ——負の対照（クラスタ上限 1）が通ってしまい、試験に歯が無いことに気づいた（2026-09-13）。
      const shapeOf = (extra: Record<string, unknown> = {}) => ({
        ...(legacyLiftCap ? { hardLiftCap: false } : {}),
        ...(fatSlots ? { leanSlots: false } : {}),
        ...(fatPairs ? { leanPairs: false } : {}),
        ...(legacyHintSlots ? { rememberSlots: false } : {}),
        ...(billWaitObjective ? { billWait: true } : {}),
        ...(billCluster ? { billCluster: true } : {}),
        ...(billHint ? { billHint: true } : {}),
        ...(headFactor === null ? {} : { headSlotChangeFactor: headFactor }),
        ...(inversionCost === null ? {} : { purchaseInversionCost: inversionCost }),
        ...(unorderedHint ? { orderedHint: false } : {}),
        ...(billSplitCost === null ? {} : { billSplitCost }),
        ...(billSpreadWeight === null ? {} : { billSpreadWeight }),
        ...(clusterCap === null ? {} : { clusterCap }),
        ...(budgetCap === null ? {} : { budget: budgetCap }),
        ...extra,
      });
      for (const limit of limits) {
        const targets = cpsatTargets(live, presets, slotCount, now, params);
        // **TS の解を同じ対象で組む。** lead だけ先から置く（モデルが置ける最も早い時刻と揃える）。
        const seedFrom = (now + CPSAT_DELIVERY_LEAD_MS) as never;
        const seedTargets = cpsatTargets(live, presets, slotCount, now, params, limit);
        const seedPlanSchedule =
          tsSeed === null
            ? null
            : committedSchedule([], seedTargets, running, seedFrom, presets, tsParams, null);
        const seedPlan =
          seedPlanSchedule === null
            ? undefined
            : new Map(
                seedPlanSchedule.slices.flatMap((slice) =>
                  slice.placements.map((placement) => [
                    itemKeyOf(placement),
                    {
                      startAt: Number(placement.startAt),
                      serveAt: Number(placement.serveAt),
                      slotIds: placement.slotIds,
                    },
                  ]),
                ),
              );
        const started = Date.now();
        let cpsat = null;
        let failure: string | null = null;
        /** 完全 hint の 1 度目（固定解）の状態。戻せなかったときは `null` のまま。 */
        let pinnedStatus: string | null = null;
        let pinnedVector: readonly number[] | undefined;
        if (completeHint) {
          try {
            // oxlint-disable-next-line no-await-in-loop
            const pinned = await planCpsat(
              {
                ...planRequest,
                running,
                pending: planRequest.pending.slice(injectRunning),
                planner: "cpsat",
                storeId: "sweep",
                requestId: "sweep",
                inputKey: "",
              } as never,
              now,
              {
                targetLimit: limit,
                ...(unguarded ? { maxVariables: 1e9, maxConstraints: 1e9 } : {}),
                shape: shapeOf({ fixHints: true }),
                ...(seedPlan === undefined ? {} : { seedPlan }),
              },
            );
            pinnedStatus = pinned.status;
            pinnedVector = pinned.solutionVector;
          } catch (error) {
            pinnedStatus = `FAILED: ${String(error).slice(0, 4000)}`;
          }
        }
        /** hint の種別を積み上げて固定したときの状態（`bisectHint`）。 */
        let hintBisect: Record<string, string> | null = null;
        if (bisectHint && String(pinnedStatus).startsWith("FAILED")) {
          hintBisect = {};
          /**
           * **未着手の杯を 1 杯ずつ足す。** 走行中の時刻だけなら実行可能だと分かっているので、
           * どの杯を足した時点で実行不能になるかを見れば、破っている制約に手が届く。
           * 杯数ぶん解くので、固定解が失敗した局面でだけ回す。
           */
          const pendingKinds = Array.from(
            { length: targets.length },
            (_, index) => `timePending:${index}`,
          );
          const STEPS = [
            ["timeRunning"],
            ...pendingKinds.map((_, k) => ["timeRunning", ...pendingKinds.slice(0, k + 1)]),
          ];
          for (const sections of STEPS) {
            try {
              // oxlint-disable-next-line no-await-in-loop
              const partial = await planCpsat(
                {
                  ...planRequest,
                  running,
                  pending: planRequest.pending.slice(injectRunning),
                  planner: "cpsat",
                  storeId: "sweep",
                  requestId: "sweep",
                  inputKey: "",
                } as never,
                now,
                {
                  targetLimit: limit,
                  ...(unguarded ? { maxVariables: 1e9, maxConstraints: 1e9 } : {}),
                  shape: shapeOf({ fixHintSections: sections }),
                  ...(seedPlan === undefined ? {} : { seedPlan }),
                },
              );
              hintBisect[`pending<=${sections.length - 1}`] = partial.status;
            } catch (error) {
              hintBisect[`pending<=${sections.length - 1}`] =
                `FAILED: ${String(error).slice(0, 60)}`;
            }
            // 最初に壊れたところで止める——それより先は見なくてよい。
            if (String(hintBisect[`pending<=${sections.length - 1}`]).startsWith("FAILED")) break;
          }
        }
        try {
          // oxlint-disable-next-line no-await-in-loop
          cpsat = await planCpsat(
            {
              ...planRequest,
              running,
              pending: planRequest.pending.slice(injectRunning),
              planner: "cpsat",
              storeId: "sweep",
              requestId: "sweep",
              inputKey: "",
            } as never,
            now,
            // 防壁を外すときは、実行時が有界であることの根拠も外れる。掃引専用である。
            {
              targetLimit: limit,
              ...(unguarded ? { maxVariables: 1e9, maxConstraints: 1e9 } : {}),
              // 旧形（上げ窓の上限を値段で持つ）と並べて測れるようにする。既定は新しい形。
              shape: shapeOf(
                pinnedVector !== undefined
                  ? { completeHint: pinnedVector }
                  : tsSeed === "fix" || fixHints
                    ? { fixHints: true }
                    : {},
              ),
              ...(seedPlan === undefined ? {} : { seedPlan }),
            },
          );
        } catch (error) {
          failure = `${String(error)} :: ${String((error as Error)?.stack ?? "").slice(0, 400)}`;
        }
        const solveMs = Date.now() - started;
        if (cpsat === null) {
          // **hint が実行可能か。** 固定して解いて答えが返れば、hint はモデルの制約を満たしている。
          let hintFeasible: string | null = null;
          let hintPressure: unknown = null;
          if (checkHints) {
            try {
              // oxlint-disable-next-line no-await-in-loop
              const pinned = await planCpsat(
                {
                  ...planRequest,
                  // **本解と同じ局面で検査する（2026-09-15 修正）。** 注入した走行中と、
                  // それが消費した待ち行列を渡していなかったので、`hintFeasible` は
                  // **失敗したモデルとは別のモデル**の話になっていた——同じ局面で
                  // `--check-hints` は OPTIMAL、`--complete-hint` の 1 度目は INFEASIBLE、
                  // という食い違いでこれに気づいた。
                  running,
                  pending: planRequest.pending.slice(injectRunning),
                  planner: "cpsat",
                  storeId: "sweep",
                  requestId: "sweep",
                  inputKey: "",
                } as never,
                now,
                { targetLimit: limit, shape: shapeOf({ fixHints: true }) },
              );
              hintFeasible = pinned.status;
              hintPressure = pinned.hintPressure ?? null;
            } catch (error) {
              hintFeasible = `FAILED: ${String(error).slice(0, 4000)}`;
            }
          }
          results.push({
            hintFeasible,
            hintPressure,
            pinnedStatus,
            hintBisect,
            limit,
            targets: targets.length,
            ok: false,
            failure,
            solveMs,
          });
          continue;
        }
        const composed = committedSchedule(
          cpsat.schedule.slices,
          live,
          running,
          now as never,
          presets,
          params,
          change,
        );
        // 採用されるか。**`admit` そのものに問う**——被覆・feasibility・改善の判定を書き写さない。
        // **本番と同じ形で問う。** `committed` は CP-SAT モードの合成（採用済みが無ければ空）である。
        // 当初ここへ TS モードの全体を渡していたため、ローカルでは採用されるのに本番では
        // 採用されないという食い違いを作った（2026-09-13 の配備で判明）。
        // **採否は受領時刻で見る。** 計画を組んだ時刻ではない（`deliverDelayMs`）。
        const gateNow = (now + deliverDelayMs) as never;
        const gateLive = pendingOrders(planRequest.pending, running, gateNow);
        const gateChange = {
          shown: shownPlan,
          running,
          now: gateNow,
          pending: gateLive,
          presets,
        };
        const committedNow = committedSchedule(
          [],
          gateLive,
          running,
          gateNow,
          presets,
          params,
          gateChange,
        );
        // **段をそのまま受ける（`admitDetailed`・2026-09-15）。** `blockedBy` は一片が 1 つの局面
        // でしか言えない写しで、**接頭辞が途中で切れる局面**——空き釜が少ないときに起きる——では
        // 何も答えない。engine が返す段を写さずに使う。
        const decision = admitDetailed(
          cpsat.schedule,
          committedNow,
          gateLive,
          running,
          shownPlan,
          gateNow,
          presets,
          params,
        );
        const accepted = decision.slices;
        // **hint が実行可能か。** 固定して解いて答えが返れば、hint はモデルの制約を満たしている。
        let hintFeasible: string | null = null;
        let hintPressure: unknown = null;
        let hintPlacements: unknown = null;
        if (checkHints) {
          try {
            // oxlint-disable-next-line no-await-in-loop
            const pinned = await planCpsat(
              {
                ...planRequest,
                // 本解と同じ局面で検査する（上の修正と同じ理由）。
                running,
                pending: planRequest.pending.slice(injectRunning),
                planner: "cpsat",
                storeId: "sweep",
                requestId: "sweep",
                inputKey: "",
              } as never,
              now,
              { targetLimit: limit, shape: shapeOf({ fixHints: true }) },
            );
            hintFeasible = pinned.status;
            hintPressure = pinned.hintPressure ?? null;
            hintPlacements = pinned.hintPlacements ?? null;
          } catch (error) {
            hintFeasible = `FAILED: ${String(error).slice(0, 4000)}`;
          }
        }
        // **2 度目を解く。** 1 度目の配置を Shown_Plan として渡し、釜が何杯移るかを数える。
        /** 動いた杯の釜を固定して解き直した判定（`holdHead`）。 */
        let headVerdicts: unknown[] | null = null;
        let chain: {
          readonly compared: number;
          readonly slotChanged: number;
          /** そのうち **Head 近傍**（前回の開始時刻が今から 120 秒以内）の杯。 */
          readonly headCompared: number;
          readonly headSlotChanged: number;
          readonly status: string;
        } | null = null;
        if (chainShown) {
          const asShown = cpsat.schedule.slices.flatMap((slice) =>
            slice.placements.map((placement) => ({
              externalOrderId: placement.externalOrderId,
              itemIndex: placement.itemIndex,
              slotIds: placement.slotIds,
              startAt: placement.startAt,
              serveAt: placement.serveAt,
              anchor: placement.anchor,
              mates: [],
            })),
          );
          /** Head 近傍で動いた杯（`holdHead` の判定対象）。 */
          const headMoves: {
            key: string;
            from: string;
            to: string;
            startedInMs: number;
          }[] = [];
          try {
            // oxlint-disable-next-line no-await-in-loop
            // **2 度目は走行中も動かす（2026-09-15）。** 本番で釜が埋まり気味の局面を見ると、
            // 走行中が 3 秒で 4 本 → 8 本と動いている——**押しまくっている現場**では、求解を始めた
            // 時点と届いた時点で釜の状況が別物になる。待ち行列を 1 件ずらすだけでは、その局面を
            // 一度も踏めない（釜の揺れ 0% と測っていたのに、本番では 20 杯中 17〜19 杯が動いた）。
            const churned =
              chainRunningDelta === 0
                ? running
                : chainRunningDelta > 0
                  ? [
                      ...running,
                      ...injected.slice(running.length, running.length + chainRunningDelta),
                    ]
                  : running.slice(0, Math.max(0, running.length + chainRunningDelta));
            const again = await planCpsat(
              {
                ...planRequest,
                running: churned,
                // **2 度目は待ち行列を 1 件ずらす。** 本番の連続する 2 回の求解の間には
                // 必ず何かが起きている（1 杯開始・新着・期限切れ）。同じ集合を 2 度解けば
                // 「入力が同じなら同じ答え」を測るだけで、**現場で見える揺れは測れない**
                // ——本番は 1 件の増減で対応した杯の 100% が別の釜へ移っていた（2026-09-13）。
                pending: planRequest.pending.slice(injectRunning + 1),
                shownPlan: asShown,
                planner: "cpsat",
                storeId: "sweep",
                requestId: "sweep-2",
                inputKey: "",
              } as never,
              now,
              { targetLimit: limit, shape: shapeOf() },
            );
            const before = new Map(
              asShown.map((item) => [
                `${item.externalOrderId}#${item.itemIndex}`,
                [...item.slotIds]
                  .map(Number)
                  .sort((a, b) => a - b)
                  .join(","),
              ]),
            );
            // **Head 近傍だけを別に数える（2026-09-15）。** 現場が「パタパタ動く」と感じるのは
            // 手を伸ばしている先であって、1 時間後に茹でる杯ではない。全対応の率だけを見ていては
            // 「見えている範囲が安定したか」が言えない。判定は**1 度目の提案の開始時刻**で行う。
            const HEAD_HORIZON_MS = 120_000;
            const startBefore = new Map(
              asShown.map((item) => [
                `${item.externalOrderId}#${item.itemIndex}`,
                Number(item.startAt),
              ]),
            );
            let compared = 0;
            let slotChanged = 0;
            let headCompared = 0;
            let headSlotChanged = 0;
            for (const slice of again.schedule.slices)
              for (const placement of slice.placements) {
                const key = `${placement.externalOrderId}#${placement.itemIndex}`;
                const old = before.get(key);
                if (old === undefined) continue;
                compared += 1;
                const now2 = [...placement.slotIds]
                  .map(Number)
                  .sort((a, b) => a - b)
                  .join(",");
                const moved = old !== now2;
                if (moved) slotChanged += 1;
                const startedAt = startBefore.get(key);
                if (startedAt !== undefined && startedAt - now <= HEAD_HORIZON_MS) {
                  headCompared += 1;
                  if (moved) {
                    headSlotChanged += 1;
                    headMoves.push({ key, from: old, to: now2, startedInMs: startedAt - now });
                  }
                }
              }
            chain = { compared, slotChanged, headCompared, headSlotChanged, status: again.status };
            // **動いた杯の釜だけを固定して解き直す（`holdHead`）。** 時刻も他の杯も自由にする。
            if (holdHead && headMoves.length > 0) {
              headVerdicts = [];
              for (const move of headMoves) {
                const [externalOrderId, itemIndexText] = move.key.split("#");
                const item = again.schedule.slices
                  .flatMap((slice) => slice.placements)
                  .find(
                    (p) =>
                      p.externalOrderId === externalOrderId &&
                      String(p.itemIndex) === itemIndexText,
                  );
                if (item === undefined) continue;
                // **鍵はモデルと同じ形にする。** `itemKeyOf` は `\u0000` で区切る——
                // `#` で組んだ最初の実装は**一致せず、固定が黙って効かなかった**（2026-09-15）。
                const hold = new Map([
                  [`${externalOrderId}\u0000${itemIndexText}`, move.from.split(",").map(Number)],
                ]);
                try {
                  // oxlint-disable-next-line no-await-in-loop
                  const pinned = await planCpsat(
                    {
                      ...planRequest,
                      running: churned,
                      pending: planRequest.pending.slice(injectRunning + 1),
                      shownPlan: asShown,
                      planner: "cpsat",
                      storeId: "sweep",
                      requestId: "sweep-hold",
                      inputKey: "",
                    } as never,
                    now,
                    { targetLimit: limit, shape: shapeOf({ holdSlots: hold }) },
                  );
                  headVerdicts.push({
                    ...move,
                    heldStatus: pinned.status,
                    // ソルバーが報告した目的値（同じモデル・固定を足しただけなので比較できる）。
                    freeObjective: again.objective,
                    heldObjective: pinned.objective,
                    // engine の採点でも並べる（重み付き合計・hint からの改善）。
                    freeTotal: again.terms?.solvedTotal ?? null,
                    heldTotal: pinned.terms?.solvedTotal ?? null,
                    freeSlotChanges: again.terms?.solved.slotChanges ?? null,
                    heldSlotChanges: pinned.terms?.solved.slotChanges ?? null,
                    heldSlots: pinned.schedule.slices
                      .flatMap((slice) => slice.placements)
                      .find(
                        (p) =>
                          p.externalOrderId === externalOrderId &&
                          String(p.itemIndex) === itemIndexText,
                      )
                      ?.slotIds.join(","),
                  });
                } catch (error) {
                  headVerdicts.push({
                    ...move,
                    heldStatus: `FAILED: ${String(error).slice(0, 200)}`,
                    freeObjective: again.objective,
                    heldObjective: null,
                    freeTotal: again.terms?.solvedTotal ?? null,
                    heldTotal: null,
                  });
                }
              }
            }
          } catch (error) {
            chain = {
              compared: 0,
              slotChanged: 0,
              headCompared: 0,
              headSlotChanged: 0,
              status: `FAILED: ${String(error).slice(0, 60)}`,
            };
          }
        }
        results.push({
          chain,
          hintFeasible,
          limit,
          targets: targets.length,
          ok: true,
          failure: null,
          solveMs,
          status: cpsat.status,
          variables: cpsat.variables,
          memoryBytes: cpsat.memoryBytes,
          reportedObjective: cpsat.objective,
          budget: cpsat.budget,
          effectiveTargetLimit: cpsat.targetLimit,
          runningCount: running.length,
          bySection: cpsat.bySection,
          metrics: cpsat.metrics,
          clusters: cpsat.clusters,
          placements: cpsat.schedule.slices.reduce((n, s2) => n + s2.placements.length, 0),
          slices: cpsat.schedule.slices.length,
          // 採用の可否は `admit` の答えそのもの。0 なら採られない。
          acceptedSlices: accepted.length,
          // 接頭辞を止めた述語。落ちた一片がなぜ落ちたかは、これでしか言えない。
          // **摘みが届いたことを結果で言えるようにする。** 「指定が効かない」事故を 4 度やっている。
          chainRunningDelta,
          // **hint の逆転**（2026-09-15）。費用を上げても逆転が単調に減らないので、出発点を疑う。
          // hint を固定して解けば「貪欲が置いた配置」がそのまま返るので、その逆転を数える。
          hintInversions: null as number | null,
          admitStage: decision.stage,
          retimedByMs: decision.retimedByMs,
          // **`release` で切れたとき、どの一片がどの理由で落ちたか**（2026-09-15）。
          //
          // **表を進めながら見る。** `feasibleRelease` は一片ごとに解放表を進めるので、初期表だけを
          // 当てても答えが出ない（最初の試みで空振りした）。採用された接頭辞で表を進め、最初に
          // 落ちた一片に 4 つの条件を当てる——述語は engine の `feasibleRelease` と同じ順序である。
          releaseGap: (() => {
            if (decision.stage !== "release") return null;
            const targets2 = placeableTargets(gateLive, gateNow, presets, params);
            let table = initialRelease(
              running,
              gateNow,
              params.unitOrigins.length * SLOTS_PER_UNIT,
            );
            for (const slice of accepted) table = advanceRelease(table, slice.placements);
            const failing = cpsat.schedule.slices[accepted.length];
            if (failing === undefined) return "落ちた一片が無い";
            const reasons: string[] = [];
            for (const placement of failing.placements) {
              const order = targets2.find(
                (o) =>
                  o.externalOrderId === placement.externalOrderId &&
                  o.itemIndex === placement.itemIndex,
              );
              if (order === undefined) {
                reasons.push("対象に無い");
                continue;
              }
              const boil = boilMillisOf(order, presets);
              if (boil === null) reasons.push("茹で時間が引けない");
              else if (Number(placement.serveAt) - Number(placement.startAt) !== boil)
                reasons.push(
                  `茹で時間の不一致 ${(Number(placement.serveAt) - Number(placement.startAt)) / 1000}s ≠ ${boil / 1000}s`,
                );
              if (placement.slotIds.length !== order.slotSpan)
                reasons.push(`釜数の不一致 ${placement.slotIds.length} ≠ ${order.slotSpan}`);
              for (const slotId of placement.slotIds) {
                const at = table[Number(slotId)];
                if (at === undefined) reasons.push(`釜 ${slotId} が表に無い`);
                else if (Number(placement.startAt) < Number(at))
                  reasons.push(
                    `釜 ${slotId} が ${Math.round((Number(at) - Number(placement.startAt)) / 1000)}s 足りない`,
                  );
              }
            }
            // **一片の順序と、釜 9〜11 を使う配置の時刻**。届いた順で採ると噛み合うか。
            const trace = cpsat.schedule.slices.slice(0, accepted.length + 2).map((sl, i) => ({
              i,
              採用: i < accepted.length,
              配置: sl.placements.map(
                (p2) =>
                  `釜${p2.slotIds.join("+")}@${Math.round((Number(p2.startAt) - now) / 1000)}→${Math.round((Number(p2.serveAt) - now) / 1000)}s`,
              ),
            }));
            return { reasons: [...new Set(reasons)].slice(0, 4), trace };
          })(),
          // **棄却の理由を 2 つに分ける。** `isStale` は段 1 の (a)(b)（卓の完全被覆と対象の一致）
          // ただ一つの述語で、`admit` の内側と同じものを同じ集合に当てている（書き写していない）。
          // 真なら被覆で落ちた。偽なら被覆は満たしており、落ちたのは feasibility か改善である。
          deliverDelayMs,
          // 種を撒けた杯の数 / 対象の数。足りなければ、撒けなかった杯が貪欲の hint を使い、
          // 進んだ解放表と噛み合わずに固定が実行不能になる。
          seeded: seedPlan === undefined ? null : `${seedPlan.size}/${seedTargets.length}`,
          /**
           * **計画の最も早い開始時刻が「解いた今」からどれだけ先か**（ミリ秒）。
           * これが受領までの遅れより小さい計画は、届いた時点で過去開始になり棄却される。
           */
          earliestStartOffsetMs: Math.min(
            ...cpsat.schedule.slices.flatMap((slice) =>
              slice.placements.map((placement) => placement.startAt - now),
            ),
          ),
          staleSlices: cpsat.schedule.slices.filter((slice) =>
            isStale(slice, placeableTargets(gateLive, gateNow, presets, params), false),
          ).length,
          // **全件被覆を要求したら何片落ちるか。** 「被覆の壁」は卓の読み違い（`table_no = 1` を
          // 実在の卓として読み、店の全注文を 1 つの群に畳んでいた）の産物だったので、
          // 群が伝票ごとになった後もそれが残るかを数える（2026-09-13）。
          staleSlicesFullCoverage: cpsat.schedule.slices.filter((slice) =>
            isStale(slice, placeableTargets(gateLive, gateNow, presets, params), true),
          ).length,
          // **合成に残った杯数。** 0 なら、CP-SAT の配置は 1 本も画面に届いていない
          // ——費用が TS と同値に見えるのは「同じくらい良い」ではなく「同じもの」だからである。
          // **どの述語が落としたか。** 一片が 1 つの局面に限って、`prune` と同じ初期表
          // （走行中から引いた解放表・上げ表）に**同じ exported 述語**を当てる。一片が 1 つなら
          // 表を進める順序が結果に効かないので、これは `prune` の書き写しではなく同値である。
          // 一片が 2 つ以上の局面では null を返す（順序が効くので、ここでは言わない）。
          blockedBy: (() => {
            const slices = cpsat.schedule.slices;
            if (slices.length !== 1) return null;
            const slice = slices[0]!;
            const targets2 = placeableTargets(gateLive, gateNow, presets, params);
            const release = initialRelease(
              running,
              gateNow,
              params.unitOrigins.length * SLOTS_PER_UNIT,
            );
            const lifts = initialLifts(running);
            const members = tableMembers(running);
            const reasons: string[] = [];
            if (isStale(slice, targets2, false)) reasons.push("stale");
            if (cannotStart(slice, gateNow, occupiedSlotsOf(running))) reasons.push("cannotStart");
            if (
              !keepsAnchor(
                slice.placements,
                release,
                lifts,
                members.get(slice.tableKey) ?? null,
                targets2,
                presets,
                params,
              )
            )
              reasons.push("keepsAnchor");
            if (!withinLiftCap(lifts, liftsOf(slice.placements), params)) reasons.push("liftCap");
            if (feasibleRelease(slice.placements, release, targets2, presets) === null)
              reasons.push("feasibleRelease");
            return reasons;
          })(),
          keptInComposed: (() => {
            const key = (slices: readonly PlanSlice[]) =>
              new Map(
                slices.flatMap((slice) =>
                  slice.placements.map((placement) => [
                    `${placement.externalOrderId}#${placement.itemIndex}`,
                    `${[...placement.slotIds].join(",")}@${placement.startAt}`,
                  ]),
                ),
              );
            const proposed = key(cpsat.schedule.slices);
            const after = key(composed.slices);
            let kept = 0;
            for (const [id, value] of proposed) if (after.get(id) === value) kept += 1;
            return kept;
          })(),
          composed: breakdown(composed.slices, live, running, now, presets, params, shownPlan),
          // **伝票ごとの待ちで採点し直す**（2026-09-13・ユーザー提案の検討）。engine の採点は
          // 変えていない——**変える価値があるかを先に数字で見る**ためだけに並べて出す。
          billCpsat: billWait(composed.slices, gateLive),
          // **目的値の分解**（解 vs hint・項別）。何と引き換えに逆転したかを読むため。
          terms: cpsat.terms,
          hintPressure,
          hintPlacements,
          headVerdicts,
          // 完全 hint の 1 度目（固定解）の状態。`null` は完全 hint を使っていない回である。
          pinnedStatus,
          hintBisect,
        });
      }
      return Response.json({
        ok: true,
        now,
        liveCount: live.length,
        runningCount: running.length,
        tsWhole: tsScore,
        // 同じ局面を engine の自前解（TS）で解いたときの伝票ごとの待ち。比較の相手である。
        billTs: billWait(tsWhole.slices, live),
        results,
      });
    }

    return new Response("not found", { status: 404 });
  },
};
