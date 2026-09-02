// tests/shell/pos-records.integration.test.ts — 取り込み経路の受け口（StoreTimerDO.receiveRecords）の
// 統合テスト（Workers pool）。
//
// _Validates: Requirements 5.5, 5.6, 5.7, 6.5, 6.16, 6.26, 6.27, 6.28, 6.34, 9.9, 10.2, 10.7, 11.17,
// 11.19, 12.15_
//
// 本ファイルが受け持つのは 10 の経路で、いずれも「受領が単一の遷移として確定し、確定の前に何も主張せず、
// 翻訳できた品目だけが正本へ写る」という一点に絞る。
//
//   N Record が単一 put・単一 broadcast になる（Property 20）
//   確定は put 成功の上にのみ立つ（Property 8）
//   未プロビジョニングと非活性が別種別で返る（Property 15）
//   非麺が混ざっても翻訳できた品目のみが写る（全体拒否しない・AC 6.27）
//   対応表に無い麺種は写らず数えられ、他の品目は確定する（AC 6.28）
//   `table_no` の欠落・`0` が `null` へ写る（AC 6.26）
//   単調性で弾いた重複が `doDedupeSkipped` に現れる（AC 12.15）
//   同一バッチの再送で put も broadcast も新たに起きない（Property 9・DO 越し）
//   任意の Record 列について再送が初回受理と同一の確定状態へ収束する（Property 9・面）
//   重複と新規が混在するバッチでも新規は確定する（Record 間に原子性が無い・Property 11 後半）
//   後着で品目が減る／0 件で除去／初回 0 件で無変更が**永続に反映される**（Property 16・DO 越し）
//
// **Property 9 を DO 越しで押さえる理由。** engine 側（tests/core/receive.property.test.ts）は「2 回目は
// 同一インスタンスが返り Effect が出ない」までを見ている。design の Property 9 の主張は「`put` も
// broadcast も新たに起きず、確定状態が一致する」であり、それは Effect の実行（`runEffects`）を通した
// 先でしか観測できない——no-op の判定が正しくても、shell が Effect の無い遷移で put を発行していれば
// 主張は破れる。engine の内側では、その破れ方が見えない。
//
// **Worker の配線（`POST /pos/records`・Code_Memo・fan-out）は通さない。** それは別タスクの関心事であり、
// ここは DO の受け口を RPC として直接叩く——受け口の結末（`ReceiveOutcome`）が種別で分かれることこそが、
// HTTP ステータスを持たない RPC で分類を運ぶという設計判断の観測点である。
//
// ハーネスは cook-scheduling.integration.test.ts に倣う（provision / connect / freshStoreId / readSnapshot）。

import { afterEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { env, reset, runInDurableObject } from "cloudflare:test";
import type { ReceiveOutcome, StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { ServerMessage } from "../../src/domain/messages";
import type { FirmnessCode, MenuItem, NoodlePreset, StoreConfig } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { ArrivalRecord } from "../../src/ingress/batch";
import type { StoreSnapshot } from "../../src/engine/snapshot";
import { schedulingDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** タイマー SSOT の単一キー。store-timer-do.ts の SNAPSHOT_KEY（private 定数）と一致させる。 */
const SNAPSHOT_KEY = "activeTimers";

/** Order_Path。既知 `path` の分類は Worker の関心事だが、Record の形を成すために値が要る。 */
const ORDER_PATH = "/lio/order";

/** 対応表に載っている麺種（`noodlePresets` にも在る＝待ち行列へ写る）。 */
const NOODLE = "PosRamen";

/** `menuItems` には在るが `noodlePresets` に無い麺種（AC 6.28 の観測対象）。 */
const ORPHAN_NOODLE = "PosOrphanNoodle";

/** 親品目の商品コード。前者は写る麺、後者は麺種を引けない麺。 */
const MENU_CODE = 11421;
const ORPHAN_MENU_CODE = 116051;

/** 麺量の商品コード（普通＝1 スロット / 大盛＝2 スロット）。 */
const SIZE_REGULAR = 19401;
const SIZE_LARGE = 19603;

/** 硬さの商品コード。指定が無い品目は既定（normal）へ畳まれる。 */
const FIRMNESS_HARD_CODE = 10010;

/** 麺量を持たない品目の商品コード（丼・餃子・飲料の代表。`menuItems` に無い）。 */
const NON_NOODLE_CODE = 99999;

const firmnessCodes: readonly FirmnessCode[] = [
  { code: FIRMNESS_HARD_CODE, firmness: "hard" },
  { code: 10011, firmness: "normal" },
];

const menuItems: readonly MenuItem[] = [
  {
    productCode: MENU_CODE,
    noodleType: NOODLE,
    sizes: [
      { code: SIZE_REGULAR, slotSpan: 1 },
      { code: SIZE_LARGE, slotSpan: 2 },
    ] as NonEmptyArray<MenuItem["sizes"][number]>,
  },
  {
    productCode: ORPHAN_MENU_CODE,
    noodleType: ORPHAN_NOODLE,
    sizes: [{ code: SIZE_REGULAR, slotSpan: 1 }] as NonEmptyArray<MenuItem["sizes"][number]>,
  },
];

const UNIT_COUNT = 2;

/** 本テストの店舗設定。`noodlePresets` に ORPHAN_NOODLE を載せないことが AC 6.28 の前提である。 */
const storeConfig: StoreConfig = {
  unitCount: UNIT_COUNT,
  arms: 3,
  toleranceRatio: 10,
  noodlePresets: [
    { noodleType: NOODLE, boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
  ] as NonEmptyArray<NoodlePreset>,
  ...schedulingDefaults(UNIT_COUNT),
  firmnessCodes,
  menuItems,
};

/**
 * 対応表 2 枚が空のままの店舗設定（`[Q8]` の値が未提示の状態）。
 *
 * 既定は空配列であり、この状態でも構造は成立する——麺量の商品コードを引けない品目は「茹でない」へ落ちる
 * ため、茹で対象が 0 件になるだけである。
 */
const untabledStoreConfig: StoreConfig = { ...storeConfig, firmnessCodes: [], menuItems: [] };

/** run 間で DO 状態が持ち越さないよう storeId を一意に採番する（[a-z0-9-]・長さ ≤64 を満たす）。 */
function freshStoreId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** StoreTimerDO の型付き RPC（applyProjection / receiveRecords）を呼べる形でスタブを得る。 */
function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

/** 投影を押し込んでプロビジョニングする（レジストリを介さない・design.md の推奨経路）。 */
async function provision(
  storeId: string,
  active: boolean = true,
): Promise<DurableObjectStub<StoreTimerDO>> {
  const stub = storeStub(storeId);
  const projection: StoreProjection = { config: storeConfig, roster: [], active, version: 1 };
  await stub.applyProjection(projection);
  return stub;
}

/** 対応表 2 枚が空の店舗をプロビジョニングする（`[Q8]` の値が未提示のままの状態）。 */
async function provisionWithoutTables(storeId: string): Promise<DurableObjectStub<StoreTimerDO>> {
  const stub = storeStub(storeId);
  const projection: StoreProjection = {
    config: untabledStoreConfig,
    roster: [],
    active: true,
    version: 1,
  };
  await stub.applyProjection(projection);
  return stub;
}

/**
 * 56 桁の `sequence_number`。上流の KDS が採る桁数に合わせる——桁数が揃っていれば辞書順が数値順に一致し、
 * 単調性の比較がそのまま働く（桁数を変えて比べる形は本テストの関心事ではない）。
 */
function seq(n: number): string {
  return String(n).padStart(56, "0");
}

/** 麺の品目（麺量を持つ＝茹で対象）。硬さの指定は任意。 */
function noodleItem(
  productCode: number,
  sizeCode: number,
  firmnessCode?: number,
): Record<string, unknown> {
  const childItems: Record<string, unknown>[] = [{ plu_no: sizeCode }];
  if (firmnessCode !== undefined) childItems.push({ plu_no: firmnessCode });
  return { plu_no: productCode, child_items: childItems };
}

/** 麺量を持たない品目（丼・餃子・飲料）。翻訳できないことが正常な入力である。 */
function nonNoodleItem(): Record<string, unknown> {
  return { plu_no: NON_NOODLE_CODE, child_items: [] };
}

/** Order_Path の Record を組む。`payload` の中身は上流の実データの形に倣う。 */
function orderRecord(args: {
  readonly billNo: string;
  readonly sequenceNumber: string;
  readonly terminalId?: string;
  readonly arrivalTimestampMs?: number;
  readonly tableNo?: unknown;
  readonly items?: readonly Record<string, unknown>[];
}): ArrivalRecord {
  const payload: Record<string, unknown> = {
    store_id: "0007",
    terminal_id: args.terminalId ?? "1",
    bill_no: args.billNo,
    datetime: "2026-08-17T20:52:19",
    order_items: args.items ?? [noodleItem(MENU_CODE, SIZE_REGULAR)],
  };
  if (args.tableNo !== undefined) payload.table_no = args.tableNo;
  return {
    path: ORDER_PATH,
    payload,
    arrivalTimestampMs: args.arrivalTimestampMs ?? Date.now() - 1_000,
    sequenceNumber: args.sequenceNumber,
  };
}

/** 永続スナップショットを読む（待ち行列の確定状態はここが正本である）。 */
async function readSnapshot(
  stub: DurableObjectStub<StoreTimerDO>,
): Promise<StoreSnapshot | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
  );
}

/** 品目の同定（externalOrderId × itemIndex）。待ち行列の突き合わせをこの組で行う。 */
function itemKeys(
  entries: readonly { readonly externalOrderId: string; readonly itemIndex: number }[],
): readonly (readonly [string, number])[] {
  return entries.map(({ externalOrderId, itemIndex }) => [externalOrderId, itemIndex] as const);
}

/** 接続中クライアントの受信を観測するハンドル（broadcast の回数と不在を件数で見るため生の列を持つ）。 */
interface WsProbe {
  readonly messages: readonly ServerMessage[];
  waitForSnapshot(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs?: number,
  ): Promise<ServerMessage>;
  close(): void;
}

/** WS を張り、client 端を accept して受信を収集する（cook-scheduling.integration.test.ts と同形）。 */
async function connect(stub: DurableObjectStub<StoreTimerDO>): Promise<WsProbe> {
  const upgrade = await stub.fetch("https://do.invalid/s/store/ws", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgrade.webSocket;
  if (ws === null) throw new Error(`WS 接続が確立されなかった（status=${upgrade.status}）`);

  const messages: ServerMessage[] = [];
  const waiters: {
    readonly predicate: (message: ServerMessage) => boolean;
    readonly resolve: (message: ServerMessage) => void;
  }[] = [];
  ws.accept();
  ws.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter !== undefined && waiter.predicate(message)) {
        waiter.resolve(message);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    messages,
    waitForSnapshot(predicate, timeoutMs = 5_000) {
      const already = messages.find((message) => predicate(message));
      if (already !== undefined) return Promise.resolve(already);
      return new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("メッセージの待機がタイムアウトした")),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    close: () => ws.close(),
  };
}

/** 猶予を置く（broadcast の不在は「一定時間待って届かない」ことでしか観測できない）。 */
function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `storage.put` の呼び出し回数を数えながら受領を通す（単一 put の主張はここでしか立たない）。 */
async function receiveCountingPuts(
  stub: DurableObjectStub<StoreTimerDO>,
  records: readonly ArrivalRecord[],
): Promise<{ readonly outcome: ReceiveOutcome; readonly putCalls: number }> {
  return runInDurableObject(stub, async (instance, state) => {
    const originalPut = state.storage.put.bind(state.storage);
    let putCalls = 0;
    (state.storage as { put: unknown }).put = (...args: readonly unknown[]) => {
      putCalls += 1;
      return (originalPut as (...a: readonly unknown[]) => Promise<void>)(...args);
    };
    try {
      const outcome = await instance.receiveRecords(records);
      return { outcome, putCalls };
    } finally {
      (state.storage as { put: unknown }).put = originalPut;
    }
  });
}

/** `storage.put` を失敗させたまま受領を通す（確定が put 成功の上にのみ立つことの観測）。 */
async function receiveWithFailingPut(
  stub: DurableObjectStub<StoreTimerDO>,
  records: readonly ArrivalRecord[],
): Promise<ReceiveOutcome> {
  return runInDurableObject(stub, async (instance, state) => {
    const originalPut = state.storage.put.bind(state.storage);
    (state.storage as { put: unknown }).put = () => Promise.reject(new Error("put failed"));
    try {
      return await instance.receiveRecords(records);
    } finally {
      (state.storage as { put: unknown }).put = originalPut;
    }
  });
}

// 店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除して独立させる。
afterEach(async () => {
  await reset();
});

describe("1 受領は 1 遷移・1 put である（Requirements 5.5）", () => {
  it("10 Record を 1 回で受けると put は 1 回・broadcast も 1 回になる", async () => {
    const stub = await provision(freshStoreId("pos-single-put"));
    const client = await connect(stub);
    await client.waitForSnapshot((message) => message.type === "snapshot");
    const before = client.messages.length;

    const records = Array.from({ length: 10 }, (_, i) =>
      orderRecord({ billNo: `bill-${i}`, sequenceNumber: seq(i + 1) }),
    );
    const { outcome, putCalls } = await receiveCountingPuts(stub, records);

    expect(outcome.kind).toBe("settled");
    // Record 数に比例して put が増えない（Record ごとに decide を呼べば Persist が 10 個生じる）。
    expect(putCalls).toBe(1);

    await client.waitForSnapshot(
      (message) => message.type === "snapshot" && message.pendingOrders.length === 10,
    );
    await idle(200);
    expect(client.messages.length).toBe(before + 1);

    const persisted = await readSnapshot(stub);
    expect(persisted?.pendingOrders).toHaveLength(10);
    // 判定材料も同じ put で確定する（端末は 1 つゆえ最後の seq が残る）。
    expect(persisted?.lastSequenceByTerminal).toEqual({ "1": seq(10) });

    client.close();
  });
});

describe("確定は put 成功の上にのみ立つ（Requirements 5.6, 5.7）", () => {
  it("put を失敗させると persist-failed が返り、待ち行列も broadcast も動かない", async () => {
    const stub = await provision(freshStoreId("pos-persist-failed"));
    const client = await connect(stub);
    await client.waitForSnapshot((message) => message.type === "snapshot");

    // 対照：put が働くときは settled が返り broadcast も出る（後段の「出ない」が空虚でないことの担保）。
    const first = await stub.receiveRecords([
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(1) }),
    ]);
    expect(first.kind).toBe("settled");
    await client.waitForSnapshot(
      (message) => message.type === "snapshot" && message.pendingOrders.length === 1,
    );
    const confirmed = await readSnapshot(stub);
    const beforeFailure = client.messages.length;

    const failed = await receiveWithFailingPut(stub, [
      orderRecord({ billNo: "bill-b", sequenceNumber: seq(2) }),
    ]);

    expect(failed.kind).toBe("persist-failed");
    // broadcast は put 成功の上にしか立たない。新しい snapshot は 1 通も届かない。
    await idle(200);
    expect(client.messages.length).toBe(beforeFailure);
    // 集合も判定材料も直前の確定状態のまま（判定材料だけ進む欠落を作らない）。
    expect(await readSnapshot(stub)).toEqual(confirmed);

    client.close();
  });
});

