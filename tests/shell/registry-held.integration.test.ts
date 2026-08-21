import { afterEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import {
  REGISTRY_NAME,
  contractViolationKey,
  unroutedKey,
  type StoreRegistryDO,
} from "../../src/shell/store-registry-do";
import { HELD_RECORD_LIMIT, type HeldRecord } from "../../src/registry/held-record";
import { ARRIVAL_WINDOW_MS } from "../../src/ingress/arrival-window";
import type { ArrivalRecord } from "../../src/ingress/batch";

// registry-held.integration.test.ts — 保留（unrouted:）と隔離（contract-violation:）の統合テスト（Workers pool）。
//
// _Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.12, 11.13, 11.14, 11.15, 11.16, 11.23, 8.8, 8.9, 8.10, 8.11_
//
// 検証する不変：
//   - 受理は `put` 成功の上にのみ立つ（put を失敗させたら persist-failed・痕跡も残らない・Property 10）。
//   - 失効の判定は保持の書き込みの時点で行われ、常設 Alarm を張らない（AC 11.16）。
//   - 保持期間は ARRIVAL_WINDOW_MS（2 時間）そのものである（定数が 2 つに分かれていない）。
//   - 件数上限 2000 の超過分が破棄され、件数が返る（AC 11.23）。
//   - 隔離は保留と別のキーに置かれ、混ざらない（design §9-b）。
//   - HeldRecord は保持を始めた時刻を持ち、それは arrival_timestamp_ms（上流の観測時刻）とは別の事実である。

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  return env.STORE_REGISTRY_DO.get(id) as unknown as DurableObjectStub<StoreRegistryDO>;
}

/** 検証済みの Record（4 構造を通った形）。保留が保つのはこれである。 */
function arrivalRecord(seq: string, arrivalTimestampMs: number): ArrivalRecord {
  return {
    path: "/lio/order",
    payload: { store_id: "H", terminal_id: 1, bill_no: seq, datetime: "2026-08-17T20:52:19" },
    arrivalTimestampMs,
    sequenceNumber: seq,
  };
}

/** 保持中の Record 列を生のまま読む（保持が put で確定していることの確認）。 */
async function readHeld(
  stub: DurableObjectStub<StoreRegistryDO>,
  key: string,
): Promise<readonly HeldRecord[] | undefined> {
  const raw = await runInDurableObject(stub, (_instance, state) => state.storage.get(key));
  return raw as readonly HeldRecord[] | undefined;
}

/** 保持分を直接書き込む（保持を始めた時刻を過去に置くため。失効の判定は読み書きの瞬間に行われる）。 */
async function seedHeld(
  stub: DurableObjectStub<StoreRegistryDO>,
  key: string,
  held: readonly HeldRecord[],
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => state.storage.put(key, held));
}

afterEach(async () => {
  await reset();
});

describe("保留は put 成功の上にのみ立つ（Requirements 11.3, 11.4）", () => {
  it("put を失敗させると persist-failed が返り、保持の痕跡も残らない", async () => {
    const stub = registryStub();

    const failed = await runInDurableObject(stub, async (instance, state) => {
      const originalPut = state.storage.put.bind(state.storage);
      (state.storage as { put: unknown }).put = () => Promise.reject(new Error("put failed"));
      try {
        return await instance.holdUnrouted("9001", [arrivalRecord("1", Date.now() - 1000)]);
      } finally {
        (state.storage as { put: unknown }).put = originalPut;
      }
    });

    expect(failed.kind).toBe("persist-failed");
    expect(await readHeld(stub, unroutedKey("9001"))).toBeUndefined();

    // 対照：put が働けば受理が返り保持が残る（上の「残らない」が空虚でないことの担保）。
    const held = await stub.holdUnrouted("9001", [arrivalRecord("1", Date.now() - 1000)]);
    expect(held.kind).toBe("held");
    expect(await readHeld(stub, unroutedKey("9001"))).toHaveLength(1);
  });

  it("同一 Store_Code への保留は到着順のまま積み増される", async () => {
    const stub = registryStub();
    const now = Date.now();

    await stub.holdUnrouted("9002", [arrivalRecord("1", now - 2000), arrivalRecord("2", now - 1500)]);
    await stub.holdUnrouted("9002", [arrivalRecord("3", now - 1000)]);

    const held = await readHeld(stub, unroutedKey("9002"));
    expect(held?.map((h) => (h.kind === "unrouted" ? h.record.sequenceNumber : null))).toEqual(["1", "2", "3"]);
  });
});

