// client/components/InstallPrompt.tsx — ブラウザで開いたユーザーを PWA インストールへ誘導する導線。
//
// 2 経路を扱う：(1) Chromium 系（Android Chrome / デスクトップ Chrome・Edge）は beforeinstallprompt を
// 捕捉し、自前の Install ボタンでネイティブのインストールプロンプトを出す。(2) iOS Safari（iPad 含む）は
// beforeinstallprompt 非対応のため、共有 → ホーム画面に追加の手順を提示する。standalone 起動済み・
// インストール済みでは何も出さない。dismiss はセッション内のみ（localStorage は persistence.ts の
// 一点に閉じ込める規律のため、ここでは永続しない＝リロードで再表示）。
//
// client の端の作用（DOM イベント・matchMedia）で完結し、SSOT・状態遷移には触れない。

import { useEffect, useState } from "react";

// beforeinstallprompt は lib.dom 標準外。必要分だけ最小に型付けする。
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

/** 導線の状態：ネイティブプロンプト可 / iOS 手順提示 / 非表示（インストール済み・非対応）。 */
type InstallMode = "available" | "ios" | "hidden";

/** インストール済み（standalone 起動）か。display-mode と iOS Safari 専用の navigator.standalone の両対応。 */
function isStandalone(): boolean {
  const standaloneDisplay = window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return standaloneDisplay || iosStandalone;
}

/** iOS Safari か（beforeinstallprompt が来ない＝手順提示に切り替える対象）。 */
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const iDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ は Mac を名乗るため、タッチ点数で iPad を補足する。
  const iPadDesktopUA = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const safari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
  return (iDevice || iPadDesktopUA) && safari;
}

/** ブラウザ閲覧時だけインストール導線を出す。インストール後・standalone では描画しない。 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [mode, setMode] = useState<InstallMode>("hidden");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isStandalone()) return; // インストール済みでは導線を出さない

    const onBeforeInstall = (event: Event) => {
      event.preventDefault(); // 既定のミニ情報バーを抑え、自前ボタンに委ねる
      setDeferred(event as BeforeInstallPromptEvent);
      setMode("available");
    };
    const onInstalled = () => {
      setMode("hidden");
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // Chromium 以外（beforeinstallprompt が来ない）で iOS Safari なら手順提示へ。
    if (isIosSafari()) setMode("ios");

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (dismissed || mode === "hidden") return null;

  const install = async () => {
    if (deferred === null) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    setMode("hidden");
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto flex max-w-[min(34rem,calc(100vw-2rem))] items-center gap-3 rounded-[0.875rem] border border-line bg-panel2 px-4 py-3 shadow-[0_1.125rem_3.125rem_rgba(0,0,0,.55)]">
        <span className="text-2xl leading-none" aria-hidden="true">🍜</span>
        <div className="min-w-0 flex-1 text-sm">
          {mode === "available" ? (
            <p className="m-0 font-semibold text-ink">Install BoilIt for full-screen, offline use.</p>
          ) : (
            <p className="m-0 font-semibold text-ink">
              Install: tap <span className="font-bold">Share</span>, then{" "}
              <span className="font-bold">Add to Home Screen</span>.
            </p>
          )}
        </div>
        {mode === "available" && (
          <button
            type="button"
            onClick={install}
            className="inline-flex h-9 flex-none cursor-pointer items-center rounded-[0.6875rem] bg-[oklch(0.84_0.006_80)] px-4 text-sm font-bold text-[#15120c] hover:brightness-95"
          >
            Install
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="inline-flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-[0.6875rem] border border-line text-muted hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
