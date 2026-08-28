// tests/shell/store-timer-alarm.integration.test.ts — 店舗 DO の Alarm 配線のうち「多重発火」と
// 「並走時の張り直し先の値」を受け持つ統合テスト（Workers pool）。
//
// _Validates: Requirements 2.5, 2.6, 2.7, 3.2, 3.3, 3.4, 6.3, 6.4_
//
// タスク 12.2 / 22.3 / 22.5 のうち、既存テストが覆っていない 2 点だけをここで主張する。
//
//   12.2 / 22.3 の未カバー部 — DO レベルの多重発火（要件2.5 / 2.6 / 2.7）
//   22.5              — 複数 Timer 並走の Alarm 張り直し先の値（要件3.2 / 3.3 / 3.4 / 6.3 / 6.4）
//
// **既存の主張は繰り返さない。**
//   - 発火 → done broadcast、残存 0 で解除、`SetAlarm`×5 → `ClearAlarm`×2 という Effect 列の**形**は
//     `tests/operation-history/store-timer-observation-fault.integration.test.ts`（`runScenario`）が固めている。
//     ゆえにここでは列の形を数え直さず、Alarm に**入った値**と多重呼び出しの結末だけを見る。
//   - 多重発火の冪等性の **pure レベル**（`fireDueTimers` を二度通しても新規 boiled が出ない）は
//     `tests/core/fire.property.test.ts`（Property 5）が固めている。ここが足すのは DO レベル——
//     `alarm()` という**入口**を同一 now で 2 回通したとき、永続・broadcast・Alarm という
//     プラットフォーム作用の側に何も漏れないこと。既存の統合テストは `alarm()` を 1 回しか呼んでいない。
//
// **なぜ「実効 endTime」で期待値を作るか。** Alarm は Adjusted_Boil_Time（= endTime + adjustment）へ張られる
// （`src/engine/alarm.ts` の `earliestEndTime`）。近接した Timer が並ぶと Boil_Sync が 0 でない Adjustment を
// 割り当てるため、茹で秒から素朴に計算したオリジナル endTime は Alarm の値と一致しない。ゆえに期待値は
// 毎回**永続 snapshot の `endTime + adjustment`** から導く（永続層が SSOT ゆえ、そこが唯一の照合先である）。
// 本ファイルの筋書きは実際に 0 でない Adjustment を生む（近接 2 本を arms=2 で同時刻へそろえる）ので、
// この導出は空虚ではない——素朴な期待値なら落ちる主張になっている。
//
// **なぜ `Date.now` を固定するか。** Alarm の予定時刻・発火時刻・ε 窓の関係が実時計に揺れると、
// 「同一 now で 2 回」という前提そのものが崩れる。他の shell テスト
// （`tests/operation-history/store-timer-observation-fault.integration.test.ts`）と同じく `vi.spyOn` で
// 固定し、`afterEach` で必ず戻す。

