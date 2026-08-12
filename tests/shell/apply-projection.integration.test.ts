// tests/shell/apply-projection.integration.test.ts — applyProjection の永続・再配信・version エコー・
// 単調ガードの統合テスト（Workers pool）。
//
// _Validates: Requirements 5.2, 5.9_
//
// 本テストは @cloudflare/vitest-pool-workers（cloudflareTest）で実 StoreTimerDO を workerd 上に駆動し、
// レジストリ → 店舗 DO の投影押し込み（applyProjection）の観測可能な帰結を、実 WS 接続込みで確かめる。
// 純粋判定（到着順非依存の単調ガード）は Property 22（apply-projection.property.test.ts）が固めるため、
// ここでは「実 DO・実 WS 上の配線」——永続・接続中クライアントへの config 再配信・version エコー・
// 到着順逆転時の状態不変——を統合の面で押さえる。
//
// 検証する筋（要件5.2 / 5.9）:
//   1. 投影を押し込むと (a) 投影が projection キーへ永続され、(b) config が接続中クライアントへ config
//      ServerMessage で再配信され（unitCount / noodlePresets が新投影を反映）、(c) 受領 version がエコーされる。
//   2. 次いで永続済みより小さい version を押し込むと、状態は変わらず（永続投影は高い version のまま）、
//      エコーは永続済み（高い）version を返す（単調ガード＝last-write-wins が店舗 DO 側で完結する）。
//
// WS は実接続で観測する：stub.fetch(Upgrade) の 101 応答から得た client 端（response.webSocket）を accept し、
// message を集める。config 再配信は store-timer-do.ts の既存 broadcast 経路（getWebSockets へ send）を継承する。
// roster は投影の一部として永続するが ServerMessage には決して載らない（要件5.3）ため、受信メッセージに
// roster フィールドが一切現れないことも併せて確かめる（構造で漏洩不能・SSOT / Roster never on wire）。

import { afterEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** 投影の永続キー。store-timer-do.ts の PROJECTION_KEY（private 定数）と一致させる。 */
const PROJECTION_KEY = "projection";

/** ワイヤ上の ServerMessage を読むための緩い形（type 判別＋任意フィールドの参照）。 */
type WireMessage = { readonly type: string; readonly [key: string]: unknown };

/** StoreTimerDO の型付き RPC（applyProjection）と fetch を呼べる形でスタブを得る。 */
function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  // STORE_TIMER_DO は型生成上まだ素の DurableObjectNamespace ゆえ、RPC メソッドを呼ぶために class 型へ絞り込む。
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

/** 値域内の完全な StoreConfig を作る（unitCount / noodlePresets を変えて再配信を判別可能にする）。 */
function config(unitCount: number, noodleType: string): StoreConfig {
  return {
    unitCount,
    arms: 3,
    toleranceRatio: 10,
    noodlePresets: [
      { noodleType, boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
    ] as NonEmptyArray<NoodlePreset>,
    ...schedulingDefaults(unitCount),
  };
}

/** 投影を作る。roster は内部値（ワイヤに出ない）として同梱する。 */
function projection(version: number, cfg: StoreConfig): StoreProjection {
  return { config: cfg, roster: ["ops@example.com", "sv@example.com"], active: true, version };
}

/** 接続中クライアントの受信を観測するハンドル。received は到着順の全メッセージ、waitFor は条件一致を待つ。 */
interface ClientProbe {
  readonly received: readonly WireMessage[];
  waitFor(predicate: (message: WireMessage) => boolean, timeoutMs?: number): Promise<WireMessage>;
}

/** client 端の WebSocket を accept し、受信メッセージを収集する。既受信にも遡って waitFor を満たせる。 */
function probe(ws: WebSocket): ClientProbe {
  const received: WireMessage[] = [];
  const waiters: { predicate: (m: WireMessage) => boolean; resolve: (m: WireMessage) => void }[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as WireMessage;
    received.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter !== undefined && waiter.predicate(message)) {
        waiter.resolve(message);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    received,
    waitFor(predicate, timeoutMs = 2000) {
      const already = received.find(predicate);
      if (already !== undefined) return Promise.resolve(already);
      return new Promise<WireMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
  };
}

describe("shell/applyProjection — 永続・config 再配信・version エコー・単調ガード（Requirements 5.2, 5.9）", () => {
  // 店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除する。
  afterEach(async () => {
    await reset();
  });

  it("押し込みで永続・config 再配信・version エコーし、次いで小さい version は状態を変えず永続 version を返す", async () => {
    const storeId = `apply-projection-integration-${crypto.randomUUID()}`;
    const stub = storeStub(storeId);

    // ── 前提: 初期投影で materialize（version 10・unitCount 2）。接続前ゆえ再配信は無い。──
    const initial = projection(10, config(2, "thin"));
    const echoInitial = await stub.applyProjection(initial);
    expect(echoInitial.version).toBe(10);

    // ── WS 接続（provisioned ゆえ 101・合鍵 URL の帰結）。client 端を accept して受信を観測する。──
    const upgrade = await stub.fetch("https://do.invalid/s/store/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(upgrade.status).toBe(101);
    const clientWs = upgrade.webSocket;
    expect(clientWs).not.toBeNull();
    const client = probe(clientWs!);

    // 接続時の一方向配信で初期 config（unitCount 2）を受ける（snapshot より先に届く）。
    await client.waitFor((m) => m.type === "config" && m.unitCount === 2);

    // ── 1. 新しい投影（version 20・unitCount 4・別 preset）を押し込む ──
    const next = projection(20, config(4, "wide"));
    const echoNext = await stub.applyProjection(next);

    // (c) 受領 version をエコーする（要件5.9）。
    expect(echoNext.version).toBe(20);

    // (b) 接続中クライアントが新 config を受領する（unitCount / noodlePresets が新投影を反映・要件5.2）。
    const reConfig = await client.waitFor((m) => m.type === "config" && m.unitCount === 4);
    expect(reConfig.noodlePresets).toEqual(next.config.noodlePresets);

    // (a) 投影が永続される（config + roster + active + version が丸ごと projection キーへ）。
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = (await state.storage.get(PROJECTION_KEY)) as StoreProjection | undefined;
      expect(stored).toEqual(next);
    });

    // ── 2. 小さい version（5）の押し込み — 単調ガードで退ける（要件5.4 / 5.9）──
    const stale = projection(5, config(3, "narrow"));
    const echoStale = await stub.applyProjection(stale);

    // エコーは永続済み（高い）version を返す（受領 version ではない）。
    expect(echoStale.version).toBe(20);

    // 状態不変（永続投影は version 20 のまま・stale の config は適用されていない）。
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = (await state.storage.get(PROJECTION_KEY)) as StoreProjection | undefined;
      expect(stored).toEqual(next);
    });

    // ── Roster はワイヤに載らない（要件5.3）。受信した全メッセージに roster フィールドが無い。──
    for (const message of client.received) {
      expect(message).not.toHaveProperty("roster");
    }
  });
});
