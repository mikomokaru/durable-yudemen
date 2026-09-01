// tests/worker/pos-records.integration.test.ts — POS_Ingress（POST /pos/records）の受け口・Code_Memo・
// fan-out・失敗分類（Workers pool）。
//
// _Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.9, 1.11, 1.12, 1.13, 4.1, 4.2, 4.4, 4.7, 5.2, 5.3,
// 5.4, 5.8, 9.2, 9.5_
//
// 観測手法（宛先 DO と レジストリの横取り）：本テストの関心は「Worker が誰へ何を渡すか」であって DO 内部の
// 遷移ではない。ゆえに worker.fetch の env に STORE_TIMER_DO / STORE_REGISTRY_DO を横取りする namespace を
// 差し込み、委譲の回数・並び・結末ごとの応答を直接観測する（DO 本体は タスク 15 で検証済み）。
//
// Code_Memo はモジュールスコープゆえテスト間で持ち越される（テストは isolate を共有する）。ゆえに各ケースの
// 前に forgetResolvedStoreIds で明示的に空へ戻す——これが Property 7 の検証が要する手段である。

import { beforeEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { env } from "cloudflare:test";
import worker, { forgetResolvedStoreIds } from "../../src/worker";
import type { ArrivalRecord } from "../../src/ingress/batch";
import { IDENTITY_HEADER, type ReceiveOutcome } from "../../src/shell/store-timer-do";
import type { HoldOutcome } from "../../src/shell/store-registry-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "pos-ingress-token";

/** 1 回の委譲（receiveRecords）の観測値。宛先 StoreId と、渡された Record 列（到着順）。 */
interface Delivery {
  readonly storeId: string;
  readonly records: readonly ArrivalRecord[];
}

/** 1 回の保留（holdUnrouted）または隔離（quarantineContractViolations）の観測値。 */
interface Hold {
  readonly storeCode: string;
  readonly items: readonly unknown[];
}

interface Harness {
  readonly testEnv: Env;
  /** 宛先 DO への委譲（店舗ごとに 1 回であることを件数で検める）。 */
  readonly deliveries: Delivery[];
  /** レジストリへの照会（Code_Memo が効けば 2 回目は現れない）。 */
  readonly resolveCalls: string[];
  /** 宛先未解決の保留（`unrouted:{storeCode}`）。 */
  readonly holds: Hold[];
  /** 上流の契約違反の隔離（`contract-violation:{storeCode}`）。 */
  readonly quarantines: Hold[];
  /** 宛先 DO へ転送された Request。RPC 委譲ゆえ常に空である（ヘッダの運搬経路が無い）。 */
  readonly forwarded: Request[];
}

const SETTLED: ReceiveOutcome = {
  kind: "settled",
  counts: { doDedupeSkipped: 0, unknownNoodleType: 0 },
};

const HELD: HoldOutcome = { kind: "held", counts: { heldExpired: 0, heldOverflow: 0 } };

function harness(params?: {
  /** Code_Index の中身（Store_Code → StoreId）。載っていないコードは未知として応答する。 */
  readonly index?: Readonly<Record<string, string>>;
  /** 宛先ごとの結末。既定は確定（settled）。 */
  readonly outcome?: (storeId: string) => ReceiveOutcome;
  /** 保留・隔離の結末。既定は保持成功（held）。 */
  readonly holdOutcome?: (storeCode: string) => HoldOutcome;
  readonly token?: string;
}): Harness {
  const deliveries: Delivery[] = [];
  const resolveCalls: string[] = [];
  const holds: Hold[] = [];
  const quarantines: Hold[] = [];
  const forwarded: Request[] = [];
  const index = params?.index ?? {};
  const outcome = params?.outcome ?? (() => SETTLED);
  const holdOutcome = params?.holdOutcome ?? (() => HELD);

  const timerNamespace = {
    idFromName: (name: string) => ({ storeId: name }),
    get: (id: { readonly storeId: string }) => ({
      receiveRecords: (records: readonly ArrivalRecord[]) => {
        deliveries.push({ storeId: id.storeId, records });
        return Promise.resolve(outcome(id.storeId));
      },
      fetch: (request: Request) => {
        // 本経路は Request を転送しない。ここへ来たら委譲の形が変わった合図である。
        forwarded.push(request);
        return new Response("unexpected", { status: 500 });
      },
    }),
  } as unknown as Env["STORE_TIMER_DO"];

  const registryNamespace = {
    getByName: (_name: string) => ({
      resolveStoreCode: (storeCode: string) => {
        resolveCalls.push(storeCode);
        return Promise.resolve(index[storeCode]);
      },
      holdUnrouted: (storeCode: string, records: readonly ArrivalRecord[]) => {
        holds.push({ storeCode, items: records });
        return Promise.resolve(holdOutcome(storeCode));
      },
      quarantineContractViolations: (storeCode: string, raws: readonly unknown[]) => {
        quarantines.push({ storeCode, items: raws });
        return Promise.resolve(holdOutcome(storeCode));
      },
    }),
  } as unknown as Env["STORE_REGISTRY_DO"];

  const testEnv = {
    ...env,
    STORE_TIMER_DO: timerNamespace,
    STORE_REGISTRY_DO: registryNamespace,
    ORDER_INGRESS_TOKEN: params?.token ?? TOKEN,
  } as unknown as Env;

  return { testEnv, deliveries, resolveCalls, holds, quarantines, forwarded };
}

/** postRecords — POS_Ingress へのリクエストを組む。token に null を渡せば Authorization を付けない。 */
function postRecords(
  body: unknown,
  options?: {
    readonly token?: string | null;
    readonly method?: string;
    readonly identity?: string;
  },
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const token = options?.token === undefined ? TOKEN : options.token;
  if (token !== null) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (options?.identity !== undefined) {
    headers.set(IDENTITY_HEADER, options.identity);
  }
  const method = options?.method ?? "POST";
  return new Request("https://ingress.invalid/pos/records", {
    method,
    headers,
    body:
      method === "GET" || method === "HEAD"
        ? null
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}

/** orderRecord — Order_Path の生 Record。到着時刻は値域窓の内側（受理時刻の直前）に置く。 */
function orderRecord(params: {
  readonly storeCode: string | number;
  readonly seq: string;
  readonly billNo?: number;
  readonly path?: string;
}): unknown {
  return {
    path: params.path ?? "/lio/order",
    payload: {
      store_id: params.storeCode,
      terminal_id: 1,
      bill_no: params.billNo ?? 1,
      datetime: "2026-08-17T20:52:19",
    },
    arrival_timestamp_ms: Date.now() - 1000,
    sequence_number: params.seq,
  };
}

beforeEach(() => {
  forgetResolvedStoreIds();
});

describe("POST /pos/records — メソッドと認可（Requirements 1.2〜1.6）", () => {
  it("POST 以外は 405 で、宛先解決も委譲も起こさない", async () => {
    const h = harness({ index: { A: "store-a" } });
    const response = await worker.fetch(postRecords(null, { method: "GET" }), h.testEnv);

    expect(response.status).toBe(405);
    expect(h.resolveCalls).toEqual([]);
    expect(h.deliveries).toEqual([]);
  });

  it("Authorization 欠如は 401 で、レジストリ・店舗 DO のいずれへも到達しない", async () => {
    const h = harness({ index: { A: "store-a" } });
    const response = await worker.fetch(
      postRecords({ records: [orderRecord({ storeCode: "A", seq: "1" })] }, { token: null }),
      h.testEnv,
    );

    expect(response.status).toBe(401);
    expect(h.resolveCalls).toEqual([]);
    expect(h.deliveries).toEqual([]);
  });

  it("トークン不一致は 401", async () => {
    const h = harness({ index: { A: "store-a" } });
    const response = await worker.fetch(
      postRecords(
        { records: [orderRecord({ storeCode: "A", seq: "1" })] },
        { token: "wrong-token" },
      ),
      h.testEnv,
    );

    expect(response.status).toBe(401);
    expect(h.deliveries).toEqual([]);
  });

  it("ORDER_INGRESS_TOKEN が未設定（空）なら、いかなる Bearer でも不許可（AC 1.4）", async () => {
    const h = harness({ index: { A: "store-a" }, token: "" });
    const response = await worker.fetch(
      postRecords({ records: [orderRecord({ storeCode: "A", seq: "1" })] }, { token: "" }),
      h.testEnv,
    );

    expect(response.status).toBe(401);
    expect(h.deliveries).toEqual([]);
  });
});

describe("POST /pos/records — ボディの形と件数上限（Requirements 1.11〜1.13）", () => {
  it("records 配列を成さないボディは 400（何も確定しない）", async () => {
    const h = harness({ index: { A: "store-a" } });

    const bodies: readonly unknown[] = [{}, { records: {} }, { records: "1" }, "not json", []];
    const statuses = await Promise.all(
      bodies.map(async (body) => (await worker.fetch(postRecords(body), h.testEnv)).status),
    );

    expect(statuses).toEqual([400, 400, 400, 400, 400]);
    expect(h.deliveries).toEqual([]);
  });

  it("空配列は受理する（全件が上流で除外された結果を失敗としない・AC 1.12）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const response = await worker.fetch(postRecords({ records: [] }), h.testEnv);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(h.deliveries).toEqual([]);
  });

  it("1001 件は 5xx で、何も委譲しない（上流の bisect に分割させる・AC 1.13）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const records = Array.from({ length: 1001 }, (_unused, i) =>
      orderRecord({ storeCode: "A", seq: `${i}` }),
    );
    const response = await worker.fetch(postRecords({ records }), h.testEnv);

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(h.deliveries).toEqual([]);
  });

  it("1000 件は受理し、1 店舗へ 1 回でまとめて渡す（上限そのものは通す）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const records = Array.from({ length: 1000 }, (_unused, i) =>
      orderRecord({ storeCode: "A", seq: `${i}`, billNo: i }),
    );
    const response = await worker.fetch(postRecords({ records }), h.testEnv);

    expect(response.status).toBe(200);
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]?.records).toHaveLength(1000);
  });
});