describe("未プロビジョニングと非活性は別の結末である（Requirements 11.17, 11.19）", () => {
  it("投影未受領は unprovisioned を返して痕跡を残さず、非活性は deactivated を返す", async () => {
    // 投影を一度も押し込んでいない DO。Code_Index に載った直後の到着がここへ来る。
    const pending = storeStub(freshStoreId("pos-unprovisioned"));
    const unprovisioned = await pending.receiveRecords([
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(1) }),
    ]);
    expect(unprovisioned.kind).toBe("unprovisioned");
    // 書き込みゼロ——集合を変えないだけでなく、痕跡そのものを残さない（put の前で拒む）。
    await runInDurableObject(pending, async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0);
    });

    const closed = await provision(freshStoreId("pos-deactivated"), false);
    const deactivated = await closed.receiveRecords([
      orderRecord({ billNo: "bill-b", sequenceNumber: seq(1) }),
    ]);
    expect(deactivated.kind).toBe("deactivated");
    expect((await readSnapshot(closed))?.pendingOrders ?? []).toEqual([]);

    // 2 つが同じ種別に畳まれていない（畳めば店舗開設の瞬間に届いた注文が「飛ばして数える」で消える）。
    expect(unprovisioned.kind).not.toBe(deactivated.kind);
  });
});

