// tests/cpsat-transport-consumer.example.test.ts — Queue consumer の 5 経路を名指しで固定する。
//
// **Validates: cpsat-planner-integration R5.3, R6.4, R6.7・design 第9節 9.1**
//
// producer 側（shim）の試験は別ファイルにある。こちらが見るのは受領側で、固定するのは
// 「何を ack し、何を retry し、何を記録するか」である。ここが緩むと、解かれなかった
// 要求が理由を残さずに消える（R6.4）か、同じ要求が予算を使い切って DLQ へ落ちる。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import solver from "../experiments/cpsat-workers/transport/solver";
import manifest from "../experiments/cpsat-workers/transport/manifest.json";
import fixtures from "../experiments/cpsat-workers/transport/fixtures.json";

const original = structuredClone(manifest);
const firstStore = manifest.stores[0];
const firstFixture = fixtures.fixtures[0];
// 空なら試験の前提が崩れている。`!` で黙らせず、その場で落として型も確定させる。
if (!firstStore || !firstFixture) throw new Error("Missing manifest fixture");
const store = firstStore;
const fixture = firstFixture;

/** 送出側が組むのと同じ形。版・窓・種別は既定で正しく、試験ごとに1つだけ崩す。 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    at: Date.now() - 1000,
    storeRef: store.ref,
    backend: "cpsat",
    mode: "probe",
    instanceId: crypto.randomUUID(),
    invocationId: crypto.randomUUID(),
    parentEventId: null,
    versions: {
      code: manifest.code,
      codec: manifest.codec,
      model: fixture.sha256,
      wasm: manifest.wasm,
      glue: manifest.glue,
      profile: manifest.profile,
      budget: String(fixture.budget),
      missingReason: null,
    },
    fact: {
      type: "cpsat.request-dispatched",
      requestId: crypto.randomUUID(),
      origin: { kind: "probe" },
      sameInputRetry: false,
    },
    ...overrides,
  };
}

function batchOf(body: unknown, attempts = 1) {
  const message = {
    id: "msg-1",
    timestamp: new Date(),
    attempts,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return { batch: { queue: "cpsat-plan-requests", messages: [message] }, message };
}

const env = {
  STORE_TIMER_DO: {
    idFromName: () => ({}),
    get: () => ({ deliverPlan: vi.fn(async () => ({ delivered: true })) }),
  },
};

let logs: string[];
beforeEach(() => {
  Object.assign(manifest, structuredClone(original));
  manifest.enabled = true;
  manifest.notBefore = Date.now() - 10_000;
  manifest.expiresAt = Date.now() + 60_000;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(line);
  });
});
afterEach(() => {
  Object.assign(manifest, structuredClone(original));
  vi.restoreAllMocks();
});

const receipts = () =>
  logs
    .map((line) => {
      try {
        return JSON.parse(line) as { transport?: string; outcome?: string };
      } catch {
        return {};
      }
    })
    .filter((parsed) => parsed.transport === "cpsat-queue-consumer");

/** 版違いは fetch なら 400 で落ちる。queue でも同じ関門を通り、解かずに ack する。 */
it("版が食い違う要求を解かずに ack し、理由を残す", async () => {
  const { batch, message } = batchOf({
    row: row({ versions: { ...row().versions, wasm: "0".repeat(64) } }),
  });
  await solver.queue?.(batch as never, env as never);
  expect(message.ack).toHaveBeenCalledTimes(1);
  expect(message.retry).not.toHaveBeenCalled();
  expect(receipts()).toEqual([expect.objectContaining({ outcome: "rejected" })]);
});

/** 窓の外も同じ。再配送しても結果は変わらないので ack する。 */
it("窓が閉じた後の要求を解かずに ack し、理由を残す", async () => {
  manifest.expiresAt = Date.now() - 1;
  const { batch, message } = batchOf({ row: row() });
  await solver.queue?.(batch as never, env as never);
  expect(message.ack).toHaveBeenCalledTimes(1);
  expect(receipts()).toEqual([expect.objectContaining({ outcome: "rejected" })]);
});

/** 壊れた body で handler ごと落とさない。読めないことも記録に値する。 */
it("壊れた body を handler を落とさずに ack し、requestId を null で残す", async () => {
  const { batch, message } = batchOf({ row: { not: "an observation" } });
  await solver.queue?.(batch as never, env as never);
  expect(message.ack).toHaveBeenCalledTimes(1);
  expect(receipts()).toEqual([expect.objectContaining({ outcome: "rejected", requestId: null })]);
});

/** 試行上限は一時的な拒否ではない。retry させずに ack して記録する。 */
it("試行上限に達した要求を retry させずに ack し、exhausted として残す", async () => {
  manifest.maxDispatches = 0;
  const { batch, message } = batchOf({ row: row() });
  await solver.queue?.(batch as never, env as never);
  expect(message.ack).toHaveBeenCalledTimes(1);
  expect(message.retry).not.toHaveBeenCalled();
  expect(receipts()).toEqual([expect.objectContaining({ outcome: "exhausted" })]);
});

/** 求解が落ち続けるとき、予算を使い切って無記録で DLQ へ落とさない。 */
it("deliver の失敗を1回は retry し、2回目以降は ack して記録する", async () => {
  const failing = {
    STORE_TIMER_DO: {
      idFromName: () => ({}),
      get: () => ({
        deliverPlan: () => {
          throw new Error("injected");
        },
      }),
    },
  };
  const first = batchOf({ row: row() }, 1);
  await solver.queue?.(first.batch as never, failing as never);
  expect(first.message.retry).toHaveBeenCalledTimes(1);
  expect(first.message.ack).not.toHaveBeenCalled();

  const later = batchOf({ row: row() }, 2);
  await solver.queue?.(later.batch as never, failing as never);
  expect(later.message.ack).toHaveBeenCalledTimes(1);
  expect(receipts()).toContainEqual(expect.objectContaining({ outcome: "deliver-failed" }));
});

/**
 * 配送遅延の主たる測定値がここにしか無い。受理された要求に行が出なければ、
 * 測る対象そのものが観測に残らず、2.5 の「欠測は合格にしない」に自分から当たる。
 */
it("受理にも受領行を出し、投入から受領までを時計 1 つで残す", async () => {
  const { batch, message } = batchOf({ row: row() });
  const enqueued = new Date(Date.now() - 120);
  (message as { timestamp: Date }).timestamp = enqueued;
  await solver.queue?.(batch as never, env as never);
  // この単体試験の env では実 WASM を読めないので `deliver` は失敗し、attempts 1 ゆえ
  // retry になる。確かめたいのは**受領行が `deliver` の前に出ていること**である
  // ——失敗しても測定対象の行は残らなければならない。
  expect(message.retry).toHaveBeenCalledTimes(1);
  const accepted = receipts().find((entry) => entry.outcome === "accepted") as
    | { enqueuedAt?: number; receivedAt?: number; attempts?: number }
    | undefined;
  expect(accepted).toBeDefined();
  expect(accepted?.enqueuedAt).toBe(enqueued.getTime());
  // 受領は投入より後で、差が配送遅延である。
  expect(accepted?.receivedAt).toBeGreaterThanOrEqual(enqueued.getTime());
  expect(accepted?.attempts).toBe(1);
});
