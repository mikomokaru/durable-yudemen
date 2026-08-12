// domain/store.ts — 店舗のサーバ権威設定（StoreConfig）。Timer の SSOT フローとは別概念。
// プラットフォーム非依存の純粋な型と検証だけを持つ（domain 内の timer 契約のみ取り込む）。
//
// StoreConfig はクライアントが制御しない（UI から変更不可・店舗ごとに固定）サーバ権威の設定で、
// サーバから各クライアントへ一方向に配信される（config ServerMessage）。Timer のような
// クライアントコマンド駆動の状態遷移（decide/Effect）には乗らない。
//
// 値の源は env シード（STORE_UNIT_COUNT / STORE_NOODLE_PRESETS）で、DO 初回構築時に検証して
// storeConfig として永続する。稼働中の差し替えは運用エンドポイント（PUT /admin/config）が再投入する。
// 詳細は yude-men-timer/design.md「店舗設定の配信（StoreConfig）」を参照。

import { isNonEmpty, type NonEmptyArray } from "./timer";
import { FIRMNESS_ORDER, type Firmness } from "./firmness";

/** 1 ユニット（釜の台）が担当する連続スロット数。unit u は slot 6u..6u+5。番号と slot の対応の正本。 */
export const SLOTS_PER_UNIT = 6;

/**
 * slotId をスロット番号へ写す恒等対応。番号と slot の対応の正本（SLOTS_PER_UNIT と同じ場所に置く）。
 *
 * 本パイロットでは slotId をそのまま 0 始まりのスロット番号として解釈する（要件12.5）。
 * slotId が連番文字列でない運用へ将来移行する場合のみ写像を差し込むが、現時点では恒等で足りる。
 * client（担当スロットの絞り込み）と engine（slot 解放表・slot 座標の合成）の双方が同じ写像を要するため、
 * 中立の契約ハブに置いて二度定義しない。
 */
export function slotOf(slotId: string): number {
  return Number(slotId);
}

/** ユニット総数の下限（1 ユニット = 6 スロット）。 */
export const UNIT_COUNT_MIN = 1;

/** ユニット総数の上限（4 ユニット = 24 スロット）。 */
export const UNIT_COUNT_MAX = 4;

/** ユニット総数の既定。env シード不在・不正・接続前のクライアント表示のフォールバックに用いる。 */
export const DEFAULT_UNIT_COUNT = 3;

/** 腕の本数（arms）の下限。1 Sync_Set の最大本数＝同時に上げられる本数の上限。 */
export const ARMS_MIN = 1;

/** 腕の本数（arms）の上限。 */
export const ARMS_MAX = 10;

/** 腕の本数（arms）の既定。env シード不在・不正のフォールバックに用いる。 */
export const DEFAULT_ARMS = 2;

/** 許容調整割合（toleranceRatio）の下限（整数パーセント）。 */
export const TOLERANCE_RATIO_MIN = 1;

/** 許容調整割合（toleranceRatio）の上限（整数パーセント）。 */
export const TOLERANCE_RATIO_MAX = 50;

/** 許容調整割合（toleranceRatio）の既定（整数パーセント）。env シード不在・不正のフォールバックに用いる。 */
export const DEFAULT_TOLERANCE_RATIO = 10;

/** ソフト制約の重みの下限。0 は当該項を無効化する（3 つの重みは同じ妥当域を共有する）。 */
export const WEIGHT_MIN = 0;

/** ソフト制約の重みの上限。 */
export const WEIGHT_MAX = 100;

/** Order_Sync の重み（w_order）の既定。3 項の中で最も強い（同一オーダーの揃いを最優先する）。 */
export const DEFAULT_ORDER_SYNC_WEIGHT = 3;

/** Table_Sync の重み（w_table）の既定。 */
export const DEFAULT_TABLE_SYNC_WEIGHT = 2;

/** Slot_Affinity の重み（w_affinity）の既定。 */
export const DEFAULT_AFFINITY_WEIGHT = 1;

/** 同期許容幅（秒）の下限。Order_Sync / Table_Sync は同じ妥当域を共有する。 */
export const SYNC_TOLERANCE_SECONDS_MIN = 0;

