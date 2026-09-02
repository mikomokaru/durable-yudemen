// tests/shell/hot-path.integration.test.ts — ホットパス分離の統合テスト（Workers pool）。
//
// _Validates: Requirements 7.7_
//
// 検証する不変（要件7.7・design.md「接続とホットパス分離」/ Component 9）：
//   WS の接続・再接続経路（高頻度＝ホットパス）は Worker → StoreTimerDO で閉じ、レジストリ
//   （STORE_REGISTRY_DO）を一切経由しない。レジストリ照会が許されるのは Entry の逆引き（起動時・低頻度）
//   に限る。ゆえに `/s/{storeId}/ws` の connect / reconnect を何度通しても、レジストリ RPC は発生しない。
//
// なぜ Worker 経路を通すか：本タスクの関心は「ホットパスの配線」であり、DO を直接叩くだけでは
// Worker のルーティング（/s/{storeId}/ws → env.STORE_TIMER_DO へ委譲）がレジストリに越境しないことを
// 示せない。ゆえに本 Worker の default fetch を実 workerd 上で呼び、接続要求が Worker → 店舗 DO で
// 閉じることを実経路で確かめる（autonomy.integration.test.ts が DO 直叩きで示した自立性の、Worker 側の対）。
//
// レジストリ非関与の観測可能な証左（autonomy.integration.test.ts と同一技法）：
//   全フロー（provision → connect → 操作 → reconnect）を通しても STORE_REGISTRY_DO 名前空間に DO が
//   一つも materialize されない（listDurableObjectIds が空）。Worker のホットパスがレジストリのスタブを
//   引けば（getByName("registry") など）当該 DO が生成されうるが、そもそも越境しないため名前空間は空のまま。
//   これが「WS の接続・再接続経路ではレジストリを経由しない」（要件7.7）の観測可能な帰結である。
//
// プロビジョニングもレジストリを介さない：レジストリ経由（/admin/stores）で店舗を作るとその設定段階で
// レジストリが materialize され、ホットパスの純粋な観測が濁る。ゆえに「最後に受領した投影」を
// applyProjection で店舗 DO へ直接押し込んでプロビジョニングし（design.md の推奨・prompt 準拠）、
// 以後の connect / reconnect だけを Worker 経路で通す。これで名前空間の空は「ホットパスの帰結」に純化される。

import { afterEach, describe, expect, it } from "vitest";
import { env, listDurableObjectIds, reset, runInDurableObject } from "cloudflare:test";
import worker from "../../src/worker";
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
 * 「最後に受領した投影」の識別可能な config。既定（DEFAULT_UNIT_COUNT=3・既定プリセット）と必ず異なる値にして、
 * Worker 経路で届く config が既定フォールバックや越境問い合わせではなく「永続投影」由来であることを判別できる
 * ようにする（ホットパスが投影だけで閉じている証左の補強）。
 */
const HOTPATH_NOODLE = "HotPathRamen";
const hotPathConfig: StoreConfig = {
  unitCount: 5,
  arms: 3,
  toleranceRatio: 12,
  noodlePresets: [
    {
      noodleType: HOTPATH_NOODLE,
      boilSeconds: { extraHard: 70, hard: 85, normal: 100, soft: 130 },
    },
  ] as NonEmptyArray<NoodlePreset>,
  ...configResidualDefaults(5),
};

/** 活性・識別可能 config を持つ「最後に受領した投影」。version は任意の正値でよい。 */
const lastProjection: StoreProjection = {
  config: hotPathConfig,
  roster: [], // ACCESS OFF 期は Roster 照合を行わない（本テストの関心は接続経路の配線であり認可ではない）。
  active: true,
  version: 3,
};

/** run 間で DO 状態が持ち越さないよう、storeId を一意に採番する（[a-z0-9-]・長さ 1..64 を満たす・要件1.2）。 */
let storeSeq = 0;
function freshStoreId(): string {
  storeSeq += 1;
  return `hotpath-${storeSeq}-${crypto.randomUUID()}`;
}

/** 指定 storeId の店舗 DO スタブを、applyProjection（型付き RPC）を呼べる形で得る（プロビジョニング用・レジストリ非関与）。 */
function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  // STORE_TIMER_DO は型生成上まだ素の DurableObjectNamespace（クラス型未反映）ゆえ class 型へ絞り込む。
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

/**
 * WS 接続ハーネス。**Worker の default fetch 経由**で `/s/{storeId}/ws` へ接続し（ホットパスの実経路）、
 * 届いた ServerMessage を FIFO で読み出す。店舗 DO は接続確立時に config → snapshot の順で送るため、
 * message リスナは accept より前に張って取りこぼしを防ぐ。
 */