describe("保持は 2 時間で失効し、常設 Alarm を持たない（Requirements 11.12, 11.16）", () => {
  it("保持の書き込みの時点で失効が判定され、2 時間の内側は残る", async () => {
    const stub = registryStub();
    const now = Date.now();
    // 境界そのもの（ちょうど 2 時間前）は主張しない——時計を 2 度読む（テストと DO）ため、境界の 1ms は
    // 実行のずれに従属する。1 分の余裕を両側に置けば、保持期間が 2 時間であること自体は一意に決まる。
    const margin = 60_000;
    await seedHeld(stub, unroutedKey("9003"), [
      // 2 時間より前に保持を始めた分（失効）。
      {
        kind: "unrouted",
        heldAt: now - ARRIVAL_WINDOW_MS - margin,
        record: arrivalRecord("1", now - ARRIVAL_WINDOW_MS),
      },
      // 2 時間の内側（窓の下限は閉じている——isWithinArrivalWindow と同じ閉じ方）。
      {
        kind: "unrouted",
        heldAt: now - ARRIVAL_WINDOW_MS + margin,
        record: arrivalRecord("2", now - ARRIVAL_WINDOW_MS + margin),
      },
    ]);

    const outcome = await stub.holdUnrouted("9003", [arrivalRecord("3", now - 1000)]);

    expect(outcome).toEqual({ kind: "held", counts: { heldExpired: 1, heldOverflow: 0 } });
    const held = await readHeld(stub, unroutedKey("9003"));
    expect(held?.map((h) => (h.kind === "unrouted" ? h.record.sequenceNumber : null))).toEqual(["2", "3"]);
  });

  it("保持を続ける Record が無くなればキーが消え、Alarm は張られない", async () => {
    const stub = registryStub();
    const now = Date.now();
    await seedHeld(stub, unroutedKey("9004"), [
      { kind: "unrouted", heldAt: now - ARRIVAL_WINDOW_MS - 1, record: arrivalRecord("1", now - 1000) },
    ]);

    // 新たに保つものが無い呼び出し（空列）でも、読んだ時点で失効が落ちる。
    const outcome = await stub.holdUnrouted("9004", []);

    expect(outcome).toEqual({ kind: "held", counts: { heldExpired: 1, heldOverflow: 0 } });
    // 不在＝保持なし（空配列を残さない。§8-a の「保留が非空か」の判定が 2 つの形を見ないため）。
    expect(await readHeld(stub, unroutedKey("9004"))).toBeUndefined();
    // 失効を待つための常設 Alarm を持たない（保留が無い間も DO を起こし続けない・AC 11.16）。
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();
  });
});

describe("件数上限は 1 Store_Code あたり 2000 Record（Requirements 11.23）", () => {
  it("超過分は古い側から破棄され、件数が返る", async () => {
    const stub = registryStub();
    const now = Date.now();
    const seeded: HeldRecord[] = Array.from({ length: HELD_RECORD_LIMIT }, (_unused, i) => ({
      kind: "unrouted",
      heldAt: now - 1000,
      record: arrivalRecord(`seed-${i}`, now - 1000),
    }));
    await seedHeld(stub, unroutedKey("9005"), seeded);

    const outcome = await stub.holdUnrouted("9005", [
      arrivalRecord("late-1", now),
      arrivalRecord("late-2", now),
      arrivalRecord("late-3", now),
    ]);

    expect(outcome).toEqual({ kind: "held", counts: { heldExpired: 0, heldOverflow: 3 } });
    const held = await readHeld(stub, unroutedKey("9005"));
    expect(held).toHaveLength(HELD_RECORD_LIMIT);
    const sequences = held?.map((h) => (h.kind === "unrouted" ? h.record.sequenceNumber : null)) ?? [];
    // 落ちたのは古い側の 3 件。保全と即時性が衝突する分岐では即時性を選ぶ（新しい注文を残す）。
    expect(sequences[0]).toBe("seed-3");
    expect(sequences.slice(-3)).toEqual(["late-1", "late-2", "late-3"]);
  });
});

describe("隔離は保留と別のキーに置く（Requirements 8.8, 8.10, 8.11）", () => {
  it("同一 Store_Code でも 2 つのキーは混ざらない", async () => {
    const stub = registryStub();
    const now = Date.now();

    await stub.holdUnrouted("9006", [arrivalRecord("1", now - 1000)]);
    // 型違反の生値（ArrivalRecord を構築できない——arrival_timestamp_ms が数値でない）。
    const violation = {
      path: "/lio/order",
      payload: { store_id: "9006" },
      arrival_timestamp_ms: "0",
      sequence_number: "2",
    };
    const quarantined = await stub.quarantineContractViolations("9006", [violation]);

    expect(quarantined.kind).toBe("held");
    const unrouted = await readHeld(stub, unroutedKey("9006"));
    const isolated = await readHeld(stub, contractViolationKey("9006"));
    expect(unrouted?.map((h) => h.kind)).toEqual(["unrouted"]);
    expect(isolated?.map((h) => h.kind)).toEqual(["contract-violation"]);
    // 隔離は検証前の生値をそのまま保つ（起点を推測で埋めない・AC 8.10）。
    expect(isolated?.[0]?.kind === "contract-violation" ? isolated[0].raw : null).toEqual(violation);
  });

  it("隔離も同一の規律で失効する（2 時間・件数を返す）", async () => {
    const stub = registryStub();
    const now = Date.now();
    await seedHeld(stub, contractViolationKey("9007"), [
      { kind: "contract-violation", heldAt: now - ARRIVAL_WINDOW_MS - 1, raw: { sequence_number: "old" } },
    ]);

    const outcome = await stub.quarantineContractViolations("9007", [{ sequence_number: "new" }]);

    expect(outcome).toEqual({ kind: "held", counts: { heldExpired: 1, heldOverflow: 0 } });
    expect(await readHeld(stub, contractViolationKey("9007"))).toHaveLength(1);
  });
});

describe("保持を始めた時刻は上流の観測時刻とは別の事実である", () => {
  it("heldAt は arrivalTimestampMs と別に記録される", async () => {
    const stub = registryStub();
    const arrivalTimestampMs = Date.now() - 90 * 60 * 1000;
    const before = Date.now();

    await stub.holdUnrouted("9008", [arrivalRecord("1", arrivalTimestampMs)]);

    const held = await readHeld(stub, unroutedKey("9008"));
    const first = held?.[0];
    expect(first?.heldAt).toBeGreaterThanOrEqual(before);
    // 起点（Order_Arrival_Time）は保持の時刻に置き換わらない——保持は失効の判定にしか使わない。
    expect(first?.kind === "unrouted" ? first.record.arrivalTimestampMs : null).toBe(arrivalTimestampMs);
    expect(first?.heldAt).not.toBe(arrivalTimestampMs);
  });
});
