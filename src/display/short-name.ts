// display/short-name.ts — 札（Short_Name）の型と、生値を確立する 2 つの関門。
//
// 札は「商品名に与える 8 コードポイント以内の表示用の短い名」であり、**名前の出所ではない**。出所は POS の
// 申告値（`OrderItem.itemName`）のままで、ここに在るのは申告名をキーに引く被せ物である
// （`slot-suggested-start` 判断 8「設定に名前表は設けない」を破らない）。
//
// `cloudflare:workers` にも storage にも触れない純粋モジュール。client（辞書を引く側）と worker（辞書を
// 作る側）の双方が import する中立地帯ゆえ、片側の都合を持ち込まない。
//
// **一意性を検査しない。** 異なる商品が同じ札を持つ状態を不正としない（requirements 判断 7）。完全な防止には
// 単一の書き手と強整合のストレージが要り、KV では読み取り→検査→書き込みを不可分にできない。ゆえに
// `toShortName` は辞書を引数に取らず、候補 1 件と元の名前だけを見る局所的な関門である。区別の良し悪しは
// 生成の指示（`SHORT_NAME_PROMPT`）が担う。

import { isRecord } from "../domain/predicate";

/**
 * 札の上限。**コードポイントで数える**（表示幅ではない・requirements 判断 4）。
 *
 * 表示幅で数えると、半角の `A` / `B` / `C` を含むセット名（`特味噌ラーメンAセット` 等・実データに 15 件）
 * だけが長くなれる規則になる。レールの行に入るのは全角 6 字程度で、そこへ長い札を通す方向へ効かせない。
 */
export const SHORT_NAME_MAX_LENGTH = 8;

/**
 * 辞書のエントリ。`short`（札を与える）か `plain`（考えた結果、略さない）の 2 値。
 *
 * **エントリが無いことは `plain` と別の事実である。** 前者は「まだ考えていない」で生成の起点になり、後者は
 * 「考えた結果」で二度と AI を呼ばない。番兵文字列（`"NONE"` 等）で表さないのは、札が `"NONE"` という商品が
 * 在ると読める余地を作らないためである。
 *
 * client からは両者の区別が要らない——`plain` も「辞書に無い」も全名を出すという同じ挙動になる。ゆえに配信
 * される対応表（`ShortNames`）には `short` だけが載る。判別が要る場所にだけ判別を置く。
 */
export type ShortNameEntry =
  | { readonly kind: "short"; readonly label: string }
  | { readonly kind: "plain" };

/**
 * client が引く形。NFKC 正規化後の申告名 → 札。`plain` と未登録はどちらも「鍵が無い」として現れる。
 *
 * `ReadonlyMap` で受け、resolver 関数（`NoodleColor` の形）にしない——`get` が既に全域関数であり、包む層が
 * 増えるだけである。
 */
export type ShortNames = ReadonlyMap<string, string>;

/**
 * 応答から候補の生文字列を取り出す唯一の関門。取り出せなければ `null`。
 *
 * **Workers AI の応答は OpenAI 形である。** `choices[].message.content` は `string | null` で、隣に
 * `refusal: string | null` が在る（`glm-5.3-flash` の `sync-output.json`）。`{ response: ... }` ではない。
 * `content` は JSON schema を指定していても**文字列**として返るため、ここで一度だけ `JSON.parse` する。
 *
 * 取り出せない形（`content` が非文字列＝`null`・refusal・欠落、JSON として壊れている、`short` が文字列で
 * ない）はすべて `null` へ畳む。呼び出し側はこれを検査落ちと同じ経路へ流す——経路を増やさないためであり、
 * 「モデルが何を返したか」の分類は生成の記録（監査）に残せば足りる。
 *
 * **正規化はここでしない。** 正規化と検査は `toShortName` が一度に行い、その戻り値だけが保存・配信へ進む。
 * ここで正規化すると「正規化した値」と「検査した値」が二箇所で作られ、ずれる余地が生まれる。
 */
