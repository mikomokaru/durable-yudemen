// tests/shell/deactivation.integration.test.ts — 非活性化時の接続閉鎖の統合テスト（Workers pool）。
//
// _Validates: Requirements 6.6_
//
// 検証する不変（要件6.6・design.md Component 8）：保持する投影が active=false（deactivated）を示すとき、
//   (a) 接続中の WebSocket は閉じられる（close code 4403・DEACTIVATED_CLOSE_CODE を映す），
//   (b) 新規接続は拒否される（HTTP 403 "Store deactivated"），
//   (c) タイマー状態（activeTimers）・投影（projection）・Alarm は保持され、物理削除（deleteAll）は起きない
//       （非活性 DO は消さず残す・要件9.6）。
//
// これらを workerd 上の実 StoreTimerDO・実 storage・実 WebSocket で確かめる。DO の fetch（WS Upgrade）で
// 接続を張り（response.webSocket → accept）、applyProjection(active=false) の押し込みで既存 WS が
// close イベントを受けることを見る。閉鎖と拒否の作用は applyProjection と fetch に分かれて宿るため
// （applyProjection が既存 WS を閉じ、fetch が新規接続を拒否する）、両経路を一つのシナリオで通す。

import { env, runInDurableObject, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { ServerMessage } from "../../src/domain/messages";
import type { StoreConfig } from "../../src/domain/store";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import type { StoreSnapshot } from "../../src/engine/snapshot";
import { schedulingDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** 投影の永続キー。store-timer-do.ts の PROJECTION_KEY（private 定数）と一致させる。 */
const PROJECTION_KEY = "projection";

/** タイマー SSOT の永続キー。store-timer-do.ts の SNAPSHOT_KEY（private 定数）と一致させる。 */
const SNAPSHOT_KEY = "activeTimers";

/**
 * 非活性化で WS を閉じるときの close code。store-timer-do.ts の DEACTIVATED_CLOSE_CODE（private 定数）と
 * 一致させる。4000〜4999 は WebSocket 仕様がアプリ専用に予約する私的レンジで、そのまま client の
 * close.code へ透過する（web_socket_auto_reply_to_close 既定・compatibility_date 2026-06-26）。
 */
const DEACTIVATED_CLOSE_CODE = 4403;

/** 値域内の完全な StoreConfig（投影の config 層）。start の noodleType 照合には依らないが現実に倣い健全な値を置く。 */
const CONFIG: StoreConfig = {
  unitCount: 3,
  arms: 2,
  toleranceRatio: 10,
  noodlePresets: DEFAULT_NOODLE_PRESETS,
  ...schedulingDefaults(3),
};

/** 活性/非活性・version を差し替えて投影を組む。roster はワイヤに出ない内部値ゆえ空でよい。 */
function projection(active: boolean, version: number): StoreProjection {
  return { config: CONFIG, roster: [], active, version };
}

/** 一意の storeId を採番する（DO 状態の持ち越しを防ぎ各テストを独立させる）。 */
let storeSeq = 0;
function freshStoreId(): string {
  storeSeq += 1;
  return `deactivation-${storeSeq}-${crypto.randomUUID()}`;
}

/**
 * WS 接続の受信箱。client 側 WebSocket に張り付き、届いた ServerMessage を貯めつつ、
 * 特定メッセージ・close イベントを待てるようにする。accept 直後に届く config / snapshot を取りこぼさない
 * よう、message を配列に貯めて waitFor がまず既着分を検査する。
 */
interface Inbox {
  /** これまでに受信した全 ServerMessage（到着順）。 */
  readonly messages: readonly ServerMessage[];
  /** 述語に一致する ServerMessage を待つ（既着なら即解決・timeout で reject）。 */
  waitFor(predicate: (message: ServerMessage) => boolean, label: string): Promise<ServerMessage>;
  /** close イベント（code / reason）を待つ。 */
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
}

/** client 側 WebSocket に受信箱を張る。accept は呼び出し側が済ませてから渡す。 */
function attachInbox(ws: WebSocket): Inbox {
  const messages: ServerMessage[] = [];
  const waiters: { predicate: (m: ServerMessage) => boolean; settle: (m: ServerMessage) => void }[] = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    messages.push(message);
    // 一致する待ち手を解決して除去する（後ろから走査し splice を安全にする）。
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter !== undefined && waiter.predicate(message)) {
        waiter.settle(message);
        waiters.splice(i, 1);
      }
    }
  });

  let resolveClose: (value: { code: number; reason: string }) => void = () => {};
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClose = resolve;
  });
  ws.addEventListener("close", (event) => {
    resolveClose({ code: event.code, reason: event.reason });
  });

  return {
    messages,
    waitFor(predicate, label) {
      const existing = messages.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`waitFor timeout: ${label}`)), 2000);
        waiters.push({
          predicate,
          settle: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    closed,
  };
}

