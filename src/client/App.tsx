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
  fetchStoreChoices,
  isPingBlackholeActive,
  openTimerConnection,
  pingBlackholeDebugEnabled,
  setPingBlackholeActive,
  storeIdFromPath,
  timerSocketUrl,
} from "./connection";
import type { StoreChoice, TimerConnection } from "./connection";
import { SlotBoard } from "./components/SlotBoard";
import { UnitSelector } from "./components/UnitSelector";
import { useUnitCount } from "./components/useUnitCount";
import { useWakeLock } from "./components/useWakeLock";
import { useAudioCues } from "./components/useAudioCues";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { InstallPrompt } from "./components/InstallPrompt";
import { Logo } from "./components/Logo";
import { unitsForCount } from "./assignment";
import { readLastStore, rememberLastStore } from "./persistence";
import { DEFAULT_UNIT_COUNT } from "../domain/store";
import { cn } from "./cn";

/**
 * ルート。自身の URL パスから storeId を読み、店舗パス（/s/{storeId}/）なら店舗タイマーへ、
 * Entry（`/`）なら前回使用店に基づく解決（クライアント側直行 or 案内表示）へ振り分ける
 * （design.md Component 10「ACCESS OFF 期の PWA 起動」）。
 */
export function App() {
  const storeId = storeIdFromPath(window.location.pathname);
  // 店舗パス外（Entry `/`）は接続を開かず、前回使用店の記憶による直行 or 案内へ落とす（要件7.8）。
  if (storeId === null) {
    return <Entry />;
  }
  return <StoreTimer storeId={storeId} />;
}

/**
 * ACCESS OFF 期（Phase 1〜2・要件7.8）の Entry。サーバ側の行き先解決が存在しないため、
 * 前回使用店の記憶だけが唯一の復帰経路となる。記憶があれば店舗パスへクライアント側で直行し、
 * 記憶が無い／不正なら合鍵 URL（Store_Path 直叩き）を案内する表示に落とす（design.md Component 10）。
 */
function Entry() {
  // 前回使用店を一度だけ読む（無い／不正は null = 記憶なし）。読み出しは副作用を持たない同期取得。
  const [lastStoreId] = useState(readLastStore);
  useEffect(() => {
    // 記憶があれば店舗パスへ直行する。Entry を履歴に残さないよう replace で置換する。
    if (lastStoreId !== null) {
      window.location.replace(`/s/${lastStoreId}/`);
    }
  }, [lastStoreId]);

  if (lastStoreId !== null) {
    // 直行中。replace が効くまでの一瞬だけ出す。
    return (
      <div className="flex h-[100dvh] items-center justify-center p-6">
        <p role="status" className="text-muted">Opening your store…</p>
      </div>
    );
  }

  // 記憶なし／不正 → 合鍵 URL の直叩きを案内する（frontend content は英語）。
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo />
      <h1 className="m-0 text-xl font-bold text-ink">No store selected</h1>
      <p className="max-w-md text-muted">
        Open the private store link you were given to start the timer. This device will
        remember your store and open it automatically next time.
      </p>
    </div>
  );
}

/**
 * 店舗タイマーのシェル。storeId は店舗パス（/s/{storeId}/）由来で常に非 null（要件1.3）。
 * この店舗パスに到達した事実をマウント時に前回使用店として記憶し、次回 Entry 起動時の直行の土台にする（要件7.6）。
 */
function StoreTimer({ storeId }: { storeId: string }) {
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

  // 複数店舗担当（SV・本部）向けの店舗切替の選択肢。GET /entry/stores（Access ON でのみ中身を返す）を
  // 取得し、2 店以上あるときだけ設定画面に切替 UI を出す（要件7.4）。ACCESS OFF 期は 404 で空配列に畳まれ、
  // 切替 UI は現れない（取得失敗も一様に空・fetchStoreChoices が優雅に劣化する）。
  const [storeChoices, setStoreChoices] = useState<readonly StoreChoice[]>([]);

  // dev/test 限定の縮退テストトグルを表示するか。本番では pingBlackholeDebugEnabled() が false を返し、
  // import.meta.env.DEV を先頭ガードに置くことで以下のトグル配線ごと本番バンドルから除外される（要件14.4）。
  const degradationTestable = import.meta.env.DEV && pingBlackholeDebugEnabled();
  // 送信 ping を破棄して擬似的な静かな喪失（half-open）を起こしているか。スイッチの可視ミラー（要件14.3）。
  const [simulatingOffline, setSimulatingOffline] = useState(isPingBlackholeActive());

  // この店舗パスに到達した事実を前回使用店として記憶する（Entry からのクライアント側直行の土台・要件7.6）。
  useEffect(() => {
    rememberLastStore(storeId);
  }, [storeId]);

  // 起動時に一度だけ店舗切替の選択肢を取得する（低頻度・Entry の逆引き照会・要件7.4 / 7.7）。
  // アンマウント後の setState を避けるため cancelled ガードで畳む。取得失敗・OFF 期は空配列（切替 UI なし）。
  useEffect(() => {
    let cancelled = false;
    void fetchStoreChoices().then((choices) => {
      if (!cancelled) setStoreChoices(choices);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // URL から読んだ storeId と同一の storeId で /s/{storeId}/ws へ接続し、永続もその storeId でスコープする（要件1.3 / 1.5）。
    // 接続拒否（deactivated 等）時は Entry（`/`）へ戻って行き先を解決し直す（要件7.6・タスク 14.1 のリダイレクトに委ねる）。
    // 拒否された店舗を履歴に残さないよう replace で置換する。
    const conn = openTimerConnection({
      storeId,
      url: timerSocketUrl(storeId),
      onRejected: () => window.location.replace("/"),
    });
    setConnection(conn);
    // 店舗のユニット総数（サーバ権威）をビューから追従する。config 受信のたびに反映される。
    const unsubscribe = conn.subscribe(() => setTotalUnits(conn.getView().unitCount));
    setTotalUnits(conn.getView().unitCount);
    return () => {
      unsubscribe();
      conn.close();
    };
  }, [storeId]);

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
            {/* 複数店舗担当者の店舗切替（2 店以上のときだけ出す）。表示は name、選択で当該店舗パスへ全遷移する
                （storeId はスラッグゆえ表示に使わない・要件7.4）。現在の店舗は選択済みとして非活性にする。 */}
            {storeChoices.length > 1 && (
              <div className="mt-2 flex flex-col gap-1">
                <p className="m-0 text-xs font-bold uppercase tracking-wide text-muted">Switch store</p>
                {storeChoices.map((choice) => {
                  const current = choice.storeId === storeId;
                  return (
                    <button
                      key={choice.storeId}
                      type="button"
                      disabled={current}
                      aria-current={current}
                      onClick={() => {
                        if (!current) window.location.assign(`/s/${choice.storeId}/`);
                      }}
                      className={cn(
                        "inline-flex h-10 items-center rounded-[0.6875rem] border border-line px-4 text-sm font-bold",
                        current
                          ? "cursor-default bg-panel2 text-muted"
                          : "cursor-pointer bg-panel2 text-ink hover:border-muted",
                      )}
                    >
                      {choice.name}
                    </button>
                  );
                })}
              </div>
            )}
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
