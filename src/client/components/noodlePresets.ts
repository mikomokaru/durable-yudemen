// client/components/noodlePresets.ts — 開始操作で送る麺種と既定茹で時間のプリセット。
// サーバは noodleType が非空であることと boilSeconds が 1〜1800 秒であることのみを要求する
// （core/start.ts validateStart）。UI はその入力空間に収まる選択肢だけを提示する。

/** 麺種と既定の茹で時間（秒）の組。開始操作の入力をこの集合に閉じ込める。 */
export interface NoodlePreset {
  readonly noodleType: string;
  readonly boilSeconds: number;
}

/** 厨房で選べる麺種プリセット。UI コンテンツは英語（language-preferences）。 */
export const NOODLE_PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Thin", boilSeconds: 60 },
  { noodleType: "Medium", boilSeconds: 90 },
  { noodleType: "Thick", boilSeconds: 120 },
];
