// tests/shell/cpsat-ts-restore.integration.test.ts — CP-SAT から TS へ戻せることを確かめる。
//
// **Validates: cpsat-planner-integration R5.3, R7.5, R7.6**
//
// 2026-09-12 に全店舗を CP-SAT へ切り替えた。戻す手段は `PLANNER_BACKEND: ts` の再配備
// だけで、それが CP-SAT 期間に増えた保存状態を壊さずに動くことは確かめていなかった。
// 「戻せた」では足りない——[確認項目](../../.kiro/specs/cpsat-planner-integration/verification/ts-restore-checklist-20260913.md)
// の 4 つを個別に固定する。
import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configResidualDefaults } from "../storeConfigDefaults";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** 未プロビジョニングの DO は 403 で注文を受けない。実店舗と同じ形へ揃える。 */
async function store() {
  const stub = env.STORE_TIMER_DO.get(
    env.STORE_TIMER_DO.idFromName(`restore-${crypto.randomUUID()}`),
  );
  await stub.applyProjection({
    active: true,
    version: 1,
    roster: [],
    config: {
      unitCount: 1,
      arms: 2,
      toleranceRatio: 10,
      noodlePresets: [
        { noodleType: "Thin", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
      ],
      ...configResidualDefaults(1),
    },
  });
  return stub;
}

/** CP-SAT が実際に返す封筒。余分な 3 フィールドを載せた計画である。 */
const cpsatEnvelope = (startAt: number) => ({
  slices: [
    {
      tableKey: "T-1",
      placements: [
        {
          externalOrderId: "POS-0001",
          itemIndex: 0,
          slotIds: ["0"],
          startAt,
          serveAt: startAt + 60_000,
          anchor: null,
        },
      ],
    },
  ],
  // 輸送の封筒。受け口がこれをどう扱うかが A-1 の主題である。
  planner: "cpsat",
  inputKey: "f".repeat(64),
  requestId: "00000000-0000-4000-8000-000000000000",
});

describe("CP-SAT から TS への復帰", () => {
  it("A-1 CP-SAT の封筒は保存状態に残らない（TS 版が読めない形を作らない）", async () => {
    await runInDurableObject(await store(), async (instance: StoreTimerDO, state) => {
      await instance.deliverPlan(cpsatEnvelope(Date.now() + 60_000));
      const snapshot = await state.storage.get<Record<string, unknown>>("activeTimers");
      // 採用されたかは局面次第だが、**採用されてもされなくても封筒は残らない**。
      // `toCookSchedule` が `{ slices }` だけを組み直すので、入口で落ちている。
      const serialized = JSON.stringify(snapshot ?? {});
      expect(serialized).not.toContain("planner");
      expect(serialized).not.toContain("inputKey");
      expect(serialized).not.toContain("requestId");
      expect(serialized).not.toContain("f".repeat(64));
    });
  });

  // **A-2 はここでは書けない。** 採用済み計画を作るには、ゲートが現行計画より厳密に良いと
  // 判定する計画を渡す必要があり、それには engine 自身の解を知っていなければならない。
  // 単純な fixture では常に同点か劣位になり、採用されない（実際に `acceptedSlices` は空だった）。
  //
  // 無理に採用させる fixture を作れば「採用されたことにした試験」になる。ゆえに **7-B の
  // 再生評価で実局面を扱うときに、採用が起きた局面を取ってここへ戻す**。
  // それまで A-2 は未確認である——[確認項目](../../.kiro/specs/cpsat-planner-integration/verification/ts-restore-checklist-20260913.md)。
  it.skip("A-2 CP-SAT が残した採用済み計画を、TS へ戻しても破棄しない", async () => {
    const stub = await store();
    // CP-SAT 期間：注文が来て、計画が採用される。
    await runInDurableObject(stub, async (instance: StoreTimerDO) => {
      const holder = instance as unknown as { env: Env };
      holder.env = {
        ...holder.env,
        PLANNER_BACKEND: "cpsat" as Env["PLANNER_BACKEND"],
        CPSAT_ACTIVATION_ID: "act-test" as Env["CPSAT_ACTIVATION_ID"],
        CPSAT_PLAN_QUEUE: { send: vi.fn() } as unknown as Env["CPSAT_PLAN_QUEUE"],
      };
      await instance.fetch(
        new Request("https://do.invalid/orders", {
          method: "POST",
          body: JSON.stringify({
            items: [
              {
                externalOrderId: "POS-0001",
                itemIndex: 0,
                noodleType: "Thin",
                firmness: "normal",
                tableId: "T-1",
                slotSpan: 1,
              },
            ],
          }),
        }),
      );
      await instance.deliverPlan(cpsatEnvelope(Date.now() + 120_000));
    });
    const adopted = await runInDurableObject(
      stub,
      async (_i, state) =>
        ((await state.storage.get<{ acceptedSlices?: unknown[] }>("activeTimers"))
          ?.acceptedSlices ?? []) as unknown[],
    );
    // 採用されていなければこの試験は何も主張していない。前提として固定する。
    expect(adopted.length).toBeGreaterThan(0);

    // TS へ戻す。**戻しただけで残存計画が消えてはならない**——消えれば推奨のない表示になる。
    const afterRestore = await runInDurableObject(stub, async (instance: StoreTimerDO, state) => {
      const holder = instance as unknown as { env: Env };
      holder.env = { ...holder.env, PLANNER_BACKEND: "ts" as Env["PLANNER_BACKEND"] };
      // 復帰後の最初の入口。ここで読み直しと reconcile が走る。
      await instance.fetch(
        new Request("https://do.invalid/", { headers: { Upgrade: "websocket" } }),
      );
      return ((await state.storage.get<{ acceptedSlices?: unknown[] }>("activeTimers"))
        ?.acceptedSlices ?? []) as unknown[];
    });
    expect(afterRestore).toEqual(adopted);
  });

  it("A-3 戻したあとに届く遅着の応答を、TS 経路の DO が棄却する", async () => {
    await runInDurableObject(await store(), async (instance: StoreTimerDO, state) => {
      const holder = instance as unknown as { env: Env };
      holder.env = { ...holder.env, PLANNER_BACKEND: "ts" as Env["PLANNER_BACKEND"] };
      const before = await state.storage.get("activeTimers");
      // 過去の開始時刻。応答の遅れで開始が過去になった計画である（R5.5）。
      await instance.deliverPlan(cpsatEnvelope(Date.now() - 600_000));
      const after = await state.storage.get("activeTimers");
      // 棄却なら状態は動かない（AC 6.6：Persist も Broadcast も出ない）。
      expect(after).toEqual(before);
    });
  });

  it("A-4 有効化世代が空なら CP-SAT の送出を止める（再有効化には新しい値が要る）", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    await runInDurableObject(await store(), async (instance: StoreTimerDO) => {
      const holder = instance as unknown as { env: Env };
      const send = vi.fn();
      holder.env = {
        ...holder.env,
        PLANNER_BACKEND: "cpsat" as Env["PLANNER_BACKEND"],
        CPSAT_ACTIVATION_ID: "" as Env["CPSAT_ACTIVATION_ID"],
        CPSAT_PLAN_QUEUE: { send } as unknown as Env["CPSAT_PLAN_QUEUE"],
      };
      await instance.fetch(
        new Request("https://do.invalid/orders", {
          method: "POST",
          body: JSON.stringify({
            items: [
              {
                externalOrderId: "POS-9001",
                itemIndex: 0,
                noodleType: "Thin",
                firmness: "normal",
                tableId: "T-9",
                slotSpan: 1,
              },
            ],
          }),
        }),
      );
      // 世代が無いまま送れば、どの有効化に属する要求か後から言えない。送らずに止める。
      expect(send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("CPSAT_ACTIVATION_ID"));
    });
    warn.mockRestore();
  });
});
