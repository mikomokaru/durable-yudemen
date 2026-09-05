// engine/digest.ts — 計画入力の指紋（Input_Fingerprint）。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここに置くのは「指紋とは何か」と「入力からどう導くか」だけである。指紋を何に使うか——要求を出すか
// 抑えるか——は settle の関心事であり、この関数は入力を畳むことしか知らない。
//
// パラメータの束（SettleParams）の型だけを settle から借りる。値としての依存はなく（import type は消える）
// 同じフィールドの列挙をここへ写さないためである——計画の入力の全体を語る束は一箇所にしか在ってはならない。

import { adjustedEndTime } from "./project";
import { planTargets } from "./schedule";
import type { SettleParams } from "./settle";
import type { Timer } from "./timer";
import { FIRMNESS_ORDER } from "../domain/firmness";
import type { PendingOrder } from "../domain/order";
import type { NoodlePreset } from "../domain/store";

/**
 * InputDigest — 計画入力から決定的に畳んだ指紋。
 *
 * 整数演算のみで畳む（浮動小数の丸めによる非決定性を排除する。Boil_Sync の整数スケール方針と同じ規律）ため
 * 実体は number である。それでもブランドを被せるのは、engine が扱う無ブランドの整数が他にもあり
 * （adjustment・ScheduleScore の値）、素の number では requestedDigest へ目的関数値を
 * 取り違えて代入するコードが型検査を通ってしまうためである。指紋と点数の混同は「要求を出すか否か」の
 * 判断を静かに壊す種類の誤りで、テストでも見えにくい。既存 types.ts のブランド型（EpochMillis / TimerId 等）と
 * 同じ規律——検証済み・所定の経路で生まれた値だけがその型を名乗れる——をここにも適用する。
 * 生成の唯一の経路は digestInput（タスク 17.1）。比較は等値のみで、大小関係も算術も意味を持たない。
 */
