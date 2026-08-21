// tests/shell/autonomy.integration.test.ts — レジストリ不達時の自立稼働の統合テスト（Workers pool）。
//
// _Validates: Requirements 6.1, 6.2_
//
// 検証する不変（店舗 DO の「自立性」＝構造の主権・design-philosophy）：
//   要件6.1 — StoreTimerDO は投影を自身のストレージに永続し続け、hibernate 復帰（rehydrate）時に
//             レジストリ（STORE_REGISTRY_DO）へ越境読みをしない（復帰ホットパスは店舗 DO 内で閉じる）。
//   要件6.2 — レジストリが不達・停止していても、最後に受領した投影で稼働を継続する
//             （タイマー機能・接続時条件判定はレジストリの可用性に依存しない）。
//
// 「レジストリ不達」の最も忠実な再現は、レジストリを一切登場させないことである。店舗 DO は
// STORE_REGISTRY_DO バインディングも他 DO スタブも保持せず（store-timer-do.ts のクラスコメント参照）、
// 設定は applyProjection の push でのみ届く。ゆえに本テストは：
//   (1) 「最後に受領した投影」を applyProjection で直接押し込んで店舗をプロビジョニングし、
//   (2) その投影だけで WS 接続時の config 配信・タイマー操作（start → snapshot broadcast）が成立し、
//   (3) in-memory を破棄して rehydrate させた後も、自身の永続（projection / activeTimers）だけで
//       config とタイマー状態が継続する
// ことを、workerd 上の実 DO・実 storage で確かめる。
//
// レジストリ非関与の直接の証左：全フローを通しても STORE_REGISTRY_DO 名前空間に DO が一つも
// materialize されないこと（listDurableObjectIds が空）。店舗 DO が接続・rehydrate の経路でレジストリの
// スタブを引けば（idFromName → get）当該 DO が生成されうるが、そもそも越境しないため名前空間は空のまま。
// これが「rehydrate 時にレジストリ RPC を呼ばない」（要件6.1）の観測可能な帰結である。

