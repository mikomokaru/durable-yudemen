// tests/worker/pos-records-end-to-end.integration.test.ts — POS_Ingress の通し（Worker → レジストリ →
// 宛先 DO → 永続）の統合テスト（Workers pool）。
//
// _Validates: Requirements 5.1, 5.7, 11.1, 11.2, 11.6, 11.10, 11.19, 11.20, 11.21_
//
// **本ファイルだけが実物の DO を通す。** tests/worker/pos-records.integration.test.ts は宛先 DO と
// レジストリを横取りして「Worker が誰へ何を渡すか」を観測し、tests/shell/* は各 DO の内側を観測する。
// どちらも通っていて、なお欠落しうる経路が 1 つ残る——**配線どうしの継ぎ目**である。宛先解決が未知を
// 返す条件（§8-a）と、保留が再生される契機（§8-b）と、宛先 DO の単調性による冪等（§8）は、3 つが同じ
// 1 本の時系列に並んだときにだけ噛み合う。ゆえにここでは横取りを一切せず、実際の時系列を作る。
//
// 検証する 3 つの時系列（いずれも「欠落しないこと」ただ一点に絞る）：
//
//   (1) 未登録の店舗へ届く → 保留 → 店舗登録 → 再生 → 待ち行列に現れる
//   (2) 保留が非空の間に届いた新着は直接配送されず、再生で保留分ごと到着順に確定する
//       （新着を直接届けていれば判定材料が先に進み、後から再生される保留分が全件重複として消える）
//   (3) 未プロビジョニング競合——Code_Index に載った直後（投影未達）の到着は 5xx になり、投影が到達した
//       後の再送で確定する（店舗開設の瞬間に届いた注文を「飛ばして数える」で消さない）

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import worker, { forgetResolvedStoreIds } from "../../src/worker";
import {
  REGISTRY_NAME,
  RESIDUAL_KEY,
  unroutedKey,
  type StoreRegistryDO,
} from "../../src/shell/store-registry-do";
import type { HeldRecord } from "../../src/registry/held-record";
import type { ArrivalRecord } from "../../src/ingress/batch";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreSnapshot } from "../../src/engine/snapshot";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** タイマー SSOT の単一キー（store-timer-do.ts の SNAPSHOT_KEY と一致させる）。 */
const SNAPSHOT_KEY = "activeTimers";

const TOKEN = "pos-ingress-token";

/** 商品コードの組。麺量を持つ品目だけが茹で対象へ写る（判定基準は麺量の有無ただ一つ）。 */
const MENU_CODE = 11421;
const SIZE_REGULAR = 19401;
const NOODLE = "PosRamen";

/**
 * 店舗が主張する対応表と麺の設定（Store_Override）。
 *
 * 投影を直に押し込まず Provisioning_API 経由で与えるのは、**設定投入経路を含めて通すため**である
 * （`compose.ts` の合成対象に載っていなければ、投入は受理されるのに投影に現れないという無言の欠落になる）。
 */
const storeOverride = {
  noodlePresets: [{ noodleType: NOODLE, boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } }],
  firmnessCodes: [{ code: 10011, firmness: "normal" }],
  menuItems: [{ productCode: MENU_CODE, noodleType: NOODLE, sizes: [{ code: SIZE_REGULAR, slotSpan: 1 }] }],
};

/** 上流の KDS が採る桁数。桁が揃っていれば辞書順が数値順に一致し、単調性の比較がそのまま働く。 */
function seq(n: number): string {
  return String(n).padStart(56, "0");
}

function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  return env.STORE_REGISTRY_DO.get(id) as unknown as DurableObjectStub<StoreRegistryDO>;
}

function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

/** ORDER_INGRESS_TOKEN だけを差し替えた env（DO バインディングは実物のまま）。 */
function ingressEnv(): Env {
  return { ...env, ORDER_INGRESS_TOKEN: TOKEN } as unknown as Env;
}

