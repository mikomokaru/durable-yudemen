// ===========================================================================
// 茹で加減（firmness）モデル
// ---------------------------------------------------------------------------
// ・boiling 相で麺の硬さを選ぶ。デフォルトは「ふつう」。
// ・硬さは「ふつう基準の茹で時間の増減(秒)」を持つ。硬いほど短い。
// ・配列の順序がそのまま UI の並び（左=硬い → 右=柔らかい）になる。
// ===========================================================================

export type Firmness = "バリカタ" | "かため" | "ふつう" | "やわめ";

export interface FirmnessLevel {
  id: Firmness;
  /** ふつうを 0 とした茹で時間の増減(秒)。負=短い、正=長い */
  deltaSec: number;
}

// 並び順 = 硬い → 柔らかい（UI もこの順で左→右に並ぶ）
export const FIRMNESS_LEVELS: FirmnessLevel[] = [
  { id: "バリカタ", deltaSec: -20 },
  { id: "かため",   deltaSec: -10 },
  { id: "ふつう",   deltaSec: 0 },
  { id: "やわめ",   deltaSec: 15 },
];

export const DEFAULT_FIRMNESS: Firmness = "ふつう";

export function firmnessDelta(f: Firmness): number {
  return FIRMNESS_LEVELS.find((l) => l.id === f)?.deltaSec ?? 0;
}

/**
 * 硬さ変更時の「終了時刻」の再計算。
 *
 * 残り時間は endsAt（終了時刻）から都度計算する設計なので、硬さを変えたら
 * endsAt を引き直すだけでよい（経過はそのまま、総時間が変わる）。
 *
 * @param startedAt  茹で開始時刻(ms, Date.now())
 * @param baseSec    その麺種の「ふつう」での総茹で時間(秒)
 * @param firmness   新しい硬さ
 * @returns          新しい endsAt(ms)
 */
export function endsAtFor(startedAt: number, baseSec: number, firmness: Firmness): number {
  const totalSec = baseSec + firmnessDelta(firmness);
  return startedAt + totalSec * 1000;
}