describe("翻訳できた品目のみが写る（Requirements 6.5, 6.16, 6.27, 6.34）", () => {
  it("非麺が混ざっても全体拒否せず、itemIndex は order_items の元の位置（欠番あり）になる", async () => {
    const stub = await provision(freshStoreId("pos-partial-items"));
    const outcome = await stub.receiveRecords([
      orderRecord({
        billNo: "bill-a",
        sequenceNumber: seq(1),
        tableNo: 12,
        items: [
          nonNoodleItem(),
          noodleItem(MENU_CODE, SIZE_REGULAR, FIRMNESS_HARD_CODE),
          nonNoodleItem(),
          noodleItem(MENU_CODE, SIZE_LARGE),
        ],
      }),
    ]);
    expect(outcome).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: 0, unknownNoodleType: 0 },
    });

    const persisted = await readSnapshot(stub);
    const orders = persisted?.pendingOrders ?? [];
    // 位置 0・2（非麺）は欠番として残る。詰め直せば元のペイロードのどこから来たかという事実が失われる。
    expect(orders.map((order) => order.itemIndex)).toEqual([1, 3]);
    // 麺量が slotSpan へ、硬さの商品コードが firmness へ翻訳される（指定が無い品目は既定へ畳む）。
    expect(orders.map((order) => order.slotSpan)).toEqual([1, 2]);
    expect(orders.map((order) => order.firmness)).toEqual(["hard", "normal"]);
    expect(orders.map((order) => order.noodleType)).toEqual([NOODLE, NOODLE]);
    expect(orders.map((order) => order.tableId)).toEqual(["12", "12"]);
    // externalOrderId は Unique_Key（4 要素をパーセントエンコードして `:` 連結）。`order_id` は含まない。
    expect(orders[0]?.externalOrderId).toBe("0007:1:bill-a:2026-08-17T20%3A52%3A19");
  });

  it("対応表に無い麺種の品目は写らず unknownNoodleType に数えられ、他の品目は確定する", async () => {
    const stub = await provision(freshStoreId("pos-unknown-noodle"));
    const outcome = await stub.receiveRecords([
      orderRecord({
        billNo: "bill-a",
        sequenceNumber: seq(1),
        items: [noodleItem(MENU_CODE, SIZE_REGULAR), noodleItem(ORPHAN_MENU_CODE, SIZE_REGULAR)],
      }),
    ]);

    expect(outcome).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: 0, unknownNoodleType: 1 },
    });
    const orders = (await readSnapshot(stub))?.pendingOrders ?? [];
    expect(orders.map((order) => order.itemIndex)).toEqual([0]);
    expect(orders.map((order) => order.noodleType)).toEqual([NOODLE]);
  });

  it("table_no の欠落と 0 はいずれも卓に紐づかない品目として null へ写る", async () => {
    const stub = await provision(freshStoreId("pos-table-id"));
    const outcome = await stub.receiveRecords([
      orderRecord({ billNo: "bill-absent", sequenceNumber: seq(1) }),
      orderRecord({ billNo: "bill-zero", sequenceNumber: seq(2), tableNo: 0 }),
      orderRecord({ billNo: "bill-five", sequenceNumber: seq(3), tableNo: 5 }),
    ]);
    expect(outcome.kind).toBe("settled");

    const orders = (await readSnapshot(stub))?.pendingOrders ?? [];
    expect(orders).toHaveLength(3);
    expect(orders.map((order) => order.tableId)).toEqual([null, null, "5"]);
  });
});