/** DO スタブへ WS Upgrade の fetch を投げる（DO の fetch は Upgrade ヘッダのみを見るため path は任意）。 */
function upgrade(stub: DurableObjectStub<StoreTimerDO>): Promise<Response> {
  return stub.fetch("https://store/s/x/ws", { headers: { Upgrade: "websocket" } });
}

describe("非活性化（deactivated）時の接続閉鎖と拒否・状態保持（Requirements 6.6）", () => {
  // シングルトンではないが id 固定で駆動するため、各テスト後に永続を掃除して独立させる。
  afterEach(async () => {
    await reset();
  });

  it("active=false 受領で既存 WS が 4403 で閉じ、新規接続は 403、タイマー状態・投影・Alarm は保持される", async () => {
    const storeId = freshStoreId();
    const stub = env.STORE_TIMER_DO.get(
      env.STORE_TIMER_DO.idFromName(storeId),
    ) as DurableObjectStub<StoreTimerDO>;

    // ── 1. 活性投影でプロビジョニング（applyProjection active:true, version:1）──
    // 接続前に押し込むため WS への再配信は無い（getWebSockets 空）。以後 fetch は provisioned & active として受理する。
    const provisioned = await runInDurableObject(stub, (instance) =>
      instance.applyProjection(projection(true, 1)),
    );
    expect(provisioned.version).toBe(1);

    // ── 2. WS 接続（成功 → 101・config・snapshot）──
    const openRes = await upgrade(stub);
    expect(openRes.status).toBe(101);
    expect(openRes.webSocket).toBeDefined();
    const ws = openRes.webSocket!;
    ws.accept();
    const inbox = attachInbox(ws);

    // 接続確立時、サーバは config を先に、続いて現在の Timer 全量の snapshot を送る（store-timer-do.ts の fetch）。
    const config = await inbox.waitFor((m) => m.type === "config", "初期 config");
    expect(config.type).toBe("config");
    const initialSnapshot = await inbox.waitFor((m) => m.type === "snapshot", "初期 snapshot");
    // 接続直後は Timer 未登録ゆえ空。
    expect(initialSnapshot.type === "snapshot" && initialSnapshot.timers.length).toBe(0);

    // ── タイマーを 1 本開始し、保持されるべき状態を実際に作る（要件6.6 の「タイマー状態は保持」を意味あるものにする）──
    ws.send(
      JSON.stringify({ type: "start", slotIds: ["0"], noodleType: "Thin", boilSeconds: 300 }),
    );
    // 開始の確定は全量 snapshot（Timer 1 本）として broadcast される。これで activeTimers が永続された証左になる。
    await inbox.waitFor(
      (m) => m.type === "snapshot" && m.timers.length === 1,
      "開始後の snapshot（Timer 1 本）",
    );

    // ── 3. 非活性投影を押し込む（applyProjection active:false, version:2）──
    // close イベントの待受は押し込み前に張っておく（attachInbox が既に close リスナを持つ）。
    const deactivated = await runInDurableObject(stub, (instance) =>
      instance.applyProjection(projection(false, 2)),
    );
    expect(deactivated.version).toBe(2);

    // ── 既存 WS は 4403（DEACTIVATED_CLOSE_CODE）で閉じられる（要件6.6）──
    const close = await inbox.closed;
    expect(close.code).toBe(DEACTIVATED_CLOSE_CODE);

    // ── 4. 新規接続は拒否される（HTTP 403）──
    const rejectedRes = await upgrade(stub);
    expect(rejectedRes.status).toBe(403);
    expect(await rejectedRes.text()).toBe("Store deactivated");

    // ── 5. タイマー状態・投影・Alarm は保持され、物理削除は起きていない（要件6.6 / 9.6）──
    await runInDurableObject(stub, async (_instance, state) => {
      // 投影は残り、active=false・version=2 が確定している（非活性の事実は消さず保持する）。
      const storedProjection = (await state.storage.get(PROJECTION_KEY)) as StoreProjection | undefined;
      expect(storedProjection).toBeDefined();
      expect(storedProjection!.active).toBe(false);
      expect(storedProjection!.version).toBe(2);

      // タイマー SSOT は保持される（deleteAll していない）。開始した 1 本が残る。
      const snapshot = (await state.storage.get(SNAPSHOT_KEY)) as StoreSnapshot | undefined;
      expect(snapshot).toBeDefined();
      expect(snapshot!.timers.length).toBe(1);

      // 開始で張られた Alarm も残る（非活性化は Alarm を消さない＝時間管理は投影の活性と独立）。
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});
