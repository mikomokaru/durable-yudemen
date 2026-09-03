// src/ingress/noodle-spec.ts — 品目 1 件の解釈。POS の商品コードから麺の 3 つの事実（麺種・茹で加減・
// スロット幅）を引く。cloudflare:workers にも storage にも触れない純粋モジュール。
//
// **判定と翻訳を 1 つの関数で返す。** 「茹でるか」と「何スロット要るか」は同じ入力（麺量の商品コード）から
// 導かれる。分ければ「麺量が在るか」を二度問うことになり、判定基準が二箇所に分かれる。
//
// batch.ts / outcome.ts が payload の構造を知らない運搬の層であるのに対し、ここは構造を知る翻訳の局所である。
// 知る範囲は 4 つのフィールド（親品目の `plu_no`・`child_items`・その各要素の `plu_no` と `item_name`）に限る。
// `item_type` は読まない（AC 6.23）。`qty` も読まない（実データでは常に 1・AC 6.35）。油の量・味の濃さは
// 茹で時間も slotSpan も変えないため写さない（AC 6.33）——素通し原則により、これらが想定外の値でも
// Record を拒否しない。

import { DEFAULT_FIRMNESS, type Firmness } from "../domain/firmness";
import type { FirmnessCode, MenuItem, NoodleSize } from "../domain/store";
import { toDeclaredName } from "../domain/predicate";

/**
 * NoodleLookup — 翻訳が要する対応表 2 枚。`StoreConfig` 全体を渡さない。
 *
 * 翻訳が読むのはこの 2 枚だけであり、`StoreConfig` を渡せば「ユニット数や同期の重みも見るかもしれない」と
 * 型が嘘をつく。2 枚を 1 枚に畳まないのは domain 側の判断（更新の主体と頻度が違う）をそのまま運ぶためである。
 *
 * `noodlePresets` を含めない。麺種が `noodlePresets` に在るかの照合は 3 層の合成後にしか判定できず、
 * 対応表に無い麺種を数えて弾くのは取り込みの段（宛先 DO）の関心事である——ここは「POS が何を注文したか」
 * を読むだけで、その麺が茹でられるかは問わない。
 */
export interface NoodleLookup {
  /** 硬さの商品コード → Firmness。空でよい（指定が解釈されず既定へ畳まれるだけ）。 */
  readonly firmnessCodes: readonly FirmnessCode[];
  /** 親商品コード → 麺種と麺量群。空なら茹で対象が 0 件になる（構造は成立する）。 */
  readonly menuItems: readonly MenuItem[];
}

/**
 * NoodleSpec — 1 品目を茹でるために要る 3 つの事実と、麺量の申告名。
 *
 * **POS の語彙を判定に用いない。** 商品コードは対応表と突き合わせる鍵としてのみ使い、商品名は判定に一切
 * 効かない。`sizeName` は申告された名前を**そのまま運ぶ**だけであり（表示のため）、麺種・茹で加減・
 * スロット幅はこれを見ずに定まる。名前を意味の判定へ持ち込めば、改名がそのまま解釈の変化になる。
 *
 * `boilSeconds` を持たない。秒は `noodlePresets` が noodleType × firmness で保つ唯一の出所であり、
 * ここへ写せば同じ真実が二箇所に生まれる。
 */
export interface NoodleSpec {
  /** 麺種（`noodlePresets` のキー）。親商品コードから引く。 */
  readonly noodleType: string;
  /** 茹で加減。指定が無ければ DEFAULT_FIRMNESS へ畳む。 */
  readonly firmness: Firmness;
  /** スロット軸上で占める幅。麺量の商品コードから引く。 */
  readonly slotSpan: number;
  /**
   * 麺量 child が申告した商品名（例 `"中盛"`）。欠落・空文字・型違い、および同一コードで名前が食い違う
   * ときは null。
   *
   * `slotSpan` と**同じ同定結果**から取る。別に引き直せば「どの child を麺量と見たか」が二箇所で語られ、
   * ずれる余地が生まれる。
   */
  readonly sizeName: string | null;
}

/**
 * toNoodleSpec — 品目 1 件を解釈する。麺量（Noodle_Size）を持たない品目は null（茹でない）。
 *
 * 判定基準は「当該品目の麺量の商品コードが `child_items` に在るか」ただ一つである（AC 6.21）。餃子・丼・
 * トッピング・飲料はいずれも麺量を持たないためここで null に落ちる。null を返す道は 2 つあるが、
 * どちらも同じ 1 つの事実の言い換えである——親商品コードが `menuItems` に無い品目は麺量コードを 1 つも
 * 持ちえない（麺量は親メニューが定める）。ゆえに「非 null ⟺ 麺量コードを持つ」は保たれる。
 *
 * 対応表が空でも構造は成立する（茹で対象が 0 件になるだけ・`[Q8]` の未提示が実装を止めない根拠）。
 */