describe("重複は読み飛ばして数える（Requirements 12.15）", () => {
  it("単調でない sequence_number の Record は集合を変えず doDedupeSkipped に現れる", async () => {
    const stub = await provision(freshStoreId("pos-dedupe"));
    const first = await stub.receiveRecords([
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(10) }),
      orderRecord({ billNo: "bill-b", sequenceNumber: seq(11) }),
    ]);
    expect(first).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: 0, unknownNoodleType: 0 },
    });
    const confirmed = await readSnapshot(stub);
    expect(itemKeys(confirmed?.pendingOrders ?? [])).toHaveLength(2);

    // 同一バッチの再送（同じ seq）＋ より小さい seq。いずれも単調性で弾かれる。
    const resent = await stub.receiveRecords([
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(10) }),
      orderRecord({ billNo: "bill-b", sequenceNumber: seq(11) }),
      orderRecord({ billNo: "bill-c", sequenceNumber: seq(9) }),
    ]);
    expect(resent).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: 3, unknownNoodleType: 0 },
    });
    // 状態は初回受理と同一へ収束する（bill-c は入らない）。
    expect(await readSnapshot(stub)).toEqual(confirmed);
  });
});

// ── Property 9（冪等は収束する）— 生成器 ──
//
// `sequence_number` は 56 桁へ揃えた数値文字列にし（桁が揃えば辞書順が数値順に一致する）、同一端末に対して
// 新旧が入り混じる列を高い頻度で踏ませる。品目数は 0 も振る——0 件は「キャンセル、または麺を含まない注文」
// という正常な入力であり、再送の収束はそこでも成り立たなければならない。
const genRecords: fc.Arbitrary<readonly ArrivalRecord[]> = fc.array(
  fc
    .record({
      billNo: fc.constantFrom("bill-a", "bill-b", "bill-c"),
      terminalId: fc.constantFrom("1", "2"),
      sequence: fc.integer({ min: 1, max: 8 }),
      itemCount: fc.integer({ min: 0, max: 2 }),
    })
    .map(({ billNo, terminalId, sequence, itemCount }) =>
      orderRecord({
        billNo,
        terminalId,
        sequenceNumber: seq(sequence),
        items: Array.from({ length: itemCount }, () => noodleItem(MENU_CODE, SIZE_REGULAR)),
      }),
    ),
  // 空の列は主張が空虚になる（`doDedupeSkipped` が 0 = 0 で通る）ため下限を 1 に置く。空バッチの受理は
  // Worker の受け口の関心事であり、そちらで押さえている。
  { minLength: 1, maxLength: 5 },
);

