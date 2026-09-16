// tests/shell/command-rejected-log.integration.test.ts — **現場の操作が拒否されたら記録が残る**。
//
// **Validates: online-cook-scheduling R1.5, R3.8**
//
// 拒否は Effect 列を生まず、要求元の WS へ `error` を返すだけなので、**サーバ側には痕跡が
// 一切残らなかった**。1108 で「スタートを押したのに走行中が 0 のまま」という観測が出たとき、
// 届かなかったのか（WS 切断）拒否されたのか（engine の判定）を**ログから区別できなかった**
// （2026-09-13）。
//
// 主張は 2 つ。**拒否は 1 行残る。成功は残さない**（成功は確定の副産物から追えるし、量になる）。
import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { StoreProjection } from "../../src/registry/projection";
import { configResidualDefaults } from "../storeConfigDefaults";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const PRESET = "sample-noodle";

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
      menuItems: [],
    },
  };
  await stub.applyProjection(projection);
  return stub;
}

/** WS の代役。`send` を受け取るだけで、DO からは本物の WebSocket に見える。 */
function fakeSocket(sent: string[]): WebSocket {
  return { send: (text: string) => sent.push(text) } as unknown as WebSocket;
}

/** 構造化ログ（1 行 1 JSON）を拾う。 */
function captureLines(): Record<string, unknown>[] {
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
  return lines;
}

it("**拒否された開始は 1 行残る**（種別と理由コード）", async () => {
  const storeId = `reject-${crypto.randomUUID()}`;
  const stub = await provisioned(storeId);
  const lines = captureLines();
  const sent: string[] = [];
  await runInDurableObject(stub, async (instance) => {
    const holder = instance as unknown as {
      webSocketMessage(ws: WebSocket, message: string): Promise<void>;
    };
    // 在りもしない品目を指す開始。engine は `OrderItemNotFound` で拒否する。
    await holder.webSocketMessage(
      fakeSocket(sent),
      JSON.stringify({
        type: "startOrderItem",
        slotIds: ["0"],
        externalOrderId: "no-such-order",
        itemIndex: 0,
      }),
    );
  });

  // 要求元へは error が返る（従来どおり）。
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!)).toMatchObject({ type: "error" });
  // **そして記録が残る。**
  const rejected = lines.filter((line) => line.kind === "command-rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ storeId, command: "StartOrderItem" });
  expect(typeof rejected[0]!.code).toBe("string");
});

it("形式不正の命令は engine へ届かず、記録も残さない（破棄は拒否ではない）", async () => {
  const storeId = `malformed-${crypto.randomUUID()}`;
  const stub = await provisioned(storeId);
  const lines = captureLines();
  const sent: string[] = [];
  await runInDurableObject(stub, async (instance) => {
    const holder = instance as unknown as {
      webSocketMessage(ws: WebSocket, message: string): Promise<void>;
    };
    await holder.webSocketMessage(fakeSocket(sent), "{ not json");
  });

  expect(sent).toHaveLength(0);
  expect(lines.filter((line) => line.kind === "command-rejected")).toHaveLength(0);
});
