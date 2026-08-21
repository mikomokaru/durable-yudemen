// tests/worker/pos-observation.integration.test.ts — POS_Ingress の観測（12 カウンタと診断ログ）の統合テスト
// （Workers pool）。
//
// _Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12,
// 12.13, 12.14, 12.15, 9.3, 9.4, 9.12_
//
// 観測手法：出力先は構造化 `console.log` ただ一つ（新しい binding を持たない）ゆえ、`console.log` を横取りして
// 行そのものを読む。カウンタの由来は 3 つに分かれる（Worker 自身・`ReceiveOutcome.counts`・`HoldOutcome.counts`）
// ため、宛先 DO とレジストリを差し替えた env で「返ってきた件数が 1 行へ畳まれるか」を見る。
//
// `replayWindowExpired` だけは実物の StoreRegistryDO で観測する——このカウンタは POS のリクエストの文脈に
// 乗らず（再生は Alarm 由来でも起きる）、再生の地点でしか出せない。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import worker, { forgetResolvedStoreIds } from "../../src/worker";
import type { ArrivalRecord } from "../../src/ingress/batch";
import { ARRIVAL_WINDOW_MS } from "../../src/ingress/arrival-window";
import type { HeldRecord } from "../../src/registry/held-record";
import {
  REGISTRY_NAME,
  type HoldOutcome,
  type StoreRegistryDO,
  unroutedKey,
} from "../../src/shell/store-registry-do";
import type { ReceiveOutcome } from "../../src/shell/store-timer-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "pos-ingress-token";

/** design「観測値の出力先」の 12 カウンタ。**この列がカウンタ名の期待値そのものである。** */
const COUNTER_NAMES = [
  "poisonRecord",
  "unknownPath",
  "statusDiscarded",
  "unknownStorePending",
  "doDedupeSkipped",
  "upstreamContractViolation",
  "unauthorized",
  "deactivatedStore",
  "unknownNoodleType",
  "heldExpired",
  "heldOverflow",
  "replayWindowExpired",
] as const;

/** リクエストの 1 行が運ぶ 11 個（`replayWindowExpired` は再生の地点が出す）。 */
const REQUEST_COUNTER_NAMES = COUNTER_NAMES.filter((name) => name !== "replayWindowExpired");

interface Harness {
  readonly testEnv: Env;
  readonly deliveries: string[];
  readonly resolveCalls: string[];
  readonly holds: string[];
}

function harness(params?: {
  readonly index?: Readonly<Record<string, string>>;
  readonly outcome?: (storeId: string) => ReceiveOutcome;
  readonly holdOutcome?: (storeCode: string) => HoldOutcome;
}): Harness {
  const deliveries: string[] = [];
  const resolveCalls: string[] = [];
  const holds: string[] = [];
  const index = params?.index ?? {};
  const outcome =
    params?.outcome ?? (() => ({ kind: "settled", counts: { doDedupeSkipped: 0, unknownNoodleType: 0 } }));
  const holdOutcome =
    params?.holdOutcome ??
    (() => ({ kind: "held", counts: { heldExpired: 0, heldOverflow: 0 } }));

  const timerNamespace = {
    idFromName: (name: string) => ({ storeId: name }),
    get: (id: { readonly storeId: string }) => ({
      receiveRecords: (_records: readonly ArrivalRecord[]) => {
        deliveries.push(id.storeId);
        return Promise.resolve(outcome(id.storeId));
      },
    }),
  } as unknown as Env["STORE_TIMER_DO"];

  const registryNamespace = {
    getByName: (_name: string) => ({
      resolveStoreCode: (storeCode: string) => {
        resolveCalls.push(storeCode);
        return Promise.resolve(index[storeCode]);
      },
      holdUnrouted: (storeCode: string, _records: readonly ArrivalRecord[]) => {
        holds.push(storeCode);
        return Promise.resolve(holdOutcome(storeCode));
      },
      quarantineContractViolations: (storeCode: string, _raws: readonly unknown[]) =>
        Promise.resolve(holdOutcome(storeCode)),
    }),
  } as unknown as Env["STORE_REGISTRY_DO"];

  const testEnv = {
    ...env,
    STORE_TIMER_DO: timerNamespace,
    STORE_REGISTRY_DO: registryNamespace,
    ORDER_INGRESS_TOKEN: TOKEN,
  } as unknown as Env;

  return { testEnv, deliveries, resolveCalls, holds };
}

