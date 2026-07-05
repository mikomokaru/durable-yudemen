// tests/shell/unprovisioned.integration.test.ts — 未プロビジョニング拒否の書き込みゼロ統合テスト（Workers pool）。
//
// _Validates: Requirements 2.6_
//
// 検証する不変：未プロビジョニングの storeId（投影が一度も押し込まれていない store DO）への
// `/s/{storeId}/ws` 接続要求は拒否され（101 Switching Protocols にならない・403）、その拒否の過程で
// 店舗 DO のストレージへ一切書き込まれない。書き込みゼロの DO は消滅し痕跡を残さない——ゆえに
// storage.list() は空である（要件2.6・design-philosophy「真」「書き込みゼロの DO」）。
//
// なぜ storage が空か：この store DO は一度も applyProjection を受けておらず、fetch は
// ensureProvisioned（storage.get のみ）で未プロビジョニングを検出し、WebSocketPair 生成・
// acceptWebSocket より前に 403 を返す（store-timer-do.ts の未プロビジョニング拒否）。書き込み経路は
// 判定より後にしか現れない。加えて constructor の blockConcurrencyWhile 内 reconcile も、空状態では
// settle が no-op で Effect 空を返し Persist（put）が立たない（task 4.3 が確認済み）。ゆえに拒否された
// 接続の後、store DO の storage には何のキーも残らない。
//
// ハーネス規約は registry-converge.integration.test.ts に倣う（cloudflare:test の env / runInDurableObject /
// reset、実 workerd 上の実 DO・実 storage）。観測する結末は「拒否 + 痕跡ゼロ」という要件2.6 の観測可能な帰結。

import { describe, it, expect, afterEach } from "vitest";
import { env, runInDurableObject, reset } from "cloudflare:test";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** 一意の（かつ isValidStoreId を満たす）storeId を run ごとに採番する。DO 状態の持ち越しを防ぐ。 */
let storeSeq = 0;
function freshStoreId(): string {
  storeSeq += 1;
  // [a-z0-9-] のみ・長さ 1..64（要件1.2）を満たす。crypto.randomUUID は [0-9a-f-] ゆえ許容集合に収まる。
  return `unprovisioned-${storeSeq}-${crypto.randomUUID()}`;
}

describe("未プロビジョニング拒否は書き込みゼロ（Requirements 2.6）", () => {
  // store DO は storage を跨いで残るため、各テスト後に永続を掃除する。
  afterEach(async () => {
    await reset();
  });

  it("未プロビジョニング storeId への WS Upgrade は 403 で拒否され、storage に痕跡が残らない", async () => {
    const storeId = freshStoreId();
    const id = env.STORE_TIMER_DO.idFromName(storeId);
    const stub = env.STORE_TIMER_DO.get(id);

    // WS Upgrade 要求を送る。未プロビジョニングの DO は WebSocketPair 生成前に拒否する。
    const response = await stub.fetch("https://do/s/" + storeId + "/ws", {
      headers: { Upgrade: "websocket" },
    });

    // 拒否である（101 Switching Protocols ではない）。未プロビジョニングは 403 "Not provisioned"。
    expect(response.status).not.toBe(101);
    expect(response.status).toBe(403);
    // WebSocket は確立していない（拒否レスポンスに webSocket は載らない）。
    expect(response.webSocket ?? null).toBeNull();

    // 書き込みゼロ：拒否された接続の後、store DO の storage には何のキーも残らない。
    // 一度も put されていない DO は痕跡を残さない（要件2.6）。storage.list() は空 Map を返す。
    await runInDurableObject(stub, async (_instance, state) => {
      const keys = await state.storage.list();
      expect(keys.size).toBe(0);
    });
  });
});