/** 同期許容幅（秒）の上限。 */
export const SYNC_TOLERANCE_SECONDS_MAX = 600;

/** 同一オーダー内の茹で上がり差の許容幅（秒）の既定。超過分だけを目的関数へ計上する。 */
export const DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS = 30;

/** 同一卓内の茹で上がり差の許容幅（秒）の既定。オーダー内より緩い。 */
export const DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS = 60;

/** 許容 slot 距離の下限。 */
export const AFFINITY_TOLERANCE_DISTANCE_MIN = 0;

/** 許容 slot 距離の上限。 */
export const AFFINITY_TOLERANCE_DISTANCE_MAX = 1000;

/**
 * 許容 slot 距離の既定（14 = 斜め隣接のオクタイル距離）。
 *
 * 3 行 × 2 列のユニットでは、ある釜の 8 近傍のうちユニット内に収まる対がすべて超過 0 になる。
 * 「同じ台の隣り合う釜なら十分近い」という現場の事実の表明であり、ユニット内のわずかな配置差で
 * 最適化が揺れない。ユニット内の対角（24）と異なるユニットの最近対（30 以上）には差が残る。
 */
export const DEFAULT_AFFINITY_TOLERANCE_DISTANCE = 14;

/** 格子座標の下限。座標は 0 以上の整数（上限は置かない——台の増設を設定側で縛らない）。 */
export const GRID_COORDINATE_MIN = 0;

/**
 * GridPoint — 格子座標。ユニット原点にもユニット内オフセットにも合成結果にも使う中立の基底。
 *
 * オフセットは原点ではないため UnitOrigin を流用しない。中立の基底を両者の下に置き、名が小さく嘘をつくのを避ける。
 */
export interface GridPoint {
  /** 横方向の格子位置（GRID_COORDINATE_MIN 以上の整数）。 */
  readonly x: number;
  /** 縦方向の格子位置（GRID_COORDINATE_MIN 以上の整数）。 */
  readonly y: number;
}

/** ユニット（釜の台・SLOTS_PER_UNIT 個の slot）の原点。 */
export type UnitOrigin = GridPoint;

/** ユニット内 slot のオフセット。全ユニットで共通（ユニットは同型の台である）。 */
export type SlotOffsets = readonly [GridPoint, GridPoint, GridPoint, GridPoint, GridPoint, GridPoint];

/**
 * ユニット内オフセットの既定（3 行 × 2 列・j → (j % 2, ⌊j / 2⌋)）。
 *
 * slot の座標は unitOrigins[⌊i / SLOTS_PER_UNIT⌋] + slotOffsets[i % SLOTS_PER_UNIT] の合成で導く。
 * 合成座標は導出値ゆえ設定として持たない。
 */
export const DEFAULT_SLOT_OFFSETS: SlotOffsets = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 0, y: 2 },
  { x: 1, y: 2 },
];

/**
 * 既定レイアウトにおけるユニット原点の x 間隔（ユニット幅 2 ＋ 台の離隔 2）。
 *
 * 離隔 2 は「同一ユニット内の任意の対は、異なるユニットの任意の対より近い」という不変条件を満たすために
 * 選んである。オクタイル距離（10·max + 4·min）では、ユニット内の最遠対は対角（dx=1, dy=2）で 24、
 * 異なるユニットの最近対は離隔 g のとき 10·(1 + g)。g = 2 なら 30 > 24 で成立し、g = 1 なら 20 < 24 で破れる。
 * 「別の台へ手を伸ばすより、自分の台の端まで動くほうが近い」という現場の事実の表明である。
 */
export const DEFAULT_UNIT_ORIGIN_STRIDE = 4;

/**
 * 既定のユニット原点列（u → (DEFAULT_UNIT_ORIGIN_STRIDE·u, 0)・ユニットを横一列に並べる）。
 *
 * 要素数が unitCount に依存するため、定数ではなく unitCount を受ける関数として持つ。
 */
