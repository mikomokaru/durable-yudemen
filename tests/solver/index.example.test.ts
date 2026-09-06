// Feature: pending-order-expiry, Component 3（外部ソルバ）— 要求の待ち行列を自分の時計で絞る
// **Validates: Requirements 2.4**
//
// tests/solver/index.example.test.ts — Solver_Worker（src/solver/index.ts）の受け口を、DO の binding と waitUntil を
// 差し替えて直に叩く。往路の 202・復路の deliverPlan（storeId で引いた stub）と、計画と変更費用の文脈が
// `liveOrders(request.pending, now)`（solver 自身の Date.now()）を読むことを見る。
//
// 場面は expiryScenes.ts の混在（期限切れの旧先頭 A・生きている B と C）。solver の時計は場面を組んだ時刻より僅かに
// 進むので、B の開始は「今」（場面の時刻から数秒の内側）、C の開始は M の上げ窓の次（ちょうど 45 秒後）で照合する。
// A を文脈に残す誤りは B・C を両方 45 秒後へ pack する計画として現れる。

import { describe, expect, it } from "vitest";
import solver from "../../src/solver/index";
import type { PlanRequest } from "../../src/solver/request";
import type { CookSchedule } from "../../src/engine/schedule";
import type { EpochMillis } from "../../src/engine/types";
import {
  changeCostOf,
  EXPIRY_PARAMS,
  EXPIRY_PRESETS,
  mixedScene,
  SECOND,
} from "../core/expiryScenes";

type SolverEnv = Parameters<typeof solver.fetch>[1];

/** 要求を投げ、waitUntil が抱えた復路を待って、届いた計画と宛先を返す。 */
async function solve(request: PlanRequest): Promise<{
  readonly status: number;
  readonly delivered: readonly CookSchedule[];
  readonly storeIds: readonly string[];
}> {
  const delivered: CookSchedule[] = [];
  const storeIds: string[] = [];
  const tasks: Promise<unknown>[] = [];
  const env = {
    STORE_TIMER_DO: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        storeIds.push(id);
        return {
          deliverPlan: (plan: CookSchedule) => {
            delivered.push(plan);
            return Promise.resolve();
          },
        };
      },
    },
  } as unknown as SolverEnv;
  const executionContext = {
    waitUntil: (task: Promise<unknown>) => {
      tasks.push(task);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const response = await solver.fetch(
    new Request("https://solver.invalid/", { method: "POST", body: JSON.stringify(request) }),
    env,
    executionContext,
  );
  await Promise.all(tasks);
  return { status: response.status, delivered, storeIds };
}

describe("Solver_Worker — 要求の待ち行列を自分の時計で絞る（pending-order-expiry AC 2.4）", () => {
  it("期限切れの旧先頭 A を文脈から外すので、B は今に残り、C は次の窓（45 秒後）に置かれる", async () => {
    const built = Date.now() as EpochMillis;
    const scene = mixedScene(built);
    const request: PlanRequest = {
      storeId: "store-1",
      pending: scene.pending,
      running: scene.running,
      params: EXPIRY_PARAMS,
      noodlePresets: EXPIRY_PRESETS,
      digest: 0,
      shownPlan: scene.shown,
    };

    const { status, delivered, storeIds } = await solve(request);

    expect(status).toBe(202);
    expect(storeIds).toEqual(["store-1"]);
    expect(delivered).toHaveLength(1);
    const placements = delivered[0]!.slices.flatMap((slice) => slice.placements);
    // 期限切れの A は計画に無い。
    expect(placements.map((placement) => placement.externalOrderId)).toEqual(["B", "C"]);
    const [b, c] = placements;
    // B は solver の「今」（場面を組んだ時刻から数秒の内側）。pack なら 45 秒後になる。
    expect(b!.startAt - built).toBeGreaterThanOrEqual(0);
    expect(b!.startAt - built).toBeLessThan(10 * SECOND);
    // C は M の上げ窓の次（M の endTime + L − 茹で時間 = ちょうど 45 秒後）。
    expect(c!.startAt - built).toBe(45 * SECOND);
    expect(b!.slotIds).toEqual(["2", "3"]);
    expect(c!.slotIds).toEqual(["4"]);
    // pack の変更費用は正しい文脈で 2L = 90、A を残した文脈では 0。
    expect(changeCostOf(scene.pack, scene, scene.live)).toBe(90);
    expect(changeCostOf(scene.pack, scene, scene.pending)).toBe(0);
  });

  it("要求の待ち行列が全件期限切れなら、空の計画を届ける（期限切れの品目を置かない）", async () => {
    const scene = mixedScene(Date.now() as EpochMillis);
    const { status, delivered } = await solve({
      storeId: "store-2",
      pending: [scene.expired],
      running: scene.running,
      params: EXPIRY_PARAMS,
      noodlePresets: EXPIRY_PRESETS,
      digest: 0,
      shownPlan: scene.shown,
    });
    expect(status).toBe(202);
    expect(delivered).toEqual([{ slices: [] }]);
  });
});
