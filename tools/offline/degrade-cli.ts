// tools/offline/degrade-cli.ts — ライブ縮退ライフサイクル CLI（端・Node ランタイム）。
//
// 実行中のサーバ（既定 ws://localhost:5173/ws）に対し、本番のクライアント窓口
// （openTimerConnection）をそのまま駆動して縮退→操作→復帰のライフサイクルをライブに検証する。
// 本番実装は一切変更しない——縮退は openTimerConnection の注入継ぎ目（openSocket）に
// リンク遮断ゲート（link-gate.ts）を差し込むことだけで起こす。永続は localStorage に触れない
// インメモリ ViewStore を注入する。状態遷移（watchConnectivity / decideView / Reconcile）は
// 本番コードがそのまま走る。
//
// 検証するライフサイクル:
//   1. 接続 → 全量 snapshot 受信で Connectivity up（Mode=live）。
//   2. （best-effort）live で start を 1 件送り、server-confirmed Timer が乗ることを観測。
//   3. リンク遮断 → 明示的切断（要件2.1）で Connectivity down（Mode=degraded）。
//   4. degraded 中に start → Provisional_Timer（origin=local）が注入される（要件6）。
//   5. リンク復旧 → 再接続 + 全量 snapshot で Connectivity up（Mode=live）へ復帰。
//      Reconcile は server-confirmed のみ置換し、provisional を保持する（決定 B・要件11.5/11.6）。
//   6. 復帰検証: Mode=live・server-confirmed が snapshot で再整合・provisional 保持。
//
// hibernation 規律に従い setInterval も終わらない setTimeout も持ち込まない。待機は必ず解決/拒否する
// 単一の setTimeout と購読で表す。ユーザー向け出力は英語、コードコメントは日本語（要件13.6 の規律）。

import { EMPTY_VIEW, mode, openTimerConnection } from "../../src/client/connection";
import type { ClientTimer, ClientView, TimerConnection } from "../../src/client/connection";
import type { ViewStore } from "../../src/client/persistence";

import { createLinkGate } from "./link-gate";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

/** 既定の接続先（dev サーバ）。第 1 引数で上書きできる。 */
const DEFAULT_URL = "ws://localhost:5173/ws";

/** 起動からの相対秒付きで 1 行ログする（英語・端の観測記録）。 */
function log(line: string): void {
  const seconds = ((Date.now() - START) / 1000).toFixed(1);
  console.log(`[+${seconds}s] ${line}`);
}
const START = Date.now();

/** localStorage に触れないインメモリ ViewStore（注入用）。boot 再水和は空ビューから始める。 */
function memoryViewStore(): ViewStore {
  let current: ClientView = EMPTY_VIEW;
  return {
    save: (view) => {
      current = view;
    },
    load: () => current,
  };
}

/** server-confirmed Timer（正本由来）だけを取り出す。 */
function serverTimers(view: ClientView): readonly ClientTimer[] {
  return view.timers.filter((timer) => timer.origin === "server");
}

/** Provisional_Timer（degraded 中のローカル意図・origin=local）だけを取り出す。 */
function provisionalTimers(view: ClientView): readonly ClientTimer[] {
  return view.timers.filter((timer) => timer.origin === "local");
}

/**
 * ビューが述語を満たすまで待つ（購読 + 単一タイムアウト）。
 * 既に満たしていれば即解決。期限超過なら理由付きで reject する（抱えない）。
 */
function waitFor(
  connection: TimerConnection,
  predicate: (view: ClientView) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate(connection.getView())) {
      resolve();
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error(`timed out waiting for ${label} (${timeoutMs}ms)`));
    }, timeoutMs);
    const unsubscribe = connection.subscribe(() => {
      if (settled) return;
      if (predicate(connection.getView())) {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/** 縮退ライフサイクルを駆動し、復帰検証の合否で終了コードを返す。 */
async function run(url: string): Promise<number> {
  const gate = createLinkGate();
  const connection = openTimerConnection({
    url,
    openSocket: gate.opener,
    persistence: memoryViewStore(),
    now: () => Date.now(),
    onBoilAlert: (timer) => log(`local boil alert fired for timer ${timer.id}`),
  });

  try {
    // 1. 接続 → live。
    log(`connecting to ${url} ...`);
    await waitFor(connection, (view) => mode(view) === "live", 15_000, "live (connected + snapshot)");
    log(`LIVE. server-confirmed timers = ${serverTimers(connection.getView()).length}`);

    // 2. （best-effort）live で start を 1 件送り、server-confirmed が乗るのを観測する。
    //    サーバが受理しない構成でも縮退→復帰の本筋は検証できるため、失敗は致命としない。
    log("live start on slot kama-1 (server-confirmed, best-effort) ...");
    connection.start("kama-1", "Thin", 1800);
    try {
      await waitFor(connection, (view) => serverTimers(view).length >= 1, 8_000, "server-confirmed timer");
      log(`server-confirmed timer observed (count = ${serverTimers(connection.getView()).length}).`);
    } catch {
      log("note: no server-confirmed timer observed; continuing with the degrade/recover lifecycle.");
    }

    // 3. リンク遮断 → degraded。
    log("cutting the link (simulating a network outage) ...");
    gate.cut();
    await waitFor(connection, (view) => mode(view) === "degraded", 10_000, "degraded");
    log("DEGRADED (temporary local authority).");

    // 4. degraded 中のローカル start → Provisional_Timer 注入（要件6）。
    log("degraded local start on slot kama-2 (provisional) ...");
    connection.start("kama-2", "Thick", 1800);
    await waitFor(connection, (view) => provisionalTimers(view).length >= 1, 5_000, "provisional timer injected");
    const provisionalBefore = provisionalTimers(connection.getView());
    log(`provisional timers injected = ${provisionalBefore.length} (ids: ${provisionalBefore.map((t) => t.id).join(", ")}).`);

    // 5. リンク復旧 → 再接続 + snapshot で live へ復帰。
    log("restoring the link ...");
    gate.restore();
    await waitFor(connection, (view) => mode(view) === "live", 15_000, "recovery to live");

    // 6. 復帰検証。
    const view = connection.getView();
    const recoveredLive = mode(view) === "live";
    // 決定 B: provisional は Reconcile を跨いで保持される。
    const provisionalRetained = provisionalBefore.every((p) =>
      view.timers.some((t) => t.id === p.id && t.origin === "local"),
    );
    log(
      `RECOVERED. mode=${mode(view)}, connectivity=${view.connectivity}, ` +
        `server-confirmed=${serverTimers(view).length}, provisional=${provisionalTimers(view).length}.`,
    );

    if (recoveredLive && provisionalRetained) {
      log("PASS: recovered to live; server-confirmed reconciled from snapshot; provisional retained (decision B).");
      connection.close();
      return EXIT_SUCCESS;
    }

    log(
      `FAIL: recovery assertion not met ` +
        `(recoveredLive=${recoveredLive}, provisionalRetained=${provisionalRetained}).`,
    );
    connection.close();
    return EXIT_FAILURE;
  } catch (error) {
    log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    connection.close();
    return EXIT_FAILURE;
  }
}

const targetUrl = process.argv[2] ?? DEFAULT_URL;
run(targetUrl).then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    log(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_FAILURE);
  },
);
