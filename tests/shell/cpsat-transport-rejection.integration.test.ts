import { afterEach, expect, it, vi } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import { toCookSchedule } from "../../src/engine/schedule";
import { configResidualDefaults } from "../storeConfigDefaults";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("固定問題の CP envelope は現行 deliverPlan で保存・Alarm・配信を起こさない", async () => {
  const id = `transport-reject-${crypto.randomUUID()}`;
  const stub = env.STORE_TIMER_DO.get(
    env.STORE_TIMER_DO.idFromName(id),
  ) as unknown as DurableObjectStub<StoreTimerDO>;
  await stub.applyProjection({
    active: true,
    version: 1,
    roster: [],
    config: {
      unitCount: 1,
      arms: 2,
      toleranceRatio: 10,
      noodlePresets: [
        { noodleType: "probe", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
      ],
      ...configResidualDefaults(1),
    },
  });
  await runInDurableObject(stub, async (instance, state) => {
    const put = vi.spyOn(state.storage, "put");
    const broadcast = vi.spyOn(state, "getWebSockets");
    const setAlarm = vi.spyOn(state.storage, "setAlarm");
    const deleteAlarm = vi.spyOn(state.storage, "deleteAlarm");
    try {
      // Positive control: the same spies must see an actual business transition.
      const response = await instance.fetch(
        new Request("https://do.invalid/orders", {
          method: "POST",
          body: JSON.stringify({
            items: [
              {
                externalOrderId: "transport-order",
                itemIndex: 0,
                noodleType: "probe",
                firmness: "normal",
                tableId: null,
              },
            ],
          }),
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(put).toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalled();
      const before = await state.storage.list();
      put.mockClear();
      broadcast.mockClear();
      setAlarm.mockClear();
      deleteAlarm.mockClear();

      const envelope = {
        protocol: "cpsat/v1",
        storeId: id,
        requestId: "fixed-small",
        result: { status: "OPTIMAL", objective: 5, solution: [2, 1, 0], slices: [] },
        observation: { mode: "probe" },
        runtime: { initializedNow: true, initializationCount: 1 },
      };
      expect(Object.hasOwn(envelope, "slices")).toBe(false);
      expect(toCookSchedule(envelope)).toBeNull();
      await instance.deliverPlan(envelope);
      await instance.deliverPlan(envelope); // Duplicate delivery is equally inert.
      expect(await state.storage.list()).toEqual(before);
      expect(put).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(setAlarm).not.toHaveBeenCalled();
      expect(deleteAlarm).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