function postRecords(body: unknown, options?: { readonly token?: string | null }): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const token = options?.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return new Request("https://ingress.invalid/pos/records", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** 実データに近い形の Order_Path。値域窓の内側（受理時刻の直前）に置く。 */
function orderRecord(params: {
  readonly storeCode: string | number;
  readonly seq: string;
  readonly path?: string;
}): unknown {
  return {
    path: params.path ?? "/lio/order",
    payload: {
      store_id: params.storeCode,
      terminal_id: 1,
      bill_no: 1,
      datetime: PAYLOAD_DATETIME,
    },
    arrival_timestamp_ms: Date.now() - 1000,
    sequence_number: params.seq,
  };
}

/** ペイロード本体がログへ出ていないことを見る目印（この値が行に現れたら個票が漏れている）。 */
const PAYLOAD_DATETIME = "2026-08-17T20:52:19";

/** 横取りした `console.log` の行（JSON 文字列）。 */
function capture(): { readonly lines: () => readonly string[] } {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return { lines: () => log.mock.calls.map((call) => String(call[0])) };
}

function parsed(lines: readonly string[], kind: string): readonly Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.posIngress === kind);
}

beforeEach(() => {
  forgetResolvedStoreIds();
  vi.restoreAllMocks();
});

describe("カウンタは 1 リクエストにつき 1 行（Requirements 12.13, 12.15）", () => {
  it("12 カウンタのうち 11 個を design の名前で 1 行に畳む（0 のものも省かない）", async () => {
    const h = harness({
      index: { A: "store-a", D: "store-d" },
      outcome: (storeId) =>
        storeId === "store-d"
          ? { kind: "deactivated" }
          : { kind: "settled", counts: { doDedupeSkipped: 2, unknownNoodleType: 3 } },
      // 保留（Z）と隔離（A）で件数を分ける——同じ 2 種を 2 箇所から集めることを見分けるため。
      holdOutcome: (storeCode) =>
        storeCode === "Z"
          ? { kind: "held", counts: { heldExpired: 4, heldOverflow: 5 } }
          : { kind: "held", counts: { heldExpired: 0, heldOverflow: 0 } },
    });
    const captured = capture();

    const response = await worker.fetch(
      postRecords({
        records: [
          // 毒（`path` 欠落）
          { payload: { store_id: "A" }, arrival_timestamp_ms: Date.now(), sequence_number: "1" },
          // 未知 `path`
          orderRecord({ storeCode: "A", seq: "2", path: "/lio/unknown" }),
          // Status_Path（意図的な破棄）
          orderRecord({ storeCode: "A", seq: "3", path: "/lio/status" }),
          // 上流の契約違反（値域窓の外）→ 隔離（A）
          { path: "/lio/order", payload: { store_id: "A" }, arrival_timestamp_ms: 0, sequence_number: "4" },
          // 確定する店舗（重複吸収 2 件・未知麺種 3 件を返す）
          orderRecord({ storeCode: "A", seq: "5" }),
          // 宛先未解決 → 保留（Z）
          orderRecord({ storeCode: "Z", seq: "6" }),
          // 非活性店舗
          orderRecord({ storeCode: "D", seq: "7" }),
        ],
      }),
      h.testEnv,
    );

    expect(response.status).toBe(200);
    const counts = parsed(captured.lines(), "counts");
    // 1 リクエストにつき 1 行（店舗が 3 つ在っても行は増えない）。
    expect(counts).toHaveLength(1);
    expect(counts[0]).toEqual({
      posIngress: "counts",
      poisonRecord: 1,
      unknownPath: 1,
      statusDiscarded: 1,
      unknownStorePending: 1,
      doDedupeSkipped: 2,
      upstreamContractViolation: 1,
      unauthorized: 0,
      deactivatedStore: 1,
      unknownNoodleType: 3,
      heldExpired: 4,
      heldOverflow: 5,
    });
  });

  it("カウンタ名は design の 12 個に一致する（過不足を作らない）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const captured = capture();

    await worker.fetch(postRecords({ records: [orderRecord({ storeCode: "A", seq: "1" })] }), h.testEnv);

    const counts = parsed(captured.lines(), "counts")[0] ?? {};
    expect(Object.keys(counts).filter((key) => key !== "posIngress")).toEqual([...REQUEST_COUNTER_NAMES]);
  });

  it("一時的失敗（5xx）のリクエストでも 1 行出る（観測が応答の種類に依存しない）", async () => {
    const h = harness({ index: { A: "store-a" }, outcome: () => ({ kind: "persist-failed" }) });
    const captured = capture();

    const response = await worker.fetch(
      postRecords({ records: [orderRecord({ storeCode: "A", seq: "1" })] }),
      h.testEnv,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(parsed(captured.lines(), "counts")).toHaveLength(1);
  });
});

