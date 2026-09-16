import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { isRecord } from "../../src/domain/predicate";
import { configResidualDefaults } from "../storeConfigDefaults";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("実StoreTimerDOのPersist失敗ではSOLVER bindingを呼ばず、同じ注文の回復時にだけ送る", async () => {
  const stub = env.STORE_TIMER_DO.get(
    env.STORE_TIMER_DO.idFromName(`transport-persist-${crypto.randomUUID()}`),
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
        { noodleType: "probe", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
      ],
      ...configResidualDefaults(1),
    },
  });
  await runInDurableObject(stub, async (instance, state) => {
    // **計画器を明示する。** 2026-09-12 に root 設定の既定が `cpsat` になったので、
    // 既定に任せると `requestPlan` は Queue へ行き、この `SOLVER` は呼ばれない。
    // TS 経路の Persist 順序を検査する試験なので、経路を自分で選ぶ。
    const holder = instance as unknown as { env: Env };
    const original = holder.env;
    holder.env = { ...original, PLANNER_BACKEND: "ts" as Env["PLANNER_BACKEND"] };
    const put = vi.spyOn(state.storage, "put");
    // この試験は 1 回の runInDurableObject で完結するので、戻しは末尾で行う。
    const received: { body: unknown; committed: unknown }[] = [];
    const send = vi.spyOn(env.SOLVER, "fetch").mockImplementation(async (input, init) => {
      const incoming = new Request(input, init);
      const body: unknown = await incoming.json();
      const committed = await state.storage.get("activeTimers");
      received.push({ body, committed });
      return new Response(null, { status: 202 });
    });
    const arrive = (id: string) =>
      instance.fetch(
        new Request("https://do.invalid/orders", {
          method: "POST",
          body: JSON.stringify({
            items: [
              {
                externalOrderId: id,
                itemIndex: 0,
                noodleType: "probe",
                firmness: "normal",
                tableId: null,
              },
            ],
          }),
        }),
      );
    // The same spy must see both real successful transitions, before and after failure.
    expect((await arrive("a")).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    const first = received[0];
    if (!first || !isRecord(first.body) || !isRecord(first.committed))
      throw new Error("Missing positive control");
    // Assert outside the mock: requestPlan intentionally catches binding errors.
    expect(first.body.pending).toEqual(first.committed.orderItems);
    expect(first.body.pending).toHaveLength(1);
    const before = await state.storage.get("activeTimers");
    send.mockClear();
    put.mockClear();
    put.mockRejectedValueOnce(new Error("Injected Persist failure"));
    expect((await arrive("b")).status).toBe(503);
    expect(put).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(await state.storage.get("activeTimers")).toEqual(before);
    expect((await arrive("b")).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(2);
    const recovered = received[1];
    if (!recovered || !isRecord(recovered.body) || !isRecord(recovered.committed))
      throw new Error("Missing recovery control");
    expect(recovered.body.pending).toEqual(recovered.committed.orderItems);
    expect(recovered.body.pending).toHaveLength(2);
    send.mockClear();
    put.mockClear();
    expect((await arrive("b")).status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    holder.env = original;
  });
});
