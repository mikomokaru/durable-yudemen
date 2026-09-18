// tests/shell/cpsat-store-sample.integration.test.ts — **CP-SAT の段階投入（標本）**を固定する。
//
// **Validates: cpsat-planner-integration R1.1, R1.4**
//
// 段 1〜3（R1.4 の補完の撤去・R5.4 の有効性採用・全件対象）は**画面に出るものを変える**変更なので、
// 全店舗へ一度に入れず標本から始める。**design 第 1.1 節の「切り替えの単位はアプリ Worker 全体」の
// 改訂である**（2026-09-13）。
//
// 判定は env の許可リストと自分の storeId だけで閉じる——**店舗別の設定編集でもレジストリの
// スキーマ変更でもない。** 投影にも永続にも何も足さない。
//
// ここで固定するのは 2 つ。
//   標本の店舗   : Queue へ送る（CP-SAT で解く）
//   標本外の店舗 : **送らない。** 画面は従来どおり engine の自前解で埋まる
import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { StoreProjection } from "../../src/registry/projection";
import { configResidualDefaults } from "../storeConfigDefaults";
import { baselineSchedule, initialRelease } from "../../src/engine/schedule";
import { initialLifts } from "../../src/engine/lift";
import { tableMembers } from "../../src/engine/project";
import { occupiedSlotsOf, type NoodlePreset } from "../../src/domain/store";
import { CPSAT_DELIVERY_LEAD_MS } from "../../src/cpsat/request";
import type { ScheduleParams } from "../../src/engine/objective";
import type { OrderItem } from "../../src/domain/order";
import type { EpochMillis } from "../../src/engine/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const PRESET = "sample-noodle";
const MENU_CODE = 11421;
const SIZE_CODE = 19401;

