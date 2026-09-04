// tests/shell/cook-scheduling.integration.test.ts — 調理順スケジューリングの状態を跨ぐ振る舞いの統合テスト
// （Workers pool）。
//
// _Validates: Requirements 1.1, 1.2, 1.4, 2.4, 2.5, 4.4, 5.2, 6.5, 7.1, 7.5, 8.5, 10.1, 10.5, 12.2, 12.3_
//
// 本ファイルが受け持つのは 7 つの経路で、いずれも「待ち行列（Pending_Order）と推奨（recommendations）と
// 採用済み PlanSlice（acceptedSlices）が、状態を跨いだときに正しく振る舞うか」という一点に絞る。
//
//   20.1 hydration と 2 端末の一致        — AC 2.4 / 8.5
//   20.2 `Persist` 失敗の抑止と回復       — AC 10.5
//   20.3 hibernation 越しの復元           — AC 2.5
//   20.4 Order_Ingress の認可・拒否・確定順序 — AC 1.1 / 1.2 / 1.4
//   20.5 外部の往復と不到達の無害性       — AC 4.4 / 5.2 / 10.1 / 12.2 / 12.3
//   20.6 採用経路の end-to-end            — AC 2.4 / 6.5 / 7.1 / 7.5
//   20.7 スキーマ v6 → v7 移行（起動経路） — AC 2.5
//
// **先行 spec との重複を避けるための切り分け。** hydration の配線そのもの（config → snapshot の順・
// 再接続で走行中 Timer が水和される）は `hot-path.integration.test.ts` が、`Persist` 失敗で確定しない
// 規律は `tests/operation-history/store-timer-entry.integration.test.ts` が、hibernate 越しの
// rehydrate は同ファイルの `evictDurableObject` を用いた Reconcile 検証が、v6 → v7 の移行そのものは
// `tests/core/migrate.example.test.ts`（タスク 6.4）が既に固めている。ゆえにここでは Timer 側の主張を
// 繰り返さず、本 spec が足した 3 フィールドについてだけ同じ経路を通す。
//
// **20.1 / 20.2 / 20.3 は採用経路（`deliverPlan` → `admit`）に触れない。** それは 20.6 の関心事である。
// 20.2 / 20.3 が要する「採用済み PlanSlice を持つ確定状態」は、永続値として直接据えることで用意する
// ——そこで採用のゲートを通せば、同じ検査が二箇所に書かれる。
//
// **20.4 / 20.5 / 20.6 は前 4 経路と同じハーネスの上に立てる（別ファイルへ切り出さない）。** ハーネスは
// module スコープの `storeConfig` と `NOODLE` に結ばれており、切り出すと「店舗設定の正本はどちらか」が
// 二箇所に分かれる。DO の storage を跨いで残る状態の掃除（`afterEach` の `reset()`）も一箇所で済む。
// 20.6 が要する 2 種の麺（長短の差が計画の良し悪しに出る）は `provision` の引数で受け、既定は据え置く。
//
// **推奨の開始時刻を時計に依存させない工夫（20.1）。** 空き釜の解放時刻は `now` であるため、釜が空いて
// いる状態では推奨の `startAt` が snapshot を組んだ時刻ごとに変わる。broadcast と hydration の一致を
// 「同一の射影から組まれること」の検査として成立させるには、両者の入力から `now` の影響を除かねば
// ならない。ゆえに全釜を走行中 Timer で埋め、解放表を絶対時刻の事実（実効 endTime）だけから決めさせる。
// 時計を差し替える手より素直で、実機の経路をそのまま通す。

import { afterEach, describe, expect, it } from "vitest";
import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { ServerMessage } from "../../src/domain/messages";
import type { PendingOrder } from "../../src/domain/order";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import { SLOTS_PER_UNIT } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { StoreSnapshot } from "../../src/engine/snapshot";
import type { AcceptedSlice } from "../../src/engine/schedule";
import { CURRENT_SCHEMA_VERSION } from "../../src/engine/types";
import type { EpochMillis, SlotId } from "../../src/engine/types";
import { configResidualDefaults } from "../storeConfigDefaults";
// 20.4 の 401 は worker.ts の経路でしか立たない（DO の受け口は 401 を返さない）。ゆえにここだけ Worker を通す。
import worker from "../../src/worker";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** タイマー SSOT の単一キー。store-timer-do.ts の SNAPSHOT_KEY（private 定数）と一致させる。 */
const SNAPSHOT_KEY = "activeTimers";

/** 本テストが用いる麺種。プリセットに無い品目は到着時に弾かれるため、config と到着で同じ値を使う。 */
const NOODLE = "CookPlanRamen";

/** ユニット 1 台（= 6 釜）。全釜を埋める操作を最小の回数で済ませるための最小構成。 */
const UNIT_COUNT = 1;

/** 釜の総数。slotId は釜番号の文字列表現（engine の slotOf = Number(slotId) の逆）。 */
const SLOT_COUNT = UNIT_COUNT * SLOTS_PER_UNIT;

/** 全釜を埋める Timer の茹で秒。テスト中に発火しない長さを採る（発火は本テストの関心事ではない）。 */
const LONG_BOIL_SECONDS = 1200;

/** snapshot ServerMessage の絞り込み型（待ち行列と推奨を読むのはこの種別だけ）。 */
type SnapshotMessage = Extract<ServerMessage, { readonly type: "snapshot" }>;

