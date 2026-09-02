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

/**
 * ステータスの色調。dot とピルの見た目を切り替えるためだけの導出タグ。
 * denied は「待てば直る」offline とは別軸——別店舗を開く／再ログインという現場の行動を促す確定的状態（要件15.10 / 15.11）。
 */
type StatusTone = "live" | "syncing" | "offline" | "denied";

/** 同期フェーズ（sync）と到達性（connectivity 由来の mode）を一つの表示へ合成する純粋導出。 */
function connectionStatus(view: ClientView): { readonly label: string; readonly tone: StatusTone } {
  if (mode(view) === "degraded") {
    // degraded の理由（unreachableReason）で表示を分岐する。到達不能理由は down 時のみ意味を持つ分類結果（要件15.9〜15.11）。
    switch (view.unreachableReason) {
      case "offline":
        return { label: "Offline — running locally", tone: "offline" }; // 既存文言・既存 tone 据え置き（要件15.9）
      case "noAccess":
        return { label: "No access to this store", tone: "denied" }; // 別店舗を開く行動を促す（要件15.10）
      case "signInRequired":
        return { label: "Sign-in required", tone: "denied" }; // 再ログインを促す（要件15.11）
    }
  }
  return { label: SYNC_LABEL[view.sync], tone: view.sync === "synced" ? "live" : "syncing" };
}

/**
 * 階調ごとの dot 色とグロー。live=同期済み / syncing=接続中・再同期中 / offline=degraded（回線喪失）/ denied=権限・認証由来の確定的到達不能。
 * denied は offline と同じ danger 色を使いつつ、やや強いグロー（半径を広げる）で「待っても直らない」区別を付ける（新しい色トークンは足さない）。
 */
const DOT_BY_TONE: Record<StatusTone, string> = {
  live: "bg-boiled shadow-[0_0_0.5rem_var(--color-boiled)]",
  syncing: "bg-running shadow-[0_0_0.5rem_var(--color-running)]",
  offline: "bg-danger shadow-[0_0_0.5rem_var(--color-danger)]",
  denied: "bg-danger shadow-[0_0_0.75rem_var(--color-danger)]",
};

/** 上部バー右側に置く同期インジケータ。view を購読し、合成した表示をピルで示す。 */
export function ConnectionStatus({ connection }: { readonly connection: TimerConnection }) {
  const view = useSyncExternalStore(connection.subscribe, connection.getView);
  const status = connectionStatus(view);
  // offline / denied はいずれも danger 系の枠へ寄せる（degraded の到達不能を同じ枠色で示し、差は dot のグローで付ける）。
  const unreachable = status.tone === "offline" || status.tone === "denied";
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-[0.875rem] py-[0.375rem] text-[0.8125rem] font-bold whitespace-nowrap",
        unreachable ? "border-danger/45 text-ink" : "border-line bg-panel2 text-muted",
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", DOT_BY_TONE[status.tone])} />
      {status.label}
    </span>
  );
}
