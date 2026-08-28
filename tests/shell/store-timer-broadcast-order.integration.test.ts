// tests/shell/store-timer-broadcast-order.integration.test.ts — 店舗 DO の broadcast 配線のうち、
// 「誰へ届くか」と「いつ出るか」を受け持つ統合テスト（Workers pool）。
//
// _Validates: Requirements 1.3, 6.2, 9.3, 9.4_
//
// タスク 22.2 の残余・22.6・13.3 の構造半分を、いずれも既存テストが覆っていない一点だけに絞って主張する。
//
//   22.2 の残余 — `cancel` の複数端末 fanout（要件1.3 / 6.2）
//   22.6        — broadcast は put 確定の後にのみ出る（要件1.3 / 6.2・実測ではなく構造で主張する）
//   13.3 の構造半分 — close で除去すべき隠れ状態を持たない（要件9.3 / 9.4）
//
// **既存の主張は繰り返さない。**
//   - `start` が全クライアントへ届くこと（複数端末の一致・hydration の一致）は
//     `tests/shell/boil-sync-multi-client.integration.test.ts` が固めている。ゆえに本ファイルは
//     `start` の到達を主張せず、`cancel` の fanout だけを見る（`start` は場面を組む手段として使う）。
//   - `Persist` が Effect 列の先頭に立つことは `tests/core/effect-order.property.test.ts`（純粋）が固めている。
//   - put 失敗で後続（broadcast）が出ないことは `tests/shell/boil-sync-persist-failure.integration.test.ts` と
//     `tests/shell/cook-scheduling.integration.test.ts`（20.2）が固めている。
//     欠けているのはその二つの中間——**`runEffects` の実行順序**、すなわち `applySideEffect` へ到達するのが
//     `await storage.put` の解決の**後**であることだけである。列の形（先頭が Persist）が正しく、失敗時に
//     後続が出ないことも正しくても、成功時に put の完了を待たずに送っていれば、確定前の状態を現場へ
//     見せうる。その一点をここで主張する。
//
// **なぜ 22.6 で壁時計を測らないか（要件1.3 / 6.2 の 1000ms を実測しない理由）。** 要件が言う 1000ms は
// 実 WAN を跨いで現場の iPad へ届くまでの時間である。CI の workerd で測れるのは同一プロセス内の IO 速度と
// runner の負荷であって、要件が語る量ではない。測っても何も保証せず、混雑した runner では環境要因で落ちる。
// `audio-cues` が Touch_Cue の 100ms 条項で同じ壁に当たり、構造的主張（同期的に予約が済む・開始時刻に
// 遅延を足さない）へ置き換えた（audio-cues/tasks.md の設計判断 5）。ここも同じ扱いにする——閾値を持たない
// 順序の主張（put 確定の前に `ws.send` が起きない）は、遅い runner でも速い runner でも同じ結論になる。
// **実 WAN での実測は `hibernation-observability` の runtime ハーネスの担当である**（Probe_Client が実デプロイ
// 先へ `wss://` で繋いで打刻し、実際に約 180ms のクロックスキューを実測している）。ここでそれを真似ると、
// 測れない量を測ったふりをする嘘になる。
//
// **なぜ `Date.now` を固定するか。** Boil_Sync の Adjustment は now と endTime の関係で決まる。実時計のまま
// では run ごとに値が揺れ、SSOT とワイヤの照合が「たまたま一致した」のか判らなくなる。他の shell テストと
// 同じく `vi.spyOn` で固定し、`afterEach` で必ず戻す。固定ゆえ、本ファイルの待機はいずれも `Date.now` に
// 依らない形（`setTimeout` と試行回数）で組む。