describe("診断ログは sequence_number と理由の 2 項目のみ（Requirements 9.3, 12.6）", () => {
  it("毒レコードごとに 1 行出し、ペイロード本体を含めない", async () => {
    const h = harness({ index: { A: "store-a" } });
    const captured = capture();

    await worker.fetch(
      postRecords({
        records: [
          // `path` 欠落
          { payload: { store_id: "A", datetime: PAYLOAD_DATETIME }, arrival_timestamp_ms: Date.now(), sequence_number: "1" },
          // Unique_Key 不完全（4 要素のうち datetime が無い）
          {
            path: "/lio/order",
            payload: { store_id: "A", terminal_id: 1, bill_no: 1 },
            arrival_timestamp_ms: Date.now() - 1000,
            sequence_number: "2",
          },
        ],
      }),
      h.testEnv,
    );

    const lines = captured.lines();
    const diagnostics = parsed(lines, "diagnostic");
    expect(diagnostics).toEqual([
      { posIngress: "diagnostic", reason: "path-missing", sequenceNumber: "1" },
      { posIngress: "diagnostic", reason: "unique-key-incomplete", sequenceNumber: "2" },
    ]);
    // ペイロード本体がどの行にも現れない（個票の内容をログへ残さない・AC 9.3 の芯）。
    for (const line of lines) {
      expect(line).not.toContain(PAYLOAD_DATETIME);
      expect(line).not.toContain("store_id");
      expect(line).not.toContain("payload");
    }
  });

  it("seq を読めない毒は理由だけを出す（推測で埋めない）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const captured = capture();

    await worker.fetch(
      postRecords({
        records: [
          // `sequence_number` 欠落（上流が毒として除外済みゆえ本来届かない・Req 10.4）。到着時刻は窓の内側に
          // 置く——型・値域が破れれば分類は契約違反へ落ち、毒の診断にならない。
          { path: "/lio/order", payload: { store_id: "A" }, arrival_timestamp_ms: Date.now() - 1000 },
        ],
      }),
      h.testEnv,
    );

    expect(parsed(captured.lines(), "diagnostic")).toEqual([
      { posIngress: "diagnostic", reason: "sequence-number-missing" },
    ]);
  });

  it("Store_Code を読めない契約違反は診断で seq を残す（隔離に証跡が残らない唯一の経路）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const captured = capture();

    await worker.fetch(
      postRecords({
        records: [
          { path: "/lio/order", payload: { store_id: {} }, arrival_timestamp_ms: "0", sequence_number: "9" },
        ],
      }),
      h.testEnv,
    );

    expect(parsed(captured.lines(), "diagnostic")).toEqual([
      { posIngress: "diagnostic", reason: "store-code-unreadable", sequenceNumber: "9" },
    ]);
    expect(parsed(captured.lines(), "counts")[0]?.upstreamContractViolation).toBe(1);
  });

  it("Status_Path と未知 `path` は数えるだけで診断を出さない（定常のノイズにしない）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const captured = capture();

    await worker.fetch(
      postRecords({
        records: [
          orderRecord({ storeCode: "A", seq: "1", path: "/lio/status" }),
          orderRecord({ storeCode: "A", seq: "2", path: "/lio/unknown" }),
        ],
      }),
      h.testEnv,
    );

    expect(parsed(captured.lines(), "diagnostic")).toEqual([]);
    const counts = parsed(captured.lines(), "counts")[0];
    expect(counts?.statusDiscarded).toBe(1);
    expect(counts?.unknownPath).toBe(1);
  });
});