const storeConfig: StoreConfig = {
  unitCount: UNIT_COUNT,
  arms: 3,
  toleranceRatio: 10,
  noodlePresets: [
    { noodleType: NOODLE, boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
  ] as NonEmptyArray<NoodlePreset>,
  ...configResidualDefaults(UNIT_COUNT),
};

/** プロビジョニング用の投影。ACCESS_REQUIRED OFF 期ゆえ roster は空でよい（関心事は認可ではない）。 */
function projectionOf(config: StoreConfig): StoreProjection {
  return { config, roster: [], active: true, version: 1 };
}

/** StoreTimerDO の型付き RPC（applyProjection）と fetch を呼べる形でスタブを得る。 */
function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  // STORE_TIMER_DO は型生成上まだ素の DurableObjectNamespace ゆえ、RPC メソッドを呼ぶために class 型へ絞り込む。
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

/** run 間で DO 状態が持ち越さないよう storeId を一意に採番する（[a-z0-9-]・長さ ≤64 を満たす）。 */
function freshStoreId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * 投影を押し込んでプロビジョニングする（レジストリを介さない・design.md の推奨経路）。
 * 未プロビジョニングの DO は WS 接続も到着も 403 で拒むため、全テストの前提としてここを通す。
 */
async function provision(
  storeId: string,
  config: StoreConfig = storeConfig,
): Promise<DurableObjectStub<StoreTimerDO>> {
  const stub = storeStub(storeId);
  await stub.applyProjection(projectionOf(config));
  return stub;
}

/**
 * Order_Ingress の 1 品目。
 *
 * 麺種を引数で受けるのは 20.6 のためである（茹で時間の長短の差がなければ、順序を変えても総和が動かず
 * 「改善する計画」が存在しない）。既定は前 4 経路が用いる単一プリセットのまま据える。
 */
function item(
  externalOrderId: string,
  itemIndex: number,
  tableId: string | null,
  noodleType: string = NOODLE,
) {
  return { externalOrderId, itemIndex, noodleType, firmness: "normal", tableId };
}

/** Order_Ingress のボディ（到着）。DO の fetch は method で経路を分けるため POST であることだけが要る。 */
function arrivalRequest(items: readonly ReturnType<typeof item>[]): Request {
  return new Request("https://do.invalid/s/store/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
}

/**
 * 到着を届け、status を返す。見るのは受理（200）だけ（401 / 400 の拒否は 20.4 の関心事）。
 *
 * **応答ボディを読み切る。** 読まずに捨てると DO 側の IO が開いたままになり、後続の
 * `evictDurableObject` が進まない（hibernate 相当の状態を作れない）。
 */
async function arrive(
  stub: DurableObjectStub<StoreTimerDO>,
  items: readonly ReturnType<typeof item>[],
): Promise<number> {
  const response = await stub.fetch(arrivalRequest(items));
  await response.text();
  return response.status;
}

/** 接続中クライアントの受信を観測するハンドル。 */
interface WsProbe {
  /** 到着順の全メッセージ（config を含む）。broadcast の不在を件数で見るために生の列を持つ。 */
  readonly messages: readonly ServerMessage[];
  /** 条件を満たす snapshot を待つ（既受信にも遡って一致する）。 */
  waitForSnapshot(
    predicate: (message: SnapshotMessage) => boolean,
    timeoutMs?: number,
  ): Promise<SnapshotMessage>;
  send(message: unknown): void;
  close(): void;
}

/** WS を張り、client 端を accept して受信を収集する（apply-projection.integration.test.ts と同形）。 */
async function connect(stub: DurableObjectStub<StoreTimerDO>): Promise<WsProbe> {
  const upgrade = await stub.fetch("https://do.invalid/s/store/ws", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgrade.webSocket;
  if (ws === null) throw new Error(`WS 接続が確立されなかった（status=${upgrade.status}）`);

  const messages: ServerMessage[] = [];
  const waiters: {
    readonly predicate: (message: SnapshotMessage) => boolean;
    readonly resolve: (message: SnapshotMessage) => void;
  }[] = [];
  ws.accept();
  ws.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    messages.push(message);
    if (message.type !== "snapshot") return;
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
      const already = messages.find(
        (message): message is SnapshotMessage => message.type === "snapshot" && predicate(message),
      );
      if (already !== undefined) return Promise.resolve(already);
      return new Promise<SnapshotMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("snapshot の待機がタイムアウトした")),
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
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
  };
}

/** 猶予を置く（broadcast の不在は「一定時間待って届かない」ことでしか観測できない）。 */
function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 全釜を走行中 Timer で埋める。解放表を絶対時刻の事実だけから決めさせるための前提（冒頭の注記参照）。 */
async function fillEverySlot(client: WsProbe): Promise<void> {
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    client.send({
      type: "start",
      slotIds: [String(slot)],
      noodleType: NOODLE,
      boilSeconds: LONG_BOIL_SECONDS,
    });
    // 直列に確定させる（同時に投げると確定順が定まらず、以後の解放表が run ごとに揺れる）。
    // oxlint-disable-next-line no-await-in-loop
    await client.waitForSnapshot((message) => message.timers.length === slot + 1);
  }
}

/**
 * 採用済み PlanSlice を 1 片作る（20.2 / 20.3 の「確定状態」の材料）。
 *
 * 採用経路（`admit`）を通さないのは意図で、そちらはタスク 20.6 が受け持つ。ここで要るのは
 * 「永続に載った採用の事実が、失敗や hibernation を跨いで残るか」だけである。
 */
function acceptedSliceFor(order: PendingOrder, slotId: string, boilMillis: number): AcceptedSlice {
  return {
    tableKey: order.tableId ?? `${order.externalOrderId}#${order.itemIndex}`,
    placements: [
      {
        externalOrderId: order.externalOrderId,
        itemIndex: order.itemIndex,
        slotIds: [slotId as SlotId],
        startAt: order.arrivalTime as EpochMillis,
        serveAt: (order.arrivalTime + boilMillis) as EpochMillis,
      },
    ],
  };
}

/** 永続スナップショットを読む（採用済み PlanSlice と指紋はワイヤに出ないため永続層で観測する）。 */
async function readSnapshot(
  stub: DurableObjectStub<StoreTimerDO>,
): Promise<StoreSnapshot | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
  );
}