import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import type { ServerMessage } from "../../src/domain/messages";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { StoreSnapshot } from "../../src/engine/snapshot";
import type { StoreProjection } from "../../src/registry/projection";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import { configResidualDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** タイマー SSOT の単一キー。store-timer-do.ts の SNAPSHOT_KEY（private 定数）と一致させる。 */
const SNAPSHOT_KEY = "activeTimers";

/** 本テストが用いる麺種。プリセットに無い麺種は開始できないため config と start で同じ値を使う。 */
const NOODLE = "BroadcastRamen";

/** ユニット 1 台（= 6 釜）。使うのは 2 釜だけで、釜数そのものは本テストの関心事ではない。 */
const UNIT_COUNT = 1;

/** 基準時刻。固定値にするのは Adjustment の値を run ごとに揺らさないためである。 */
const BASE_TIME = 1_900_000_000_000;

/** テスト中に発火しない茹で秒（発火は本ファイルの関心事ではない）。近接 2 本で Adjustment が 0 でなくなる。 */
const FIRST_BOIL_SECONDS = 100;
const SECOND_BOIL_SECONDS = 110;

/** 使う釜。1 台のユニットの先頭 2 つで足りる。 */
const FIRST_SLOT = "0";
const SECOND_SLOT = "1";

/** snapshot ServerMessage の絞り込み型（Timer 集合を読むのはこの種別だけ）。 */
type SnapshotMessage = Extract<ServerMessage, { readonly type: "snapshot" }>;

/** 本テストの店舗設定。arms 2・許容調整割合 10% は近接 2 本に 0 でない Adjustment を与える最小の形である。 */
const storeConfig: StoreConfig = {
  unitCount: UNIT_COUNT,
  arms: 2,
  toleranceRatio: 10,
  noodlePresets: [
    { noodleType: NOODLE, boilSeconds: { extraHard: 90, hard: 100, normal: 110, soft: 120 } },
  ] as NonEmptyArray<NoodlePreset>,
  ...configResidualDefaults(UNIT_COUNT),
};

/** プロビジョニング用の投影。ACCESS_REQUIRED OFF 期ゆえ roster は空でよい（関心事は認可ではない）。 */
const projection: StoreProjection = { config: storeConfig, roster: [], active: true, version: 1 };

/** 接続中クライアントの受信を観測するハンドル。 */
interface WsProbe {
  /** 到着順の全メッセージ（config を含む）。broadcast の不在を件数で見るために生の列を持つ。 */
  readonly messages: readonly ServerMessage[];
  /** 条件を満たす snapshot を待つ（既受信にも遡って一致する）。 */
  waitForSnapshot(predicate: (message: SnapshotMessage) => boolean, timeoutMs?: number): Promise<SnapshotMessage>;
  send(message: unknown): void;
  close(): void;
}

/** run 間で DO 状態が持ち越さないよう storeId を一意に採番する（[a-z0-9-]・長さ ≤64 を満たす）。 */
function freshStoreId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** StoreTimerDO の型付き RPC（applyProjection）と fetch を呼べる形でスタブを得る。 */
function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  // STORE_TIMER_DO は型生成上まだ素の DurableObjectNamespace ゆえ、RPC メソッドを呼ぶために class 型へ絞り込む。
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

/**
 * 投影を押し込んでプロビジョニングする（レジストリを介さない・design.md の推奨経路）。
 * 未プロビジョニングの DO は WS 接続を 403 で拒むため、全テストの前提としてここを通す。
 */
async function provision(storeId: string): Promise<DurableObjectStub<StoreTimerDO>> {
  const stub = storeStub(storeId);
  await stub.applyProjection(projection);
  return stub;
}

/** WS を張り、client 端を accept して受信を収集する（他の shell 統合テストと同形）。 */
async function connect(stub: DurableObjectStub<StoreTimerDO>): Promise<WsProbe> {
  const upgrade = await stub.fetch("https://do.invalid/s/store/ws", { headers: { Upgrade: "websocket" } });
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
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && waiter.predicate(message)) {
        waiter.resolve(message);
        waiters.splice(index, 1);
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
        const timeout = setTimeout(() => reject(new Error("snapshot の待機がタイムアウトした")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timeout);
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

/** 永続 snapshot を読む（永続層が SSOT ゆえ、ワイヤの照合先はここだけである）。 */
async function readSnapshot(stub: DurableObjectStub<StoreTimerDO>): Promise<StoreSnapshot> {
  const snapshot = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
  );
  if (snapshot === undefined) throw new Error("StoreSnapshot が永続されていない");
  return snapshot;
}

/** 永続 snapshot の実効 endTime（Adjusted_Boil_Time）。ワイヤはこの値だけを載せる。 */
function effectiveEndTimes(snapshot: StoreSnapshot): Readonly<Record<string, number>> {
  return Object.fromEntries(snapshot.timers.map((timer) => [timer.id, timer.endTime + timer.adjustment]));
}

/** ワイヤ snapshot の endTime（既に実効値へ畳まれている）。 */
function projectedEndTimes(message: SnapshotMessage): Readonly<Record<string, number>> {
  return Object.fromEntries(message.timers.map((timer) => [timer.id, timer.endTime]));
}

/** ワイヤ snapshot から、当該釜を占める Timer の timerId を引く。 */
function timerIdAtSlot(message: SnapshotMessage, slotId: string): string {
  const found = message.timers.find((timer) => timer.slotIds.includes(slotId));
  if (found === undefined) throw new Error(`釜 ${slotId} の Timer が snapshot に無い`);
  return found.id;
}

/** 全クライアントが同じ条件の snapshot を受けるまで待つ（fanout の主張はこの待機の上に立つ）。 */
function waitForAll(
  clients: readonly WsProbe[],
  predicate: (message: SnapshotMessage) => boolean,
): Promise<readonly SnapshotMessage[]> {
  return Promise.all(clients.map((client) => client.waitForSnapshot(predicate)));
}

// 店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除し、固定した時計を戻して独立させる。
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("22.2 の残余 — cancel の複数端末 fanout（Requirements 1.3, 6.2）", () => {
  it("1 台の cancel が接続中の全端末へ同一の snapshot として届き、当該 Timer が全端末から消える", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIME);
    const stub = await provision(freshStoreId("broadcast-cancel-fanout"));
    const clients: WsProbe[] = [];

    try {
      // 3 台。2 台では「送信元と他 1 台」しか区別できず、「全端末」の主張が 1 台の他者に縮む。
      const first = await connect(stub);
      const second = await connect(stub);
      const third = await connect(stub);
      clients.push(first, second, third);
      await waitForAll(clients, (message) => message.timers.length === 0);

      // 場面を組む 2 本。近接ゆえ Boil_Sync が 0 でない Adjustment を割り当て、キャンセル後に残る 1 本の
      // 実効 endTime は「素の endTime」ではなくなる——ワイヤと SSOT の照合が空虚にならない場面である。
      first.send({ type: "start", slotIds: [FIRST_SLOT], noodleType: NOODLE, boilSeconds: FIRST_BOIL_SECONDS });
      await waitForAll(clients, (message) => message.timers.length === 1);
      second.send({ type: "start", slotIds: [SECOND_SLOT], noodleType: NOODLE, boilSeconds: SECOND_BOIL_SECONDS });
      const started = await first.waitForSnapshot((message) => message.timers.length === 2);
      await waitForAll(clients, (message) => message.timers.length === 2);

      const cancelled = timerIdAtSlot(started, FIRST_SLOT);
      const remaining = timerIdAtSlot(started, SECOND_SLOT);
      // 開始した端末（first）ではなく third から落とす。要求元と送信元の区別が結論に効かないことを、
      // 場面の側で担保する（Reply を持たない設計ゆえ、要求元も他端末と同じ snapshot を受ける）。
      third.send({ type: "cancel", timerId: cancelled });

      // 述語を「件数 1」だけにしてはならない。1 本目の開始直後の snapshot が既に件数 1 であり、probe は
      // 既受信にも遡って一致するため、キャンセル前の古い snapshot を掴んで空虚に通ってしまう。
      // ゆえに「当該 Timer が居ないこと」を述語に入れ、キャンセル後の snapshot だけを一致させる。
      const gone = (message: SnapshotMessage): boolean =>
        message.timers.length === 1 && !message.timers.some((timer) => timer.id === cancelled);
      const [firstView, secondView, thirdView] = await Promise.all([
        first.waitForSnapshot(gone),
        second.waitForSnapshot(gone),
        third.waitForSnapshot(gone),
      ]);

      // 全端末で当該 Timer が消え、残る 1 本は同一である。
      expect(firstView.timers.map(({ id }) => id)).toEqual([remaining]);
      // 3 台の受信内容が丸ごと一致する。broadcast は単一 payload を全 WS へ送る形ゆえ、端末ごとに
      // 別の真実（別の endTime・別の serverTime）が生まれる余地が無いことをここで固定する。
      expect(secondView).toEqual(firstView);
      expect(thirdView).toEqual(firstView);

      // 届いた内容が put 確定済みの事実と一致する（永続層が SSOT）。
      const ssot = await readSnapshot(stub);
      expect(ssot.timers.map(({ id }) => id)).toEqual([remaining]);
      expect(projectedEndTimes(firstView)).toEqual(effectiveEndTimes(ssot));
      // キャンセルで残った 1 本は単独クラスタへ戻り Adjustment が 0 へ解ける。実効 endTime が素の
      // endTime へ一致することは、上の照合が「調整の畳み込みを経た値」を見ている証左である。
      expect(ssot.timers.map(({ adjustment }) => adjustment)).toEqual([0]);
      expect(projectedEndTimes(firstView)).toEqual({ [remaining]: BASE_TIME + SECOND_BOIL_SECONDS * 1000 });
    } finally {
      for (const client of clients) client.close();
    }
  });
});