describe("POST /pos/records — fan-out（Requirements 5.2, 5.3, 5.4）", () => {
  it("複数店舗混在は各店へ 1 回ずつ委譲し、同一店舗内は到着順を保つ", async () => {
    const h = harness({ index: { A: "store-a", B: "store-b" } });
    const response = await worker.fetch(
      postRecords({
        records: [
          orderRecord({ storeCode: "A", seq: "1", billNo: 11 }),
          orderRecord({ storeCode: "B", seq: "2", billNo: 21 }),
          orderRecord({ storeCode: "A", seq: "3", billNo: 12 }),
          orderRecord({ storeCode: "A", seq: "4", billNo: 13 }),
        ],
      }),
      h.testEnv,
    );

    expect(response.status).toBe(200);
    // 店舗ごとに 1 回（同一 Store_Code が 3 回現れても委譲は 1 回に畳まれる）。
    expect(h.deliveries).toHaveLength(2);
    const toA = h.deliveries.find((d) => d.storeId === "store-a");
    const toB = h.deliveries.find((d) => d.storeId === "store-b");
    // 到着順のまま（並びが崩れれば下流の単調性による冪等が意味を失う）。
    expect(toA?.records.map((r) => r.sequenceNumber)).toEqual(["1", "3", "4"]);
    expect(toB?.records.map((r) => r.sequenceNumber)).toEqual(["2"]);
    // 同一 Store_Code の照会は 1 回だけ（AC 4.7）。
    expect(h.resolveCalls.filter((code) => code === "A")).toEqual(["A"]);
  });
});