export type InputDigest = number & { readonly __brand: "InputDigest" };
/**
 * digestInput — 計画の入力から決定的に指紋を導出する（要件5.3 / 5.6・Glossary Input_Fingerprint）。
 *
 * 畳むのは 4 つ。**計画対象**の Pending_Order（planTargets が定める先頭 PLAN_TARGET_LIMIT 件）、
 * 釜を占める Timer の必要事実（id / slotIds / 実効 endTime）、採点パラメータ、そして計画対象が引く麺プリセット。
 * 現在の指紋は導出値であり状態に昇格させない（保持するのは「直前に要求した時点の値」だけ・AC 7.2 / 7.3）。
 *
 * **何を含めるかは「変われば計画が変わりうるか」で決まる。** 変わっても計画が変わらない値を含めれば、
 * 無駄な要求が出る。逆に計画を変える値を落とせば、改善の機会に気づけないまま抑制が効く。
 *   - 計画対象の Pending_Order は**計画に効くフィールド**を含める（鍵・麺種・茹で加減・卓・到着時刻・
 *     slotSpan）。表示だけに効く申告名（itemName / sizeName）は含めない——変わっても計画は変わらない。
 *   - 計画対象**外**（65 件目以降）は含めない。計画に現れず推奨の対象にもならないので、増減しても
 *     計画は変わらない。含めれば混雑時に届く到着のたびに要求が出る（AC 11.2 の意図に反する）。
 *   - Timer は id / slotIds / 実効 endTime だけ。麺種・茹で加減・seq・boiledAt は解放表に効かない。
 *     実効 endTime（endTime + adjustment）を採るのは、Boil_Sync の調整後の値が釜の解放時刻という
 *     所与の事実そのものだからである（AC 9.3）。
 *   - **麺プリセットを畳む**（Glossary Input_Fingerprint の「パラメータ」にこれも含まれる）。茹で時間は
 *     startAt と serveAt を結ぶ唯一の値ゆえ（settle.ts の SettleParams）、プリセットが差し替われば同じ
 *     待ち行列から別の計画が出る。畳まなければ、差し替え前後の要求が同一指紋になって改善の機会を落とす。
 *     ゆえに第 3 引数は SettleParams（ScheduleParams の上位集合）を受ける。
 *   - **プリセットは計画対象が引く麺種の分だけ畳む。** 計画がプリセットへ触れる唯一の経路は「品目の
 *     noodleType でプリセットを引き当て、その firmness の秒を採る」ことである（schedule.ts の toBoiling）。
 *     待ち行列に現れない麺種の秒がいくら動いても計画は変わらないので、畳めば無駄な要求が出る
 *     （計画対象外の 65 件目以降を落とすのと同じ判断）。**麺種の粒度で切り、硬さの粒度までは切らない**
 *     ——プリセットは麺種 1 件が設定の単位であり、硬さごとに切り出すと「使われている」の定義が二つになる。
 *   - **`arms` は畳む。** 計画が Arms_Overflow で読む（lift-group-planning）ので、変われば採点が変わりうる。
 *   - **`toleranceRatio`（SyncParams）は畳まない。** 計画へ届く経路は Boil_Sync による running の実効
 *     endTime の変化ただ一つで、その実効 endTime は既に上で畳んである。二重に畳めば、「解放表が 1 ミリ秒も
 *     動かないパラメータ変更」で要求が出る——変わっても計画が変わらない値を含めないという上の基準に
 *     そのまま反する。畳まないことで抑制の判定は「計画の入力が変わったか」に厳密に留まる。
 *   - **`now` は含めない。** 含めれば指紋は毎回変わり、抑制（AC 5.6）が一度も働かない——「前回依頼時から
 *     入力が変わったか」を問う仕組みが、時計が進んだだけで常に「変わった」と答えることになる。時間の経過は
 *     確かに計画（解放表の下限・過ぎた推奨の陳腐化）を動かすが、それは**状態変化のたびに再評価される**もので
 *     あって外部へ問い直す理由ではない。時刻起動の失効判定を持たない規律（AC 7.5）とここで揃う。
 *
 * **列挙順に依存しない**（AC 4.3 と同じ規律）。計画対象は planTargets が正準順序へ整列済み。Timer は id 昇順、
 * slotIds は符号単位順、麺プリセットは麺種の符号単位順へ整列してから畳む。文字列比較に localeCompare を
 * 用いない（環境の locale という隠れた入力を決定性の要求へ混ぜない・schedule.ts と同じ判断）。
 *
 * **整数演算のみで畳む**（浮動小数の丸めによる非決定性を排除する。Boil_Sync の整数スケール方針と同じ規律）。
 * **暗号強度は要らない。** 衝突の代償は「改善の要求が 1 回出ない」ことだけで、次の状態変化で必ず出る。
 * ゆえに FNV-1a 風の 32bit 畳み込みで足りる（client の noodleColor が同じ形をパレット割当に用いているが、
 * あちらは「色をどう割り当てるか」であってこちらは「入力が変わったか」——概念が違うので共有しない）。
 */