describe("Property 9: 冪等は収束する（Requirements 9.9, 10.2, 10.7）", () => {
  it("同一バッチを再送しても put は 1 回も増えず broadcast も出ない", async () => {
    const stub = await provision(freshStoreId("pos-idempotent"));
    const client = await connect(stub);
    await client.waitForSnapshot((message) => message.type === "snapshot");

    const records = [
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(1) }),
      orderRecord({ billNo: "bill-b", sequenceNumber: seq(2) }),
    ];
    const first = await stub.receiveRecords(records);
    expect(first).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: 0, unknownNoodleType: 0 },
    });
    await client.waitForSnapshot(
      (message) => message.type === "snapshot" && message.pendingOrders.length === 2,
    );
    const confirmed = await readSnapshot(stub);
    const afterFirst = client.messages.length;

    // 上流の retry がそのまま届く形（同一バッチの二度目）。
    const resent = await receiveCountingPuts(stub, records);

    expect(resent.outcome).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: records.length, unknownNoodleType: 0 },
    });
    // 受理は返るが確定は起きない——put が 1 回も走らないことが「新たに起きない」の観測点である。
    expect(resent.putCalls).toBe(0);
    await idle(200);
    expect(client.messages.length).toBe(afterFirst);
    expect(await readSnapshot(stub)).toEqual(confirmed);

    client.close();
  });

  it("任意の Record 列について、再送は初回受理と同一の確定状態へ収束する", async () => {
    await fc.assert(
      fc.asyncProperty(genRecords, async (records) => {
        const stub = await provision(freshStoreId("pos-converge"));

        const first = await stub.receiveRecords(records);
        expect(first.kind).toBe("settled");
        const confirmed = await readSnapshot(stub);

        // 2 回目・3 回目。**何度送っても**が主張ゆえ、1 度の再送で終えない。
        const second = await receiveCountingPuts(stub, records);
        const third = await receiveCountingPuts(stub, records);

        // 全件が単調性で弾かれる（初回で判定材料が列の最大 seq まで進んでいる）。
        expect(second.outcome).toEqual({
          kind: "settled",
          counts: { doDedupeSkipped: records.length, unknownNoodleType: 0 },
        });
        expect(third.outcome).toEqual(second.outcome);
        expect(second.putCalls).toBe(0);
        expect(third.putCalls).toBe(0);
        expect(await readSnapshot(stub)).toEqual(confirmed);
      }),
      // 1 run が DO の provision と 3 回の受領を伴うため試行数を絞る（母集団は 5 件までの列で足りる）。
      { numRuns: 12 },
    );
  });
});

