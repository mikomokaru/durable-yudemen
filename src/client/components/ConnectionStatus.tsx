// client/components/ConnectionStatus.tsx — 上部バーの同期/到達性インジケータ。
// 接続の外部ストア（view）を購読し、同期フェーズ（sync）と到達性（mode）を一つの表示へ合成する。
// 状態は持たず view から都度導出する（保持は全量・表示は導出）。degraded のときは「ローカル継続中」を
// 最優先で示し、それ以外は同期フェーズを示す。sync の意味は仕様どおり（snapshot 受信で synced）。

import { useSyncExternalStore } from "react";
import type { ClientView, TimerConnection } from "../connection";
import { mode } from "../connection";
import { cn } from "../cn";

/** 同期フェーズを人が読む文へ（UI コンテンツは英語）。 */
const SYNC_LABEL = {
  connecting: "Connecting…",
  synced: "Synced",
  syncFailed: "Sync failed — reconnecting…",
} as const;

/** ステータスの色調。dot とピルの見た目を切り替えるためだけの導出タグ。 */
type StatusTone = "live" | "syncing" | "offline";

/** 同期フェーズ（sync）と到達性（connectivity 由来の mode）を一つの表示へ合成する純粋導出。 */
function connectionStatus(view: ClientView): { readonly label: string; readonly tone: StatusTone } {
  if (mode(view) === "degraded") {
    return { label: "Offline — running locally", tone: "offline" };
  }
  return { label: SYNC_LABEL[view.sync], tone: view.sync === "synced" ? "live" : "syncing" };
}

/** 階調ごとの dot 色とグロー。live=同期済み / syncing=接続中・再同期中 / offline=degraded。 */
const DOT_BY_TONE: Record<StatusTone, string> = {
  live: "bg-boiled shadow-[0_0_0.5rem_var(--color-boiled)]",
  syncing: "bg-running shadow-[0_0_0.5rem_var(--color-running)]",
  offline: "bg-danger shadow-[0_0_0.5rem_var(--color-danger)]",
};

/** 上部バー右側に置く同期インジケータ。view を購読し、合成した表示をピルで示す。 */
export function ConnectionStatus({ connection }: { readonly connection: TimerConnection }) {
  const view = useSyncExternalStore(connection.subscribe, connection.getView);
  const status = connectionStatus(view);
  const offline = status.tone === "offline";
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-[0.875rem] py-[0.375rem] text-[0.8125rem] font-bold",
        offline ? "border-danger/45 text-ink" : "border-line bg-panel2 text-muted",
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", DOT_BY_TONE[status.tone])} />
      {status.label}
    </span>
  );
}