export function toShortNameCandidate(response: unknown): string | null {
  if (!isRecord(response)) return null;
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  // refusal が在るときも content は null になる。型で落ちるので refusal 自体は読まない
  // （読めば「拒否」という 3 つ目の結末が生まれ、畳み先は同じ `null` である）。
  if (typeof content !== "string") return null;
  const parsed = parseJson(content);
  if (!isRecord(parsed)) return null;
  const short = parsed.short;
  return typeof short === "string" ? short : null;
}

/**
 * 候補を NFKC 正規化し、3 条件を検査して**正規化後の札**を返す。落ちれば `null`。
 *
 * **真偽値ではなく値を返す**（`toDeclaredName` / `toGridPoint` / `toMenuItem` と同じ作法）。真偽値だと、
 * 検査を通った候補を**生のまま保存する**経路が残る——`特味噌ﾈｷﾞﾗｰﾒ` は正規化すれば 8 字かつ部分列だが、
 * 生は 9 コードポイントで `特味噌ネギラーメン` の部分列でもない。検査した性質が表示値に成立しない。値を返す
 * 関門はこの経路を作らない。**戻り値をそのまま保存し、そのまま配信する。**
 *
 * 条件は 3 つだけである。
 *   1. 非空
 *   2. `SHORT_NAME_MAX_LENGTH` 以下（コードポイント）
 *   3. 元の名前にある文字だけで組まれていること（**多重集合の包含**。文字を足さない）
 *
 * 文字種の検査は持たない——3 が「元名に無い文字は使えない」を構造的に与える。味の系統やセット種別
 * （`A` / `B` / `C`）の保持も条件にしない。**これは技術的な制約ではなく方針の選択である**——元名と候補だけで
 * 検査でき辞書も要らないが、多少の衝突を許容すると決めた以上（判断 7）、区別の度合いを機械が一律に裁く条件を
 * 重ねても守られる不変が生まれない。検査は「元の名前から削っただけであること」に限り、良し悪しは指示へ預ける。
 *
 * `name` 側も正規化してから突き合わせる。辞書の鍵は正規化後の名前であり、半角カナ（`旨辛ｽﾀﾐﾅﾗｰﾒﾝ`）の
 * 申告値をそのまま渡されても同じ判定に落ちる。
 */
export function toShortName(candidate: string, name: string): string | null {
  const label = candidate.normalize("NFKC");
  const length = [...label].length;
  if (length === 0 || length > SHORT_NAME_MAX_LENGTH) return null;
  if (!usesOnlyCharactersOf(label, name.normalize("NFKC"))) return null;
  return label;
}

/**
 * `a` が `b` の文字だけで組まれているか（**多重集合の包含**）。同じ文字を `b` にある回数までしか使えない。
 *
 * **並び替えを許す。** `味噌ラーメンAセット` に対する `A味噌` は通る——セット種別を先頭へ動かす形
 * （`A味噌` / `B塩`）を生成の指示が求めており（判断 33）、順序を固定したままでは実現できない。
 *
 * **守っているのは「元の名前に無い文字を使わせない」ことである。** これが `特味噌` を `醤油` と言い換える
 * 取り違えを潰す芯であり、順序はその芯ではない。並び替えても出所の文字は変わらないので、別の商品の名を
 * 名乗ることはできない。
 *
 * 文字はコードポイント単位で数える——`[...s]` はサロゲートペアを 1 要素として回すため、絵文字や異体字が
 * 混ざっても文字の途中で切らない。入力は最長 11 字ゆえ素朴な計数で足りる。
 */
export function usesOnlyCharactersOf(a: string, b: string): boolean {
  const available = new Map<string, number>();
  for (const character of b) available.set(character, (available.get(character) ?? 0) + 1);
  for (const character of a) {
    const left = available.get(character) ?? 0;
    if (left === 0) return false;
    available.set(character, left - 1);
  }
  return true;
}

/** JSON として読めなければ `undefined`（例外を呼び出し側へ漏らさない）。 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
