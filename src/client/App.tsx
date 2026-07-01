// client/App.tsx — 厨房タイマーのルート。接続のライフサイクルと担当ユニットの保持を司り、
// フルスクリーンの外殻（上部固定バー + ボード）を組み立てる。
//
// 担当ユニットは接続から独立した、ユーザー操作でのみ変わる state として持つ（要件12.4）。
// 接続台数の増減はこの state に一切影響しない——影響しうる配線をそもそも持たないことで担保する。
// 接続は WebSocket という作用の端であり、connection.ts に封じ込めた openTimerConnection を
// マウント中だけ開いて閉じる（StrictMode の再マウントでも開閉が対応するよう effect で扱う）。
//
// レイアウトは縦フレックスの .ymt：上部に固定バー（タイトル / 同期インジケータ / 設定）、
// 残り高さをボードが満たし、スロットグリッドが等分充填でスクロールなしに収まる。設定は
// ポップオーバーに集約し、外側クリック / Esc で閉じる。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  EMPTY_VIEW,
  isPingBlackholeActive,
  openTimerConnection,
  pingBlackholeDebugEnabled,
  setPingBlackholeActive,
} from "./connection";
import type { TimerConnection } from "./connection";
import { SlotBoard } from "./components/SlotBoard";
import { UnitSelector } from "./components/UnitSelector";
import { useUnitCount } from "./components/useUnitCount";
import { useWakeLock } from "./components/useWakeLock";
import { useAudioCues } from "./components/useAudioCues";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { InstallPrompt } from "./components/InstallPrompt";
import { Logo } from "./components/Logo";
import { unitsForCount } from "./assignment";
import { DEFAULT_UNIT_COUNT } from "../domain/store";
import { cn } from "./cn";