/** put の解決を試験側が握る門。`open()` を呼ぶまで `storage.put` は解決しない。 */
interface PersistGate {
  /** patch した put が待つ約束。 */
  readonly promise: Promise<void>;
  /** put を通す（以後は本物の put へ委譲される）。 */
  open(): void;
}

function persistGate(): PersistGate {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

describe("22.6 — broadcast は put 確定の後にのみ出る（Requirements 1.3, 6.2）", () => {
  it("put を解決させないあいだ ws.send は 1 度も起きず、解決させて初めて確定 snapshot が届く", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIME);
    const stub = await provision(freshStoreId("broadcast-after-put"));
    const client = await connect(stub);
    await client.waitForSnapshot((message) => message.timers.length === 0);

    const gate = persistGate();
    const putKeys: string[] = [];
    // put を「本物へ委譲する前に門を待つ」形へ差し替える。捨てるのではなく遅らせるのが要点である
    // ——失敗の抑止は既存テストが覆っており、ここが見たいのは**成功する put の完了待ち**だからである。
    // 差し替え先は `runInDurableObject` が渡す実 instance の `ctx.storage` で、既存の失敗注入
    // （boil-sync-persist-failure / cook-scheduling）と同一の継ぎ目である。SUT（`runEffects` 本体）は
    // 本物のまま走り、変えるのは storage の応答時刻だけである。
    const restorePut = await runInDurableObject(stub, (_instance, state) => {
      const originalPut = state.storage.put.bind(state.storage) as (...args: unknown[]) => Promise<void>;
      (state.storage as { put: unknown }).put = async (...args: unknown[]) => {
        putKeys.push(typeof args[0] === "string" ? args[0] : "(non-string key)");
        await gate.promise;
        return originalPut(...args);
      };
      return () => {
        (state.storage as { put: unknown }).put = originalPut;
      };
    });

    const messagesBeforeStart = client.messages.length;
    // 状態変化を起こす。WS 経路ゆえ webSocketMessage → decide → runEffects と本番どおり進み、
    // Persist で門に掛かって止まる。await しない（止まるのが期待される振る舞いである）。
    client.send({ type: "start", slotIds: [FIRST_SLOT], noodleType: NOODLE, boilSeconds: FIRST_BOIL_SECONDS });
    await idle(300);

    // 空虚さの排除。put へ**到達している**ことを確かめる——到達前に止まっているなら、下の「送信 0 件」は
    // 順序について何も語らない（そもそも Effect 列に入っていないだけかもしれない）。
    expect(putKeys).toEqual([SNAPSHOT_KEY]);
    // ここが 22.6 の主張である。put が確定していないあいだ、`applySideEffect` へは到達しない
    // ——`ws.send` が 1 度も起きていないことが、その到達しなさの観測である。
    expect(client.messages.length).toBe(messagesBeforeStart);

    // 門を開けて put を通す。以後に届く snapshot は、定義上 put 確定の後の送信である。
    gate.open();
    const confirmed = await client.waitForSnapshot((message) => message.timers.length === 1);

    // 届いた内容が put されたその状態と一致する（確定の起点は put 成功のみ）。
    const ssot = await readSnapshot(stub);
    expect(projectedEndTimes(confirmed)).toEqual(effectiveEndTimes(ssot));
    expect(ssot.timers.map(({ endTime }) => endTime)).toEqual([BASE_TIME + FIRST_BOIL_SECONDS * 1000]);
    // 1 回の状態変化に put は 1 回だけ（遅延させただけで再試行を呼んでいない）。
    expect(putKeys).toEqual([SNAPSHOT_KEY]);

    await runInDurableObject(stub, () => {
      restorePut();
    });
    client.close();
  });
});