export function defaultUnitOrigins(unitCount: number): readonly UnitOrigin[] {
  const origins: UnitOrigin[] = [];
  for (let unit = 0; unit < unitCount; unit++) {
    origins.push(defaultUnitOrigin(unit));
  }
  return origins;
}

/** 単一ユニットの既定原点。既定列の生成と toUnitOrigins の要素ごとの畳み込みが同じ式を二度書かないための芯。 */
function defaultUnitOrigin(unit: number): UnitOrigin {
  return { x: unit * DEFAULT_UNIT_ORIGIN_STRIDE, y: 0 };
}

/** 硬さ別の茹で時間（秒）。麺ごとに異なる値を持つ（券売機統合・運用注入の写し先）。 */
export type FirmnessSeconds = Readonly<Record<Firmness, number>>;

/**
 * NoodlePreset — 店舗が提供する麺種と、その麺の硬さ別茹で時間（秒）の組。開始操作の入力をこの集合へ閉じ込める。
 *
 * 茹で時間は「麺の種類ごと」に硬さ別で定義する（FirmnessSeconds）。開始は既定 normal を用い、茹で加減の
 * 変更でその麺の該当秒へ endTime を引き直す。サーバ権威でクライアントは変更不可。茹で時間の範囲ポリシー
 * （1〜1800 秒）の正本は engine の validateStart / adjustTimer にあり、ここでは構造（非空の種別名・全 4 硬さの
 * 正の整数秒）の健全性だけを担保する。
 */
export interface NoodlePreset {
  readonly noodleType: string;
  readonly boilSeconds: FirmnessSeconds;
}

