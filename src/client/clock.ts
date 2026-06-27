// client/clock.ts — クロックオフセット補正と残り時間の純粋導出。
// 残り秒は状態として持たず、描画のたびにこの関数群で導出する（要件10.1 の思想をクライアントへ徹底）。
// cloudflare:workers にも DOM/React にも依存しない、ただの関数群。
//
// 時刻と継続時間を概念として区別する。endTime / serverTime / localReceipt / now は
// 「エポックミリ秒の絶対時刻」、offset / 残りは「ミリ秒の継続時間」。混同は意味を壊すため、
// 値の役割を関数の形とコメントで明示する。現在時刻 now は引数として受け取り、Date.now() を
// 関数内に持ち込まない（純粋性を保ち、任意時刻で検証可能にする）。

/**
 * クロックオフセット — サーバ基準へ補正するための量（ミリ秒）。
 *
 * serverTime（送信時点のサーバ時刻）と localReceipt（受信時点のローカル時刻）の差。
 * クライアントが状態として保持するのはこの offset であって、残り秒ではない（要件10.3）。
 */
export function clockOffset(serverTime: number, localReceipt: number): number {
  return serverTime - localReceipt;
}

/**
 * 補正後の現在時刻 — ローカル現在時刻 now に offset を加え、サーバ基準へ寄せた時刻。
 *
 * 切断中は新しい serverTime を受け取れないため、接続中に確立した最新 offset を使い続けて
 * ローカル再算出する。サーバへは問い合わせない（要件5.1 / 5.2 / 5.3）。
 */
export function correctedNow(offset: number, now: number): number {
  return now + offset;
}

/**
 * 残り時間（ミリ秒）— endTime（事実）と補正後現在時刻からの導出値。
 *
 * 決して負を出さない。補正後現在時刻が endTime 以上なら必ず 0 になる（要件4.4 / 5.6 / 10.4）。
 */
export function remainingMs(endTime: number, offset: number, now: number): number {
  return Math.max(0, endTime - correctedNow(offset, now));
}