export function digestInput(
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  params: SettleParams,
): InputDigest {
  const targets = planTargets(pending);
  const occupants = [...running].sort(byTimerId);

  let digest = FNV_OFFSET_BASIS;
  // 数値は文字列へ写してから畳む。Number → String は ECMAScript が一意に定めるため丸めの自由度がなく、
  // 畳み込み自体（xor と imul）は整数演算だけで閉じる。
  const fold = (value: string | number): void => {
    digest = foldText(digest, typeof value === "string" ? value : String(value));
  };

  fold(targets.length);
  for (const order of targets) {
    fold(order.externalOrderId);
    fold(order.itemIndex);
    fold(order.noodleType);
    fold(order.firmness);
    // 単独グループ（tableId が null）は空文字へ写す。tableId は非空文字列に限られる（domain/order.ts）ため
    // 本物の卓 id と衝突しない。
    fold(order.tableId ?? "");
    fold(order.arrivalTime);
    // 占める釜の数は割当に効く（大盛は 2 釜）。
    fold(order.slotSpan);
  }

  fold(occupants.length);
  for (const timer of occupants) {
    fold(timer.id);
    const slotIds = [...timer.slotIds].sort(byCodeUnit);
    fold(slotIds.length);
    for (const slotId of slotIds) fold(slotId);
    fold(adjustedEndTime(timer));
  }

  fold(params.orderSyncWeight);
  fold(params.tableSyncWeight);
  fold(params.affinityWeight);
  fold(params.arms);
  fold(params.toleranceRatio); // 合流の窓 h_i を導く（判断 18）
  fold(params.orderSyncToleranceSeconds);
  fold(params.tableSyncToleranceSeconds);
  fold(params.affinityToleranceDistance);
  // レイアウトは距離の唯一の出所ゆえ座標そのものを畳む。原点の数は unitCount（釜の数）＝置ける場所の全体。
  fold(params.unitOrigins.length);
  for (const origin of params.unitOrigins) {
    fold(origin.x);
    fold(origin.y);
  }
  // オフセットは 6 要素タプルで長さが型に固定されているため件数を畳む必要がない。
  for (const offset of params.slotOffsets) {
    fold(offset.x);
    fold(offset.y);
  }

  // 麺プリセットは計画対象が引く分だけ（drawnPresets が範囲と正準順序の双方を定める）。
  const presets = drawnPresets(params.noodlePresets, targets);
  fold(presets.length);
  for (const preset of presets) {
    fold(preset.noodleType);
    // 硬さは FIRMNESS_ORDER で走る（Record の列挙順ではなく domain が定める並びを唯一の正準順序にする）。
    for (const firmness of FIRMNESS_ORDER) fold(preset.boilSeconds[firmness]);
  }

  return (digest >>> 0) as InputDigest;
}

/**
 * 計画対象が引く麺プリセットを、麺種の符号単位順で返す。
 *
 * **同一麺種の重複は相対順序を保つ。** 引き当ては先頭一致（schedule.ts の toBoiling が presets.find を使う）
 * ゆえ、同じ麺種が二度現れる設定では**どちらが先か**が計画を変える実在の事実である。Array.prototype.sort は
 * 安定（ES2019 以降）なので、麺種だけを鍵に整列すれば、事実でない並び（別の麺種どうしの順序）だけが
 * 正準化され、事実である並び（同一麺種の遮蔽関係）は保たれる。
 */
function drawnPresets(
  presets: readonly NoodlePreset[],
  targets: readonly PendingOrder[],
): readonly NoodlePreset[] {
  const drawn = new Set(targets.map((order) => order.noodleType));
  return presets
    .filter((preset) => drawn.has(preset.noodleType))
    .sort((preset, other) => byCodeUnit(preset.noodleType, other.noodleType));
}

/** FNV-1a の 32bit オフセット基底。 */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a の 32bit 素数。Math.imul で 32bit に閉じた乗算を行う。 */
const FNV_PRIME = 0x01000193;

/**
 * 1 つの値を畳み込む。符号単位を順に混ぜ、最後に**長さ**を混ぜる。
 *
 * 長さを混ぜるのは値の境界を立てるためである。区切り文字（NUL 等）に頼ると、その文字が値の中に
 * 現れ得る限り "ab" + "c" と "a" + "bc" が同じ指紋になる余地が残る（externalOrderId は非空文字列で
 * あることしか検証されない）。長さを混ぜれば、現れない文字を仮定せずに境界が立つ。
 */
function foldText(digest: number, text: string): number {
  let folded = digest;
  for (let i = 0; i < text.length; i++) {
    folded ^= text.charCodeAt(i);
    folded = Math.imul(folded, FNV_PRIME);
  }
  folded ^= text.length;
  return Math.imul(folded, FNV_PRIME);
}

/** Timer の正準順序（id 昇順）。id は一意ゆえ全順序になり、列挙順に依存しない。 */
function byTimerId(timer: Timer, other: Timer): number {
  if (timer.id === other.id) return 0;
  return timer.id < other.id ? -1 : 1;
}

/** 文字列の符号単位順。slotIds の並びを正準化する（並びは事実ではなく列挙順である）。 */
function byCodeUnit(text: string, other: string): number {
  if (text === other) return 0;
  return text < other ? -1 : 1;
}