describe("Property 11: Record 間には原子性が無い（Requirements 5.5, 9.2, 9.5）", () => {
  it("重複と新規が混在するバッチでも、新規は同一の put で確定する", async () => {
    const stub = await provision(freshStoreId("pos-overlap"));
    const first = await stub.receiveRecords([
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(10) }),
      orderRecord({ billNo: "bill-b", sequenceNumber: seq(11) }),
    ]);
    expect(first.kind).toBe("settled");

    // 上流の bisect は「どこまで成功したか」を知らないため、重なりを含むバッチが届く。
    const overlapped = await receiveCountingPuts(stub, [
      orderRecord({ billNo: "bill-b", sequenceNumber: seq(11) }),
      orderRecord({ billNo: "bill-c", sequenceNumber: seq(12) }),
    ]);

    // 重複 1 件が同一バッチの他 Record の確定を妨げない（Arrival_Batch は意味的なまとまりではない）。
    expect(overlapped.outcome).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: 1, unknownNoodleType: 0 },
    });
    expect(overlapped.putCalls).toBe(1);

    const persisted = await readSnapshot(stub);
    expect(persisted?.pendingOrders.map((order) => order.externalOrderId)).toEqual([
      "0007:1:bill-a:2026-08-17T20%3A52%3A19",
      "0007:1:bill-b:2026-08-17T20%3A52%3A19",
      "0007:1:bill-c:2026-08-17T20%3A52%3A19",
    ]);
    expect(persisted?.lastSequenceByTerminal).toEqual({ "1": seq(12) });
  });
});

describe("Property 16: 後着は置換・0 件は除去または無変更（Requirements 6.7, 6.11, 6.12）", () => {
  // engine 側（tests/core/receive.example.test.ts）は 3 つの写り方を状態遷移として押さえている。ここが足すのは
  // **永続への反映**だけである——置換が単一の put で確定し、除去が待ち行列から本当に消え、無変更の受領でも
  // 判定材料が進むことは、`runEffects` を通した先でしか観測できない。
  it("3 品目 → 1 品目の後着で置換され、単一の put で確定する", async () => {
    const stub = await provision(freshStoreId("pos-supersede"));
    const first = await stub.receiveRecords([
      orderRecord({
        billNo: "bill-a",
        sequenceNumber: seq(1),
        items: [
          noodleItem(MENU_CODE, SIZE_REGULAR),
          noodleItem(MENU_CODE, SIZE_REGULAR),
          noodleItem(MENU_CODE, SIZE_LARGE),
        ],
      }),
    ]);
    expect(first.kind).toBe("settled");
    expect((await readSnapshot(stub))?.pendingOrders).toHaveLength(3);

    // 同一 Unique_Key（4 要素が同じ）への後着。内容が違えば別 Record として届き、後着が新しい状態である。
    const superseded = await receiveCountingPuts(stub, [
      orderRecord({
        billNo: "bill-a",
        sequenceNumber: seq(2),
        items: [noodleItem(MENU_CODE, SIZE_LARGE)],
      }),
    ]);

    expect(superseded.outcome.kind).toBe("settled");
    expect(superseded.putCalls).toBe(1);
    const persisted = await readSnapshot(stub);
    // 全置換であって差分の当て込みではない（残り 2 品目が待ち行列に取り残されない）。
    expect(persisted?.pendingOrders).toHaveLength(1);
    expect(persisted?.pendingOrders.map((order) => order.slotSpan)).toEqual([2]);
    expect(persisted?.lastSequenceByTerminal).toEqual({ "1": seq(2) });
  });

  it("茹で対象 0 件の後着は当該 Unique_Key を待ち行列から除去する", async () => {
    const stub = await provision(freshStoreId("pos-removal"));
    await stub.receiveRecords([
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(1) }),
      orderRecord({ billNo: "bill-b", sequenceNumber: seq(2) }),
    ]);

    // 品目が空の後着（キャンセル、および全品目が非麺へ変更された場合がここに当たる）。
    const removed = await stub.receiveRecords([
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(3), items: [] }),
    ]);

    expect(removed.kind).toBe("settled");
    const persisted = await readSnapshot(stub);
    // 消えるのは当該 Unique_Key の分だけで、他のオーダーは残る。
    expect(persisted?.pendingOrders.map((order) => order.externalOrderId)).toEqual([
      "0007:1:bill-b:2026-08-17T20%3A52%3A19",
    ]);
    expect(persisted?.lastSequenceByTerminal).toEqual({ "1": seq(3) });
  });

  it("初回から 0 件の受領は集合を変えず、判定材料だけを進める", async () => {
    const stub = await provision(freshStoreId("pos-empty-first"));
    const first = await stub.receiveRecords([
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(1) }),
    ]);
    expect(first.kind).toBe("settled");
    const confirmed = await readSnapshot(stub);

    // 麺を含まない注文は正常な入力である。判定材料を進めなければ、再送のたびに翻訳をやり直すことになる。
    const unchanged = await stub.receiveRecords([
      orderRecord({ billNo: "bill-none", sequenceNumber: seq(2), items: [nonNoodleItem()] }),
    ]);

    expect(unchanged.kind).toBe("settled");
    const persisted = await readSnapshot(stub);
    expect(persisted?.pendingOrders).toEqual(confirmed?.pendingOrders);
    expect(persisted?.lastSequenceByTerminal).toEqual({ "1": seq(2) });

    // 判定材料が進んでいるため、同じ Record の再送は読み飛ばされる（0 件の受領も冪等である）。
    const resent = await receiveCountingPuts(stub, [
      orderRecord({ billNo: "bill-none", sequenceNumber: seq(2), items: [nonNoodleItem()] }),
    ]);
    expect(resent.outcome).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: 1, unknownNoodleType: 0 },
    });
    expect(resent.putCalls).toBe(0);
  });
});

