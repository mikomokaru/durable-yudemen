// tests/shell/store-timer-auto-response.integration.test.ts — 心拍 auto-response の**ランタイム挙動**を
// 受け持つ統合テスト（Workers pool）。
//
// _Validates: Requirements 1.1, 1.5, 12.3_
//
// タスク 10.2。既存カバーは `tests/offline-degradation.static.test.ts`（`:410` 付近）の静的検査だけで、
// あちらは `store-timer-do.ts` の**ソーステキスト**から `setWebSocketAutoResponse` の呼び出し点が
// ちょうど 1 点であること・引数が `PING_REQUEST` / `PONG_RESPONSE` のペアであることを固定する。
// ソースを読む主張ゆえ、**登録が実際にランタイムへ効いたか**も、**心拍が `webSocketMessage` を
// 起動しないか**も観測しない。本ファイルがその欠けを埋める——実 workerd 上で心拍を打ち、
// プラットフォーム側から見える事実だけで主張する。棲み分けは「静的検査＝登録点の固定」／
// 「本ファイル＝登録の実効とランタイム経路の観測」である。
//
// **`webSocketMessage` の非発火をどう観測するか（要件1.5 の核）。** DO の `webSocketMessage` は未知の
// 文字列を無言で捨てるため、「呼ばれなかった」ことをワイヤの側から見る口が無い。計装（`emitSeam`）も
// construct / rehydrate / alarm / broadcast の 4 継ぎ目だけで、`webSocketMessage` 自体の継ぎ目を持たない。
// ゆえに `runInDurableObject` で得た**実インスタンスの `webSocketMessage` を包み**、ランタイムが
// dispatch した事実そのものを数える。workerd はハンドラをインスタンスのプロパティとして引くため、
// own property に被せた包みが実際に呼ばれる（プローブで確認済み）。`src/**` は一文字も変えない。
//
// **対照を必ず置く。** 包みが死んでいれば「0 件」は無条件に成立してしまう。ゆえに同じテストの中で
// 正当な `ClientMessage`（`start`）を送り、そちらは包みに 1 件記録されることを見せる。0 件の主張は
// この対照の上にだけ立つ。
//
// **肯定的観測を併せる。** 非発火は不在の主張ゆえ、「そもそも応答が起きたのか」を別の口から取る。
// `ctx.getWebSocketAutoResponseTimestamp(ws)` は auto-response がその接続へ最後に応答した時刻を返す
// （応答前は null）。ランタイムが応答した事実をプラットフォーム側から読めるため、これを肯定側に据える。
//
// **待機は主張と同じ言葉で書く。** pong は同一の文字列が何度も現れる**再訪する述語**であり、「pong が
// 来た」という存在の待機は 1 本目（あるいは遡って過去の 1 本）で解ける。2 本打った pong の 2 本目を
// 待てないまま先へ進むと、直後の否定的観測が「まだ応答が済んでいないだけ」を無書き込みと読み違える。
// ゆえに `waitForFrame` は通算本数（count）で待つ。通算は単調に増えるため遡りが取り違えを生まず、
// 主張（pong が 2 本）と待機（pong が 2 本に達する）が一致する。猶予（`idle`）は否定的観測のためだけに
// 置き、同期の代わりには使わない——待機で同期できるものは待機で同期する。
//
// **なぜ時計を固定しないか。** 本ファイルの主張はいずれも絶対時刻・経過時間の量に依らない（心拍の
// 送信間隔や pong 待ちの閾値は client 側の関心事であり、要件1.2 / 1.4 の担当はここではない）。
// 固定する理由が無いものを固定しない。

import { afterEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import type { ServerMessage } from "../../src/domain/messages";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { StoreSnapshot } from "../../src/engine/snapshot";
import type { StoreProjection } from "../../src/registry/projection";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import { PING_REQUEST, PONG_RESPONSE } from "../../src/transport/heartbeat";
import { configResidualDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** タイマー SSOT の単一キー。store-timer-do.ts の SNAPSHOT_KEY（private 定数）と一致させる。 */
const SNAPSHOT_KEY = "activeTimers";

/** 本テストが用いる麺種。プリセットに無い麺種は開始できないため config と start で同じ値を使う。 */
const NOODLE = "HeartbeatRamen";

/** ユニット 1 台（= 6 釜）。使うのは 1 釜だけで、釜数そのものは本テストの関心事ではない。 */
const UNIT_COUNT = 1;

/** テスト中に発火しない茹で秒。発火・Alarm は本ファイルの関心事ではない。 */
const BOIL_SECONDS = 600;

/** 対照の `start` が占める釜。 */
const SLOT = "0";

/** 本テストの店舗設定。arms / toleranceRatio は主張に効かないため他の shell 統合テストと同形で足りる。 */
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

/**
 * 監視が記録を溜める先のプロパティ名。
 *
 * インスタンスへ後付けする観測用の場所であり、`src/**` の語彙ではないため衝突しない綴りを選ぶ。
 */
const ARRIVED_AT_SEAM = "__arrivedAtMessageSeam";

/** 監視を被せたインスタンス。記録先は後付けゆえ交差型で表明する。 */
type WatchedInstance = StoreTimerDO & { [ARRIVED_AT_SEAM]?: string[] };

/** 接続中クライアントの受信を観測するハンドル。 */
interface WsProbe {
  /** 到着順の生フレーム。心拍の pong は ServerMessage ではないため、parse せず生の列で持つ。 */
  readonly frames: readonly string[];
  /**
   * 条件を満たす生フレームの通算 `count` 本目を待つ（既受信にも遡って数え入れる）。
   *
   * **なぜ「存在」ではなく「通算本数」で待つか。** 心拍の pong は同一の文字列が何度も現れる
   * ——**再訪する述語**である。存在の待機はその 1 本目（あるいは遡って過去の 1 本）で解けるため、
   * 2 本打った pong の 2 本目を待てず、待機が主張より弱くなる。通算本数は単調に増えるので遡りが
   * 取り違えを生まず、かつ主張（pong が 2 本）と待機（pong が 2 本に達する）が同じ言葉で書ける。
   */
  waitForFrame(
    predicate: (frame: string) => boolean,
    count?: number,
    timeoutMs?: number,
  ): Promise<string>;
  /** 生フレームをそのまま送る（心拍は素の文字列、ClientMessage は JSON 文字列）。 */
  send(frame: string): void;
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

/** WS を張り、client 端を accept して生フレームを収集する（accept より前にリスナを張り取りこぼしを防ぐ）。 */
async function connect(stub: DurableObjectStub<StoreTimerDO>): Promise<WsProbe> {
  const upgrade = await stub.fetch("https://do.invalid/s/store/ws", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgrade.webSocket;
  if (ws === null) throw new Error(`WS 接続が確立されなかった（status=${upgrade.status}）`);

  const frames: string[] = [];
  const waiters: {
    readonly predicate: (frame: string) => boolean;
    readonly count: number;
    readonly resolve: (frame: string) => void;
  }[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    // 心拍は素の文字列で届く。ArrayBuffer は本経路に現れないが、来ても列を汚さないよう弾く。
    if (typeof event.data !== "string") return;
    const frame = event.data;
    frames.push(frame);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || !waiter.predicate(frame)) continue;
      // 今届いた 1 本で通算が閾値に達したなら、この frame がちょうど count 本目である。
      if (frames.filter(waiter.predicate).length < waiter.count) continue;
      waiter.resolve(frame);
      waiters.splice(index, 1);
    }
  });
  ws.accept();

  return {
    frames,
    waitForFrame(predicate, count = 1, timeoutMs = 5_000) {
      const already = frames.filter(predicate)[count - 1];
      if (already !== undefined) return Promise.resolve(already);
      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("フレームの待機がタイムアウトした")),
          timeoutMs,
        );
        waiters.push({
          predicate,
          count,
          resolve: (frame) => {
            clearTimeout(timeout);
            resolve(frame);
          },
        });
      });
    },
    send: (frame: string) => ws.send(frame),
    close: () => ws.close(),
  };
}

/** 生フレーム列のうち JSON として読めるものを ServerMessage として取り出す（pong は JSON ではないので落ちる）。 */
function serverMessages(probe: WsProbe): readonly ServerMessage[] {
  const parsed: ServerMessage[] = [];
  for (const frame of probe.frames) {
    if (!frame.startsWith("{")) continue;
    parsed.push(JSON.parse(frame) as ServerMessage);
  }
  return parsed;
}

/** 接続確立時の一方向配信（config → snapshot）を受け取り切る。以後の列を心拍と対照だけに純化するため。 */
async function drainHydration(probe: WsProbe): Promise<void> {
  await probe.waitForFrame((frame) => frame.includes('"type":"config"'));
  await probe.waitForFrame((frame) => frame.includes('"type":"snapshot"'));
}

/**
 * `webSocketMessage` の起動を数える監視をインスタンスへ被せる（要件1.5 の観測手段）。
 *
 * 呼び出しを潰さず元のハンドラへ委譲するのは、対照（`start`）が従来どおり確定・broadcast まで
 * 進むことを同じ筋で見せる必要があるためである。観測のために振る舞いを変えたら、観測した対象が
 * 本番の経路でなくなる。
 */
async function watchMessageSeam(stub: DurableObjectStub<StoreTimerDO>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const watched = instance as WatchedInstance;
    const arrived: string[] = [];
    watched[ARRIVED_AT_SEAM] = arrived;
    const original = instance.webSocketMessage.bind(instance);
    watched.webSocketMessage = async (
      socket: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> => {
      arrived.push(typeof message === "string" ? message : "<binary>");
      await original(socket, message);
    };
  });
}