/** POS_Ingress へのリクエスト（認可は既存の Bearer 照合）。 */
function postRecords(records: readonly unknown[]): Request {
  return new Request("https://ingress.invalid/pos/records", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ records }),
  });
}

/** 上流が届ける生の Record（`arrival_timestamp_ms` / `sequence_number` はメタデータの名で運ばれる）。 */
function rawRecord(params: {
  readonly storeCode: string;
  readonly sequenceNumber: string;
  readonly billNo: string;
  readonly arrivalTimestampMs?: number;
}): unknown {
  return {
    path: "/lio/order",
    payload: {
      store_id: params.storeCode,
      terminal_id: "1",
      bill_no: params.billNo,
      datetime: "2026-08-17T20:52:19",
      order_items: [{ plu_no: MENU_CODE, child_items: [{ plu_no: SIZE_REGULAR }] }],
    },
    arrival_timestamp_ms: params.arrivalTimestampMs ?? Date.now() - 60_000,
    sequence_number: params.sequenceNumber,
  };
}

/** 検証済みの Record（保留が保つ形）。生 Record と同一の内容を 4 構造で表す。 */
function arrivalRecord(params: {
  readonly storeCode: string;
  readonly sequenceNumber: string;
  readonly billNo: string;
  readonly arrivalTimestampMs?: number;
}): ArrivalRecord {
  const raw = rawRecord(params) as {
    path: string;
    payload: Record<string, unknown>;
    arrival_timestamp_ms: number;
    sequence_number: string;
  };
  return {
    path: raw.path,
    payload: raw.payload,
    arrivalTimestampMs: raw.arrival_timestamp_ms,
    sequenceNumber: raw.sequence_number,
  };
}

/** 店舗を 1 件登録する（登録の確定が再生の契機である・design §9 の契機 1）。 */
async function createStore(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeId: string,
  storeCode: string,
): Promise<void> {
  const res = await stub.fetch(
    new Request("https://registry/admin/stores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId,
        chainId: "yamaokaya",
        name: `${storeCode} 店`,
        storeCode,
        override: storeOverride,
      }),
    }),
  );
  expect(res.status).toBe(201);
}

/** 一括 upsert（配列ボディ）。1 回の収束で捌ける上限を超えた分は残作業として残る。 */
async function upsertStores(
  stub: DurableObjectStub<StoreRegistryDO>,
  elements: readonly unknown[],
): Promise<void> {
  const res = await stub.fetch(
    new Request("https://registry/admin/stores", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(elements),
    }),
  );
  expect(res.ok).toBe(true);
}

async function readKey<T>(stub: DurableObjectStub<StoreRegistryDO>, key: string): Promise<T | undefined> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get<T>(key));
}

/** 保持中の `sequence_number` の列（順序ごと突き合わせる）。不在＝保持なし。 */
async function heldSequences(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeCode: string,
): Promise<readonly string[] | undefined> {
  const held = await readKey<readonly HeldRecord[]>(stub, unroutedKey(storeCode));
  return held?.map((entry) => (entry.kind === "unrouted" ? entry.record.sequenceNumber : "?"));
}

/** 保持分を直に置く（後述の (2) が要する「登録済みだが再生が持ち越された」状態を作る）。 */
async function seedHeld(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeCode: string,
  records: readonly ArrivalRecord[],
): Promise<void> {
  const now = Date.now();
  const held: readonly HeldRecord[] = records.map((record) => ({ kind: "unrouted", heldAt: now, record }));
  await runInDurableObject(stub, (_instance, state) => state.storage.put(unroutedKey(storeCode), held));
}

/** 待ち行列の確定状態（宛先 DO の永続が正本である）。 */
async function readSnapshot(storeId: string): Promise<StoreSnapshot | undefined> {
  return runInDurableObject(storeStub(storeId), (_instance, state) =>
    state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
  );
}

/** 待ち行列に並ぶ品目の Unique_Key 列（bill_no だけが違うため末尾で読み分けられる）。 */
async function queuedBills(storeId: string): Promise<readonly string[]> {
  const snapshot = await readSnapshot(storeId);
  return (snapshot?.pendingOrders ?? []).map((order) => order.externalOrderId);
}