/** 到着を 1 件確定させ、その確定状態へ採用済み PlanSlice を 1 片据える。 */
async function confirmedWithAcceptedSlice(
  stub: DurableObjectStub<StoreTimerDO>,
): Promise<StoreSnapshot> {
  return runInDurableObject(stub, async (_instance, state) => {
    const persisted = await state.storage.get<StoreSnapshot>(SNAPSHOT_KEY);
    if (persisted === undefined) throw new Error("到着が永続されていない");
    const order = persisted.pendingOrders[0];
    if (order === undefined) throw new Error("待ち行列が空である");
    const next: StoreSnapshot = {
      ...persisted,
      acceptedSlices: [acceptedSliceFor(order, "0", 60_000)],
    };
    await state.storage.put(SNAPSHOT_KEY, next);
    return next;
  });
}

/** 品目の同定（externalOrderId × itemIndex）。待ち行列・推奨の突き合わせをこの組で行う。 */
function itemKeys(
  entries: readonly { readonly externalOrderId: string; readonly itemIndex: number }[],
): readonly (readonly [string, number])[] {
  return entries.map(({ externalOrderId, itemIndex }) => [externalOrderId, itemIndex] as const);
}

// 店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除して独立させる。
afterEach(async () => {
  await reset();
});

describe("20.1 hydration と 2 端末の一致（Requirements 2.4, 8.5）", () => {
  it("再接続の hydration は、他端末が受けた broadcast と同一の待ち行列・推奨を返す", async () => {
    const stub = await provision(freshStoreId("cook-hydration"));

    // 全釜を埋め、以後の推奨の開始時刻を釜の解放時刻（絶対時刻の事実）だけで決まる形にする。
    const first = await connect(stub);
    await fillEverySlot(first);

    // 2 端末目。ここまでの確定状態を hydration で受ける。
    const second = await connect(stub);
    await second.waitForSnapshot((message) => message.timers.length === SLOT_COUNT);

    // 同卓 2 品目の到着。確定変化ゆえ両端末へ snapshot が broadcast される。
    expect(await arrive(stub, [item("order-a", 0, "t-1"), item("order-a", 1, "t-1")])).toBe(200);
    const broadcast = await second.waitForSnapshot((message) => message.pendingOrders.length === 2);
    // 前提が崩れた空虚な合格を許さない（推奨が 1 件も無ければ「一致」は何も語らない）。
    expect(broadcast.recommendations).toHaveLength(2);

    // 一方が切って張り直す。hydration の snapshot は broadcast と同一の射影（toWireSnapshot）から組まれる。
    first.close();
    const reconnected = await connect(stub);
    const hydrated = await reconnected.waitForSnapshot(() => true);

    // 待ち行列と推奨が、他端末が受けた broadcast と厳密に一致する（AC 2.4 / 8.5）。
    expect(hydrated.pendingOrders).toEqual(broadcast.pendingOrders);
    expect(hydrated.recommendations).toEqual(broadcast.recommendations);

    reconnected.close();
    second.close();
  });
});

describe("20.2 `Persist` 失敗の抑止と回復（Requirements 10.5）", () => {
  it("put 失敗は broadcast を出さず、待ち行列と採用済み PlanSlice を直前の確定状態に保ち、hydration で回復する", async () => {
    const stub = await provision(freshStoreId("cook-persist-failure"));
    expect(await arrive(stub, [item("order-a", 0, "t-1")])).toBe(200);
    // 直前の確定状態＝待ち行列 1 件＋採用済み PlanSlice 1 片。
    const confirmed = await confirmedWithAcceptedSlice(stub);
    await evictDurableObject(stub, { webSockets: "close" });

    const client = await connect(stub);
    const hydrated = await client.waitForSnapshot(() => true);
    expect(hydrated.pendingOrders).toEqual(confirmed.pendingOrders);
    const beforeFailure = client.messages.length;

    // put を失敗させたまま別オーダーの到着を通す。応答の側（受理を返さないこと）は 20.4 が受け持つため、
    // ここでは確定状態と broadcast の側だけを見る。
    await runInDurableObject(stub, async (instance, state) => {
      const originalPut = state.storage.put.bind(state.storage);
      (state.storage as { put: unknown }).put = () => Promise.reject(new Error("put failed"));
      try {
        const response = await instance.fetch(arrivalRequest([item("order-b", 0, "t-2")]));
        await response.text();
      } finally {
        (state.storage as { put: unknown }).put = originalPut;
      }
    });

    // broadcast は put 成功の上にしか立たない（Effect 列の規律）。新しい snapshot は 1 通も届かない。
    await idle(200);
    expect(client.messages.length).toBe(beforeFailure);

    // 直前の確定状態が保たれる——待ち行列に order-b は無く、採用済み PlanSlice も失われていない。
    const persisted = await readSnapshot(stub);
    expect(persisted?.pendingOrders).toEqual(confirmed.pendingOrders);
    expect(persisted?.acceptedSlices).toEqual(confirmed.acceptedSlices);

    // 後続の hydration が確定状態を回復する（推奨も確定状態から改めて導出される）。
    const recovered = await connect(stub);
    const rehydrated = await recovered.waitForSnapshot(() => true);
    expect(rehydrated.pendingOrders).toEqual(confirmed.pendingOrders);
    expect(itemKeys(rehydrated.recommendations)).toEqual([["order-a", 0]]);

    client.close();
    recovered.close();
  });
});