export function toNoodleSpec(
  orderItem: Record<string, unknown>,
  lookup: NoodleLookup,
): NoodleSpec | null {
  const menuItem = findMenuItem(orderItem.plu_no, lookup.menuItems);
  if (menuItem === null) return null;

  const childNames = toChildNames(orderItem.child_items);
  const size = findNoodleSize(childNames, menuItem.sizes);
  if (size === null) return null;

  // 硬さの指定が無い品目は既定へ畳む。これは設定の欠落を畳むのではなく「POS が指定を送っていない」という
  // 入力の形に対する既定であり、対応表に無い麺種を畳まない規律（AC 6.28）とは層が違う。
  const firmness = findFirmness(childNames, lookup.firmnessCodes) ?? DEFAULT_FIRMNESS;

  // 名前は同定した麺量の商品コードで引く（slotSpan と同じ 1 度の同定から取る）。
  return {
    noodleType: menuItem.noodleType,
    firmness,
    slotSpan: size.slotSpan,
    sizeName: childNames.get(size.code) ?? null,
  };
}

/** 親品目の商品コードで対応表を引く。対応が無ければ null（麺量を定めるメニューが無い）。 */
function findMenuItem(rawProductCode: unknown, menuItems: readonly MenuItem[]): MenuItem | null {
  if (!isProductCode(rawProductCode)) return null;
  for (const menuItem of menuItems) {
    if (menuItem.productCode === rawProductCode) return menuItem;
  }
  return null;
}

/**
 * `child_items` の各要素を「商品コード → 申告された商品名」の写像として取り出す。
 *
 * **キー集合が位置に依らない判定の実体である**（AC 6.20）。`child_items` は意味の異なる品目を同居させた
 * 直列の並びで、配列の構造が意味を分けていない。位置を捨てれば、軸の指定が欠ける注文でも解釈がずれない。
 * `s_class_code` も判定に用いない——軸の識別は商品コードを対応表と突き合わせて行う。
 *
 * 集合ではなく写像にするのは、麺量として同定した child の商品名を**同じ同定結果から**取るためである
 * （`NoodleSpec.sizeName`）。判定に用いるのは引き続きキー（商品コード）だけで、名前は判定に一切効かない。
 *
 * **同一コードで名前が食い違えば `null` にする。** 先勝ちも後勝ちも並び順に依るため、どちらも「位置を
 * 捨てる」の規律を破る。位置に依らない結果は一つだけである——申告が曖昧なら名前を持たない。同じ名前の
 * 重複は曖昧でないため保つ。
 *
 * 配列でない・要素がオブジェクトでない・`plu_no` が商品コードでない場合は当該要素を無視する（素通し原則。
 * 想定外の形は Record の拒否事由にしない）。
 */
function toChildNames(rawChildItems: unknown): ReadonlyMap<number, string | null> {
  const names = new Map<number, string | null>();
  if (!Array.isArray(rawChildItems)) return names;
  for (const child of rawChildItems) {
    if (typeof child !== "object" || child === null) continue;
    const record = child as Record<string, unknown>;
    const code = record.plu_no;
    if (!isProductCode(code)) continue;
    const name = toDeclaredName(record.item_name)?.name ?? null;
    if (!names.has(code)) {
      names.set(code, name);
      continue;
    }
    // 既存と食い違えば曖昧ゆえ名前を落とす（キーは残す——判定は名前に依らない）。
    if (names.get(code) !== name) names.set(code, null);
  }
  return names;
}

/**
 * 当該メニューの麺量群を対応表の順に走査し、指定されている最初のものを返す。
 *
 * **走査の向きが対応表側であることが、位置に依らないことの担保である。** `child_items` 側から走査すれば、
 * 想定外に麺量が 2 つ指定された注文で結果が並び順に依ってしまう。対応表側から走れば、同じ集合には常に
 * 同じ麺量が対応する（決定的）。
 */
function findNoodleSize(
  childCodes: ReadonlyMap<number, string | null>,
  sizes: readonly NoodleSize[],
): NoodleSize | null {
  for (const size of sizes) {
    if (childCodes.has(size.code)) return size;
  }
  return null;
}

/** 硬さ対応表を表の順に走査し、指定されている最初のものを返す（findNoodleSize と同型・同じ理由）。 */
function findFirmness(
  childCodes: ReadonlyMap<number, string | null>,
  firmnessCodes: readonly FirmnessCode[],
): Firmness | null {
  for (const firmnessCode of firmnessCodes) {
    if (childCodes.has(firmnessCode.code)) return firmnessCode.firmness;
  }
  return null;
}

/**
 * 商品コードとして妥当か（正の整数）。券売機の商品コードは採番された正の整数である。
 *
 * 数値文字列を数へ寄せない。対応表の `code` は数値であり、型を跨いで突き合わせれば「どちらの表現が
 * 正か」という判断を推測で埋めることになる。
 */
function isProductCode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