import { afterEach, describe, expect, it } from "vitest";
import { env, evictDurableObject, listDurableObjectIds, reset, runInDurableObject } from "cloudflare:test";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { ServerMessage } from "../../src/domain/messages";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import { DEFAULT_UNIT_COUNT } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import { configResidualDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO / STORE_REGISTRY_DO を型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * 投影の永続キー。store-timer-do.ts の PROJECTION_KEY と一致させる（そこでは private 定数）。
 * rehydrate が自身のこのキーだけを読んで config を復元することを間接的に前提とする。
 */
const PROJECTION_KEY = "projection";

/**
 * 「最後に受領した投影」の識別可能な config。既定（DEFAULT_UNIT_COUNT=3・既定プリセット）と必ず異なる値にして、
 * 接続時の config がレジストリの再問い合わせや既定フォールバックではなく「永続投影」由来であることを判別できる
 * ようにする。unitCount は既定と異なる 4、noodleType は既定に無い固有名を用いる。
 */
const AUTONOMY_NOODLE = "AutonomyRamen";
const autonomyConfig: StoreConfig = {
  unitCount: 4,
  arms: 3,
  toleranceRatio: 15,
  noodlePresets: [
    { noodleType: AUTONOMY_NOODLE, boilSeconds: { extraHard: 80, hard: 90, normal: 100, soft: 120 } },
  ] as NonEmptyArray<NoodlePreset>,
  ...configResidualDefaults(4),
};

/** 活性・識別可能 config を持つ「最後に受領した投影」。version は任意の正値でよい（単調ガードの下限）。 */
const lastProjection: StoreProjection = {
  config: autonomyConfig,
  roster: [], // ACCESS OFF 期は Roster 照合を行わない（本テストの関心は自立稼働であり認可ではない）。
  active: true,
  version: 7,
};

/** run 間で DO 状態が持ち越さないよう、storeId を一意に採番する。 */
let storeSeq = 0;
function freshStoreId(): string {
  storeSeq += 1;
  return `autonomy-${storeSeq}-${crypto.randomUUID()}`;
}

/**
 * WS 接続ハーネス。DO の fetch（Upgrade: websocket）へ接続し、届いた ServerMessage を FIFO で読み出す。
 *
 * 店舗 DO は接続確立時に config → snapshot の順で送るため（store-timer-do.ts の fetch）、message
 * リスナは accept より前に張って取りこぼしを防ぐ。next() は到着済みがあれば即返し、無ければ次の到着を待つ。
 */
interface WsHarness {
  readonly next: () => Promise<ServerMessage>;
  readonly send: (message: unknown) => void;
  readonly close: () => void;
}

async function openWs(stub: DurableObjectStub<StoreTimerDO>, storeId: string): Promise<WsHarness> {
  const response = await stub.fetch(`https://do.invalid/s/${storeId}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = response.webSocket;
  if (ws === null) {
    throw new Error(`WS 接続が確立されなかった（status=${response.status}）`);
  }

  const queue: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(message);
    else queue.push(message);
  });
  ws.accept();

  return {
    next: () =>
      new Promise<ServerMessage>((resolve) => {
        const buffered = queue.shift();
        if (buffered !== undefined) resolve(buffered);
        else waiters.push(resolve);
      }),
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
  };
}

/** 指定 storeId の店舗 DO スタブを、applyProjection（型付き RPC）を呼べる形で得る。 */
function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  // STORE_TIMER_DO は型生成上まだ素の DurableObjectNamespace（クラス型未反映）ゆえ class 型へ絞り込む。
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

describe("店舗 DO の自立稼働（レジストリ不達でも投影で継続・要件6.1 / 6.2）", () => {
  // シングルトン級の DO・店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除する。
  afterEach(async () => {
    await reset();
  });

  it("最後に受領した投影だけで config を配信し、タイマー操作が成立する（レジストリ非関与・要件6.2）", async () => {
    const storeId = freshStoreId();
    const stub = storeStub(storeId);

    // (1) 「最後に受領した投影」を push でプロビジョニングする（レジストリを介さず applyProjection を直接呼ぶ）。
    await runInDurableObject(stub, (instance: StoreTimerDO) => instance.applyProjection(lastProjection));

    // (2) WS 接続。config は永続投影由来の識別可能な値（unitCount=4・固有 noodleType）であること。
    const ws = await openWs(stub, storeId);
    const config = await ws.next();
    expect(config.type).toBe("config");
    if (config.type !== "config") throw new Error("config を受信しなかった");
    expect(config.unitCount).toBe(autonomyConfig.unitCount);
    expect(config.unitCount).not.toBe(DEFAULT_UNIT_COUNT); // 既定フォールバックではなく投影由来であることの担保。
    expect(config.noodlePresets).toEqual(autonomyConfig.noodlePresets);

    // 接続直後の hydration snapshot はタイマー無し（未操作）。
    const initialSnapshot = await ws.next();
    expect(initialSnapshot.type).toBe("snapshot");
    if (initialSnapshot.type !== "snapshot") throw new Error("snapshot を受信しなかった");
    expect(initialSnapshot.timers).toHaveLength(0);

    // (3) タイマー操作が成立する（start → 確定変化の snapshot broadcast）。レジストリに依存しない稼働の核。
    ws.send({ type: "start", slotIds: ["1"], noodleType: AUTONOMY_NOODLE, boilSeconds: 300 });
    const started = await ws.next();
    expect(started.type).toBe("snapshot");
    if (started.type !== "snapshot") throw new Error("start 後の snapshot を受信しなかった");
    expect(started.timers).toHaveLength(1);
    expect(started.timers[0]?.noodleType).toBe(AUTONOMY_NOODLE);
    expect(started.timers[0]?.slotIds).toEqual(["1"]);

    ws.close();

    // レジストリは一度も materialize されていない（越境が無いため名前空間は空のまま）。
    const registryIds = await listDurableObjectIds(env.STORE_REGISTRY_DO);
    expect(registryIds).toHaveLength(0);
  });

  it("in-memory 破棄（rehydrate）後も自身の永続だけで config とタイマー状態が継続する（越境読みなし・要件6.1）", async () => {
    const storeId = freshStoreId();
    const stub = storeStub(storeId);

    // 「最後に受領した投影」を push し、タイマーを 1 件走らせて永続させる（config も activeTimers も自身の storage へ）。
    await runInDurableObject(stub, (instance: StoreTimerDO) => instance.applyProjection(lastProjection));

    const before = await openWs(stub, storeId);
    await before.next(); // config
    await before.next(); // 初期 snapshot（空）
    before.send({ type: "start", slotIds: ["2"], noodleType: AUTONOMY_NOODLE, boilSeconds: 300 });
    const startedSnapshot = await before.next();
    expect(startedSnapshot.type).toBe("snapshot");
    if (startedSnapshot.type !== "snapshot") throw new Error("start 後の snapshot を受信しなかった");
    expect(startedSnapshot.timers).toHaveLength(1);
    before.close();

    // in-memory 状態を破棄して rehydrate を強制する（durable storage は保全され、次アクセスで storage から再構築）。
    // これは hibernate 復帰と同じ状況——復帰ホットパスが自身の storage だけで閉じることを検証する土台。
    await evictDurableObject(stub, { webSockets: "close" });

    // 破棄後の新 instance へ WS 接続する。config は永続投影から復元され、snapshot は永続タイマーから水和される。
    // どちらもレジストリへ問い合わせずに（applyProjection の再受領なしに）成立しなければならない。
    const after = await openWs(stub, storeId);
    const config = await after.next();
    expect(config.type).toBe("config");
    if (config.type !== "config") throw new Error("rehydrate 後に config を受信しなかった");
    expect(config.unitCount).toBe(autonomyConfig.unitCount);
    expect(config.noodlePresets).toEqual(autonomyConfig.noodlePresets);

    const rehydratedSnapshot = await after.next();
    expect(rehydratedSnapshot.type).toBe("snapshot");
    if (rehydratedSnapshot.type !== "snapshot") throw new Error("rehydrate 後に snapshot を受信しなかった");
    // 走行中タイマーが永続から復元されている（boilSeconds=300 ゆえ reconcile で発火せず残る）。
    expect(rehydratedSnapshot.timers).toHaveLength(1);
    expect(rehydratedSnapshot.timers[0]?.noodleType).toBe(AUTONOMY_NOODLE);
    expect(rehydratedSnapshot.timers[0]?.slotIds).toEqual(["2"]);
    after.close();

    // rehydrate・再接続の全経路を通してもレジストリは一度も materialize されていない（越境読みなし・要件6.1）。
    const registryIds = await listDurableObjectIds(env.STORE_REGISTRY_DO);
    expect(registryIds).toHaveLength(0);

    // 補強：投影は店舗 DO 自身の projection キーに永続され続けている（rehydrate の唯一の設定源）。
    await runInDurableObject(stub, async (_instance: StoreTimerDO, state: DurableObjectState) => {
      const persisted = (await state.storage.get(PROJECTION_KEY)) as StoreProjection | undefined;
      expect(persisted).toEqual(lastProjection);
    });
  });
});
