// client/cn.ts — className 連結の最小ヘルパ。falsy（false / null / undefined）を捨てて join する。
// 条件付きクラス（状態での色分け）を素直に書くためだけの道具。clsx 等の機構は持ち込まない（YAGNI）。

/** 与えられた断片のうち真値だけを空白区切りで連結する。 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
