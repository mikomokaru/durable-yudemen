// client/OrderFlow.tsx — オーダーの流れ（KANBAN）画面のシェル。`/s/{storeId}/flow/` で開く。
//
// 釜のタイマー画面（App の StoreTimer）と同じ接続（openTimerConnection）を自分のマウント中だけ開き、上部バーと
// 盤面（OrderFlowBoard）を組み立てる。担当ユニットは持たない——この画面は店舗全体を俯瞰する。音・ラジアル・
// 開始操作も持たない。持つのは Plating → Done の端末ローカル確認（platingAcks.ts）だけである。
//
// プロトタイプ（2026-09-16）。段階と既存モデルの対応は flowLanes.ts の冒頭を参照。

import { useEffect, useState } from "react";
import { openTimerConnection, timerSocketUrl, type TimerConnection } from "./connection";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { InstallPrompt } from "./components/InstallPrompt";
import { Logo } from "./components/Logo";
import { OrderFlowBoard } from "./components/OrderFlowBoard";
import { OrderFlowRows } from "./components/OrderFlowRows";
import { ScreenSwitch } from "./components/ScreenSwitch";
import { useWakeLock } from "./components/useWakeLock";
import { readPlatingAcks, rememberLastStore, writePlatingAcks } from "./persistence";
import { itemKeyOf, type ItemKey } from "../domain/order";
import { cn } from "./cn";

/**
 * 盤面の向き。既定は横時系列・縦積み（rows・2026-09-17 にユーザー確定）。`?layout=columns` で縦レーン版を見比べられる。
 * URL が正で、状態には持たない。
 */
type Layout = "columns" | "rows";
function layoutFromSearch(search: string): Layout {
  return new URLSearchParams(search).get("layout") === "columns" ? "columns" : "rows";
}

export function OrderFlow({ storeId }: { readonly storeId: string }) {
  useWakeLock();
  const layout = layoutFromSearch(window.location.search);
  const [connection, setConnection] = useState<TimerConnection | null>(null);
  const [acked, setAcked] = useState<ReadonlySet<ItemKey>>(() => readPlatingAcks(storeId));

  useEffect(() => {
    rememberLastStore(storeId);
  }, [storeId]);

  useEffect(() => {
    const conn = openTimerConnection({
      storeId,
      url: timerSocketUrl(storeId),
      onRejected: () => window.location.replace("/"),
    });
    setConnection(conn);
    return () => conn.close();
  }, [storeId]);

  // 確認を足すときに、現在の snapshot に無い品目の鍵を刈る（期限で消えた品目の鍵を溜め続けない）。
  const ack = (key: ItemKey) => {
    const present = new Set(connection?.getView().orderItems.map(itemKeyOf) ?? []);
    const next = new Set([...acked].filter((known) => present.has(known)));
    next.add(key);
    setAcked(next);
    writePlatingAcks(storeId, next);
  };

  return (
    <div className="flex h-[100dvh] flex-col">
      <header
        className={cn(
          "relative z-30 flex flex-none items-center gap-4 border-b border-line",
          "h-[calc(clamp(3.25rem,7.5vh,4.125rem)+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]",
          "bg-[color-mix(in_oklab,var(--color-panel)_92%,black)] px-[clamp(0.75rem,2.4vw,1.625rem)]",
        )}
      >
        <h1 className="m-0 text-[clamp(1rem,2.4vw,1.375rem)] leading-none">
          <Logo />
        </h1>
        <span
          className="font-mono text-xs text-muted"
          aria-label={`Store ${storeId}`}
          title={storeId}
        >
          {storeId}
        </span>
        <div className="flex-1" />
        {/* 画面の切替。タイマー画面と同じ位置（上部バーの中央）に固定する。 */}
        <div className="absolute left-1/2 -translate-x-1/2">
          <ScreenSwitch storeId={storeId} current="orders" />
        </div>
        {connection && <ConnectionStatus connection={connection} />}
        {/* 盤面の向きの切替。既定は Rows。縦レーン版（Columns）は比較のために残す。 */}
        <nav
          aria-label="Layout"
          className="inline-flex items-center gap-1 rounded-[0.6875rem] border border-line bg-panel2 p-1"
        >
          {(["rows", "columns"] as const).map((candidate) => (
            <a
              key={candidate}
              href={candidate === "columns" ? "?layout=columns" : "?"}
              aria-current={layout === candidate ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center rounded-[0.5rem] px-3 text-xs font-bold no-underline",
                layout === candidate ? "bg-panel text-ink" : "text-muted hover:text-ink",
              )}
            >
              {candidate === "rows" ? "Rows" : "Columns"}
            </a>
          ))}
        </nav>
      </header>
      <main
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-[clamp(0.5rem,1.2vh,0.875rem)]",
          "pt-[clamp(0.5rem,1.4vw,1rem)]",
          "pl-[calc(clamp(0.5rem,1.4vw,1rem)+env(safe-area-inset-left))]",
          "pr-[calc(clamp(0.5rem,1.4vw,1rem)+env(safe-area-inset-right))]",
          "pb-[calc(clamp(0.5rem,1.4vw,1rem)+env(safe-area-inset-bottom))]",
        )}
        aria-label="Order flow"
      >
        {connection ? (
          layout === "rows" ? (
            <OrderFlowRows
              connection={connection}
              acked={acked}
              onAck={ack}
              onAssignTable={connection.assignTable}
            />
          ) : (
            <OrderFlowBoard
              connection={connection}
              acked={acked}
              onAck={ack}
              onAssignTable={connection.assignTable}
            />
          )
        ) : (
          <p role="status" className="text-muted">
            Connecting…
          </p>
        )}
      </main>
      <InstallPrompt />
    </div>
  );
}