describe("POST /pos/records — Code_Memo（Requirements 4.1, 4.2, 4.4）", () => {
  it("2 回目の解決でレジストリへ照会しない", async () => {
    const h = harness({ index: { A: "store-a" } });
    const body = { records: [orderRecord({ storeCode: "A", seq: "1" })] };

    await worker.fetch(postRecords(body), h.testEnv);
    await worker.fetch(postRecords(body), h.testEnv);

    expect(h.resolveCalls).toEqual(["A"]);
    expect(h.deliveries).toHaveLength(2);
  });

  it("未知の Store_Code はキャッシュせず、毎回照会する（後の店舗登録で既知に転じる・AC 4.4）", async () => {
    const h = harness({ index: {} });
    const body = { records: [orderRecord({ storeCode: "Z", seq: "1" })] };

    // 宛先未解決の Record は捨てず保留へ回る（AC 11.1）。保持が成功した上でバッチが受理される。
    const first = await worker.fetch(postRecords(body), h.testEnv);
    const second = await worker.fetch(postRecords(body), h.testEnv);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.resolveCalls).toEqual(["Z", "Z"]);
    expect(h.deliveries).toEqual([]);
    expect(h.holds.map((hold) => hold.storeCode)).toEqual(["Z", "Z"]);
  });

  it("forgetResolvedStoreIds で memo を空へ戻すと、同じ結果を再び照会から得る（Property 7 の手段）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const body = { records: [orderRecord({ storeCode: "A", seq: "1" })] };

    await worker.fetch(postRecords(body), h.testEnv);
    forgetResolvedStoreIds();
    await worker.fetch(postRecords(body), h.testEnv);

    expect(h.resolveCalls).toEqual(["A", "A"]);
    // memo が空でも温まっていても宛先は同一（memo は結果を変えない）。
    expect(h.deliveries.map((d) => d.storeId)).toEqual(["store-a", "store-a"]);
  });
});