describe("20.3 hibernation 越しの復元（Requirements 2.5）", () => {
  it("hibernate 後のイベントで、待ち行列と採用済み PlanSlice が永続から復元される", async () => {
    const stub = await provision(freshStoreId("cook-hibernation"));
    expect(await arrive(stub, [item("order-a", 0, "t-1")])).toBe(200);
    const confirmed = await confirmedWithAcceptedSlice(stub);

    // in-memory の Working_Copy を揮発させる（hibernate 相当）。
    await evictDurableObject(stub, { webSockets: "close" });

    // hibernate 後の最初のイベント。ここで確定する状態が、揮発した待ち行列と採用の事実を永続から
    // 復元できていることの証左になる——復元に失敗していれば order-a と採用済み PlanSlice は消える。
    expect(await arrive(stub, [item("order-b", 0, "t-2")])).toBe(200);

    const persisted = await readSnapshot(stub);
    expect(itemKeys(persisted?.pendingOrders ?? [])).toEqual([
      ["order-a", 0],
      ["order-b", 0],
    ]);
    expect(persisted?.acceptedSlices).toEqual(confirmed.acceptedSlices);

    // 復元された状態から推奨が導出される（両オーダーが推奨の対象に入る）。
    const client = await connect(stub);
    const hydrated = await client.waitForSnapshot(() => true);
    expect(itemKeys(hydrated.pendingOrders)).toEqual([
      ["order-a", 0],
      ["order-b", 0],
    ]);
    expect(itemKeys(hydrated.recommendations)).toEqual(
      expect.arrayContaining([
        ["order-a", 0],
        ["order-b", 0],
      ]),
    );

    client.close();
  });
});