/**
 * WebSocket そのものか。`instanceof` に加えて `send` / `close` の二面を見るのは、実装が socket を別の
 * ラッパへ包んで抱えた場合も掴むためである（見逃せば「隠れ状態が無い」という主張が甘くなる）。
 */
function isSocketLike(value: unknown): boolean {
  if (value instanceof WebSocket) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly send?: unknown; readonly close?: unknown };
  return typeof candidate.send === "function" && typeof candidate.close === "function";
}

/** socket を直に、または配列 / Set / Map の要素として抱えているか。 */
function holdsSocket(value: unknown): boolean {
  if (isSocketLike(value)) return true;
  if (Array.isArray(value)) return value.some(isSocketLike);
  if (value instanceof Set) return [...value].some(isSocketLike);
  if (value instanceof Map) return [...value.keys()].some(isSocketLike) || [...value.values()].some(isSocketLike);
  return false;
}

/**
 * DO インスタンスが**自前で**抱えている socket 参照の置き場（own プロパティ名）。空であることが主張である。
 *
 * `ctx` / `env` を除くのは、これがプラットフォームから受け取るハンドルであって DO 自身の状態ではないから
 * である。`ctx.getWebSockets()` が接続の正本であること自体が本テストの前提であり、それを「隠れ状態」と
 * 数えれば主張が自己矛盾する。
 *
 * 走査は own プロパティの直下と、その配列 / Set / Map の要素までである（接続レジストリを持つならその形に
 * なる）。任意深さの入れ子までは追わない——射程を明示しておく方が、追えているふりをするより誠実である。
 */
