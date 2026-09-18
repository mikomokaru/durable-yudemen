// tests/shell/apply-short-names.integration.test.ts — 札の押し込みの受け口（Workers pool）。
//
// _Validates: item-display-abbreviation Requirements 7.1, 7.3, 7.4, 7.5, 7.6, 7.13, 7.14, 7.15_
//
// 押し込みは `deliverPlan` と同じ形で外から入る。ここで確かめるのは 4 つである。
//
//   1. **順序**——マージ → 別キーへ保存 → 保存が成功してから在メモリ反映と再送。保存に失敗したら
//      従来の札を維持し、未保存の札を配信しない。
//   2. **休眠からの復元**——保存済みの札は、押し直し**なし**で読み戻る。
//   3. **マージ**——商品 A の札に商品 B を足しても A は残り、保存・復元される。
//   4. **再送**——札が変わったときだけ送る。変わらなければ送らない。
//
// `StoreSnapshot` とは別キーに保存することも合わせて見る（`CURRENT_SCHEMA_VERSION` は 13 のまま）。

import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { NoodlePreset } from "../../src/domain/store";
import { configResidualDefaults } from "../storeConfigDefaults";

/** ワイヤ上の ServerMessage を読むための緩い形。 */
type WireMessage = { readonly type: string; readonly [key: string]: unknown };