describe("20.7 スキーマ v6 → v7 移行（Requirements 2.5）", () => {
  it("v6 の永続値を置いて起動すると 3 フィールドが埋まり、既存 Timer の挙動が変わらない", async () => {
    const stub = await provision(freshStoreId("cook-schema-v7"));
    const now = Date.now();
    // v6 の永続値（3 フィールドを持たない）。走行中・未調整・発火しない endTime を置き、起動時の
    // Reconcile が Timer を動かさない形にする——移行そのものを見たいのであって発火を見たいのではない。
    const v6Timer = {
      id: "timer-v6",
      slotIds: ["0"],
      noodleType: NOODLE,
      firmness: "normal",
      startTime: now - 10_000,
      endTime: now + 600_000,
      seq: 0,
      boiledAt: null,
      adjustment: 0,
    };
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put(SNAPSHOT_KEY, { version: 6, timers: [v6Timer], nextSeq: 1 }),
    );
    // 起動経路（constructor の rehydrate → migrate）を通す。tests/core の example test（タスク 6.4）が
    // 純粋関数として固めた移行が、DO の起動を通しても同じであることだけをここで見る。
    await evictDurableObject(stub, { webSockets: "close" });

    const client = await connect(stub);
    const hydrated = await client.waitForSnapshot(() => true);
    // 既存 Timer の挙動が変わらない（実効 endTime は v6 の endTime そのまま＝adjustment 0 のまま）。
    expect(hydrated.timers).toHaveLength(1);
    expect(hydrated.timers[0]?.id).toBe(v6Timer.id);
    expect(hydrated.timers[0]?.endTime).toBe(v6Timer.endTime);
    // 移行で埋まった 3 フィールドのうち、ワイヤに出るのは待ち行列と（そこから導く）推奨の 2 つ。
    expect(hydrated.pendingOrders).toEqual([]);
    expect(hydrated.recommendations).toEqual([]);

    // 移行は在メモリで済むため、永続の書き換えは次の確定変化まで起きない。到着を 1 件通して v7 を確定させる。
    expect(await arrive(stub, [item("order-a", 0, "t-1")])).toBe(200);
    const persisted = await readSnapshot(stub);
    expect(persisted?.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(itemKeys(persisted?.pendingOrders ?? [])).toEqual([["order-a", 0]]);
    expect(persisted?.acceptedSlices).toEqual([]);
    // 指紋は「直前に要求した時点の値」として埋まる（到着は要求を出してよい遷移である）。
    expect(typeof persisted?.requestedDigest).toBe("number");
    // 既存 Timer の 3 つの事実は移行と確定を跨いで不変。
    expect(persisted?.timers[0]?.endTime).toBe(v6Timer.endTime);
    expect(persisted?.timers[0]?.adjustment).toBe(0);
    expect(persisted?.timers[0]?.boiledAt).toBeNull();
    // v7 で足った紐づけは、v6 の Timer に対して null（アドホック麺茹で扱い）へ畳まれる。
    expect(persisted?.timers[0]?.orderItem).toBeNull();

    client.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20.4 / 20.5 / 20.6 の下地。前 4 経路のハーネス（provision / connect / arrive / readSnapshot）を
// そのまま使い、足りない 3 つだけを加える——Worker 経路の呼び出し（401 のため）、`env.SOLVER` の
// 差し替え（送出の観測と不到達のため）、「使える釜が 1 つだけ」の場面（改善する計画のため）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * テストが注入する Order_Ingress のトークン。
 *
 * 実 secret（`.dev.vars` の ORDER_INGRESS_TOKEN）に依存しない。CI には `.dev.vars` が無く、空トークンでは
 * `isOrderIngressAuthorized` が常に偽になって「一致すれば到達する」側の主張が消える
 * （`tests/worker/admin-token-access-independence.integration.test.ts` と同じ hermetic 化）。
 */
const TEST_ORDER_INGRESS_TOKEN = "test-order-ingress-token-hermetic";

/** 正しい Bearer。認可される側の要求はすべてこれを添える。 */
const AUTHORIZED_BEARER = `Bearer ${TEST_ORDER_INGRESS_TOKEN}`;

/**
 * worker.ts の Order_Ingress 経路（POST /s/{storeId}/orders）へ通す。
 *
 * **401 の主張はこの経路でしか立たない。** DO の受け口（`receiveOrder`）は 401 を返さないため、
 * DO へ直接届けるハーネス（`arrive`）では「認可されない要求が DO へ到達しない」ことを言えない。
 * vars は wrangler types が既定値の literal 型で生成するため、実行時値の差し替えは unknown 経由で写す。
 */
async function callOrderIngress(
  storeId: string,
  authorization: string | null,
  body: unknown,
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorization !== null) headers.set("Authorization", authorization);
  const request = new Request(`https://pos.invalid/s/${storeId}/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const testEnv = { ...env, ORDER_INGRESS_TOKEN: TEST_ORDER_INGRESS_TOKEN } as unknown as Env;
  return worker.fetch(request, testEnv);
}

/** 差し替えた Solver_Worker の応答（往路の観測点）。要求の中身は見ないため引数を取らない。 */
type SolverProbe = () => Promise<Response>;

/**
 * DO 内の `env.SOLVER` を差し替えて action を実行する（20.5 の 2 経路が共有する）。
 *
 * **miniflare の補助 Worker（vitest.config.ts）は差し替えない。** あちらは設定に 1 つだけ置く全テスト共通の
 * 相手先で、5xx を返す形へ変えれば往路が通ることを前提にする他のテストが道連れになる。design の
 * Testing Strategy が「補助 Worker は 202 だけを返す」と記した前提もそのまま残したい。差し替えを instance の
 * `env` に限れば、影響はこの呼び出しの内側に閉じる。
 *
 * **`env` を丸ごと置き換える（`env.SOLVER` へ直接代入しない）。** bindings オブジェクトは isolate 内で
 * 共有されており、そこを書き換えると差し替えが他の DO・他のテストへ漏れる。
 */
async function withSolver<T>(
  stub: DurableObjectStub<StoreTimerDO>,
  probe: (state: DurableObjectState) => SolverProbe,
  action: (instance: StoreTimerDO, state: DurableObjectState) => Promise<T>,
): Promise<T> {
  return runInDurableObject(stub, async (instance, state) => {
    const holder = instance as unknown as { env: Env };
    const original = holder.env;
    holder.env = { ...original, SOLVER: { fetch: probe(state) } as unknown as Env["SOLVER"] };
    try {
      return await action(instance, state);
    } finally {
      holder.env = original;
    }
  });
}

/** 改善する計画のための麺（茹で時間の長短の差が順序の良し悪しを生む）。 */
const PLAN_LONG_NOODLE = "CookPlanLong";
const PLAN_SHORT_NOODLE = "CookPlanShort";
const PLAN_LONG_BOIL_SECONDS = 600;
const PLAN_SHORT_BOIL_SECONDS = 60;

/** 注入する計画の対象（長い麺 A ＝卓 t-a、短い麺 B ＝卓 t-b、後から届く C ＝卓 t-c）。 */
const ORDER_LONG = "o-long";
const ORDER_SHORT = "o-short";
const ORDER_THIRD = "o-third";
const TABLE_LONG = "t-a";
const TABLE_SHORT = "t-b";
const TABLE_THIRD = "t-c";

/**
 * 注入する計画の開始時刻を現在から先へ置く余裕。
 *
 * 2 つの制約に挟まれている。**過去に始まる配置は feasible でない**（解放表の下限が now）ので現在より後で
 * なければならず、**`startAt < now` は陳腐化**（`hasLapsedStart`）ゆえ後続の再評価の時点でもまだ未来で
 * なければならない。30 秒は両方を余裕をもって満たし、かつ改善判定を覆さない（B の待ちが 90 秒でも
 * 自前解の 660 秒より遥かに良い）。
 */
const PLAN_START_LEAD_MS = 30_000;

/**
 * 20.5 / 20.6 が用いる店舗設定。1 ユニット（6 釜）・長短 2 種の麺。
 *
 * arms 1・許容調整割合 1% は Boil_Sync を単独クラスタへ落とし Adjustment 0 を割り当てさせる
 * （`tests/core/plan.example.test.ts` と同じ置き方）。計時が乱れないことを厳密な一致で言うための前提である。
 */
const planConfig: StoreConfig = {
  unitCount: UNIT_COUNT,
  arms: 1,
  toleranceRatio: 1,
  noodlePresets: [
    {
      noodleType: PLAN_LONG_NOODLE,
      boilSeconds: {
        extraHard: PLAN_LONG_BOIL_SECONDS,
        hard: PLAN_LONG_BOIL_SECONDS,
        normal: PLAN_LONG_BOIL_SECONDS,
        soft: PLAN_LONG_BOIL_SECONDS,
      },
    },
    {
      noodleType: PLAN_SHORT_NOODLE,
      boilSeconds: {
        extraHard: PLAN_SHORT_BOIL_SECONDS,
        hard: PLAN_SHORT_BOIL_SECONDS,
        normal: PLAN_SHORT_BOIL_SECONDS,
        soft: PLAN_SHORT_BOIL_SECONDS,
      },
    },
  ] as NonEmptyArray<NoodlePreset>,
  ...configResidualDefaults(UNIT_COUNT),
};

/**
 * 指定した釜を走行中 Timer で塞ぐ。**改善する計画は「使える釜が少ない」場面にしか存在しない**
 * ——釜が余れば全品目が並列に入り、順序が総和に効かない。
 *
 * 茹で秒を釜ごとにずらすのは、塞ぐ Timer どうしが Boil_Sync の近接クラスタを成さないようにするため。
 */
async function blockSlots(client: WsProbe, slots: readonly number[]): Promise<void> {
  let started = 0;
  for (const slot of slots) {
    started += 1;
    client.send({
      type: "start",
      slotIds: [String(slot)],
      noodleType: PLAN_LONG_NOODLE,
      boilSeconds: LONG_BOIL_SECONDS + 50 * slot,
    });
    // 直列に確定させる（同時に投げると確定順が定まらず、以後の解放表が run ごとに揺れる）。
    // oxlint-disable-next-line no-await-in-loop
    await client.waitForSnapshot((message) => message.timers.length === started);
  }
}

/** 「使える釜が釜 0 だけ」で長短 2 品目が待つ場面。20.5 / 20.6 が共有する下地。 */
interface PlanStage {
  readonly stub: DurableObjectStub<StoreTimerDO>;
  readonly client: WsProbe;
}

/** 釜 1〜5 を塞ぎ、長い麺 A（卓 t-a）と短い麺 B（卓 t-b）を同時に到着させる。 */
async function planStage(prefix: string): Promise<PlanStage> {
  const stub = await provision(freshStoreId(prefix), planConfig);
  const client = await connect(stub);
  await blockSlots(client, [1, 2, 3, 4, 5]);

  expect(
    await arrive(stub, [
      item(ORDER_LONG, 0, TABLE_LONG, PLAN_LONG_NOODLE),
      item(ORDER_SHORT, 0, TABLE_SHORT, PLAN_SHORT_NOODLE),
    ]),
  ).toBe(200);
  const arrived = await client.waitForSnapshot((message) => message.pendingOrders.length === 2);
  // 自前解は同時到着を卓 id 順に置くため、長い麺が先に入る。ここに改善の余地が在る（B を先に入れれば
  // 総和が縮む）。この前提が崩れていれば以後の「採用された」は何も語らない。
  expect(itemKeys(arrived.recommendations)).toEqual([
    [ORDER_LONG, 0],
    [ORDER_SHORT, 0],
  ]);

  return { stub, client };
}

/**
 * 短い麺 B を釜 0 へ先に入れる計画。自前解（A → B）より総和が小さいため Acceptance_Gate を通る。
 *
 * `serveAt − startAt` は当該品目の茹で時間に厳密に一致させる（`admit` のハード制約検査がここを見る）。
 */
function improvingPlan(startAt: number) {
  return {
    slices: [
      {
        tableKey: TABLE_SHORT,
        placements: [
          {
            externalOrderId: ORDER_SHORT,
            itemIndex: 0,
            slotIds: ["0"],
            startAt,
            serveAt: startAt + PLAN_SHORT_BOIL_SECONDS * 1000,
          },
        ],
        // 外部が主張する部分和は嘘（0）。採点は engine の scoreSchedule ただ一つで、admit が差し替える。
        score: 0,
      },
    ],
    score: 0,
  };
}

describe("20.4 Order_Ingress の認可・拒否・確定順序（Requirements 1.1, 1.2, 1.4）", () => {
  it("トークン不一致・欠如は 401 で DO へ到達せず、待ち行列も broadcast も動かない", async () => {
    const storeId = freshStoreId("cook-ingress-auth");
    const stub = await provision(storeId);
    const client = await connect(stub);
    await client.waitForSnapshot(() => true);
    const before = client.messages.length;
    const body = { items: [item("order-a", 0, "t-1")] };

    const mismatched = await callOrderIngress(storeId, `${AUTHORIZED_BEARER}-not-the-token`, body);
    await mismatched.text();
    const bare = await callOrderIngress(storeId, TEST_ORDER_INGRESS_TOKEN, body);
    await bare.text();
    const absent = await callOrderIngress(storeId, null, body);
    await absent.text();

    expect([mismatched.status, bare.status, absent.status]).toEqual([401, 401, 401]);
    // 状態を変更しない（AC 1.1）。永続にも broadcast にも痕跡が無い。
    await idle(200);
    expect(client.messages.length).toBe(before);
    expect((await readSnapshot(stub))?.pendingOrders ?? []).toEqual([]);

    // **401 が DO 由来でないことの証。** DO の受け口は 401 を返さない（未プロビジョニング・非活性は 403、
    // 不正ボディは 400、put 失敗は 503）。同じ要求に正しいトークンを添えれば到達して受理される。
    const authorized = await callOrderIngress(storeId, AUTHORIZED_BEARER, body);
    await authorized.text();
    expect(authorized.status).toBe(200);
    const broadcast = await client.waitForSnapshot((message) => message.pendingOrders.length === 1);
    expect(itemKeys(broadcast.pendingOrders)).toEqual([["order-a", 0]]);

    client.close();
  });

  it("必須属性欠落・未知種別・型違反は 400 で、待ち行列と Timer 集合をいずれも変えない", async () => {
    const storeId = freshStoreId("cook-ingress-reject");
    const stub = await provision(storeId);
    const client = await connect(stub);
    // Timer 集合の不変を言うために 1 本走らせ、待ち行列の不変を言うために 1 件受理しておく
    // ——空集合が空のままであることは「変えない」の証拠として弱い。
    client.send({
      type: "start",
      slotIds: ["0"],
      noodleType: NOODLE,
      boilSeconds: LONG_BOIL_SECONDS,
    });
    await client.waitForSnapshot((message) => message.timers.length === 1);
    expect(await arrive(stub, [item("order-a", 0, "t-1")])).toBe(200);
    await client.waitForSnapshot((message) => message.pendingOrders.length === 1);
    const confirmed = await readSnapshot(stub);
    const before = client.messages.length;

    // 必須属性の欠落（noodleType 無し）・未知の品目種別・型違反（itemIndex が文字列）。
    const missing = await callOrderIngress(storeId, AUTHORIZED_BEARER, {
      items: [{ externalOrderId: "order-b", itemIndex: 0, firmness: "normal", tableId: "t-2" }],
    });
    await missing.text();
    const unknown = await callOrderIngress(storeId, AUTHORIZED_BEARER, {
      items: [item("order-c", 0, "t-3", "NotOnTheMenu")],
    });
    await unknown.text();
    const mistyped = await callOrderIngress(storeId, AUTHORIZED_BEARER, {
      items: [{ ...item("order-d", 0, "t-4"), itemIndex: "0" }],
    });
    await mistyped.text();

    expect([missing.status, unknown.status, mistyped.status]).toEqual([400, 400, 400]);
    // 両集合が不変（AC 1.4）。確定状態を丸ごと突き合わせる——待ち行列も Timer も指紋も動いていない。
    await idle(200);
    expect(client.messages.length).toBe(before);
    expect(await readSnapshot(stub)).toEqual(confirmed);

    client.close();
  });

  it("put を失敗させると受理応答も broadcast も出ない（どちらも確定の後にのみ立つ）", async () => {
    const stub = await provision(freshStoreId("cook-ingress-commit"));
    const client = await connect(stub);
    await client.waitForSnapshot(() => true);

    // 対照：put が働くときは受理（200）が返り broadcast も出る。後段の「出ない」が空虚でないことの担保。
    expect(await arrive(stub, [item("order-a", 0, "t-1")])).toBe(200);
    const confirmed = await client.waitForSnapshot((message) => message.pendingOrders.length === 1);
    expect(confirmed.recommendations).toHaveLength(1);
    const beforeFailure = client.messages.length;

    const rejected = await runInDurableObject(stub, async (instance, state) => {
      const originalPut = state.storage.put.bind(state.storage);
      (state.storage as { put: unknown }).put = () => Promise.reject(new Error("put failed"));
      try {
        const response = await instance.fetch(arrivalRequest([item("order-b", 0, "t-2")]));
        return {
          status: response.status,
          body: (await response.json()) as { readonly accepted: boolean },
        };
      } finally {
        (state.storage as { put: unknown }).put = originalPut;
      }
    });

    // 受理を主張しない（AC 1.2）。put 前に 200 を返せば、POS は届いたと信じ、こちらは何も確定していない。
    expect(rejected.status).toBe(503);
    expect(rejected.body.accepted).toBe(false);
    // broadcast も出ない。受理応答と broadcast が put 成功という一点に揃っていることの表明である。
    await idle(200);
    expect(client.messages.length).toBe(beforeFailure);
    expect(itemKeys((await readSnapshot(stub))?.pendingOrders ?? [])).toEqual([["order-a", 0]]);

    client.close();
  });
});

describe("20.5 外部の往復と不到達の無害性（Requirements 4.4, 5.2, 10.1, 12.2, 12.3）", () => {
  it("shell は 202 のみを await して event 処理を終え、応答ボディを復路として読まない", async () => {
    const stage = await planStage("cook-solver-outbound");
    let calls = 0;
    let pendingAtSend: readonly PendingOrder[] | undefined;

    const status = await withSolver(
      stage.stub,
      (state) => async () => {
        calls += 1;
        // **送出の時点で put は既に成功している。** Effect 列は `Persist` を先頭に持ち `RequestPlan` を
        // 末尾に置くため、外部へ要求が出るのは確定の後だけである。
        pendingAtSend = (await state.storage.get<StoreSnapshot>(SNAPSHOT_KEY))?.pendingOrders;
        // 復路を応答ボディに載せて返す（毒入りの 202）。読まれれば採用が起きてしまう計画である
        // ——同じ計画を `deliverPlan` へ渡すと採用されることは 20.6 が示す。
        return Response.json(improvingPlan(Date.now() + PLAN_START_LEAD_MS), { status: 202 });
      },
      async (instance) => {
        const response = await instance.fetch(
          arrivalRequest([item(ORDER_THIRD, 0, TABLE_THIRD, PLAN_LONG_NOODLE)]),
        );
        const observed = response.status;
        await response.text();
        return observed;
      },
    );

    // event 処理は 202 を得た時点で終わる（受理が返る）。計算完了は待たない。
    expect(status).toBe(200);
    expect(calls).toBe(1);
    expect(itemKeys(pendingAtSend ?? [])).toEqual([
      [ORDER_LONG, 0],
      [ORDER_SHORT, 0],
      [ORDER_THIRD, 0],
    ]);
    // 応答ボディは復路ではない（採用を起こすのは `deliverPlan` ただ一つ）。
    expect((await readSnapshot(stage.stub))?.acceptedSlices).toEqual([]);

    stage.client.close();
  });

  it("`deliverPlan` は hibernate した DO を wake させ、`PlanArrived` が decide へ流れる", async () => {
    const stage = await planStage("cook-solver-inbound");
    // in-memory の Working_Copy を揮発させる（hibernate 相当）。復路は DO を起こす正当な wake である。
    stage.client.close();
    await evictDurableObject(stage.stub, { webSockets: "close" });

    await stage.stub.deliverPlan(improvingPlan(Date.now() + PLAN_START_LEAD_MS));

    // 採用が永続へ載っている＝wake し、永続から復元した状態の上で `PlanArrived` が decide を通った。
    // 採用の end-to-end（broadcast・hydration・再評価）は 20.6 が受け持つ。
    expect((await readSnapshot(stage.stub))?.acceptedSlices).toHaveLength(1);
  });

  it("Solver_Worker が不到達でも受理は返り、推奨は出続け、Timer 本体の計時が乱れない", async () => {
    const stub = await provision(freshStoreId("cook-solver-down"));
    const client = await connect(stub);
    // 走行中 Timer を 1 本置き、計時の事実（実効 endTime と Alarm）を確定させる。
    client.send({
      type: "start",
      slotIds: ["0"],
      noodleType: NOODLE,
      boilSeconds: LONG_BOIL_SECONDS,
    });
    const started = await client.waitForSnapshot((message) => message.timers.length === 1);
    const endTime = started.timers[0]?.endTime;
    const alarmBefore = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );

    const status = await withSolver(
      stub,
      () => () => Promise.reject(new Error("solver unreachable")),
      async (instance) => {
        const response = await instance.fetch(arrivalRequest([item("order-a", 0, "t-1")]));
        const observed = response.status;
        await response.text();
        return observed;
      },
    );

    // 送出失敗を Timer 本体の応答へ伝播させない（AC 10.2）。到着は確定して受理が返る。
    expect(status).toBe(200);
    const broadcast = await client.waitForSnapshot((message) => message.pendingOrders.length === 1);
    // 推奨は出続ける——外部は改善の供給源であって前提ではない（AC 4.4 / 10.1）。
    expect(itemKeys(broadcast.recommendations)).toEqual([["order-a", 0]]);
    // 計時は乱れない。実効 endTime も次の発火予定も、外部の失敗を跨いで同じ値である。
    expect(broadcast.timers[0]?.endTime).toBe(endTime);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
      alarmBefore,
    );

    client.close();
  });
});

describe("20.6 採用経路の end-to-end（Requirements 2.4, 6.5, 7.1, 7.5）", () => {
  it("注入した改善計画が採用されて永続・broadcast・hydration に残り、続く再評価で維持されて尾部が再実行される", async () => {
    const stage = await planStage("cook-adopt");
    const startAt = Date.now() + PLAN_START_LEAD_MS;
    const plan = improvingPlan(startAt);

    // **テストから復路を直接呼ぶ。** 骨格 Solver は自前解と同値の計画しか返さない（ゲートが同値を棄却する）
    // ため、実機上で採用経路が一度も通らない。その穴をここで塞ぐ。
    await stage.stub.deliverPlan(plan);

    // 採用 → broadcast（AC 6.5）。推奨の先頭が短い麺へ入れ替わり、開始時刻は計画が主張したそのままである。
    const adopted = await stage.client.waitForSnapshot(
      (message) => message.recommendations[0]?.externalOrderId === ORDER_SHORT,
    );
    expect(itemKeys(adopted.recommendations)).toEqual([
      [ORDER_SHORT, 0],
      [ORDER_LONG, 0],
    ]);
    expect(adopted.recommendations[0]?.startAt).toBe(startAt);
    // 尾部（長い麺）は採用された配置の占有から積み直される（切り貼りではない・AC 7.5）。
    expect(adopted.recommendations[1]?.startAt).toBe(startAt + PLAN_SHORT_BOIL_SECONDS * 1000);

    // `Persist` — 採用は「再現不能な事実」として永続に載る（AC 7.1）。
    const persisted = await readSnapshot(stage.stub);
    expect(persisted?.acceptedSlices).toHaveLength(1);
    expect(persisted?.acceptedSlices[0]?.tableKey).toBe(TABLE_SHORT);
    expect(persisted?.acceptedSlices[0]?.placements).toEqual(plan.slices[0]?.placements);
    // 採用済みの一片は点数を持たない（採点は比較の時点の導出・永続しない）。
    expect(persisted?.acceptedSlices[0]).not.toHaveProperty("score");

    // 再接続 hydration に採用結果が残る（AC 2.4）。broadcast と同一の射影から組まれる。
    const reconnected = await connect(stage.stub);
    const hydrated = await reconnected.waitForSnapshot(() => true);
    expect(hydrated.recommendations).toEqual(adopted.recommendations);
    expect(hydrated.pendingOrders).toEqual(adopted.pendingOrders);

    // 続く状態変化での再評価（AC 7.5）。陳腐化しない一片は維持され、尾部だけが新着を織り込んで走り直す。
    expect(await arrive(stage.stub, [item(ORDER_THIRD, 0, TABLE_THIRD, PLAN_LONG_NOODLE)])).toBe(
      200,
    );
    const reevaluated = await reconnected.waitForSnapshot(
      (message) => message.pendingOrders.length === 3,
    );
    expect(itemKeys(reevaluated.recommendations)).toEqual([
      [ORDER_SHORT, 0],
      [ORDER_LONG, 0],
      [ORDER_THIRD, 0],
    ]);
    // 維持——採用された開始時刻は新着に押されない。
    expect(reevaluated.recommendations[0]?.startAt).toBe(startAt);
    // 尾部再実行——長い麺は採用配置の解放時刻から、新着はその後ろへ積まれる。
    expect(reevaluated.recommendations[1]?.startAt).toBe(startAt + PLAN_SHORT_BOIL_SECONDS * 1000);
    expect(reevaluated.recommendations[2]?.startAt).toBe(
      startAt + (PLAN_SHORT_BOIL_SECONDS + PLAN_LONG_BOIL_SECONDS) * 1000,
    );
    // 採用の事実そのものは再評価を跨いで不変（維持は導出値の側で起きる）。
    expect((await readSnapshot(stage.stub))?.acceptedSlices).toEqual(persisted?.acceptedSlices);

    stage.client.close();
    reconnected.close();
  });
});

describe("lift-group-planning — 群の 1 本目を入れた後も残りが 1 本目に揃う（Requirements 3.2, 3.4, 7.4）", () => {
  it("同じ卓の 3 品目のうち 1 本目を品目から開始すると、残りの推奨は走行中の実効 endTime に揃う", async () => {
    const stub = await provision(freshStoreId("cook-lift-group"));
    const client = await connect(stub);

    // 同じ卓に茹で加減の違う 3 品目（既定プリセットは hard 52 / normal 60 / soft 75 秒）。
    const table = "t-lift";
    const items = [
      {
        externalOrderId: "order-lift",
        itemIndex: 0,
        noodleType: NOODLE,
        firmness: "soft",
        tableId: table,
      },
      {
        externalOrderId: "order-lift",
        itemIndex: 1,
        noodleType: NOODLE,
        firmness: "normal",
        tableId: table,
      },
      {
        externalOrderId: "order-lift",
        itemIndex: 2,
        noodleType: NOODLE,
        firmness: "hard",
        tableId: table,
      },
    ];
    expect(await arrive(stub, items)).toBe(200);
    const planned = await client.waitForSnapshot((message) => message.pendingOrders.length === 3);
    // 計画は 3 本の serveAt（startAt + 茹で秒）を一致させる。
    const boilOf = (firmness: string) => ({ hard: 52, normal: 60, soft: 75 })[firmness]! * 1000;
    const serveTimes = planned.recommendations.map(
      (rec) => rec.startAt + boilOf(items[rec.itemIndex]!.firmness),
    );
    expect(new Set(serveTimes).size).toBe(1);

    // 1 本目（最も長い soft・最も早い startAt）を品目から始める。
    const first = [...planned.recommendations].sort((a, b) => a.startAt - b.startAt)[0]!;
    expect(first.itemIndex).toBe(0);
    client.send({
      type: "startOrderItem",
      slotIds: first.slotIds,
      externalOrderId: first.externalOrderId,
      itemIndex: first.itemIndex,
    });
    const started = await client.waitForSnapshot((message) => message.timers.length === 1);
    const anchor = started.timers[0]!.endTime;

    // 残り 2 本の推奨は走行中の実効 endTime（錨）に揃う——1 本目を入れても群が崩れない。
    expect(started.recommendations).toHaveLength(2);
    for (const rec of started.recommendations) {
      expect(rec.startAt + boilOf(items[rec.itemIndex]!.firmness)).toBe(anchor);
    }

    client.close();
  });
});