async function provisioned(storeId: string) {
  const stub = env.STORE_TIMER_DO.get(env.STORE_TIMER_DO.idFromName(storeId));
  const projection: StoreProjection = {
    active: true,
    version: 1,
    roster: [],
    config: {
      unitCount: 1,
      arms: 2,
      toleranceRatio: 10,
      noodlePresets: [
        { noodleType: PRESET, boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
      ],
      ...configResidualDefaults(1),
      firmnessCodes: [{ code: 10011, firmness: "normal" }],
      menuItems: [
        {
          productCode: MENU_CODE,
          noodleType: PRESET,
          sizes: [{ code: SIZE_CODE, portions: 1 }],
        },
      ],
    },
  };
  await stub.applyProjection(projection);
  return stub;
}

/** 1 品目の到着（本番の受け口 `receiveRecords` が受ける形）。 */
function records(storeId: string) {
  return [
    {
      path: "/lio/order",
      payload: {
        store_id: "0007",
        terminal_id: "1",
        bill_no: storeId,
        datetime: "2026-09-13T12:00:00",
        order_items: [{ plu_no: MENU_CODE, child_items: [{ plu_no: SIZE_CODE }] }],
      },
      arrivalTimestampMs: Date.now() - 1_000,
      sequenceNumber: "1".padStart(56, "0"),
    },
  ];
}

/**
 * 許可リストと計画器を差し替えて 1 回の到着を流し、Queue へ送られたかを返す。
 *
 * **差し替えと呼び出しを同じ `runInDurableObject` の中で行う。** 外から `stub` 越しに呼ぶと
 * 差し替えた env が効かず、本物の Queue binding へ送られて試験が止まる（2026-09-13 に踏んだ）。
 */
async function sends(storeId: string, allowed: string): Promise<boolean> {
  const stub = await provisioned(storeId);
  return runInDurableObject(stub, async (instance) => {
    const holder = instance as unknown as {
      env: Env;
      receiveRecords(records: unknown): Promise<unknown>;
    };
    let sent = 0;
    holder.env = {
      ...holder.env,
      PLANNER_BACKEND: "cpsat" as Env["PLANNER_BACKEND"],
      CPSAT_ACTIVATION_ID: "act-test" as Env["CPSAT_ACTIVATION_ID"],
      CPSAT_STORE_IDS: allowed as Env["CPSAT_STORE_IDS"],
      CPSAT_PLAN_QUEUE: {
        send: async () => {
          sent += 1;
        },
      } as unknown as Queue,
    };
    const outcome = (await holder.receiveRecords(records(storeId))) as { kind: string };
    expect(outcome.kind).toBe("settled");
    return sent > 0;
  });
}

it("標本の店舗は Queue へ送る", async () => {
  const storeId = `sample-in-${crypto.randomUUID()}`;
  expect(await sends(storeId, `other-store,${storeId},another-store`)).toBe(true);
});

it("**標本外の店舗は送らない**（Queue にも載せず、CPU も課金も使わない）", async () => {
  const storeId = `sample-out-${crypto.randomUUID()}`;
  expect(await sends(storeId, "other-store,another-store")).toBe(false);
});

it("許可リストが空なら絞らない（全店舗が標本）", async () => {
  const storeId = `sample-all-${crypto.randomUUID()}`;
  expect(await sends(storeId, "")).toBe(true);
});

/**
 * **本番の形で「最初の 1 件が採られる」ことを DO の層で固定する（2026-09-13）。**
 *
 * 段 1（改善判定を外す）と段 3（尾部を自前解で埋めない）は**別々には正しく、組み合わせで初めて
 * 壊れた**——段 3 で `committed` が空になるのに、`prune` に「対応する一片が現行に無ければ落とす」
 * が残っていたため、**最初の 1 件が永久に採られなかった**。
 *
 * **掃引（評価器）では捕まらなかった。** あちらは `committed` を TS モードで組んでおり、本番の形を
 * 写していなかった。**この 1 本があれば配備前に止まっていた。**
 */
it("**採用済みが無い状態から、届いた計画の最初の 1 件が採られる**（段 1 × 段 3）", async () => {
  const storeId = `adopt-${crypto.randomUUID()}`;
  const stub = await provisioned(storeId);
  await runInDurableObject(stub, async (instance) => {
    const holder = instance as unknown as {
      env: Env;
      receiveRecords(records: unknown): Promise<unknown>;
      deliverPlan(plan: unknown): Promise<void>;
      ctx: DurableObjectState;
    };
    let enqueued: { pending: readonly OrderItem[]; params: unknown } | null = null;
    holder.env = {
      ...holder.env,
      PLANNER_BACKEND: "cpsat" as Env["PLANNER_BACKEND"],
      CPSAT_ACTIVATION_ID: "act-test" as Env["CPSAT_ACTIVATION_ID"],
      // 空＝「絞らない」。`vars` に許可リストが入って以降、生成 Env の型は文字列リテラルなので、
      // 同ファイルの他の 2 つと同じく Env の型で受け直す（`pnpm cf-typegen` のたびに落ちるのを防ぐ）。
      CPSAT_STORE_IDS: "" as Env["CPSAT_STORE_IDS"],
      CPSAT_PLAN_QUEUE: {
        send: async (message: { pending: readonly OrderItem[]; params: unknown }) => {
          enqueued = message;
        },
      } as unknown as Queue,
    };
    await holder.receiveRecords(records(storeId));
    expect(enqueued).not.toBeNull();

    // **確定計画は空である**——段 3 で尾部を自前解で埋めないので、採用済みが無い間は提案が無い。
    const before = await readCommitted(holder.ctx);
    expect(before).toEqual([]);

    // 届いた計画（engine 自身の解を外部計画として持ち込む。良し悪しは論点ではない）。
    //
    // **計画は「受領の見込み時刻」から置く**（`CPSAT_DELIVERY_LEAD_MS`・2026-09-14）。本番の
    // CP-SAT はそうする。ここを「今」にすると、組んでから `deliverPlan` が走るまでの数ミリ秒で
    // 先頭が過去開始になり、`feasibleRelease` が計画全体を落とす——**本番で採用 0 だったのと
    // 同じ形**であり、試験としては時刻に依存して落ちたり通ったりする。
    const request = enqueued as unknown as {
      pending: readonly OrderItem[];
      params: ScheduleParams;
      noodlePresets: readonly NoodlePreset[];
    };
    const from = (Date.now() + CPSAT_DELIVERY_LEAD_MS) as EpochMillis;
    const arrived = baselineSchedule(
      request.pending,
      initialRelease([], from, request.params.unitOrigins.length * 6),
      tableMembers([]),
      initialLifts([]),
      request.noodlePresets,
      request.params,
      from,
      occupiedSlotsOf([]),
      null,
    );
    expect(arrived.slices.length).toBeGreaterThan(0);

    await holder.deliverPlan({ ...arrived, planner: "cpsat" });

    // **採用され、画面に出るものが CP-SAT の計画になる。**
    const after = await readCommitted(holder.ctx);
    expect(after.length).toBeGreaterThan(0);
  });
});

/**
 * **注文 1 件ごとの配置の揺れを数える**（2026-09-14・段 1 の検証項目）。
 *
 * CP-SAT モードではちらつきの守り手が `admit` の改善判定からモデルの `slotChangeCost` へ移った。
 * **係数が十分かは、実際に何杯の配置が動いたかを数えて初めて言える。** その数が `cpsat.plan-decided`
 * に載っていることを、**動かした杯の数をこちらが決めた局面**で確かめる。
 */
it("**採否の記録に、旧 Shown_Plan からの配置の揺れが載る**", async () => {
  const storeId = `churn-${crypto.randomUUID()}`;
  const stub = await provisioned(storeId);
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const [first] = args;
    if (typeof first !== "string") return;
    try {
      lines.push(JSON.parse(first) as Record<string, unknown>);
    } catch {
      /* 構造化ログでない行は見ない */
    }
  });
  await runInDurableObject(stub, async (instance) => {
    const holder = instance as unknown as {
      env: Env;
      receiveRecords(records: unknown): Promise<unknown>;
      deliverPlan(plan: unknown): Promise<void>;
    };
    let enqueued: { pending: readonly OrderItem[]; params: unknown } | null = null;
    holder.env = {
      ...holder.env,
      PLANNER_BACKEND: "cpsat" as Env["PLANNER_BACKEND"],
      CPSAT_ACTIVATION_ID: "act-test" as Env["CPSAT_ACTIVATION_ID"],
      // 空＝「絞らない」。`vars` に許可リストが入って以降、生成 Env の型は文字列リテラルなので、
      // 同ファイルの他の 2 つと同じく Env の型で受け直す（`pnpm cf-typegen` のたびに落ちるのを防ぐ）。
      CPSAT_STORE_IDS: "" as Env["CPSAT_STORE_IDS"],
      CPSAT_PLAN_QUEUE: {
        send: async (message: { pending: readonly OrderItem[]; params: unknown }) => {
          enqueued = message;
        },
      } as unknown as Queue,
    };
    await holder.receiveRecords(records(storeId));
    const request = enqueued as unknown as {
      pending: readonly OrderItem[];
      params: ScheduleParams;
      noodlePresets: readonly NoodlePreset[];
    };
    const from = (Date.now() + CPSAT_DELIVERY_LEAD_MS) as EpochMillis;
    const first = baselineSchedule(
      request.pending,
      initialRelease([], from, request.params.unitOrigins.length * 6),
      tableMembers([]),
      initialLifts([]),
      request.noodlePresets,
      request.params,
      from,
      occupiedSlotsOf([]),
      null,
    );
    await holder.deliverPlan({ ...first, planner: "cpsat" });

    // 同じ品目を、**1 秒だけ後ろへ動かした**計画。揺れは 1 杯・時刻だけである。
    const moved = {
      planner: "cpsat",
      slices: first.slices.map((slice) => ({
        tableKey: slice.tableKey,
        placements: slice.placements.map((placement) => ({
          ...placement,
          startAt: placement.startAt + 1_000,
          serveAt: placement.serveAt + 1_000,
        })),
      })),
    };
    await holder.deliverPlan(moved);

    // **窓を超える移動**（茹で 60 秒・許容 10% ゆえ窓は 6 秒。30 秒動かす）。
    const far = {
      planner: "cpsat",
      slices: first.slices.map((slice) => ({
        tableKey: slice.tableKey,
        placements: slice.placements.map((placement) => ({
          ...placement,
          startAt: placement.startAt + 30_000,
          serveAt: placement.serveAt + 30_000,
        })),
      })),
    };
    await holder.deliverPlan(far);
  });
  const decided = lines.filter((line) => line.kind === "cpsat.plan-decided");
  expect(decided).toHaveLength(3);
  // 1 回目は比較の相手が無い（Shown_Plan が空）。**採否の段と補正の幅も 1 行に載る。**
  expect(decided[0]).toMatchObject({
    churnCompared: 0,
    churnAny: 0,
    admitStage: "complete",
    retimedByMs: 0,
  });
  // **画面の先頭が「いま」からどれだけ先か。** 計画は lead の分だけ先から置いてあるので、
  // 届いた側も採用済みの側も正の値になる——**これが「提案がいつも少し先を指す」の大きさ**である。
  const head = decided[0] as { arrivedHeadInMs: number; standingHeadInMs: number };
  expect(head.arrivedHeadInMs).toBeGreaterThan(0);
  expect(head.arrivedHeadInMs).toBeLessThanOrEqual(CPSAT_DELIVERY_LEAD_MS);
  expect(head.standingHeadInMs).toBe(head.arrivedHeadInMs);
  // 2 回目は 1 杯が時刻だけ動いた。**釜は動いていない。**
  // **1 秒の移動は合流の窓 h_i の内側**（茹で 60 秒 × toleranceRatio 10% = 6 秒）ゆえ、
  // 厨房から見える揺れとしては数えない——`changeCost` の (d) と同じ規則である。
  expect(decided[1]).toMatchObject({
    churnCompared: 1,
    churnTime: 1,
    churnTimeBeyondWindow: 0,
    churnSlot: 0,
    churnAny: 1,
  });
  // 3 回目は窓を超えて動いた。**これが厨房から見える揺れである。**
  expect(decided[2]).toMatchObject({
    churnCompared: 1,
    churnTime: 1,
    churnTimeBeyondWindow: 1,
    churnSlot: 0,
    churnAny: 1,
  });
});

/** 永続スナップショットの採用済み一片を読む（画面に出るものの正本）。 */
async function readCommitted(ctx: DurableObjectState): Promise<readonly unknown[]> {
  const snapshot = await ctx.storage.get<{ acceptedSlices?: readonly unknown[] }>("activeTimers");
  return snapshot?.acceptedSlices ?? [];
}
