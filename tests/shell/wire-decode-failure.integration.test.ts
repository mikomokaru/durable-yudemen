// tests/shell/wire-decode-failure.integration.test.ts — Property 6（shell 側）。
//
// **Validates: Requirements 2.8, 2.10**
//
// 記録を出すのは Decoder ではなく受け口である。ここは実 workerd 上で壊れた ClientMessage を送り、
// 記録が 1 件残ることと Working_Copy が変わらないことをプラットフォーム側から観測する。
//
// Working_Copy の不変は永続キーで見る。復号に失敗した要求は engine へ進まないため `storage.put` が
// 起きず、SNAPSHOT_KEY は接続前と同一のままである（メモリへの代入は永続化ではない、という規律の裏返し
// ——put が起きないことをもって「確定していない」と言える）。
//
// 記録の中身は `console.error` を包んで観測する。`src/**` は一文字も変えない。

import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { StoreProjection } from "../../src/registry/projection";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import { configResidualDefaults } from "../storeConfigDefaults";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** タイマー SSOT の単一キー。store-timer-do.ts の SNAPSHOT_KEY（private 定数）と一致させる。 */
const SNAPSHOT_KEY = "activeTimers";

const NOODLE = "DecodeRamen";
const UNIT_COUNT = 1;

const storeConfig: StoreConfig = {
  unitCount: UNIT_COUNT,
  arms: 2,
  toleranceRatio: 10,
  noodlePresets: [
    { noodleType: NOODLE, boilSeconds: { extraHard: 90, hard: 100, normal: 110, soft: 120 } },
  ] as NonEmptyArray<NoodlePreset>,
  ...configResidualDefaults(UNIT_COUNT),
};

const projection: StoreProjection = { config: storeConfig, roster: [], active: true, version: 1 };

function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

async function provision(storeId: string): Promise<DurableObjectStub<StoreTimerDO>> {
  const stub = storeStub(storeId);
  await stub.applyProjection(projection);
  return stub;
}

/** WS を張って client 端を accept する（送るだけなのでフレーム収集はしない）。 */
async function connect(stub: DurableObjectStub<StoreTimerDO>): Promise<WebSocket> {
  const upgrade = await stub.fetch("https://do.invalid/s/store/ws", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgrade.webSocket;
  if (ws === null) throw new Error(`WS 接続が確立されなかった（status=${upgrade.status}）`);
  ws.accept();
  return ws;
}

/** DO インスタンス側の永続 SSOT を読む（Working_Copy の確定状態を永続から見る）。 */
async function persistedSnapshot(stub: DurableObjectStub<StoreTimerDO>): Promise<unknown> {
  return runInDurableObject(stub, async (_instance, state) => state.storage.get(SNAPSHOT_KEY));
}

/**
 * 記録が指定の本数に達するまで待つ。
 *
 * 固定の sleep では待たない——主張は「記録が n 件」であり、待機もその言葉で書く。通算本数は単調に
 * 増えるため、遡りが取り違えを生まない（既存 shell 統合テストと同じ作法）。
 */
async function waitForRecords(
  lines: readonly string[],
  count: number,
  timeoutMs = 5_000,
): Promise<readonly string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const failures = lines.filter((line) => line.includes("decode-failure"));
    if (failures.length >= count) return failures;
    if (Date.now() > deadline) {
      throw new Error(`記録の待機がタイムアウトした（${failures.length}/${count} 件）`);
    }
    await scheduler.wait(1);
  }
}

describe("Feature: verified-wire-contract, Property 6: Decode_Failure の可観測性（shell）", () => {
  it("壊れた ClientMessage は記録を 1 件残し、永続 SSOT を変えない", async () => {
    const stub = await provision("decode-failure-store");
    const before = await persistedSnapshot(stub);
    const ws = await connect(stub);

    const lines: string[] = [];
    let failures: readonly string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
    try {
      // 未知の種別・必須項目の欠落・撤去済み種別。いずれも engine へ進まない。
      ws.send(JSON.stringify({ type: "whatever" }));
      ws.send(JSON.stringify({ type: "start", slotIds: [] }));
      ws.send(JSON.stringify({ type: "boiled", timerId: "T" }));
      failures = await waitForRecords(lines, 3);
    } finally {
      ws.close();
    }

    expect(failures).toHaveLength(3);
    expect(JSON.parse(failures[0] ?? "{}")).toEqual({
      kind: "decode-failure",
      contract: "ClientMessage",
    });
    expect(await persistedSnapshot(stub)).toEqual(before);
  });

  it("記録に Wire_Text の中身（POS 由来の識別子）が入らない", async () => {
    const stub = await provision("decode-failure-pii-store");
    const ws = await connect(stub);

    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(String(args[0]));
    };
    try {
      ws.send(
        JSON.stringify({
          type: "start",
          slotIds: [],
          externalOrderId: "secret-order",
          itemIndex: 0,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      console.error = original;
    }

    const failures = lines.filter((line) => line.includes("decode-failure"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toContain("secret-order");
  });
});

afterEach(async () => {
  // 接続と DO の状態をテスト間で持ち越さない（既存 shell 統合テストと同じ作法）。
  vi.restoreAllMocks();
  await reset();
});