describe("POST /pos/records — 失敗分類（Requirements 5.8, 9.2, 9.5）", () => {
  it("Poison・未知 path・Status_Path を含むバッチは受理し、Order_Path のみを届ける", async () => {
    const h = harness({ index: { A: "store-a" } });
    const response = await worker.fetch(
      postRecords({
        records: [
          // path 欠落（毒）
          { payload: { store_id: "A" }, arrival_timestamp_ms: Date.now(), sequence_number: "1" },
          // payload 欠落（毒）
          { path: "/lio/order", arrival_timestamp_ms: Date.now(), sequence_number: "2" },
          // Unique_Key 不完全（毒）
          {
            path: "/lio/order",
            payload: { store_id: "A", terminal_id: 1, bill_no: 1 },
            arrival_timestamp_ms: Date.now() - 1000,
            sequence_number: "3",
          },
          // 未知 path（恒久的失敗）
          orderRecord({ storeCode: "A", seq: "4", path: "/lio/unknown" }),
          // Status_Path（意図的な破棄）
          orderRecord({ storeCode: "A", seq: "5", path: "/lio/status" }),
          // 値域窓の外（上流の契約違反）
          {
            path: "/lio/order",
            payload: { store_id: "A" },
            arrival_timestamp_ms: 0,
            sequence_number: "6",
          },
          // 正常
          orderRecord({ storeCode: "A", seq: "7" }),
        ],
      }),
      h.testEnv,
    );

    expect(response.status).toBe(200);
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]?.records.map((r) => r.sequenceNumber)).toEqual(["7"]);
    // 値域窓の外の Record は待ち行列へ届かず、隔離（2 時間・再生しない）へ回る（AC 8.8・8.11・8.15）。
    expect(h.quarantines).toHaveLength(1);
    expect(h.quarantines[0]?.storeCode).toBe("A");
    expect(h.quarantines[0]?.items).toHaveLength(1);
    // 保留（unrouted）とは別の受け口である——隔離は再生されないため混ぜられない（design §9-b）。
    expect(h.holds).toEqual([]);
  });

  it("保留の put が失敗すれば 5xx（保持できていないものを受理と主張しない・Property 10）", async () => {
    const h = harness({ index: {}, holdOutcome: () => ({ kind: "persist-failed" }) });
    const response = await worker.fetch(
      postRecords({ records: [orderRecord({ storeCode: "Z", seq: "1" })] }),
      h.testEnv,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(h.holds).toHaveLength(1);
  });

  it("Store_Code を読めない契約違反は隔離せず数えて破棄する（置き場が無い）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const response = await worker.fetch(
      postRecords({
        records: [
          // `arrival_timestamp_ms` が型違反（上流の契約違反）で、かつ store_id が読めない。
          {
            path: "/lio/order",
            payload: { store_id: {} },
            arrival_timestamp_ms: "0",
            sequence_number: "1",
          },
        ],
      }),
      h.testEnv,
    );

    expect(response.status).toBe(200);
    expect(h.quarantines).toEqual([]);
    expect(h.deliveries).toEqual([]);
  });

  it("全 Record が恒久的失敗でもバッチを受理する（AC 9.5）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const response = await worker.fetch(
      postRecords({ records: [orderRecord({ storeCode: "A", seq: "1", path: "/lio/unknown" })] }),
      h.testEnv,
    );

    expect(response.status).toBe(200);
    expect(h.deliveries).toEqual([]);
  });

  it("unprovisioned は 5xx（投影未達は一時的な状態ゆえ再試行に値する）", async () => {
    const h = harness({ index: { A: "store-a" }, outcome: () => ({ kind: "unprovisioned" }) });
    const response = await worker.fetch(
      postRecords({ records: [orderRecord({ storeCode: "A", seq: "1" })] }),
      h.testEnv,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it("persist-failed は 5xx（何も確定していないものを受理と主張しない）", async () => {
    const h = harness({ index: { A: "store-a" }, outcome: () => ({ kind: "persist-failed" }) });
    const response = await worker.fetch(
      postRecords({ records: [orderRecord({ storeCode: "A", seq: "1" })] }),
      h.testEnv,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it("deactivated は飛ばして数え、同一バッチの他店舗は確定する（2xx）", async () => {
    const h = harness({
      index: { A: "store-a", B: "store-b" },
      outcome: (storeId) => (storeId === "store-a" ? { kind: "deactivated" } : SETTLED),
    });
    const response = await worker.fetch(
      postRecords({
        records: [
          orderRecord({ storeCode: "A", seq: "1" }),
          orderRecord({ storeCode: "B", seq: "2" }),
        ],
      }),
      h.testEnv,
    );

    expect(response.status).toBe(200);
    // 非活性店舗にも委譲は起こる（活性の判定は宛先 DO の既存ゲートが持つ・索引を活性で絞らない）。
    expect(h.deliveries.map((d) => d.storeId).sort()).toEqual(["store-a", "store-b"]);
  });

  it("1 店舗が 5xx でも、他店舗への委譲は行われる（既に確定した分は残り再送の重複は冪等が吸収する）", async () => {
    const h = harness({
      index: { A: "store-a", B: "store-b" },
      outcome: (storeId) => (storeId === "store-a" ? { kind: "persist-failed" } : SETTLED),
    });
    const response = await worker.fetch(
      postRecords({
        records: [
          orderRecord({ storeCode: "A", seq: "1" }),
          orderRecord({ storeCode: "B", seq: "2" }),
        ],
      }),
      h.testEnv,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(h.deliveries.map((d) => d.storeId).sort()).toEqual(["store-a", "store-b"]);
  });
});

describe("POST /pos/records — 内部 identity ヘッダ（Requirements 1.9）", () => {
  it("クライアント由来の X-Yudemen-Identity は宛先 DO へ運ばれない（RPC 委譲ゆえ運搬経路が無い）", async () => {
    const h = harness({ index: { A: "store-a" } });
    const response = await worker.fetch(
      postRecords(
        { records: [orderRecord({ storeCode: "A", seq: "1" })] },
        { identity: "attacker@evil.example" },
      ),
      h.testEnv,
    );

    expect(response.status).toBe(200);
    // Request の転送は一度も起きない（ヘッダを運ぶ経路そのものが存在しない）。
    expect(h.forwarded).toEqual([]);
    // 委譲されたのは Record 列だけである（4 構造に正規化済みで、ヘッダ由来の値を含まない）。
    expect(h.deliveries).toHaveLength(1);
    expect(Object.keys(h.deliveries[0]?.records[0] ?? {}).sort()).toEqual([
      "arrivalTimestampMs",
      "path",
      "payload",
      "sequenceNumber",
    ]);
  });
});

// ── Property 7（Code_Memo は結果を変えない）を面で押さえる ──
//
// **Validates: Requirements 4.2, 4.3, 4.4**
//
// 上の example は「2 回目は照会しない」「未知はキャッシュしない」という 2 つの経路を固定している。design の
// 主張はより強く、*任意の* Store_Code 列について「memo が空の状態と温まった状態で宛先解決の結果が一致し、
// memo を全て捨てても振る舞いは遅くなるだけである」という。既知と未知が任意に混在する列を振ることでしか、
// この一致は面として確かめられない——温まり方は列の並びに依存するため、example では 1 つの並びしか見ない。
//
// 観測するのは 3 つの結末（応答・委譲の宛先と並び・保留の宛先）と、照会の回数である。前者が一致し後者だけが
// 減ることが「結果を変えず速くするだけ」の内容そのものである。

/** Property 7 の母集団となる Code_Index。`Z` は載せない（未知として応答される）。 */
const MEMO_INDEX: Readonly<Record<string, string>> = { A: "store-a", B: "store-b" };

/** 委譲の要約（宛先ごとに渡った `sequence_number` の並び）。並列 fan-out ゆえ宛先で並べ替える。 */
function deliverySummary(h: Harness): readonly (readonly [string, readonly string[]])[] {
  return h.deliveries
    .map(
      (delivery) =>
        [delivery.storeId, delivery.records.map((record) => record.sequenceNumber)] as const,
    )
    .toSorted(([left], [right]) => left.localeCompare(right));
}

/** 保留の要約（Store_Code ごとに保持へ回った `sequence_number` の並び）。 */
function holdSummary(h: Harness): readonly (readonly [string, readonly string[]])[] {
  return h.holds
    .map(
      (hold) =>
        [hold.storeCode, hold.items.map((item) => (item as ArrivalRecord).sequenceNumber)] as const,
    )
    .toSorted(([left], [right]) => left.localeCompare(right));
}

describe("Property 7: Code_Memo は結果を変えない（Requirements 4.2, 4.3, 4.4）", () => {
  it("既知と未知が任意に混在する列について、memo が空でも温まっていても結末が一致する", async () => {
    await fc.assert(
      fc.asyncProperty(
        // 空の列では 3 巡の結末がいずれも空になり主張が空虚になる（空バッチの受理は上の example が持つ）。
        fc.array(fc.constantFrom("A", "B", "Z"), { minLength: 1, maxLength: 6 }),
        async (storeCodes) => {
          const body = {
            records: storeCodes.map((storeCode, index) =>
              orderRecord({ storeCode, seq: `${index + 1}`, billNo: index + 1 }),
            ),
          };

          // 1 巡目：memo は空。既知・未知いずれもレジストリへ照会する。
          forgetResolvedStoreIds();
          const cold = harness({ index: MEMO_INDEX });
          const coldResponse = await worker.fetch(postRecords(body), cold.testEnv);

          // 2 巡目：memo は温まっている（既知分だけが載る）。
          const warm = harness({ index: MEMO_INDEX });
          const warmResponse = await worker.fetch(postRecords(body), warm.testEnv);

          expect(warmResponse.status).toBe(coldResponse.status);
          expect(deliverySummary(warm)).toEqual(deliverySummary(cold));
          expect(holdSummary(warm)).toEqual(holdSummary(cold));
          // 減るのは照会だけ。未知は毎回照会される（不在は不変ではない・AC 4.4）。
          expect(warm.resolveCalls).toEqual(
            cold.resolveCalls.filter((storeCode) => MEMO_INDEX[storeCode] === undefined),
          );

          // 3 巡目：memo を全て捨てる。結末は変わらず、照会が 1 巡目の形へ戻るだけである。
          forgetResolvedStoreIds();
          const forgotten = harness({ index: MEMO_INDEX });
          const forgottenResponse = await worker.fetch(postRecords(body), forgotten.testEnv);

          expect(forgottenResponse.status).toBe(coldResponse.status);
          expect(deliverySummary(forgotten)).toEqual(deliverySummary(cold));
          expect(holdSummary(forgotten)).toEqual(holdSummary(cold));
          expect(forgotten.resolveCalls).toEqual(cold.resolveCalls);
        },
      ),
      { numRuns: 40 },
    );
  });
});