function billKey(billNo: string): string {
  return `9100:1:${billNo}:2026-08-17T20%3A52%3A19`;
}

/** 収束の残作業が空になるまで Alarm を進める（実時間の Alarm 発火を待たない）。 */
async function drainConvergence(stub: DurableObjectStub<StoreRegistryDO>): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // 残作業を読んでから次の 1 回を進める（並列化すれば「まだ残っている」を観測できない）。
    // oxlint-disable-next-line no-await-in-loop
    const residual = (await readKey<readonly string[]>(stub, RESIDUAL_KEY)) ?? [];
    if (residual.length === 0) return;
    // oxlint-disable-next-line no-await-in-loop
    await runInDurableObject(stub, (instance) => instance.alarm());
  }
  throw new Error("収束の残作業が空にならなかった");
}

// Code_Memo はモジュールスコープゆえテスト間で持ち越される。**(2) の前提は memo が当該 Store_Code を
// 持たないことである**——保留を積んだ isolate は未知応答を受けた isolate であり、未知は載らない（AC 4.4）。
beforeEach(() => {
  forgetResolvedStoreIds();
});

afterEach(async () => {
  await reset();
});

describe("未登録の店舗へ届いた Record は保留され、登録の確定で待ち行列へ現れる（Requirements 11.1, 11.6, 11.10）", () => {
  it("POST → 保留 → 店舗登録 → 再生 → 永続まで通る", async () => {
    const registry = registryStub();
    const ingress = ingressEnv();

    // 宛先未解決。**捨てず保留する**——4xx を返せば上流はアラームの無いカウンタを加算して Record を捨てる。
    const accepted = await worker.fetch(
      postRecords([
        rawRecord({ storeCode: "9100", sequenceNumber: seq(1), billNo: "b1" }),
        rawRecord({ storeCode: "9100", sequenceNumber: seq(2), billNo: "b2" }),
      ]),
      ingress,
    );

    expect(accepted.status).toBe(200);
    expect(await heldSequences(registry, "9100")).toEqual([seq(1), seq(2)]);
    // 待ち行列にはまだ何も無い（保留は受理であって確定ではない）。
    expect(await readSnapshot("e2e-late")).toBeUndefined();

    // 店舗登録の確定が再生の契機である（宛先が定まった瞬間に保留が動く）。
    await createStore(registry, "e2e-late", "9100");

    // 保留は空になり（不在＝保持なし）、2 件が到着順で待ち行列へ入った。
    expect(await heldSequences(registry, "9100")).toBeUndefined();
    expect(await queuedBills("e2e-late")).toEqual([billKey("b1"), billKey("b2")]);
    // 判定材料も進んでいる＝再生が通常の受け口（receiveRecords）を通った証左である（AC 11.10）。
    expect((await readSnapshot("e2e-late"))?.lastSequenceByTerminal).toEqual({ "1": seq(2) });
    // 保留が空になったので、以降の新着は直接配送へ回る（§8-a の未知応答が解けている）。
    expect(await registry.resolveStoreCode("9100")).toBe("e2e-late");
  });
});

