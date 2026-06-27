// client/components/useNow.ts — 現在時刻 now を一定間隔で更新するフック。
// 残り秒は状態として持たない。導出の入力である現在時刻だけを刻み、描画のたびに clock.ts へ
// now を渡して残りを算出させる（要件10.5 / 5.1：1000ms 以下の間隔で再算出）。
// クライアント端なので hibernation 制約は無関係（設計のクライアント節）。

import { useEffect, useState } from "react";

/** 現在時刻（エポックミリ秒）を intervalMs 間隔で更新して返す。既定 1000ms。 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