import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { ServerMessage } from "../../src/domain/messages";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { StoreSnapshot } from "../../src/engine/snapshot";
import { configResidualDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** タイマー SSOT の単一キー。store-timer-do.ts の SNAPSHOT_KEY（private 定数）と一致させる。 */
const SNAPSHOT_KEY = "activeTimers";

/** 本テストが用いる麺種。プリセットに無い麺種は開始できないため config と start で同じ値を使う。 */
const NOODLE = "AlarmRamen";

/** ユニット 1 台（= 6 釜）。使うのは 4 釜だけで、釜数そのものは本テストの関心事ではない。 */
const UNIT_COUNT = 1;

/**
 * 基準時刻。すべての Timer はこの時刻に開始し、以後の now はここからの相対で動かす。
 *
 * 固定値にするのは、発火時刻と ε 窓（500ms）の関係を run ごとに揺らさないためである。
 */
const BASE_TIME = 1_800_000_000_000;

/**
 * 並走させる 4 本。茹で秒は「近接 2 本（60 / 62 秒）＋離れた 2 本（120 / 300 秒）」になるよう選ぶ。
 *
 * 近接 2 本は許容調整窓（±10% = ±6.0 / ±6.2 秒）が重なるため 1 つの Proximity_Cluster を成し、arms=2 の下で
 * 同一の Sync_Target へそろえられる——ここで 0 でない Adjustment が生まれ、Alarm の値がオリジナル endTime と
 * 食い違う。離れた 2 本は窓が重ならず単独クラスタ（Adjustment 0）に落ち、発火順の骨格を作る。
 */
const NEAR_SLOT = "0";
const PAIR_SLOT = "3";
const MID_SLOT = "1";
const LATE_SLOT = "2";
const NEAR_BOIL_SECONDS = 60;
const PAIR_BOIL_SECONDS = 62;
const MID_BOIL_SECONDS = 120;
const LATE_BOIL_SECONDS = 300;

/** snapshot ServerMessage の絞り込み型（Timer 集合を読むのはこの種別だけ）。 */
type SnapshotMessage = Extract<ServerMessage, { readonly type: "snapshot" }>;

/**
 * 本テストの店舗設定。arms 2・許容調整割合 10% が近接 2 本を「同時に上げる 1 セット」へ畳む条件である。
 *
 * arms を 1 にすると同じ 2 本が別セットへ分かれ、maximin が両者を窓の両端へ押し離す（同時刻にならない）。
 * 本テストが見たいのは「実効最早へ張る」ことなので、Adjustment が 0 でなくなる最も素直な形を採る。
 */
const storeConfig: StoreConfig = {
  unitCount: UNIT_COUNT,
  arms: 2,
  toleranceRatio: 10,
  noodlePresets: [
    { noodleType: NOODLE, boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
  ] as NonEmptyArray<NoodlePreset>,
  ...configResidualDefaults(UNIT_COUNT),
};

/** プロビジョニング用の投影。ACCESS_REQUIRED OFF 期ゆえ roster は空でよい（関心事は認可ではない）。 */
const projection: StoreProjection = { config: storeConfig, roster: [], active: true, version: 1 };

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
 * 未プロビジョニングの DO は WS 接続を 403 で拒むため、全テストの前提としてここを通す。
 */
async function provision(storeId: string): Promise<DurableObjectStub<StoreTimerDO>> {
  const stub = storeStub(storeId);
  await stub.applyProjection(projection);
  return stub;
}

/** 接続中クライアントの受信を観測するハンドル。 */
interface WsProbe {
  /** 到着順の全メッセージ（config を含む）。broadcast の不在を件数で見るために生の列を持つ。 */
  readonly messages: readonly ServerMessage[];
  /** 条件を満たす snapshot を待つ（既受信にも遡って一致する）。 */
  waitForSnapshot(predicate: (message: SnapshotMessage) => boolean, timeoutMs?: number): Promise<SnapshotMessage>;
  send(message: unknown): void;
  close(): void;
}

/** WS を張り、client 端を accept して受信を収集する（cook-scheduling.integration.test.ts と同形）。 */
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
        const timer = setTimeout(() => reject(new Error("snapshot の待機がタイムアウトした")), timeoutMs);
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

/**
 * 永続 snapshot を読む。
 *
 * ワイヤの snapshot では期待値を作れない——`toWireTimer` は running / boiled の区別（boiledAt）と
 * Adjustment を削ぎ落とし、実効 endTime だけを載せる。「走行中のうちの実効最早」を導くには両方が要る。
 */
async function readSnapshot(stub: DurableObjectStub<StoreTimerDO>): Promise<StoreSnapshot> {
  const persisted = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
  );
  if (persisted === undefined) throw new Error("StoreSnapshot が永続されていない");
  return persisted;
}

/** 設定中の Alarm を読む（プラットフォーム側の事実）。 */
async function readAlarm(stub: DurableObjectStub<StoreTimerDO>): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/**
 * 残存する走行中 Timer の実効最早（Adjusted_Boil_Time の最小値）。走行中 0 件なら null。
 *
 * boiled を除くのは、endTime が過去ゆえ Alarm 対象にすると無限再発火になるためである（要件2.9）。
 * 実効値を `endTime + adjustment` として自前で組むのは、期待値を engine の導出関数に相乗りさせず
 * 永続された事実だけから独立に立てるためである。
 */
function earliestEffectiveEndTime(snapshot: StoreSnapshot): number | null {
  const running = snapshot.timers.filter((timer) => timer.boiledAt === null);
  if (running.length === 0) return null;
  return Math.min(...running.map((timer) => timer.endTime + timer.adjustment));
}

/**
 * 設定中の Alarm が「永続から導いた走行中の実効最早」に一致することを主張し、その値を返す。
 *
 * 返すのは、次の発火をその予定時刻に起こすためである（実機の Alarm は予定時刻に起動する）。
 */
async function expectAlarmAtEffectiveEarliest(stub: DurableObjectStub<StoreTimerDO>): Promise<number | null> {
  const expected = earliestEffectiveEndTime(await readSnapshot(stub));
  expect(await readAlarm(stub)).toBe(expected);
  return expected;
}

/** 走行中 Timer が占める釜（昇順）。永続 snapshot にしか無い区別なのでここで読む。 */
function runningSlots(snapshot: StoreSnapshot): readonly string[] {
  return snapshot.timers
    .filter((timer) => timer.boiledAt === null)
    .flatMap((timer) => timer.slotIds)
    .sort();
}

/** 茹で上がり（boiled）の Timer が占める釜（昇順）。 */
function boiledSlots(snapshot: StoreSnapshot): readonly string[] {
  return snapshot.timers
    .filter((timer) => timer.boiledAt !== null)
    .flatMap((timer) => timer.slotIds)
    .sort();
}

/** 釜 slotId で 1 本走らせ、確定の broadcast を待って返す。 */
async function startAtSlot(
  client: WsProbe,
  slotId: string,
  boilSeconds: number,
  expectedTimers: number,
): Promise<SnapshotMessage> {
  client.send({ type: "start", slotIds: [slotId], noodleType: NOODLE, boilSeconds });
  return client.waitForSnapshot((message) => message.timers.length === expectedTimers);
}

/** timerId をキャンセルし、確定の broadcast を待って返す。 */
async function cancelTimer(client: WsProbe, timerId: string, expectedTimers: number): Promise<SnapshotMessage> {
  client.send({ type: "cancel", timerId });
  return client.waitForSnapshot((message) => message.timers.length === expectedTimers);
}

/** ワイヤ snapshot から、当該釜を占める Timer の timerId を引く。 */
function timerIdAtSlot(message: SnapshotMessage, slotId: string): string {
  const found = message.timers.find((timer) => timer.slotIds.includes(slotId));
  if (found === undefined) throw new Error(`釜 ${slotId} の Timer が snapshot に無い`);
  return found.id;
}

/**
 * 予定時刻 `at` に Alarm を起こす。now をその時刻へ固定してから `alarm()` を直接呼ぶ。
 *
 * `runDurableObjectAlarm` を使わないのは、予約を消費して 1 回しか走らないため——同一 now で 2 回という
 * 本テストの主題がそもそも書けない。入口（`alarm()`）を直接呼ぶ形は
 * `tests/operation-history/store-timer-observation-fault.integration.test.ts` と同じである。
 */
async function fireAlarmAt(stub: DurableObjectStub<StoreTimerDO>, at: number): Promise<void> {
  vi.mocked(Date.now).mockReturnValue(at);
  expect(await runInDurableObject(stub, (instance) => instance.alarm())).toBeUndefined();
}

/** 4 本を並走させる。開始順は茹で秒の降順——各 start が Alarm を「より早い方へ」張り直す形になる。 */
async function startFourTimers(client: WsProbe): Promise<SnapshotMessage> {
  await startAtSlot(client, LATE_SLOT, LATE_BOIL_SECONDS, 1);
  await startAtSlot(client, MID_SLOT, MID_BOIL_SECONDS, 2);
  await startAtSlot(client, NEAR_SLOT, NEAR_BOIL_SECONDS, 3);
  return startAtSlot(client, PAIR_SLOT, PAIR_BOIL_SECONDS, 4);
}

// 店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除し、固定した時計を戻して独立させる。
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("12.2 / 22.3 DO レベルの多重発火（Requirements 2.5, 2.6, 2.7）", () => {
  it("同一 now で alarm() を 2 回呼んでも、新たな boiled は増えず確定 snapshot も Alarm も 1 回目と一致し、二度目の broadcast は出ない", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIME);
    const stub = await provision(freshStoreId("alarm-redundant-fire"));
    const client = await connect(stub);
    await startFourTimers(client);

    // 1 回目。Alarm の予定時刻＝走行中の実効最早（近接 2 本がそろえられた共通時刻）に起こす。
    const scheduled = await expectAlarmAtEffectiveEarliest(stub);
    if (scheduled === null) throw new Error("走行中 Timer が無く Alarm 予定が立っていない");
    // 前提が崩れた空虚な合格を許さない——Adjustment が 0 なら実効最早はオリジナル endTime に等しく、
    // 「実効時刻で張る」という主張が何も語らなくなる。
    expect(scheduled).not.toBe(BASE_TIME + NEAR_BOIL_SECONDS * 1000);

    await fireAlarmAt(stub, scheduled);
    // serverTime で待つ。boiled は除去されないため Timer 件数も実効 endTime も発火前と変わらず、
    // 発火の broadcast をワイヤの内容で見分ける手掛かりは固定した now だけである。
    await client.waitForSnapshot((message) => message.serverTime === scheduled);
    const afterFirst = await readSnapshot(stub);
    const alarmAfterFirst = await readAlarm(stub);
    const messagesAfterFirst = client.messages.length;
    // 近接 2 本が同一の Sync_Target で同時に茹で上がり、離れた 2 本は走行中のまま残る。
    expect(boiledSlots(afterFirst)).toEqual([NEAR_SLOT, PAIR_SLOT].sort());
    expect(runningSlots(afterFirst)).toEqual([MID_SLOT, LATE_SLOT].sort());

    // 2 回目。now は 1 回目と同一。at-least-once な Alarm が同じ時刻で二度起きた場面である。
    // put の回数を数えるのは、no-op 抑止を作用の側で直接見るためである——`settle` が Effect 空を返せば
    // Persist（列の先頭）が一度も走らない。Persist が走らないことは、その上に立つ SetAlarm / Broadcast も
    // 出ないことの根拠でもある（SSOT 規律）。
    const secondRun = await runInDurableObject(stub, async (instance, state) => {
      const originalPut = state.storage.put.bind(state.storage) as (...args: unknown[]) => Promise<void>;
      let puts = 0;
      (state.storage as { put: unknown }).put = (...args: unknown[]) => {
        puts += 1;
        return originalPut(...args);
      };
      try {
        const returned = await instance.alarm();
        return { returned, puts };
      } finally {
        (state.storage as { put: unknown }).put = originalPut;
      }
    });

    expect(secondRun.returned).toBeUndefined();
    // 永続への書き込みが一度も起きない（要件2.6：既に boiled のものを再処理しない）。
    expect(secondRun.puts).toBe(0);
    // 新たな boiled は増えず、確定 snapshot は 1 回目と丸ごと一致する（要件2.5 / 2.7）。
    expect(await readSnapshot(stub)).toEqual(afterFirst);
    // 次の発火予定も動かない（残存最早は 1 回目の張り直しのまま）。
    expect(await readAlarm(stub)).toBe(alarmAfterFirst);
    // 二度目の broadcast は出ない。同じ茹で上がりを二度提示すれば、現場は二度アラームを聞く。
    await idle(200);
    expect(client.messages.length).toBe(messagesAfterFirst);

    client.close();
  });
});