/** 同一オリジンの WS エンドポイント。https なら wss、それ以外は ws。 */
function timerSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export function App() {
  // 担当窓 (アンカー b, 長さ k)。長さ k は viewport の向きが、アンカー b は UnitSelector が決める。
  // 接続台数の増減では一切変わらない（要件12.4）。向きの変化（=ユーザー操作）で窓を unitsForCount で遷移させる。
  const [units, setUnits] = useState<readonly number[]>([0]);
  // 店舗のユニット総数（サーバ権威・config 受信で確定）。接続前は既定値。担当窓の可行域はこれに従う。
  const [totalUnits, setTotalUnits] = useState<number>(DEFAULT_UNIT_COUNT);
  // viewport の向きが決める表示ユニット数（窓長 k）。縦=1 / 横=2。
  const count = useUnitCount();
  // 厨房 iPad の画面スリープを抑制する（前面で出しっぱなしにする運用のため）。
  useWakeLock();
  // 接続はマウント中のみ生存する作用。effect で開閉を対応させる。
  const [connection, setConnection] = useState<TimerConnection | null>(null);
  // 音声評価のための view 購読（SlotBoard と同じ useSyncExternalStore パターン）。残り秒は状態化しない——
  // 受信・接続状態変化でのみ更新される事実を参照するだけ。接続確立前は EMPTY_VIEW、確立で subscribe 参照が
  // 変わり購読し直す。
  const view = useSyncExternalStore(
    useCallback((onChange: () => void) => (connection ? connection.subscribe(onChange) : () => {}), [connection]),
    useCallback(() => (connection ? connection.getView() : EMPTY_VIEW), [connection]),
  );
  // 画面点灯維持（useWakeLock）の隣に同列でマウントする端の作用。担当ユニット units を音の対象に渡し、
  // Touch_Cue の再生口を受け取って SlotBoard の指定操作へ相乗りさせる。
  const { playTouchCue } = useAudioCues(view, units);
  // 設定ポップオーバーの開閉。上部バーの設定ボタンが切り替える UI 状態。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);

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

  // 向き（窓長 k）または総数の変化で担当窓を遷移させる。unitsForCount がアンカーを可行域へ射影し、
  // 展開/収束/右端クランプを一式で導く（A→AB, C→BC, BC→B など）。回転＝ユーザー操作なので 12.4 と整合。
  useEffect(() => {
    setUnits((prev) => unitsForCount(prev, count, totalUnits));
  }, [count, totalUnits]);

  // 設定ポップオーバー：外側クリック / Esc で閉じる（ボタン自身のクリックはトグルとして扱う）。
  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        popRef.current && !popRef.current.contains(target) &&
        settingsBtnRef.current && !settingsBtnRef.current.contains(target)
      ) {
        setSettingsOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  // 縮退テストの擬似切断を可逆に切り替える。Mode は書き換えず、本物の silent-loss 検知経路を通す（要件14.2/14.3/14.5）。
  function toggleSimulatedOffline(): void {
    const next = !simulatingOffline;
    setPingBlackholeActive(next);
    setSimulatingOffline(next);
  }

  return (
    <div className="flex h-[100dvh] flex-col">
      <header
        className={cn(
          "relative z-30 flex flex-none items-center gap-4 border-b border-line",
          "h-[calc(clamp(3.25rem,7.5vh,4.125rem)+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]",
          "px-[clamp(0.75rem,2.4vw,1.625rem)] bg-[color-mix(in_oklab,var(--color-panel)_92%,black)]",
        )}
      >
        <h1 className="m-0 text-[clamp(1rem,2.4vw,1.375rem)] leading-none">
          <Logo />
        </h1>
        <div className="flex-1" />
        {connection && <ConnectionStatus connection={connection} />}
        <button
          ref={settingsBtnRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-[0.6875rem] border border-line bg-panel2 px-4 text-sm font-bold text-ink hover:border-muted before:text-[1.0625rem] before:content-['⚙']"
        >
          Settings
        </button>
        {settingsOpen && (
          <div
            ref={popRef}
            role="dialog"
            aria-label="Settings"
            className="absolute right-[clamp(0.75rem,2.4vw,1.625rem)] top-[calc(100%+0.5rem)] z-40 w-[min(22.5rem,calc(100vw-1.5rem))] rounded-[0.875rem] border border-line bg-panel p-[0.875rem] shadow-[0_1.125rem_3.125rem_rgba(0,0,0,.55)]"
          >
            <UnitSelector units={units} totalUnits={totalUnits} count={count} onChange={setUnits} />
            {degradationTestable && (
              <button
                type="button"
                aria-pressed={simulatingOffline}
                onClick={toggleSimulatedOffline}
                className="mt-2 inline-flex h-10 cursor-pointer items-center rounded-[0.6875rem] border border-line bg-panel2 px-4 text-sm font-bold text-ink hover:border-muted"
              >
                {simulatingOffline ? "Stop simulating offline" : "Simulate offline (dev)"}
              </button>
            )}
          </div>
        )}
      </header>

      <main
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-[clamp(0.5rem,1.2vh,0.875rem)]",
          // 上は header が safe-area を吸収済み。左右下はここで safe-area-inset を加える（black-translucent 対応）。
          "pt-[clamp(0.5rem,1.4vw,1rem)]",
          "pl-[calc(clamp(0.5rem,1.4vw,1rem)+env(safe-area-inset-left))]",
          "pr-[calc(clamp(0.5rem,1.4vw,1rem)+env(safe-area-inset-right))]",
          "pb-[calc(clamp(0.5rem,1.4vw,1rem)+env(safe-area-inset-bottom))]",
        )}
        aria-label="Slots"
      >
        {connection ? (
          <SlotBoard connection={connection} units={units} playTouchCue={playTouchCue} />
        ) : (
          <p role="status" className="text-muted">Connecting…</p>
        )}
      </main>

      {/* ブラウザ閲覧時のみ表示する PWA インストール導線（standalone では自動的に消える）。 */}
      <InstallPrompt />
    </div>
  );
}