/** 麺種プリセットの既定。env シード不在・不正・接続前のクライアント表示のフォールバックに用いる。 */
export const DEFAULT_NOODLE_PRESETS: NonEmptyArray<NoodlePreset> = [
  { noodleType: "Thin", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
  { noodleType: "Medium", boilSeconds: { extraHard: 75, hard: 82, normal: 90, soft: 105 } },
  { noodleType: "Thick", boilSeconds: { extraHard: 100, hard: 110, normal: 120, soft: 140 } },
];

/**
 * StoreConfig — 店舗のサーバ権威設定（ユニット総数・麺種プリセット・同期の重みと許容幅・slot レイアウト）。
 *
 * クライアントは受信して表示・担当範囲のクランプ・開始選択肢の提示に用いるが、変更はできない（サーバ権威）。
 * 将来サーバ制御の設定が増えればここへ足す（配信機構 config は StoreConfig 全体を運ぶ）。
 */
export interface StoreConfig {
  /** 店舗のユニット総数（UNIT_COUNT_MIN〜UNIT_COUNT_MAX）。1 ユニット = 6 スロット。 */
  readonly unitCount: number;
  /** 腕の本数（ARMS_MIN〜ARMS_MAX）。1 Sync_Set の最大本数＝同時に上げられる本数の上限（既定 DEFAULT_ARMS）。 */
  readonly arms: number;
  /** 許容調整割合（TOLERANCE_RATIO_MIN〜TOLERANCE_RATIO_MAX の整数パーセント・既定 DEFAULT_TOLERANCE_RATIO）。 */
  readonly toleranceRatio: number;
  /** 店舗が提供する麺種プリセット（型で非空を強制・開始 UI はこの集合だけを咲かせる）。 */
  readonly noodlePresets: NonEmptyArray<NoodlePreset>;
  /** Order_Sync の重み（WEIGHT_MIN〜WEIGHT_MAX の整数・既定 DEFAULT_ORDER_SYNC_WEIGHT）。 */
  readonly orderSyncWeight: number;
  /** Table_Sync の重み（WEIGHT_MIN〜WEIGHT_MAX の整数・既定 DEFAULT_TABLE_SYNC_WEIGHT）。 */
  readonly tableSyncWeight: number;
  /** Slot_Affinity の重み（WEIGHT_MIN〜WEIGHT_MAX の整数・既定 DEFAULT_AFFINITY_WEIGHT）。 */
  readonly affinityWeight: number;
  /** 同一オーダー内の茹で上がり差の許容幅（秒・既定 DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS）。超過分のみ計上する。 */
  readonly orderSyncToleranceSeconds: number;
  /** 同一卓内の茹で上がり差の許容幅（秒・既定 DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS）。超過分のみ計上する。 */
  readonly tableSyncToleranceSeconds: number;
  /** 許容 slot 距離（既定 DEFAULT_AFFINITY_TOLERANCE_DISTANCE）。超過分のみ計上する。 */
  readonly affinityToleranceDistance: number;
  /** ユニット原点の列（unitCount 個・既定 defaultUnitOrigins）。slot 座標は原点とオフセットの合成で導く。 */
  readonly unitOrigins: readonly UnitOrigin[];
  /** ユニット内 slot のオフセット（全ユニット共通・既定 DEFAULT_SLOT_OFFSETS）。 */
  readonly slotOffsets: SlotOffsets;
}

/**
 * 生値（env 文字列・永続値・運用投入のボディ）を、範囲内の整数へ畳む共通の芯。公開しない。
 *
 * 抽出の判断（design-philosophy「抽象は重複が実在してから入れる」）：同形の検証が 9 個（unitCount / arms /
 * toleranceRatio ＋ 重み 3 個 ＋ 許容幅 3 個）に達し、重複は実在する。ゆえに芯を一箇所へ寄せた。
 * ただし公開シンボルは各パラメータの to* のまま残す——呼び出し側（shell の設定ロード・registry の合成）が
 * 範囲と既定を引数で組み立てるのではなく名前で呼べること、各パラメータの既定と妥当域がその名の傍で一度だけ
 * 読めることが、この設定群の可読性の芯である。芯は畳み方（不正は既定・範囲内はクランプ）のみを担う。
 */
function toBoundedInteger(raw: unknown, min: number, max: number, fallback: number): number {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * 任意の生値（env 文字列・永続値など）を、範囲内の整数ユニット総数へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限はすべて DEFAULT_UNIT_COUNT へ畳む（不正値を表現させない）。
 * 範囲内へはクランプし、検証を一箇所へ集約する。
 */
export function toUnitCount(raw: unknown): number {
  return toBoundedInteger(raw, UNIT_COUNT_MIN, UNIT_COUNT_MAX, DEFAULT_UNIT_COUNT);
}

/**
 * 任意の生値（env 文字列・永続値など）を、範囲内の整数 arms へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限はすべて DEFAULT_ARMS へ畳む（当該パラメータのみ・要件 6.3 / 6.4）。
 * 範囲内へはクランプし、検証を一箇所へ集約する（toUnitCount と同形）。
 */
export function toArms(raw: unknown): number {
  return toBoundedInteger(raw, ARMS_MIN, ARMS_MAX, DEFAULT_ARMS);
}

/**
 * 任意の生値（env 文字列・永続値など）を、範囲内の整数パーセント toleranceRatio へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限はすべて DEFAULT_TOLERANCE_RATIO へ畳む（当該パラメータのみ・要件 6.3 / 6.4）。
 * 範囲内へはクランプし、検証を一箇所へ集約する（toUnitCount と同形）。engine では toleranceRatio / 100 を割合として用いる。
 */
export function toToleranceRatio(raw: unknown): number {
  return toBoundedInteger(raw, TOLERANCE_RATIO_MIN, TOLERANCE_RATIO_MAX, DEFAULT_TOLERANCE_RATIO);
}

/**
 * 任意の生値を、範囲内の整数 orderSyncWeight（w_order）へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限は DEFAULT_ORDER_SYNC_WEIGHT へ畳む（当該パラメータのみ・要件 3.4）。
 */
export function toOrderSyncWeight(raw: unknown): number {
  return toBoundedInteger(raw, WEIGHT_MIN, WEIGHT_MAX, DEFAULT_ORDER_SYNC_WEIGHT);
}

/**
 * 任意の生値を、範囲内の整数 tableSyncWeight（w_table）へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限は DEFAULT_TABLE_SYNC_WEIGHT へ畳む（当該パラメータのみ・要件 3.4）。
 */
export function toTableSyncWeight(raw: unknown): number {
  return toBoundedInteger(raw, WEIGHT_MIN, WEIGHT_MAX, DEFAULT_TABLE_SYNC_WEIGHT);
}

/**
 * 任意の生値を、範囲内の整数 affinityWeight（w_affinity）へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限は DEFAULT_AFFINITY_WEIGHT へ畳む（当該パラメータのみ・要件 3.4）。
 */
export function toAffinityWeight(raw: unknown): number {
  return toBoundedInteger(raw, WEIGHT_MIN, WEIGHT_MAX, DEFAULT_AFFINITY_WEIGHT);
}

/**
 * 任意の生値を、範囲内の整数秒 orderSyncToleranceSeconds へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限は DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS へ畳む（当該パラメータのみ・要件 3.4）。
 */
export function toOrderSyncToleranceSeconds(raw: unknown): number {
  return toBoundedInteger(
    raw,
    SYNC_TOLERANCE_SECONDS_MIN,
    SYNC_TOLERANCE_SECONDS_MAX,
    DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
  );
}

/**
 * 任意の生値を、範囲内の整数秒 tableSyncToleranceSeconds へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限は DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS へ畳む（当該パラメータのみ・要件 3.4）。
 */
export function toTableSyncToleranceSeconds(raw: unknown): number {
  return toBoundedInteger(
    raw,
    SYNC_TOLERANCE_SECONDS_MIN,
    SYNC_TOLERANCE_SECONDS_MAX,
    DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
  );
}

/**
 * 任意の生値を、範囲内の整数 affinityToleranceDistance へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限は DEFAULT_AFFINITY_TOLERANCE_DISTANCE へ畳む（当該パラメータのみ・要件 3.4）。
 */
export function toAffinityToleranceDistance(raw: unknown): number {
  return toBoundedInteger(
    raw,
    AFFINITY_TOLERANCE_DISTANCE_MIN,
    AFFINITY_TOLERANCE_DISTANCE_MAX,
    DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  );
}

/**
 * 任意の生値（env の JSON 文字列・永続配列・運用投入のボディなど）を、unitCount 個のユニット原点列へ写す純粋関数。
 *
 * 要素ごとに検証し、不正な座標は当該要素のみ既定 (DEFAULT_UNIT_ORIGIN_STRIDE·u, 0) へ畳む（他の妥当な座標は
 * 保持する）。要素数が unitCount に足りなければ足りない分を既定で埋め、多ければ余剰を落とす（ユニット総数が
 * 長さの正本であり、原点だけが存在するユニットを作らない）。
 *
 * toNoodlePresets が「要素ごとに検証して落とす」のに対し、こちらは落とさず既定へ畳んで長さを揃える。
 * 原点の index はユニット番号そのもので（slot 座標は unitOrigins[⌊i / SLOTS_PER_UNIT⌋] で引く）、欠けた要素を
 * 落とすと以降のユニットが番号ごと繰り上がり、slot 座標の対応が崩れるためである。
 */
export function toUnitOrigins(raw: unknown, unitCount: number): readonly UnitOrigin[] {
  // 長さは unitCount に従うため、unitCount 自身も妥当域へ畳んでから用いる（不正な長さを表現させない）。
  const count = toUnitCount(unitCount);
  const source = typeof raw === "string" ? parseJson(raw) : raw;
  const items = Array.isArray(source) ? source : [];
  const origins: UnitOrigin[] = [];
  for (let unit = 0; unit < count; unit++) {
    origins.push(toGridPoint(items[unit], defaultUnitOrigin(unit)));
  }
  return origins;
}

/**
 * 任意の生値（env の JSON 文字列・永続配列・運用投入のボディなど）を、SLOTS_PER_UNIT 個のオフセット組へ写す純粋関数。
 *
 * 要素数が足りない・多い・不正座標のとき、当該要素のみ DEFAULT_SLOT_OFFSETS の対応要素へ畳む
 * （toUnitOrigins と同形。オフセットの index は slot 番号そのものゆえ、欠落を落として詰めない）。
 */
export function toSlotOffsets(raw: unknown): SlotOffsets {
  const source = typeof raw === "string" ? parseJson(raw) : raw;
  const items = Array.isArray(source) ? source : [];
  // 6 要素タプルを組み立てる（型が長さを保証するため、写像を map で書いて長さの主張を assertion に委ねない）。
  return [
    toGridPoint(items[0], DEFAULT_SLOT_OFFSETS[0]),
    toGridPoint(items[1], DEFAULT_SLOT_OFFSETS[1]),
    toGridPoint(items[2], DEFAULT_SLOT_OFFSETS[2]),
    toGridPoint(items[3], DEFAULT_SLOT_OFFSETS[3]),
    toGridPoint(items[4], DEFAULT_SLOT_OFFSETS[4]),
    toGridPoint(items[5], DEFAULT_SLOT_OFFSETS[5]),
  ];
}

/**
 * 生値を GridPoint へ畳む。x・y の双方が GRID_COORDINATE_MIN 以上の整数でなければ fallback を返す。
 *
 * 座標に上限は置かない（台の増設を設定側で縛らない）ためクランプはせず、非有限・非整数・下限未満は既定へ畳む。
 * 畳む単位は座標の組（点）である——x だけを既定へ寄せると、どこにも指定されていない位置を新たに作ってしまう。
 */
function toGridPoint(value: unknown, fallback: GridPoint): GridPoint {
  if (typeof value !== "object" || value === null) return fallback;
  const candidate = value as Record<string, unknown>;
  const { x, y } = candidate;
  if (!isGridCoordinate(x) || !isGridCoordinate(y)) return fallback;
  return { x, y };
}

/** 格子座標として妥当か（GRID_COORDINATE_MIN 以上の整数）。 */
function isGridCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= GRID_COORDINATE_MIN;
}

/**
 * 任意の生値（env の JSON 文字列・永続配列・運用投入のボディなど）を、非空の麺種プリセット列へ写す純粋関数。
 *
 * 文字列は JSON として解釈し（失敗は既定へ）、配列でなければ既定へ畳む。各要素は構造検証（非空の noodleType・
 * 正の整数 boilSeconds）に通ったものだけを正規化して残す。結果が空なら DEFAULT_NOODLE_PRESETS へ畳む
 * （「不正な状態を表現可能にしない」を基数へ適用＝開始 UI が必ず 1 つ以上の選択肢を持つ）。検証を一箇所へ集約する。
 */
export function toNoodlePresets(raw: unknown): NonEmptyArray<NoodlePreset> {
  const source = typeof raw === "string" ? parseJson(raw) : raw;
  if (!Array.isArray(source)) {
    return DEFAULT_NOODLE_PRESETS;
  }
  const presets: NoodlePreset[] = [];
  for (const item of source) {
    const preset = toNoodlePreset(item);
    if (preset !== null) presets.push(preset);
  }
  return isNonEmpty(presets) ? presets : DEFAULT_NOODLE_PRESETS;
}

/** 生値を NoodlePreset へ正規化する。構造（非空種別名・全 4 硬さの正の整数秒）を満たさなければ null。 */
function toNoodlePreset(value: unknown): NoodlePreset | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.noodleType !== "string" || candidate.noodleType.length === 0) return null;
  const boilSeconds = toFirmnessSeconds(candidate.boilSeconds);
  if (boilSeconds === null) return null;
  // 余剰フィールドを落として正規化する（store config に混ぜ物を残さない）。
  return { noodleType: candidate.noodleType, boilSeconds };
}

/** 生値を FirmnessSeconds へ。全 4 硬さが正の整数秒であることを要求する（一つでも欠け/不正なら null）。 */
function toFirmnessSeconds(value: unknown): FirmnessSeconds | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const seconds = {} as Record<Firmness, number>;
  for (const firmness of FIRMNESS_ORDER) {
    const sec = candidate[firmness];
    if (typeof sec !== "number" || !Number.isInteger(sec) || sec <= 0) return null;
    seconds[firmness] = sec;
  }
  return seconds;
}

/** JSON 文字列を解釈する。解釈不能は undefined（呼び出し側が既定へ畳む）。 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
