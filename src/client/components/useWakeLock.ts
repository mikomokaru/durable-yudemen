// client/components/useWakeLock.ts — 画面スリープ抑制（Screen Wake Lock）の作用フック。
//
// 厨房 iPad をタイマー画面に出しっぱなしにする間、自動ロック/画面オフを抑える。これは client の端の作用で
// あって SSOT・状態遷移には触れない（design-philosophy「計算と作用の分離」）。Wake Lock は可視時のみ取得でき、
// 非可視化（アプリ退避・画面オフ）で OS が自動解放するため、visibilitychange で前面復帰のたびに取り直す。
// 非対応環境（古い iOS など navigator.wakeLock を持たない）では何もしない（優雅な劣化）。

import { useEffect } from "react";

/** マウント中だけ画面スリープを抑制する。前面復帰のたびに自動で取り直す。 */
export function useWakeLock(): void {
  useEffect(() => {
    if (!("wakeLock" in navigator)) return; // 非対応環境では無効

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      // 可視時のみ取得可能。非可視・取得済み・解除済みでは何もしない。
      if (cancelled || sentinel !== null || document.visibilityState !== "visible") return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void next.release(); // 取得中にアンマウントしたら即解放する
          return;
        }
        sentinel = next;
        // OS 側の自動解放（画面オフ・アプリ退避）を検知し、次の可視化で取り直せるよう状態を戻す。
        next.addEventListener("release", () => {
          sentinel = null;
        });
      } catch {
        sentinel = null; // 取得失敗は致命的でない。次の可視化で再試行する。
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release();
      sentinel = null;
    };
  }, []);
}
