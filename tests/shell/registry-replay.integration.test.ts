// tests/shell/registry-replay.integration.test.ts — 保留の再生と、欠落を防ぐ 3 つの不変の統合テスト
// （Workers pool）。
//
// _Validates: Requirements 11.6, 11.7, 11.8, 11.9, 11.10, 11.20, 11.21, 11.22_
//
// 本ファイルの重心は「欠落しないこと」ただ一つに置く。重複は宛先 DO の単調性が吸収し、遅延は再送と Alarm が
// 回収するが、欠落は取り戻せない。ゆえに検証するのは 4 つの不変である。
//
//   Property 13 保留が非空であるあいだ resolveStoreCode は未知を返し、空になった時点で解決可能へ転じる
//   Property 18 保留は必ず再生の契機を持つ（既知コードは同一リクエスト内・未知コードは店舗登録の確定）
//   Property 19 再生は送り終えた範囲だけを取り除く（2 本が同時に走っても未送信分が消えない）
//   Property 17 再生時に窓の外へ出た Record は破棄され、再保留されない（循環が生じない）
//   design §9-b 隔離（`contract-violation:`）は **再生の対象にならない**（証跡であって保留ではない）
//
// **Property 19 は `pushToStore` の解決を制御して検証する**（design の Testing Strategy）。await 境界での
// 交互実行を再現しなければ「件数で削っても通る」テストになり、守るべき不変を何も守らない。

import { afterEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import {
  REGISTRY_NAME,
  REPLAY_RESIDUAL_KEY,
  contractViolationKey,
  unroutedKey,
  type StoreRegistryDO,
} from "../../src/shell/store-registry-do";
import type { HeldRecord } from "../../src/registry/held-record";
import { ARRIVAL_WINDOW_MS } from "../../src/ingress/arrival-window";
import type { ArrivalRecord } from "../../src/ingress/batch";
import type { ReceiveOutcome, StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreSnapshot } from "../../src/engine/snapshot";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** タイマー SSOT の単一キー（store-timer-do.ts の SNAPSHOT_KEY と一致させる）。 */
const SNAPSHOT_KEY = "activeTimers";

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

/** 店舗を登録する（登録の確定が再生の契機である・design §9 の契機 1）。 */
async function registerStore(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeId: string,
  storeCode: string,
): Promise<void> {
  const res = await stub.fetch(
    new Request("https://registry/admin/stores", {
      method: "POST",
      body: JSON.stringify({ storeId, chainId: "yamaokaya", name: `${storeCode} 店`, storeCode }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(res.status).toBe(201);
}

/** 検証済みの Record（4 構造を通った形）。保留が保つのはこれである。 */
function arrivalRecord(sequenceNumber: string, arrivalTimestampMs: number): ArrivalRecord {
  return {
    path: "/lio/order",
    payload: {
      store_id: "R",
      terminal_id: "1",
      bill_no: sequenceNumber,
      datetime: "2026-08-17T20:52:19",
      order_items: [],
    },
    arrivalTimestampMs,
    sequenceNumber,
  };
}

/** 保持の 1 件（保持を始めた時刻を添える）。 */
function heldRecord(sequenceNumber: string, arrivalTimestampMs: number, heldAt: number): HeldRecord {
  return { kind: "unrouted", heldAt, record: arrivalRecord(sequenceNumber, arrivalTimestampMs) };
}

async function readHeld(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeCode: string,
): Promise<readonly HeldRecord[] | undefined> {
  const raw = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get(unroutedKey(storeCode)),
  );
  return raw as readonly HeldRecord[] | undefined;
}

/** 保持中の `sequence_number` の列（順序ごと突き合わせる）。 */
async function heldSequences(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeCode: string,
): Promise<readonly string[]> {
  const held = await readHeld(stub, storeCode);
  return (held ?? []).map((entry) => (entry.kind === "unrouted" ? entry.record.sequenceNumber : "?"));
}

async function seedHeld(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeCode: string,
  held: readonly HeldRecord[],
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => state.storage.put(unroutedKey(storeCode), held));
}

/** 宛先 DO の判定材料。**再生が通常の受け口（receiveRecords）を通ったことの証左である**（AC 11.10）。 */
async function lastSequenceOf(storeId: string, terminalId: string): Promise<string | undefined> {
  const snapshot = await runInDurableObject(storeStub(storeId), (_instance, state) =>
    state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
  );
  return snapshot?.lastSequenceByTerminal[terminalId];
}

/**
 * 再生の内側（private）へ触るための窓。
 *
 * `drainUnrouted` を直接呼ぶのは、**2 本の再生が同時に走る状況を意図的に作るため**である（`replayUnrouted`
 * の in-memory フラグは同時実行を 1 本に畳んでしまい、identity ベースの削除が守っている不変そのものを
 * 観測できなくする）。フラグが失われても欠落しないことが design の主張であり、ここはその主張の検証である。
 */
interface ReplayInternals {
  drainUnrouted(storeCode: string): Promise<{ readonly kind: string; readonly windowExpired: number }>;
  pushToStore(storeId: string, records: readonly ArrivalRecord[]): Promise<ReceiveOutcome>;
}

function internals(instance: StoreRegistryDO): ReplayInternals {
  return instance as unknown as ReplayInternals;
}

const SETTLED: ReceiveOutcome = {
  kind: "settled",
  counts: { doDedupeSkipped: 0, unknownNoodleType: 0 },
};

/** 条件が満たされるまで実時間で待つ（await 境界の進みは microtask の数に依らない）。 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    // 待つこと自体が目的ゆえ直列に await する（並列化すれば「まだ満たされていない」を観測できない）。
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`条件が満たされなかった: ${label}`);
}

afterEach(async () => {
  await reset();
});

describe("Property 13: 保留が非空の間は直接配送されない（Requirements 11.20, 11.21）", () => {
  it("宛先が既知でも保留が非空なら未知を返し、空になった時点で解決可能へ転じる", async () => {
    const stub = registryStub();
    await registerStore(stub, "replay-p13", "6001");
    // 前提：保留が無ければ宛先は引ける（以下の undefined が「登録できていない」ことに帰属しない担保）。
    expect(await stub.resolveStoreCode("6001")).toBe("replay-p13");

    await seedHeld(stub, "6001", [heldRecord(seq(1), Date.now() - 1_000, Date.now())]);

    // 保留が非空 → 未知。新着はこれを受けて保留へ積まれ、再生される保留分より先に判定材料を進めない。
    expect(await stub.resolveStoreCode("6001")).toBeUndefined();

    // 保留が空になった時点で解決可能へ転じる（未知は Code_Memo に載らないため、Worker 側も追随できる）。
    await runInDurableObject(stub, (_instance, state) => state.storage.delete(unroutedKey("6001")));
    expect(await stub.resolveStoreCode("6001")).toBe("replay-p13");
  });
});

describe("Property 18: 保留は必ず再生の契機を持つ（Requirements 11.6, 11.10）", () => {
  it("既知コードへの holdUnrouted は応答を返す前に再生を終える（詰まらない）", async () => {
    const stub = registryStub();
    await registerStore(stub, "replay-known", "6002");

    const outcome = await stub.holdUnrouted("6002", [arrivalRecord(seq(10), Date.now() - 1_000)]);

    // 保持は確定し、同一リクエスト内の再生が保留を空にした（キーの不在＝保持なし）。
    expect(outcome.kind).toBe("held");
    expect(await readHeld(stub, "6002")).toBeUndefined();
    // 詰まっていない——次のバッチは直接配送へ回る（§8-a の未知応答が解けている）。
    expect(await stub.resolveStoreCode("6002")).toBe("replay-known");
    // 再生は通常の受け口を通った（再生専用の解釈経路が無い・AC 11.10）。
    expect(await lastSequenceOf("replay-known", "1")).toBe(seq(10));
  });

  it("未知コードの保留は店舗登録の確定を契機に再生される", async () => {
    const stub = registryStub();

    // 宛先が未知ゆえ、この時点では再生の契機が無い（保留はそのまま残る）。
    const outcome = await stub.holdUnrouted("6003", [arrivalRecord(seq(20), Date.now() - 1_000)]);
    expect(outcome.kind).toBe("held");
    expect(await heldSequences(stub, "6003")).toEqual([seq(20)]);

    await registerStore(stub, "replay-late", "6003");

    expect(await readHeld(stub, "6003")).toBeUndefined();
    expect(await lastSequenceOf("replay-late", "1")).toBe(seq(20));
  });

  it("再生が完了しなければ残作業と Alarm を残す（契機を失わない）", async () => {
    const stub = registryStub();
    await registerStore(stub, "replay-defer", "6004");

    const outcome = await runInDurableObject(stub, async (instance, state) => {
      // 投影未受領を注入する。一時的な状態ゆえ再試行に値し、保留を削ってはならない（Property 15）。
      internals(instance).pushToStore = () => Promise.resolve({ kind: "unprovisioned" });
      await state.storage.deleteAlarm();
      return instance.holdUnrouted("6004", [arrivalRecord(seq(30), Date.now() - 1_000)]);
    });

    // 保持は確定している（ゆえに persist-failed ではない）が、再生は持ち越した。
    expect(outcome.kind).toBe("replay-deferred");
    expect(await heldSequences(stub, "6004")).toEqual([seq(30)]);
    const residual = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get(REPLAY_RESIDUAL_KEY),
    );
    expect(residual).toEqual(["6004"]);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });
});

describe("Property 19: 再生は送り終えた範囲だけを取り除く（Requirements 11.7）", () => {
  it("2 本の再生が同時に走っても、RPC 中の追記と未送信分が消えない", async () => {
    const stub = registryStub();
    await registerStore(stub, "replay-race", "6005");
    const now = Date.now();
    await seedHeld(stub, "6005", [
      heldRecord(seq(1), now - 3_000, now),
      heldRecord(seq(2), now - 2_000, now),
    ]);

    const remaining = await runInDurableObject(stub, async (instance, state) => {
      const pushed: readonly string[][] = [];
      const gates: (() => void)[] = [];
      // 押し込みの解決を制御する（await 境界での交互実行を再現するための唯一の注入点）。
      internals(instance).pushToStore = (_storeId, records) => {
        (pushed as string[][]).push(records.map((record) => record.sequenceNumber));
        return new Promise<ReceiveOutcome>((resolve) => gates.push(() => resolve(SETTLED)));
      };

      // 1 本目（Alarm 由来に相当）: [1,2] を読んで送信中。
      const first = internals(instance).drainUnrouted("6005");
      await waitUntil(() => pushed.length === 1, "1 本目の押し込み");
      expect(pushed[0]).toEqual([seq(1), seq(2)]);

      // その await の最中に 3 が届く。既知コードゆえ同期再生が始まり、2 本目が走る（穴 1 の帰結）。
      const held = instance.holdUnrouted("6005", [arrivalRecord(seq(3), Date.now() - 1_000)]);
      await waitUntil(() => pushed.length === 2, "2 本目の押し込み");
      expect(pushed[1]).toEqual([seq(1), seq(2), seq(3)]);

      // 2 本目が先に完走して保留を空にする（件数で削れば、ここで 3 件消える）。
      gates[1]?.();
      await held;
      expect(await state.storage.get(unroutedKey("6005"))).toBeUndefined();

      // 空になった保留へ 4 が届く（まだ誰も送っていない）。
      await state.storage.put(unroutedKey("6005"), [heldRecord(seq(4), Date.now() - 1_000, Date.now())]);

      // 1 本目が復帰する。件数（2 件）で削れば 4 が消える。identity（送り終えた seq=2 以下）で削れば残る。
      gates[0]?.();
      await waitUntil(() => pushed.length === 3, "1 本目の復帰後の押し込み");
      expect(pushed[2]).toEqual([seq(4)]);
      const survived = (await state.storage.get(unroutedKey("6005"))) as readonly HeldRecord[] | undefined;

      gates[2]?.();
      await first;
      return survived;
    });

    // 未送信の 4 は 1 本目の書き戻しを生き延びた（消えていたら欠落である）。
    expect(remaining?.map((entry) => (entry.kind === "unrouted" ? entry.record.sequenceNumber : "?"))).toEqual([
      seq(4),
    ]);
    // 最後は空になる（再生は保留が空になるまで繰り返す）。
    expect(await readHeld(stub, "6005")).toBeUndefined();
  });

  it("押し込みが一時的に失敗したときは 1 件も取り除かない", async () => {
    const stub = registryStub();
    await registerStore(stub, "replay-nodrop", "6006");
    const now = Date.now();
    await seedHeld(stub, "6006", [heldRecord(seq(1), now - 2_000, now), heldRecord(seq(2), now - 1_000, now)]);

    await runInDurableObject(stub, async (instance) => {
      internals(instance).pushToStore = () => Promise.resolve({ kind: "persist-failed" });
      const progress = await internals(instance).drainUnrouted("6006");
      expect(progress.kind).toBe("deferred");
    });

    // 送れていないものを送ったとしない（確定の起点は宛先 DO の put 成功のみ）。
    expect(await heldSequences(stub, "6006")).toEqual([seq(1), seq(2)]);
  });
});

describe("Property 17: 窓外の Record は再保留されない（Requirements 11.22, 11.8）", () => {
  it("窓の外へ出た Record は押し込まれず、再保留もされない", async () => {
    const stub = registryStub();
    await registerStore(stub, "replay-window", "6007");
    const now = Date.now();
    // 境界の 1ms は 2 度の時計読み（テストと DO）に従属するため、1 分の余裕を置く。
    const margin = 60_000;
    await seedHeld(stub, "6007", [
      // 保持は最近だが Order_Arrival_Time が窓の下限より前（窓外）。
      heldRecord(seq(1), now - ARRIVAL_WINDOW_MS - margin, now),
      // 保持を始めたのが 2 時間より前（失効）。
      heldRecord(seq(2), now - 1_000, now - ARRIVAL_WINDOW_MS - margin),
      heldRecord(seq(3), now - 1_000, now),
    ]);

    const pushed = await runInDurableObject(stub, async (instance) => {
      const batches: readonly string[][] = [];
      internals(instance).pushToStore = (_storeId, records) => {
        (batches as string[][]).push(records.map((record) => record.sequenceNumber));
        return Promise.resolve(SETTLED);
      };
      const progress = await internals(instance).drainUnrouted("6007");
      expect(progress.kind).toBe("drained");
      // 窓外・失効の 2 件は数えられる（出力はタスク 17・ここは数える構造の確認）。
      expect(progress.windowExpired).toBe(2);
      return batches;
    });

    // 窓の外にある時刻の注文を待ち行列へ入れない（並びの基準が Order_Arrival_Time ゆえ順序を壊す）。
    expect(pushed).toEqual([[seq(3)]]);
    // 保留 → 再生 → 窓外 → 再保留の循環を作らない。
    expect(await readHeld(stub, "6007")).toBeUndefined();
  });

  it("送れる Record が 1 件も無い保留も刈られる（永久に未知を返し続けない）", async () => {
    const stub = registryStub();
    await registerStore(stub, "replay-allstale", "6008");
    const now = Date.now();
    await seedHeld(stub, "6008", [heldRecord(seq(1), now - ARRIVAL_WINDOW_MS - 60_000, now)]);

    // 空の保留要求でも既知コードゆえ再生が走り、窓外だけの保留を刈る。
    const outcome = await stub.holdUnrouted("6008", []);

    expect(outcome.kind).toBe("held");
    expect(await readHeld(stub, "6008")).toBeUndefined();
    // 刈られた結果、宛先が引けるようになる（§8-a の未知応答が解ける）。
    expect(await stub.resolveStoreCode("6008")).toBe("replay-allstale");
  });
});

describe("隔離は再生されない（Requirements 8.8, 8.11）", () => {
  /** 隔離中の件数を読む（保留とは別のキーである・design §9-b）。 */
  async function readQuarantined(
    stub: DurableObjectStub<StoreRegistryDO>,
    storeCode: string,
  ): Promise<readonly HeldRecord[] | undefined> {
    const raw = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get(contractViolationKey(storeCode)),
    );
    return raw as readonly HeldRecord[] | undefined;
  }

  /** 型違反の生値（`ArrivalRecord` を構築できない——`arrival_timestamp_ms` が数値でない）。 */
  function violation(sequenceNumber: string): unknown {
    return {
      path: "/lio/order",
      payload: { store_id: "Q", terminal_id: "1", bill_no: sequenceNumber, datetime: "2026-08-17T20:52:19" },
      arrival_timestamp_ms: "0",
      sequence_number: sequenceNumber,
    };
  }

  it("店舗登録の確定でも押し込まれず、証跡として残り、宛先解決も塞がない", async () => {
    const stub = registryStub();
    await stub.quarantineContractViolations("6009", [violation(seq(9))]);

    // 保留の契機（店舗登録の確定）を起こす。隔離にこの契機は効かない——窓の外にある時刻の注文を待ち行列へ
    // 入れれば、並びの基準が Order_Arrival_Time ゆえ順序を壊す。
    await registerStore(stub, "replay-quarantine", "6009");

    expect(await lastSequenceOf("replay-quarantine", "1")).toBeUndefined();
    // 再生されないことは破棄されることではない——2 時間は上流のバグを調べる証跡として残る。
    expect(await readQuarantined(stub, "6009")).toHaveLength(1);
    // §8-a の判定は保留のキーだけを見る。隔離が宛先解決を塞げば、失効までの 2 時間、当該店舗の正常な新着まで
    // 保留へ回り続ける（隔離は宛先が既知でも起こるため、その状態は自ら解けない）。
    expect(await stub.resolveStoreCode("6009")).toBe("replay-quarantine");
  });

  it("再生の残作業に当該 Store_Code が載っていても、隔離は押し込みの対象にならない", async () => {
    const stub = registryStub();
    await registerStore(stub, "replay-quarantine-alarm", "6010");
    await stub.quarantineContractViolations("6010", [violation(seq(10))]);
    // 保留が空でも残作業に載る経路はある（再生の持ち越しの後に保留だけが失効した場合）。その回の Alarm が
    // 隔離を拾えば、待ち行列に窓外の注文が入る。
    await runInDurableObject(stub, (_instance, state) => state.storage.put(REPLAY_RESIDUAL_KEY, ["6010"]));

    await runInDurableObject(stub, (instance) => instance.alarm());

    expect(await lastSequenceOf("replay-quarantine-alarm", "1")).toBeUndefined();
    expect(await readQuarantined(stub, "6010")).toHaveLength(1);
    // 残作業は捌けたものとして落ちる（宛先が引けて保留が空ならもう待つ理由が無い）。
    const residual = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get(REPLAY_RESIDUAL_KEY),
    );
    expect(residual).toEqual([]);
  });
});