describe("対応表が空でも経路は成立する（`[Q8]` の値が未提示のまま・Requirements 6.29, 13.12）", () => {
  // 対応表の値（`[Q8]`）は設定投入で後から与えられる。純粋層（tests/ingress/noodle-spec.example.test.ts）は
  // 「空の表なら常に null」を押さえているが、それだけでは**経路が成立するか**が判らない——翻訳結果が 0 件の
  // 受領が受理されるのか、判定材料が進むのか、再送が冪等かは `runEffects` を通した先の事実である。
  it("空の表では茹で対象が 0 件になるだけで受理され、判定材料は進む", async () => {
    const stub = await provisionWithoutTables(freshStoreId("pos-untabled"));
    const items = [
      noodleItem(MENU_CODE, SIZE_REGULAR, FIRMNESS_HARD_CODE),
      noodleItem(MENU_CODE, SIZE_LARGE),
    ];
    const received = await receiveCountingPuts(stub, [
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(1), items }),
    ]);

    // 未知麺種ではない——麺量を引けない品目は「茹でない」であって、弾かれた品目ではない。
    expect(received.outcome).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: 0, unknownNoodleType: 0 },
    });
    const persisted = await readSnapshot(stub);
    expect(persisted?.pendingOrders).toEqual([]);
    // 判定材料は進む（進まなければ再送のたびに同じ Record を翻訳し直すことになる）。
    expect(persisted?.lastSequenceByTerminal).toEqual({ "1": seq(1) });

    // 再送は冪等（0 件の受領でも収束する）。
    const resent = await receiveCountingPuts(stub, [
      orderRecord({ billNo: "bill-a", sequenceNumber: seq(1), items }),
    ]);
    expect(resent.outcome).toEqual({
      kind: "settled",
      counts: { doDedupeSkipped: 1, unknownNoodleType: 0 },
    });
    expect(resent.putCalls).toBe(0);

    // 同じ Record が、表を投入した店舗では待ち行列へ写る（0 件は表の欠落の帰結であって経路の破れではない）。
    const tabled = await provision(freshStoreId("pos-tabled"));
    expect(
      (
        await tabled.receiveRecords([
          orderRecord({ billNo: "bill-a", sequenceNumber: seq(1), items }),
        ])
      ).kind,
    ).toBe("settled");
    expect((await readSnapshot(tabled))?.pendingOrders).toHaveLength(2);
  });
});