describe("認可失敗の観測は Worker 内で完結する（Requirements 9.12, 12.8）", () => {
  it("unauthorized を数えて診断を 1 行出し、DO へ到達しない", async () => {
    const h = harness({ index: { A: "store-a" } });
    const captured = capture();

    const response = await worker.fetch(
      postRecords({ records: [orderRecord({ storeCode: "A", seq: "1" })] }, { token: "wrong-token" }),
      h.testEnv,
    );

    expect(response.status).toBe(401);
    // StoreRegistryDO・StoreTimerDO のいずれも起こさない（観測が状態の入口を叩かない）。
    expect(h.resolveCalls).toEqual([]);
    expect(h.deliveries).toEqual([]);
    expect(h.holds).toEqual([]);
    const counts = parsed(captured.lines(), "counts");
    expect(counts).toHaveLength(1);
    expect(counts[0]?.unauthorized).toBe(1);
    expect(parsed(captured.lines(), "diagnostic")).toEqual([
      { posIngress: "diagnostic", reason: "unauthorized" },
    ]);
  });
});

describe("破棄の 3 つは別のカウンタである（Requirements 12.12）", () => {
  it("heldExpired と heldOverflow は畳まれず、それぞれの値で出る", async () => {
    const h = harness({
      index: {},
      holdOutcome: () => ({ kind: "held", counts: { heldExpired: 7, heldOverflow: 11 } }),
    });
    const captured = capture();

    await worker.fetch(postRecords({ records: [orderRecord({ storeCode: "Z", seq: "1" })] }), h.testEnv);

    const counts = parsed(captured.lines(), "counts")[0];
    expect(counts?.heldExpired).toBe(7);
    expect(counts?.heldOverflow).toBe(11);
    // 3 つ目は再生の地点が出す（リクエストの行に混ぜない）。
    expect(counts).not.toHaveProperty("replayWindowExpired");
  });

  it("replayWindowExpired は再生の地点（StoreRegistryDO）が別の行で出す", async () => {
    const stub = env.STORE_REGISTRY_DO.get(
      env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME),
    ) as unknown as DurableObjectStub<StoreRegistryDO>;
    const storeCode = "8801";
    const created = await stub.fetch(
      new Request("https://registry/admin/stores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: "observe-replay",
          chainId: "yamaokaya",
          name: `${storeCode} 店`,
          storeCode,
        }),
      }),
    );
    expect(created.status).toBe(201);

    // 保持を始めたのは今だが、Order_Arrival_Time は既に値域窓の外にある（再生の遅れがこの形で現れる）。
    const outside: HeldRecord = {
      kind: "unrouted",
      heldAt: Date.now(),
      record: {
        path: "/lio/order",
        payload: { store_id: storeCode, terminal_id: "1", bill_no: "1", datetime: PAYLOAD_DATETIME },
        arrivalTimestampMs: Date.now() - ARRIVAL_WINDOW_MS - 60_000,
        sequenceNumber: "1".padStart(56, "0"),
      },
    };
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put(unroutedKey(storeCode), [outside]),
    );

    const captured = capture();
    // 既知コードへの保留は同一リクエスト内で再生を起こす（新たな Record は足さない）。
    const outcome = await stub.holdUnrouted(storeCode, []);
    expect(outcome.kind).toBe("held");

    const replay = parsed(captured.lines(), "replayWindowExpired");
    expect(replay).toEqual([{ posIngress: "replayWindowExpired", discarded: 1 }]);
    // 窓の外の Record は再保留されない（破棄が件数として残る）。
    const held = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get(unroutedKey(storeCode)),
    );
    expect(held).toBeUndefined();
  });
});