function socketBearingFields(instance: object): readonly string[] {
  return Object.entries(instance)
    .filter(([name]) => name !== "ctx" && name !== "env")
    .filter(([, value]) => holdsSocket(value))
    .map(([name]) => name);
}

/**
 * `ctx.getWebSockets()` の件数が期待値になるまで待つ。
 *
 * `Date.now` を固定しているため締切を時刻差で組めない。試行回数で上限を切る（close の完了は
 * ランタイム側の handshake ゆえ、送出直後には反映されていないことがある）。
 */
async function waitForSocketCount(stub: DurableObjectStub<StoreTimerDO>, expected: number): Promise<number> {
  let count = -1;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop
    count = await runInDurableObject(stub, (_instance, state) => state.getWebSockets().length);
    if (count === expected) return count;
    // oxlint-disable-next-line no-await-in-loop
    await idle(50);
  }
  return count;
}

describe("13.3 の構造半分 — close で除去すべき隠れ状態を持たない（Requirements 9.3, 9.4）", () => {
  // **なぜ「除去」を振る舞いとして主張しないか。** 実装は `ctx.getWebSockets()` を接続の正本とし、自前の
  // 接続レジストリを一切持たない（`webSocketClose` の本体は空で、その理由がコメントに書かれている）。
  // ゆえに「close で除去される独自状態」は存在せず、その除去を主張すれば、存在しない振る舞いを守る死んだ
  // テストになる。代わりに存在の否定そのものを主張する——close の後に DO が自前の接続状態を持たないこと、
  // そして後続の broadcast が残った socket にだけ、正確に届くこと。
  //
  // 主張のうち「自前状態を持たない」は runtime のリフレクション（own プロパティの走査）で見る。ソース
  // テキストの grep ではなく実インスタンスを見るのは、そちらが**実際に抱えている参照**だからである。
  // ただし限界は明示しておく——走査が届くのは own プロパティであり、ES private フィールド（`#field`）は
  // 見えない。現行実装は状態を TypeScript の `private`（= own プロパティ）で宣言しているため走査が全体を
  // 覆うが、これは実装の書き方に依存した射程である。
  it("1 台の close 後も DO は自前の接続状態を持たず、後続 broadcast は残った socket にだけ届く", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIME);
    const stub = await provision(freshStoreId("broadcast-after-close"));
    const clients: WsProbe[] = [];

    try {
      const staying = await connect(stub);
      const leaving = await connect(stub);
      const other = await connect(stub);
      clients.push(staying, leaving, other);
      await waitForAll(clients, (message) => message.timers.length === 0);
      expect(await waitForSocketCount(stub, 3)).toBe(3);

      // 1 台が去る。
      leaving.close();
      expect(await waitForSocketCount(stub, 2)).toBe(2);
      const messagesAtClose = leaving.messages.length;

      // close 後の DO は、自前の socket 参照をどこにも持たない（除去すべき隠れ状態が存在しない）。
      // 併せて検出器そのものを実 socket で試し、空の結果が「見えていないだけ」ではないことを確かめる。
      const inspected = await runInDurableObject(stub, (instance, state) => {
        const live = state.getWebSockets();
        return {
          fields: socketBearingFields(instance),
          ownFieldCount: Object.keys(instance).length,
          detectsBare: live.length > 0 && live[0] !== undefined ? holdsSocket(live[0]) : false,
          detectsCollection: holdsSocket(live),
        };
      });
      expect(inspected.fields).toEqual([]);
      // 走査が空振りしていない（own プロパティを実際に見ている）ことの担保。
      expect(inspected.ownFieldCount).toBeGreaterThan(0);
      expect(inspected.detectsBare).toBe(true);
      expect(inspected.detectsCollection).toBe(true);

      // 後続の状態変化。WS メッセージ経路がそのまま処理される（要件9.3）。
      staying.send({ type: "start", slotIds: [FIRST_SLOT], noodleType: NOODLE, boilSeconds: FIRST_BOIL_SECONDS });
      const arrived = (message: SnapshotMessage): boolean => message.timers.length === 1;
      const [stayingView, otherView] = await Promise.all([
        staying.waitForSnapshot(arrived),
        other.waitForSnapshot(arrived),
      ]);
      // 残った 2 台には同一の snapshot が届く。
      expect(otherView).toEqual(stayingView);
      expect(stayingView.timers).toHaveLength(1);

      // 去った 1 台へは何も届かない（close 後に送りつける経路が無い）。
      await idle(200);
      expect(leaving.messages.length).toBe(messagesAtClose);
      // 送信先の正本は最後まで getWebSockets() のままである（broadcast が件数を書き換えない）。
      expect(await waitForSocketCount(stub, 2)).toBe(2);
    } finally {
      for (const client of clients) client.close();
    }
  });
});