describe("22.5 複数 Timer 並走の Alarm 張り直し（Requirements 3.2, 3.3, 3.4, 6.3, 6.4）", () => {
  it("開始とキャンセルの各遷移で Alarm が残存走行中の実効最早に一致し、走行中 0 件で解除される", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIME);
    const stub = await provision(freshStoreId("alarm-rearm-cancel"));
    const client = await connect(stub);

    // ── 開始（要件3.2）。茹で秒の降順に足すので、Alarm は毎回より早い方へ張り直される。
    await startAtSlot(client, LATE_SLOT, LATE_BOIL_SECONDS, 1);
    expect(await expectAlarmAtEffectiveEarliest(stub)).toBe(BASE_TIME + LATE_BOIL_SECONDS * 1000);
    await startAtSlot(client, MID_SLOT, MID_BOIL_SECONDS, 2);
    expect(await expectAlarmAtEffectiveEarliest(stub)).toBe(BASE_TIME + MID_BOIL_SECONDS * 1000);
    await startAtSlot(client, NEAR_SLOT, NEAR_BOIL_SECONDS, 3);
    expect(await expectAlarmAtEffectiveEarliest(stub)).toBe(BASE_TIME + NEAR_BOIL_SECONDS * 1000);
    // 4 本目（近接）を足すと Boil_Sync が両者を共通時刻へそろえるため、Alarm はオリジナル endTime の
    // どちらでもない実効最早へ動く。ここが「素朴な期待値では落ちる」箇所である。
    const synced = await startAtSlot(client, PAIR_SLOT, PAIR_BOIL_SECONDS, 4);
    const syncedEarliest = await expectAlarmAtEffectiveEarliest(stub);
    expect(syncedEarliest).not.toBe(BASE_TIME + NEAR_BOIL_SECONDS * 1000);
    expect(syncedEarliest).not.toBe(BASE_TIME + PAIR_BOIL_SECONDS * 1000);

    // ── キャンセル（要件6.3）。now を進めるのは、走行中の中断という実際の場面に合わせるため。
    vi.mocked(Date.now).mockReturnValue(BASE_TIME + 10_000);
    // Alarm 設定対象（実効最早）を含む近接 2 本の一方を落とす。残った片方は単独クラスタへ戻り
    // Adjustment が 0 に解けるので、張り直し先は「素の endTime を並べた最小値」ではなく再同期後の実効最早。
    await cancelTimer(client, timerIdAtSlot(synced, NEAR_SLOT), 3);
    expect(await expectAlarmAtEffectiveEarliest(stub)).toBe(BASE_TIME + PAIR_BOIL_SECONDS * 1000);

    await cancelTimer(client, timerIdAtSlot(synced, PAIR_SLOT), 2);
    expect(await expectAlarmAtEffectiveEarliest(stub)).toBe(BASE_TIME + MID_BOIL_SECONDS * 1000);

    await cancelTimer(client, timerIdAtSlot(synced, MID_SLOT), 1);
    expect(await expectAlarmAtEffectiveEarliest(stub)).toBe(BASE_TIME + LATE_BOIL_SECONDS * 1000);

    // ── 最後の 1 本のキャンセル（要件6.4）。走行中 0 件ゆえ Alarm は解除される。
    await cancelTimer(client, timerIdAtSlot(synced, LATE_SLOT), 0);
    expect(await expectAlarmAtEffectiveEarliest(stub)).toBeNull();
    expect(await readAlarm(stub)).toBeNull();

    client.close();
  });

  it("発火の各遷移で Alarm が残存走行中の実効最早に一致し、走行中 0 件で解除される（boiled は対象に含めない）", async () => {
    vi.spyOn(Date, "now").mockReturnValue(BASE_TIME);
    const stub = await provision(freshStoreId("alarm-rearm-fire"));
    const client = await connect(stub);
    await startFourTimers(client);

    // ── 1 回目の発火（要件3.3）。近接 2 本が同時に茹で上がり、残存走行中の実効最早へ張り直される。
    const first = await expectAlarmAtEffectiveEarliest(stub);
    if (first === null) throw new Error("走行中 Timer が無く Alarm 予定が立っていない");
    await fireAlarmAt(stub, first);
    await client.waitForSnapshot((message) => message.serverTime === first);
    const afterFirst = await readSnapshot(stub);
    expect(boiledSlots(afterFirst)).toEqual([NEAR_SLOT, PAIR_SLOT].sort());
    // boiled 2 本は集合に残る（除去は明示完了のみ）が、Alarm の対象は走行中だけである（要件2.9）。
    expect(await expectAlarmAtEffectiveEarliest(stub)).toBe(BASE_TIME + MID_BOIL_SECONDS * 1000);

    // ── 2 回目の発火（要件3.3）。走行中は 1 本だけ残り、Alarm はその実効 endTime へ動く。
    await fireAlarmAt(stub, BASE_TIME + MID_BOIL_SECONDS * 1000);
    await client.waitForSnapshot((message) => message.serverTime === BASE_TIME + MID_BOIL_SECONDS * 1000);
    expect(runningSlots(await readSnapshot(stub))).toEqual([LATE_SLOT]);
    expect(await expectAlarmAtEffectiveEarliest(stub)).toBe(BASE_TIME + LATE_BOIL_SECONDS * 1000);

    // ── 3 回目の発火（要件3.4）。走行中が尽きたので Alarm は解除される。boiled 4 本は残ったままである
    // ——「残存 0」が指すのは走行中の 0 件であって、集合が空であることではない。
    await fireAlarmAt(stub, BASE_TIME + LATE_BOIL_SECONDS * 1000);
    await client.waitForSnapshot((message) => message.serverTime === BASE_TIME + LATE_BOIL_SECONDS * 1000);
    const afterLast = await readSnapshot(stub);
    expect(runningSlots(afterLast)).toEqual([]);
    expect(boiledSlots(afterLast)).toEqual([NEAR_SLOT, PAIR_SLOT, MID_SLOT, LATE_SLOT].sort());
    expect(earliestEffectiveEndTime(afterLast)).toBeNull();
    expect(await readAlarm(stub)).toBeNull();

    client.close();
  });
});
