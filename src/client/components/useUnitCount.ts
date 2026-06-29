// client/components/useUnitCount.ts — viewport の向きから表示ユニット数（窓長 k）を導く端。
//
// 縦画面（portrait）= 1 ユニット、横画面（landscape）= 2 ユニット。これは担当窓 (アンカー b, 長さ k) の
// うち k を viewport が決める機構（b は UnitSelector が決める）。向きの変化は端末を持つ人の明示操作であり、
// 接続台数の増減とは無関係（要件12.4 の趣旨＝担当はユーザー操作でのみ動く、を満たす）。
//
// 外部ストア（matchMedia）を useSyncExternalStore で購読し、回転のたびに再描画＋窓遷移を促す。

import { useSyncExternalStore } from "react";

/** landscape を判定する media query。これ一点が縦横の切替しきい値（縦横比 1.0 相当）。 */
const LANDSCAPE = "(orientation: landscape)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(LANDSCAPE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** 現在の窓長: 横画面 = 2、縦画面 = 1。 */
function snapshot(): 1 | 2 {
  return window.matchMedia(LANDSCAPE).matches ? 2 : 1;
}

/**
 * viewport の向きから表示ユニット数（窓長 k ∈ {1,2}）を返すフック。
 * 縦画面 = 1、横画面 = 2。回転で値が変わり、購読側（App）が unitsForCount で担当窓を遷移させる。
 */
export function useUnitCount(): 1 | 2 {
  // SSR フォールバックは 1（縦）。本アプリは SPA だが getServerSnapshot 必須のため明示する。
  return useSyncExternalStore(subscribe, snapshot, () => 1);
}
