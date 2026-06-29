// client/components/noodleColor.ts — noodleType から背景色を導出する純粋関数（クライアント表示の関心事）。
//
// 色は noodleType の導出値であって状態ではない。ゆえに保持・配信・設定（StoreConfig/ワイヤ/永続）に載せず、
// 表示の端（client）で算出する。
//
// 目的は「厨房で遠目に麺種を弁別できる」こと。基本は noodleType の安定ハッシュで色を決める（メニュー構成や
// 並び順に依存せず、ある麺種は常に同じ色＝ユーザーが色で麺種を覚えられる）。ただしハッシュは別の麺種が同じ
// パレット枠に落ちる衝突を避けられないため、「ぶつかったら次の空き枠へずらす」線形探索で解消する（open
// addressing）。衝突に関与しない麺種の色はメニューが変わっても動かない——動くのは衝突した片方だけ。
//
// 用途は前景色（麺名テキスト・ラジアル花びらの麺名）。暗いパネルの上で読めるよう、明度を上げた pastel に
// する（背景塗りではないので暗色帯にはしない）。パレットは 13 色（素数＝ハッシュ剰余の分散が素直）で、
// 暖色 8・寒色 5 の暖色寄り。色相を散らしてどの 2 色も弁別できるようにする（線形探索は同一枠衝突しか解か
// ないため、別枠どうしが似ていては意味がない）。彩度は低めの「心にやさしい」muted トーンで、長時間の厨房
// 使用でも目が疲れにくくする。状態（running=琥珀 / boiled=緑 / danger=赤）は左ボーダー・時間テキスト・
// グローが担い続け、麺色は麺名の identity だけに使う。

/**
 * 前景（麺名テキスト）用のキュレート済みパレット（oklch・13 色＝素数）。暖色 8・寒色 5 の暖色寄り。暗いパネル上で
 * 読める明るめの pastel、彩度は低めの muted トーンで目にやさしく。互いに弁別しやすいよう手で選ぶ。
 */
const NOODLE_PALETTE = [
  // 暖色 8（紅・橙・黄系＋桃）
  "oklch(0.76 0.085 330)", // 梅
  "oklch(0.76 0.085 350)", // 撫子
  "oklch(0.75 0.090 12)", // 朱
  "oklch(0.77 0.090 32)", // 橙
  "oklch(0.80 0.085 52)", // 杏
  "oklch(0.82 0.080 72)", // 黄土
  "oklch(0.85 0.080 92)", // 山吹
  "oklch(0.86 0.078 110)", // 菜種
  // 寒色 5（緑・青・菫系）
  "oklch(0.80 0.075 150)", // 苔
  "oklch(0.78 0.070 185)", // 緑青
  "oklch(0.76 0.075 220)", // 浅葱
  "oklch(0.74 0.080 255)", // 露草
  "oklch(0.75 0.085 290)", // 藤
] as const;

/** noodleType → 背景塗りを解決する関数。ハッシュ＋線形探索の割り当て結果を閉じ込めた resolver。 */
export type NoodleColor = (noodleType: string) => string;

/** noodleType を NOODLE_PALETTE の優先 index（ハッシュ）へ安定写像する（FNV-1a 風・Math.imul で 32bit に畳む）。 */
function hashIndex(noodleType: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < noodleType.length; i++) {
    hash ^= noodleType.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % NOODLE_PALETTE.length;
}

/**
 * 店舗メニュー（noodleType の並び）から色 resolver を作る。
 *
 * 各 noodleType はハッシュの優先枠を取り、その枠が既に他の麺種に取られていれば「次の空き枠」へ線形探索で
 * ずらす（ぶつかったら次）。衝突しない麺種の色は優先枠のまま＝メニュー構成に依らず安定する。メニューが
 * パレット数（13）を超えると空きが尽き、以降は優先枠を共有する（弁別不能は不可避）。メニュー外の noodleType
 * はハッシュ優先枠でフォールバックする（撤去済みメニューの走行中タイマー等）。
 */
export function noodleColors(menu: readonly string[]): NoodleColor {
  const slotOf = new Map<string, number>();
  const used = new Set<number>();
  for (const noodleType of menu) {
    if (slotOf.has(noodleType)) continue;
    let slot = hashIndex(noodleType);
    // ぶつかったら次の空き枠へ。一周しても空きが無ければ（メニュー > パレット数）優先枠を共有する。
    let probe = 0;
    while (used.has(slot) && probe < NOODLE_PALETTE.length) {
      slot = (slot + 1) % NOODLE_PALETTE.length;
      probe++;
    }
    slotOf.set(noodleType, slot);
    used.add(slot);
  }
  return (noodleType) => NOODLE_PALETTE[slotOf.get(noodleType) ?? hashIndex(noodleType)]!;
}