/** 監視が記録した到着列を読む。live な配列を跨って渡さないため、複製を返す。 */
async function arrivedAtMessageSeam(
  stub: DurableObjectStub<StoreTimerDO>,
): Promise<readonly string[]> {
  return runInDurableObject(stub, (instance) => {
    const arrived = (instance as WatchedInstance)[ARRIVED_AT_SEAM];
    if (arrived === undefined) throw new Error("監視が被せられていない（対照が成立しない）");
    return [...arrived];
  });
}

/** 登録されている auto-response のペアをランタイムから読む（静的検査ではなく実効値の観測）。 */
async function registeredHeartbeatPair(
  stub: DurableObjectStub<StoreTimerDO>,
): Promise<{ readonly request: string; readonly response: string } | null> {
  return runInDurableObject(stub, (_instance, state) => {
    const pair = state.getWebSocketAutoResponse();
    if (pair === null) return null;
    return { request: pair.request, response: pair.response };
  });
}

/**
 * 収容中の全 WS について、auto-response が最後に応答した時刻を読む（null は未応答）。
 *
 * Date そのものを跨って渡さず epoch millis へ落とす。比較したいのは「応答があったか」と
 * 「その後変わっていないか」だけで、Date のインスタンス同一性ではない。
 */
async function autoResponseTimestamps(
  stub: DurableObjectStub<StoreTimerDO>,
): Promise<readonly (number | null)[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.getWebSockets().map((socket) => {
      const at = state.getWebSocketAutoResponseTimestamp(socket);
      return at === null ? null : at.getTime();
    }),
  );
}

/** 収容中の WS 本数（接続管理の正は ctx.getWebSockets() ゆえ、ここが唯一の照合先である）。 */
async function acceptedSocketCount(stub: DurableObjectStub<StoreTimerDO>): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => state.getWebSockets().length);
}

/** 永続 snapshot を読む（永続層が SSOT ゆえ、心拍が状態を汚していないかの照合先はここだけである）。 */
async function readPersistedSnapshot(
  stub: DurableObjectStub<StoreTimerDO>,
): Promise<StoreSnapshot | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
  );
}

/** 心拍の応答フレームか（待機の述語と件数の数え上げで同じ判定を使い、二重定義を避ける）。 */
function isPong(frame: string): boolean {
  return frame === PONG_RESPONSE;
}

/** 猶予を置く（非発火は「一定時間待って記録が増えない」ことでしか観測できない）。 */
function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `start` の ClientMessage（対照に用いる正当なワイヤ形式・既存形式のみを使う）。 */
const START_FRAME = JSON.stringify({
  type: "start",
  slotIds: [SLOT],
  noodleType: NOODLE,
  boilSeconds: BOIL_SECONDS,
});

// 店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除して独立させる。
afterEach(async () => {
  await reset();
});

describe("auto-response の登録がランタイムへ効く（Requirements 1.1）", () => {
  it("収容後の DO には心拍ペアがちょうど 1 組登録され、その値は client と共有する確定値そのものである", async () => {
    const stub = await provision(freshStoreId("heartbeat-pair"));
    const probe = await connect(stub);
    await drainHydration(probe);

    // 静的検査はソーステキストの引数が `PING_REQUEST, PONG_RESPONSE` であることしか見ない。ここでは
    // ランタイムが実際に保持している登録内容を読み、心拍の確定値（transport/heartbeat.ts）と突き合わせる。
    const pair = await registeredHeartbeatPair(stub);
    expect(pair).toEqual({ request: PING_REQUEST, response: PONG_RESPONSE });

    probe.close();
  });
});

