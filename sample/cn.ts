/** 簡易 className 連結（falsy を捨てて join） */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
