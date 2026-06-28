// client/App.tsx — 厨房タイマーのルート。接続のライフサイクルと担当ユニットの保持を司る。
//
// 担当ユニットは接続から独立した、ユーザー操作でのみ変わる state として持つ（要件12.4）。
// 接続台数の増減はこの state に一切影響しない——影響しうる配線をそもそも持たないことで担保する。
// 接続は WebSocket という作用の端であり、connection.ts に封じ込めた openTimerConnection を
// マウント中だけ開いて閉じる（StrictMode の再マウントでも開閉が対応するよう effect で扱う）。

import { useEffect, useState } from "react";
import {
  isPingBlackholeActive,
  openTimerConnection,
  pingBlackholeDebugEnabled,
  setPingBlackholeActive,
} from "./connection";
import type { TimerConnection } from "./connection";
import { SlotBoard } from "./components/SlotBoard";
import { UnitSelector } from "./components/UnitSelector";
import { DEFAULT_UNIT_COUNT } from "../domain/store";

/** 同一オリジンの WS エンドポイント。https なら wss、それ以外は ws。 */
function timerSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export function App() {
  // 担当ユニット集合。既定は 1 ユニット（unit 0 = slot 0..5）。ユーザー再指定でのみ更新（要件12.1 / 12.4）。
  const [units, setUnits] = useState<readonly number[]>([0]);
  // 店舗のユニット総数（サーバ権威・config 受信で確定）。接続前は既定値。担当 UI の範囲はこれに従う。
  const [totalUnits, setTotalUnits] = useState<number>(DEFAULT_UNIT_COUNT);
  // 接続はマウント中のみ生存する作用。effect で開閉を対応させる。
  const [connection, setConnection] = useState<TimerConnection | null>(null);

  // dev/test 限定の縮退テストトグルを表示するか。本番では pingBlackholeDebugEnabled() が false を返し、
  // import.meta.env.DEV を先頭ガードに置くことで以下のトグル配線ごと本番バンドルから除外される（要件14.4）。
  const degradationTestable = import.meta.env.DEV && pingBlackholeDebugEnabled();
  // 送信 ping を破棄して擬似的な静かな喪失（half-open）を起こしているか。スイッチの可視ミラー（要件14.3）。
  const [simulatingOffline, setSimulatingOffline] = useState(isPingBlackholeActive());

  useEffect(() => {
    const conn = openTimerConnection({ url: timerSocketUrl() });
    setConnection(conn);
    // 店舗のユニット総数（サーバ権威）をビューから追従する。config 受信のたびに反映される。
    const unsubscribe = conn.subscribe(() => setTotalUnits(conn.getView().unitCount));
    setTotalUnits(conn.getView().unitCount);
    return () => {
      unsubscribe();
      conn.close();
    };
  }, []);

  // 縮退テストの擬似切断を可逆に切り替える。Mode は書き換えず、本物の silent-loss 検知経路を通す（要件14.2/14.3/14.5）。
  function toggleSimulatedOffline(): void {
    const next = !simulatingOffline;
    setPingBlackholeActive(next);
    setSimulatingOffline(next);
  }

  return (
    <main>
      <h1>Yude-men Timer</h1>
      <UnitSelector units={units} totalUnits={totalUnits} onChange={setUnits} />
      {degradationTestable ? (
        <button type="button" aria-pressed={simulatingOffline} onClick={toggleSimulatedOffline}>
          {simulatingOffline ? "Stop simulating offline" : "Simulate offline (dev)"}
        </button>
      ) : null}
      {connection ? (
        <SlotBoard connection={connection} units={units} />
      ) : (
        <p role="status">Connecting…</p>
      )}
    </main>
  );
}
