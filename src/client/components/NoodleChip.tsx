// NoodleChip — 麺種の名と玉数を一つのチップで示す（noodle-portions 判断 7・改訂 2026-09-18）。
//
// 玉数は品名に含めない。品名に添えると札が伸び、麺種は色でしか判らなかった。麺を釜へ落とす人が要るのは
// 「どの麺を何玉か」であり、それを一箇所で読めるように、麺種の色で塗ったチップに `{noodleType} {portions}` を置く。
// 単位「玉」は付けない（数字だけ・client の英語 UI の例外を広げない）。
//
// 色の出所は他の札と同じ resolver（noodleColor）だけで、文字は NoodleBadge と同じ統一の暗色。

import { portionsFigure } from "./queueDisplay";

/** チップの語。麺種と玉数を空白で繋ぐ（`REG 1.5`）。読み上げも同じ語。 */
export function noodleChipLabel(noodleType: string, portions: number): string {
  return `${noodleType} ${portionsFigure(portions)}`;
}

export function NoodleChip({
  noodleType,
  portions,
  tint,
  className,
}: {
  readonly noodleType: string;
  readonly portions: number;
  /** 麺種の色（noodleColor(noodleType)）。呼び出し側が resolver から引く。 */
  readonly tint: string;
  readonly className?: string | undefined;
}) {
  return (
    <span
      data-chip=""
      className={`inline-flex flex-none items-baseline rounded-full px-[0.5em] py-[0.1em] text-[0.6875rem] leading-none font-bold whitespace-nowrap tabular-nums ${className ?? ""}`}
      style={{ backgroundColor: tint, color: "#15120c" }}
    >
      {noodleChipLabel(noodleType, portions)}
    </span>
  );
}