describe("保留が非空の間の新着は直接配送されず、保留分が重複で消えない（Requirements 11.20, 11.21）", () => {
  it("再生が持ち越された状態へ届いた新着も保留へ積まれ、全件が到着順で確定する", async () => {
    const registry = registryStub();
    const ingress = ingressEnv();
    await createStore(registry, "e2e-order", "9100");
    // 「登録は済んだが再生が Alarm 継続へ持ち越された」状態を作る（投影未達で `unprovisioned` になった回の
    // 帰結である）。保留に在るのは小さい `sequence_number` の 2 件で、これが消えないことが本ケースの主張。
    await seedHeld(registry, "9100", [
      arrivalRecord({ storeCode: "9100", sequenceNumber: seq(1), billNo: "b1" }),
      arrivalRecord({ storeCode: "9100", sequenceNumber: seq(2), billNo: "b2" }),
    ]);

    // 新着（大きい seq）。**宛先は既知だが、保留が非空ゆえ未知として応答される**（§8-a）。ゆえに直接配送は
    // されず保留へ積まれ、既知コードの `holdUnrouted` が同一リクエスト内で再生を起こす（§8-b の穴 1）。
    const accepted = await worker.fetch(
      postRecords([rawRecord({ storeCode: "9100", sequenceNumber: seq(5), billNo: "b5" })]),
      ingress,
    );

    expect(accepted.status).toBe(200);
    // 3 件すべてが到着順で並ぶ。新着を直接届けていれば判定材料が seq(5) まで進み、後から再生される
    // seq(1) / seq(2) は全件「重複」として弾かれて b5 の 1 件だけが残る——それが欠落である。
    expect(await queuedBills("e2e-order")).toEqual([billKey("b1"), billKey("b2"), billKey("b5")]);
    expect((await readSnapshot("e2e-order"))?.lastSequenceByTerminal).toEqual({ "1": seq(5) });
    expect(await heldSequences(registry, "9100")).toBeUndefined();
  });
});

describe("未プロビジョニング競合（Requirements 11.19, 5.7）", () => {
  it("Code_Index に載った直後（投影未達）の到着は 5xx になり、投影到達後の再送で確定する", async () => {
    const registry = registryStub();
    const ingress = ingressEnv();

    // 一括登録。イデアと Code_Index は 1 回の put で確定するが、投影の押し込みは 1 回の収束で捌ける
    // 上限までしか進まない——残りは残作業として Alarm 継続へ委ねられる。**これが競合の窓そのものである。**
    const codeOf = (index: number): string => `82${String(index).padStart(2, "0")}`;
    const storeIdOf = (index: number): string => `e2e-bulk-${index}`;
    await upsertStores(
      registry,
      Array.from({ length: 30 }, (_unused, index) => ({
        storeId: storeIdOf(index),
        chainId: "yamaokaya",
        name: `${codeOf(index)} 店`,
        storeCode: codeOf(index),
        override: storeOverride,
      })),
    );

    const residual = (await readKey<readonly string[]>(registry, RESIDUAL_KEY)) ?? [];
    // 窓が実在することの担保（1 回で全店へ押し込めるなら本ケースは何も検めていない）。
    expect(residual.length).toBeGreaterThan(0);
    const targetStoreId = residual[0] ?? "";
    const targetCode = codeOf(Number(targetStoreId.slice("e2e-bulk-".length)));

    // 宛先は引ける（Code_Index には載っている）が、当該店舗 DO は投影を受けていない。
    expect(await registry.resolveStoreCode(targetCode)).toBe(targetStoreId);
    const record = rawRecord({ storeCode: targetCode, sequenceNumber: seq(1), billNo: "b1" });
    const early = await worker.fetch(postRecords([record]), ingress);

    // 一時的な状態ゆえ再試行に値する（`deactivated` と同じ「飛ばして数える」にすれば、店舗開設の瞬間に
    // 届いた注文——最も新しい注文——が消える）。
    expect(early.status).toBeGreaterThanOrEqual(500);
    // 何も確定していない。痕跡そのものが残らない（put の前で拒む）。
    expect(await readSnapshot(targetStoreId)).toBeUndefined();

    // 投影が到達する（収束の Alarm 継続）。
    await drainConvergence(registry);

    // 上流のバッチ retry がそのまま届く形。ここで確定すれば、5xx は欠落ではなく遅延だったことになる。
    const resent = await worker.fetch(postRecords([record]), ingress);

    expect(resent.status).toBe(200);
    const snapshot = await readSnapshot(targetStoreId);
    expect(snapshot?.pendingOrders).toHaveLength(1);
    expect(snapshot?.lastSequenceByTerminal).toEqual({ "1": seq(1) });
  });
});