/** 投影を押し込んで店舗を成立させる（未プロビジョニングだと WS が 403 になる）。 */
async function provision(stub: DurableObjectStub<StoreTimerDO>): Promise<void> {
  const projection: StoreProjection = {
    config: {
      unitCount: 1,
      arms: 3,
      toleranceRatio: 10,
      noodlePresets: [
        { noodleType: PRESET, boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
      ] as NonEmptyArray<NoodlePreset>,
      ...configResidualDefaults(1),
      firmnessCodes: [{ code: 10011, firmness: "normal" }],
      menuItems: [
        { productCode: MENU_CODE, noodleType: PRESET, sizes: [{ code: SIZE_CODE, portions: 1 }] },
      ],
    },
    roster: [],
    active: true,
    version: 1,
  };
  await stub.applyProjection(projection);
}

/** 1 品目を届ける（申告名つき）。この品目が snapshot に載り、札が被さる対象になる。 */
async function arrive(stub: DurableObjectStub<StoreTimerDO>, declaredName: string): Promise<void> {
  await stub.receiveRecords([
    {
      path: "/lio/order",
      payload: {
        store_id: "0007",
        terminal_id: "1",
        bill_no: `bill-${declaredName}`,
        datetime: "2026-09-15T12:00:00",
        order_items: [
          { plu_no: MENU_CODE, item_name: declaredName, child_items: [{ plu_no: SIZE_CODE }] },
        ],
      },
      arrivalTimestampMs: Date.now() - 1_000,
      sequenceNumber: `${declaredName}`.padStart(56, "0"),
    },
  ]);
}

/** WS を張り、受信を集める。 */
async function connect(stub: DurableObjectStub<StoreTimerDO>): Promise<WireMessage[]> {
  const upgrade = await stub.fetch("https://do.invalid/s/store/ws", {
    headers: { Upgrade: "websocket" },
  });
  if (upgrade.status !== 101 || upgrade.webSocket === null) {
    throw new Error(`WS が確立しなかった（status=${upgrade.status}）`);
  }
  const received: WireMessage[] = [];
  const ws = upgrade.webSocket;
  ws.accept();
  ws.addEventListener("message", (event) => {
    received.push(JSON.parse(event.data as string) as WireMessage);
  });
  return received;
}

/** 受信から snapshot の品目を取り出す（最後の 1 通）。 */
function itemsOf(received: readonly WireMessage[]): readonly Record<string, unknown>[] {
  const snapshots = received.filter((m) => m.type === "snapshot");
  const last = snapshots.at(-1);
  return (last?.orderItems ?? []) as readonly Record<string, unknown>[];
}

/** 送信が落ち着くまで待つ（WS はイベントループ越しに届く）。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

/** 札の永続キー（`store-timer-do.ts` の `SHORT_NAMES_KEY` と同じ値・意図的に二重化して固定する）。 */
const SHORT_NAMES_KEY = "shortNames";
/** Timer の永続キー（`store-timer-do.ts` の `SNAPSHOT_KEY`）。札がこちらへ混ざらないことを見る。 */
const SNAPSHOT_KEY = "activeTimers";

/** 麺の対応表（`receiveRecords` が 1 品目を解釈するのに要る最小）。 */
const PRESET = "REG";
const MENU_CODE = 11421;
const SIZE_CODE = 19401;
const DECLARED = "特味噌ネギラーメン";

const STORE = "yamaokaya-1108";

function stubOf(storeId: string = STORE): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  // 型生成上まだ素の DurableObjectNamespace ゆえ、RPC を呼ぶために class 型へ絞り込む（既存の作法）。
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

/** 永続した札を読む。DO の内側からしか見えない。 */
async function storedLabels(
  stub: DurableObjectStub<StoreTimerDO>,
): Promise<Record<string, string> | undefined> {
  return runInDurableObject(stub, async (_instance, state) => {
    return (await state.storage.get(SHORT_NAMES_KEY)) as Record<string, string> | undefined;
  });
}

/**
 * 在メモリの状態を捨てる（hibernate と同じ状態）。`loaded` を落とせば次の入口で `ensureLoaded` が走り、
 * 永続から読み直す——**押し直しを待たずに札が戻る**ことを、この経路で確かめる。
 */
function forgetMemory(instance: StoreTimerDO): void {
  const mutable = instance as unknown as {
    loaded: boolean;
    shortNames: Readonly<Record<string, string>>;
  };
  mutable.loaded = false;
  mutable.shortNames = {};
}

afterEach(async () => {
  await reset();
});

describe("札の押し込み", () => {
  it("受け取った札を `StoreSnapshot` とは別のキーへ保存する", async () => {
    const stub = stubOf();
    await stub.applyShortNames({ 特味噌ネギラーメン: "特味噌ネギ" });

    expect(await storedLabels(stub)).toEqual({ 特味噌ネギラーメン: "特味噌ネギ" });
  });

  it("**Timer の永続（`activeTimers`）を書き換えない**（v13 のまま・`migrate` に分岐を足さない）", async () => {
    const stub = stubOf();
    await provision(stub);
    await arrive(stub, DECLARED);

    // 札の適用**前**の中身を控える。実在するキーを読む——不在のキーを読んで {} と比べても何も言えない。
    const before = await runInDurableObject(stub, async (_i, state) =>
      JSON.stringify(await state.storage.get(SNAPSHOT_KEY)),
    );
    expect(before, "前提：Timer の永続が実在する").not.toBe(undefined);

    await stub.applyShortNames({ [DECLARED]: "特味噌ネギ" });

    const after = await runInDurableObject(stub, async (_i, state) =>
      JSON.stringify(await state.storage.get(SNAPSHOT_KEY)),
    );
    expect(after, "札の適用が Timer の永続を変えた").toBe(before);
    // 札の値そのものでは見ない——申告名 `特味噌ネギラーメン` は札 `特味噌ネギ` を部分文字列として含む。
    // 見るべきは**項目が生えていないこと**である（`OrderItem` に `shortName` は無い）。
    expect(after, "Timer の永続に shortName が現れた").not.toContain("shortName");
  });

  it("**商品 A の札へ商品 B をマージしても A は残る**（保存・復元とも）", async () => {
    const stub = stubOf();
    await stub.applyShortNames({ 特味噌ネギラーメン: "特味噌ネギ" });
    await stub.applyShortNames({ 辛味噌ネギラーメン: "辛味噌ネギ" });

    expect(await storedLabels(stub)).toEqual({
      特味噌ネギラーメン: "特味噌ネギ",
      辛味噌ネギラーメン: "辛味噌ネギ",
    });
  });

  it("同じ名前への押し直しは後着で上書きする", async () => {
    const stub = stubOf();
    await stub.applyShortNames({ 特味噌ネギラーメン: "特味噌ネギ" });
    await stub.applyShortNames({ 特味噌ネギラーメン: "特味噌ネ" });

    expect(await storedLabels(stub)).toEqual({ 特味噌ネギラーメン: "特味噌ネ" });
  });

  it("空の札・空の鍵は落とす（「札がある」と「無い」を区別できなくしない）", async () => {
    const stub = stubOf();
    await stub.applyShortNames({
      特味噌ネギラーメン: "特味噌ネギ",
      辛味噌ネギラーメン: "",
      "": "x",
    });

    expect(await storedLabels(stub)).toEqual({ 特味噌ネギラーメン: "特味噌ネギ" });
  });

  it("**休眠からの復帰で、押し直しなしに保存済みの札が在メモリへ戻る**", async () => {
    const stub = stubOf();
    await stub.applyShortNames({ 特味噌ネギラーメン: "特味噌ネギ" });

    // **観測は「書き込みが起きないこと」で行う。** 保存済みの値を読むだけでは復元を証明できない
    // ——メモリが空のままでも `applyShortNames` が同じ値を書き直し、永続は同じに見えるからである。
    // 在メモリへ戻っていれば「変化なし」と判定され、`put` は 1 度も起きない。
    const puts = await runInDurableObject(stub, async (instance, state) => {
      // 在メモリを捨てる（hibernate と同じ状態）。**押し直しはしない。**
      forgetMemory(instance);
      const original = state.storage.put.bind(state.storage);
      let count = 0;
      state.storage.put = ((...args: Parameters<typeof original>) => {
        count += 1;
        return original(...args);
      }) as typeof original;
      try {
        // 同じ札をもう一度。復元されていれば変化が無く、書き込みも再送も起きない。
        await instance.applyShortNames({ 特味噌ネギラーメン: "特味噌ネギ" });
      } finally {
        state.storage.put = original;
      }
      return count;
    });

    expect(puts, "復元されていれば同じ札で書き込みは起きない").toBe(0);
    expect(await storedLabels(stub)).toEqual({ 特味噌ネギラーメン: "特味噌ネギ" });
  });

  it("札が変わったときだけ書き込む（変わらなければ何もしない）", async () => {
    const stub = stubOf();
    await stub.applyShortNames({ 特味噌ネギラーメン: "特味噌ネギ" });

    const counts = await runInDurableObject(stub, async (instance, state) => {
      const original = state.storage.put.bind(state.storage);
      let count = 0;
      state.storage.put = ((...args: Parameters<typeof original>) => {
        count += 1;
        return original(...args);
      }) as typeof original;
      try {
        // 同じ札 → 変化なし。
        await instance.applyShortNames({ 特味噌ネギラーメン: "特味噌ネギ" });
        const unchanged = count;
        // 別の札 → 変化あり。
        await instance.applyShortNames({ 辛味噌ネギラーメン: "辛味噌ネギ" });
        return { unchanged, changed: count - unchanged };
      } finally {
        state.storage.put = original;
      }
    });

    expect(counts.unchanged, "変わらないのに書いている").toBe(0);
    expect(counts.changed, "変わったのに書いていない").toBe(1);
  });
});

describe("再送（WS の受信で観測する）", () => {
  it("**札が変われば、札つきの snapshot が届く**", async () => {
    const stub = stubOf();
    await provision(stub);
    await arrive(stub, DECLARED);
    const received = await connect(stub);
    await settle();
    // 接続時の hydration では札がまだ無い＝全名のまま。
    expect(itemsOf(received)[0]?.shortName).toBeUndefined();
    const before = received.filter((m) => m.type === "snapshot").length;

    await stub.applyShortNames({ [DECLARED]: "特味噌ネギ" });
    await settle();

    const after = received.filter((m) => m.type === "snapshot").length;
    expect(after, "札が変わったのに送られていない").toBe(before + 1);
    expect(itemsOf(received)[0]?.shortName).toBe("特味噌ネギ");
    expect(itemsOf(received)[0]?.itemName, "申告名は落とさない").toBe(DECLARED);
  });

  it("**同じ札では送らない**", async () => {
    const stub = stubOf();
    await provision(stub);
    await arrive(stub, DECLARED);
    await stub.applyShortNames({ [DECLARED]: "特味噌ネギ" });
    const received = await connect(stub);
    await settle();
    const before = received.filter((m) => m.type === "snapshot").length;

    await stub.applyShortNames({ [DECLARED]: "特味噌ネギ" });
    await settle();

    expect(received.filter((m) => m.type === "snapshot").length, "変わらないのに送っている").toBe(
      before,
    );
  });

  it("札を持たない品目には `shortName` を付けない（受け手は全名へ戻る）", async () => {
    const stub = stubOf();
    await provision(stub);
    await arrive(stub, DECLARED);
    const received = await connect(stub);
    await stub.applyShortNames({ 別の商品: "別" });
    await settle();

    expect(itemsOf(received)[0]?.shortName).toBeUndefined();
  });

  it("**保存に失敗したら、未保存の札は送られず在メモリにも残らない**", async () => {
    const stub = stubOf();
    await provision(stub);
    await arrive(stub, DECLARED);
    await stub.applyShortNames({ [DECLARED]: "特味噌ネギ" });
    const received = await connect(stub);
    await settle();
    const before = received.filter((m) => m.type === "snapshot").length;

    await expect(
      runInDurableObject(stub, async (instance, state) => {
        const original = state.storage.put.bind(state.storage);
        state.storage.put = () => Promise.reject(new Error("storage down"));
        try {
          await instance.applyShortNames({ [DECLARED]: "特ネギ" });
        } finally {
          state.storage.put = original;
        }
      }),
    ).rejects.toThrow("storage down");
    await settle();

    // 送っていない。
    expect(received.filter((m) => m.type === "snapshot").length).toBe(before);
    // 在メモリも従来のまま——次の送信でも旧い札が出る（未保存の札が画面へ出ない）。
    await stub.applyShortNames({ 別の商品: "別" });
    await settle();
    expect(itemsOf(received)[0]?.shortName).toBe("特味噌ネギ");
  });

  it("**休眠復帰の後、押し直さずに hydration で A・B 両方の札が届く**", async () => {
    const stub = stubOf();
    await provision(stub);
    await arrive(stub, "特味噌ネギラーメン");
    await arrive(stub, "辛味噌ネギラーメン");
    await stub.applyShortNames({ 特味噌ネギラーメン: "特味噌ネギ" });
    await stub.applyShortNames({ 辛味噌ネギラーメン: "辛味噌ネギ" });

    // 在メモリを捨てる（hibernate と同じ状態）。**押し直しはしない。**
    await runInDurableObject(stub, (instance) => {
      forgetMemory(instance);
    });

    const received = await connect(stub);
    await settle();
    const labels = Object.fromEntries(
      itemsOf(received).map((item) => [item.itemName, item.shortName]),
    );
    expect(labels).toEqual({ 特味噌ネギラーメン: "特味噌ネギ", 辛味噌ネギラーメン: "辛味噌ネギ" });
  });
});

describe("保存の失敗", () => {
  it("保存に失敗したら従来の札を維持し、未保存の札を在メモリへ入れない", async () => {
    const stub = stubOf();
    await stub.applyShortNames({ 特味噌ネギラーメン: "特味噌ネギ" });

    // `put` を落として押し込む。呼び手へは失敗が伝わる。
    await expect(
      runInDurableObject(stub, async (instance, state) => {
        const original = state.storage.put.bind(state.storage);
        state.storage.put = () => Promise.reject(new Error("storage down"));
        try {
          await instance.applyShortNames({ 辛味噌ネギラーメン: "辛味噌ネギ" });
        } finally {
          state.storage.put = original;
        }
      }),
    ).rejects.toThrow("storage down");

    // 従来の札はそのまま。未保存の札は永続にも現れない。
    expect(await storedLabels(stub)).toEqual({ 特味噌ネギラーメン: "特味噌ネギ" });
  });
});