describe("心拍は webSocketMessage を起動せずランタイムが応答する（Requirements 1.5）", () => {
  it("ping には pong が返るが継ぎ目に到着が記録されず、対照の start だけがちょうど 1 件記録される", async () => {
    const stub = await provision(freshStoreId("heartbeat-no-wake"));
    const probe = await connect(stub);
    await drainHydration(probe);

    // 応答前は未応答（null）。この初期値があるからこそ、後の Date への変化が「応答が起きた」ことを示す。
    expect(await autoResponseTimestamps(stub)).toEqual([null]);

    await watchMessageSeam(stub);

    // (1) 心拍を 1 発打つ。返るのは素の pong 文字列で、ServerMessage ではない。
    probe.send(PING_REQUEST);
    const pong = await probe.waitForFrame(isPong);
    expect(pong).toBe(PONG_RESPONSE);

    // (2) 否定的観測 — 継ぎ目に何も到着していない。猶予を置いてから読むのは、非発火が「待っても
    //     増えない」ことでしか観測できないためである。
    await idle(200);
    expect(await arrivedAtMessageSeam(stub)).toEqual([]);

    // (3) 肯定的観測 — 応答したのはランタイムである。auto-response の打刻が null から実時刻へ変わる。
    //     継ぎ目を通らずに pong が返った事実は、この 2 つの観測の組み合わせでのみ立つ。
    const afterPing = await autoResponseTimestamps(stub);
    expect(afterPing).toHaveLength(1);
    expect(afterPing[0]).toBeTypeOf("number");

    // (4) 対照 — 正当な ClientMessage は継ぎ目を通る。これが無いと (2) の「0 件」は監視が死んでいても
    //     成立してしまう。start は確定変化を生み snapshot が broadcast されるので、そこまで見て
    //     経路が本番どおり働いていることも同時に押さえる。
    probe.send(START_FRAME);
    await probe.waitForFrame(
      (frame) => frame.includes('"type":"snapshot"') && frame.includes(NOODLE),
    );
    expect(await arrivedAtMessageSeam(stub)).toEqual([START_FRAME]);

    // (5) 通常メッセージは auto-response 経路を通らない——打刻は心拍のときのまま動かない。
    expect(await autoResponseTimestamps(stub)).toEqual(afterPing);

    probe.close();
  });
});

describe("auto-response を登録しても既存の WS 経路は生きている（Requirements 12.3）", () => {
  it("複数端末から心拍を重ねても SSOT は無書き込みのまま保たれ、start の確定と fanout・収容本数は従来どおりである", async () => {
    const stub = await provision(freshStoreId("heartbeat-coexist"));
    const first = await connect(stub);
    const second = await connect(stub);
    await drainHydration(first);
    await drainHydration(second);

    // 心拍が状態を作らないことを言うには、まず「まだ何も書かれていない」起点が要る。プロビジョニング
    // 直後の DO は Timer を持たず、fetch も hydration も Persist を生まないため SSOT のキーは未書き込み。
    expect(await readPersistedSnapshot(stub)).toBeUndefined();

    await watchMessageSeam(stub);

    // 心拍を重ねる（同一端末から連続・別端末からも）。打った本数ぶんの pong が揃うまで待つことで、
    // 以降の観測が「まだ届いていないだけ」ではないことを担保する。1 本目の到着で先へ進むと、
    // 否定的観測は「まだ応答が済んでいないだけ」を無書き込みと読み違える。
    first.send(PING_REQUEST);
    first.send(PING_REQUEST);
    second.send(PING_REQUEST);
    await first.waitForFrame(isPong, 2);
    await second.waitForFrame(isPong, 1);
    await idle(200);

    // 心拍は SSOT に一切書かない（Working_Copy も永続も動かない）。継ぎ目にも何も到着していない。
    expect(await readPersistedSnapshot(stub)).toBeUndefined();
    expect(await arrivedAtMessageSeam(stub)).toEqual([]);
    // 心拍は収容も増やさない。接続管理の正は ctx.getWebSockets() であり、心拍はそこに現れない。
    expect(await acceptedSocketCount(stub)).toBe(2);

    // 対照 — 心拍を挟んだ後でも既存経路は従来どおり: start が永続を確定させ、両端末へ broadcast される。
    first.send(START_FRAME);
    const [firstView, secondView] = await Promise.all([
      first.waitForFrame((frame) => frame.includes('"type":"snapshot"') && frame.includes(NOODLE)),
      second.waitForFrame((frame) => frame.includes('"type":"snapshot"') && frame.includes(NOODLE)),
    ]);
    // 単一 payload の broadcast ゆえ、両端末が受けるフレームは丸ごと一致する。
    expect(secondView).toBe(firstView);

    const persisted = await readPersistedSnapshot(stub);
    expect(persisted?.timers).toHaveLength(1);
    expect(persisted?.timers[0]?.noodleType).toBe(NOODLE);

    // 心拍が混ざらないことを、確定後にもう一度見る（列に入るのは対照の start ちょうど 1 件だけ）。
    expect(await arrivedAtMessageSeam(stub)).toEqual([START_FRAME]);
    // 心拍は ServerMessage の列に一切混ざらない（ワイヤ形式に手を加えていない・要件12.2）。到着した
    // ServerMessage は hydration の config → snapshot と、start 確定の snapshot ちょうど 3 通で、
    // 残りは打った本数ぶんの pong だけである——生フレーム総数がこの内訳で綺麗に割り切れる。
    const pongFrames = first.frames.filter(isPong);
    expect(pongFrames).toHaveLength(2);
    expect(second.frames.filter(isPong)).toHaveLength(1);
    expect(serverMessages(first).map((message) => message.type)).toEqual([
      "config",
      "snapshot",
      "snapshot",
    ]);
    expect(serverMessages(first)).toHaveLength(first.frames.length - pongFrames.length);

    first.close();
    second.close();
  });
});