interface WsHarness {
  readonly next: () => Promise<ServerMessage>;
  readonly send: (message: unknown) => void;
  readonly close: () => void;
}

async function connectViaWorker(storeId: string): Promise<WsHarness> {
  // ホットパスの実経路：Worker の default fetch を呼ぶ。Worker は storeId を検証し、
  // env.STORE_TIMER_DO.idFromName(storeId) → get({ locationHint }) のスタブへ fetch を委譲する。
  // この経路にレジストリは登場しない（要件7.7 の配線をそのまま実行する）。
  const request = new Request(`https://hot.invalid/s/${storeId}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  // Worker の default fetch は (request, env) のみを取り（極薄・ExecutionContext を用いない）、
  // 委譲先の stub.fetch を await して返す。waitUntil を張らないため ctx は不要。
  const response = await worker.fetch(request, env);

  const ws = response.webSocket;
  if (ws === null) {
    throw new Error(`WS 接続が Worker 経路で確立されなかった（status=${response.status}）`);
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

/** レジストリ名前空間に materialize された DO が一つも無いことを確かめる（ホットパス非越境の証左・要件7.7）。 */
async function expectRegistryNeverMaterialized(): Promise<void> {
  const registryIds = await listDurableObjectIds(env.STORE_REGISTRY_DO);
  expect(registryIds).toHaveLength(0);
}

describe("ホットパス分離：WS 接続・再接続はレジストリを経由しない（Requirements 7.7）", () => {
  // 店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除して独立させる。
  afterEach(async () => {
    await reset();
  });

  it("Worker 経路の connect / reconnect を通してもレジストリは一度も materialize されない", async () => {
    const storeId = freshStoreId();

    // (1) 「最後に受領した投影」を applyProjection で直接押し込んでプロビジョニングする（レジストリ非関与）。
    await runInDurableObject(storeStub(storeId), (instance: StoreTimerDO) =>
      instance.applyProjection(lastProjection),
    );

    // (2) 一度目の接続を Worker 経路で張る。config は永続投影由来の識別可能な値であること
    //     （越境問い合わせや既定フォールバックではないことの担保）。
    const first = await connectViaWorker(storeId);
    const config1 = await first.next();
    expect(config1.type).toBe("config");
    if (config1.type !== "config") throw new Error("config を受信しなかった");
    expect(config1.unitCount).toBe(hotPathConfig.unitCount);
    expect(config1.unitCount).not.toBe(DEFAULT_UNIT_COUNT); // 既定フォールバックではなく投影由来である担保。
    expect(config1.noodlePresets).toEqual(hotPathConfig.noodlePresets);

    // 接続直後の hydration snapshot は未操作ゆえ空。
    const snapshot1 = await first.next();
    expect(snapshot1.type).toBe("snapshot");
    if (snapshot1.type !== "snapshot") throw new Error("snapshot を受信しなかった");
    expect(snapshot1.timers).toHaveLength(0);

    // (3) タイマー操作（start → 確定変化の snapshot broadcast）。webSocketMessage 経路もレジストリに依存しない。
    first.send({ type: "start", slotIds: ["1"], noodleType: HOTPATH_NOODLE, boilSeconds: 300 });
    const started = await first.next();
    expect(started.type).toBe("snapshot");
    if (started.type !== "snapshot") throw new Error("start 後の snapshot を受信しなかった");
    expect(started.timers).toHaveLength(1);

    first.close();

    // (4) 再接続（reconnect）も Worker 経路で張る。走行中タイマーが自身の永続から水和され、
    //     この再接続経路でもレジストリへ越境しない。
    const second = await connectViaWorker(storeId);
    const config2 = await second.next();
    expect(config2.type).toBe("config");
    if (config2.type !== "config") throw new Error("再接続で config を受信しなかった");
    expect(config2.unitCount).toBe(hotPathConfig.unitCount);

    const snapshot2 = await second.next();
    expect(snapshot2.type).toBe("snapshot");
    if (snapshot2.type !== "snapshot") throw new Error("再接続で snapshot を受信しなかった");
    // 先の start で走り出した Timer が再接続時の全量 hydration に現れる（boilSeconds=300 ゆえ発火せず残る）。
    expect(snapshot2.timers).toHaveLength(1);
    expect(snapshot2.timers[0]?.noodleType).toBe(HOTPATH_NOODLE);
    second.close();

    // (5) connect / 操作 / reconnect の全ホットパスを通してもレジストリは一度も materialize されていない。
    //     これが「WS の接続・再接続経路ではレジストリを経由しない」（要件7.7）の観測可能な帰結である。
    await expectRegistryNeverMaterialized();
  });
});
