// display/detect.ts — 1 バッチ分の初出の検出と、リクエスト共通の締切の配分。
//
// 初出とは「辞書にエントリを持たない名前」であり、**保存された状態ではなく引き当ての結果**である。ゆえに
// 取りこぼしは壊れではない——エントリを書かずに終われば、当該商品が再び注文されたときに改めて初出と
// 判定される。拾い直しの契機は**当該商品の次の注文**であって、他の商品の注文では起きない。
//
// **締切は 2 段で持つ。** `ctx.waitUntil` の寿命は呼び出し 1 回に対して与えられ、その中の全処理が共有する
// （応答後 30 秒）。1 件あたりの上限（`SHORT_NAME_DEADLINE_MS`）だけでは、初出が複数あるバッチで後半の
// 保存が失われる。ゆえにリクエスト共通の締切を先頭で確定し、各 Generation の budget をそこから配る。
//
// **残り時間を読む規則は `budgetOf` の 1 箇所に置き、`await` をまたぐたびに呼び直す。** ループの先頭で
// 1 回引くだけでは足りない——辞書の読み取りはネットワークを待つので、引いた時点の残りは生成を始める
// 時点の残りではない。残り 2 秒のときに読み取りが 3 秒かかれば、締切を過ぎているのに 2 秒の budget で
// 生成が始まる。締切は「いつ測っても同じ絶対時刻」として持ち、残りはそのつど引く。

import { readShortName, readShortNames } from "./dictionary";
import type { ShortNameEntry } from "./short-name";
import { SHORT_NAME_DEADLINE_MS, generateShortName, type ShortNameDeps } from "./generate";

/**
 * 1 リクエストの全 Generation が共有する締切。`waitUntil` の 30 秒に対して 10 秒を残す。
 *
 * 残す 6 秒は、締切の直前に着手した Generation が保存まで到達するための余裕である（2026-09-15 に 20 秒から
 * 引き上げた——実測で 1 回の呼び出しが最大 26.6 秒かかり、当初の値では裾がすべて切れていた）。
 */
export const SHORT_NAME_REQUEST_DEADLINE_MS = 24_000;

/**
 * 1 リクエストが着手する初出の上限。
 *
 * 締切だけでも作業は有界だが、件数の上限を別に置くと**最悪ケースが時間に依らず読める**。着手した件数で
 * 数える（保存の成否では数えない）——失敗が上限を抜ける穴になれば、KV が落ちている間に 1 リクエストが
 * 無制限に AI を呼ぶ。
 *
 * **2026-09-15 に 4 から 1 へ下げた。** 実測で 1 回の呼び出しが最大 26.6 秒かかるため、複数件を 1 リクエストで
 * 捌こうとすると `waitUntil` の 30 秒に収まらない。1 件ずつでも収束は「当該商品の次の注文」に委ねる設計
 * （判断 25）なので成り立ち、再試行（判断 13）も残せる。
 */
export const SHORT_NAME_MAX_PER_REQUEST = 1;

/** これを下回る残り時間では新しい Generation を**始めない**（始めても待機に使える時間が無い）。 */
export const SHORT_NAME_MIN_BUDGET_MS = 1_000;

/**
 * isolate が持ち越す既知の鍵。`keys` が `null` は「この isolate でまだ一度も辞書を読んでいない」。
 *
 * **可変である。** worker のモジュール・スコープに 1 つ置き、isolate の生存中だけ持ち越す。失われても
 * 余計な `list()` が 1 回増えるだけで、正しさには効かない。
 *
 * 鍵を加えるのは**エントリの存在を観測した後か、保存が成功した後に限る**。書けていない鍵を既知にすると、
 * その名前は二度と生成されないのに辞書にも無い——全名のまま固定される。
 *
 * **鍵だけの集合では足りない。** 押し込む札そのものを取り出せないため、エントリを値として持つ（判断 29）。
 */
export interface ShortNameCache {
  entries: Map<string, ShortNameEntry> | null;
}

/** 押し込みの受け手。`StoreTimerDO` がこの形を満たす（binding の型をここへ持ち込まない）。 */
export interface ShortNamePushTarget {
  applyShortNames(entries: Readonly<Record<string, string>>): Promise<void>;
}

/** 店舗ごとの押し込み先を引く。`deps` から切り離すのは、検出の純粋な部分を実 binding 無しで回すためである。 */
export type ShortNamePush = (
  storeId: string,
  labels: Readonly<Record<string, string>>,
) => Promise<void>;

/**
 * バッチに現れた商品名から初出を見つけ、締切の許す範囲で札を生成する。
 *
 * 受け取るのは**生の申告名の列**である（payload の形は呼び出し側が知る）。正規化と重複除去はここで行う
 * ——鍵で畳みつつ**生の申告名を 1 つ保つ**（同じ鍵に複数の表記が混ざればバッチ内の先頭）。鍵だけを残すと
 * `旨辛ｽﾀﾐﾅﾗｰﾒﾝ` がこの段で `旨辛スタミナラーメン` になり、記録に残すべき元の表記を復元できない。
 *
 * **例外を外へ出さない。** 生成の失敗（保存の失敗を含む）は取り込みの失敗ではない。失敗した鍵は既知集合に
 * 加えず、当該商品の次の到着で再検出される。
 */
export async function detectFirstAppearance(
  deps: ShortNameDeps,
  cache: ShortNameCache,
  storeId: string,
  declaredNames: readonly string[],
  push: ShortNamePush,
): Promise<void> {
  const deadline = deps.now() + SHORT_NAME_REQUEST_DEADLINE_MS;

  // 鍵で重複を除きつつ、生の申告名を 1 つ保つ（先頭が勝つ）。
  const pending = new Map<string, string>();
  for (const declaredName of declaredNames) {
    if (declaredName.length === 0) continue;
    const key = declaredName.normalize("NFKC");
    if (!pending.has(key)) pending.set(key, declaredName);
  }
  if (pending.size === 0) return;

  // isolate の初回だけ全件を読む。この読み込みも締切の内側で起きる。
  if (cache.entries === null) {
    cache.entries = await readShortNames(deps.store);
  }
  const known = cache.entries;

  // 押し込みの積荷。**`short` だけを載せる**——`plain` は札を持たず、受け手にとって「辞書に無い」と同じ。
  const labels: Record<string, string> = {};

  // 第 1 巡：**在メモリで判る分を先に集める。** I/O を伴わないので、生成の上限にも締切にも掛からない。
  // 1 巡にまとめて break すると「初出 4 件 → 未登録 1 件 → 既知」の順で最後の既知が積まれない（AC 7.11）。
  const unknown: [string, string][] = [];
  for (const [key, declaredName] of pending) {
    const entry = known.get(key);
    if (entry === undefined) unknown.push([key, declaredName]);
    else if (entry.kind === "short") labels[key] = entry.label;
  }

  // 第 2 巡：知らない分だけを、上限と締切の下で解く。ここで break しても第 1 巡の収穫は残る。
  let started = 0;
  for (const [key, declaredName] of unknown) {
    if (started >= SHORT_NAME_MAX_PER_REQUEST) break;
    // 読み取りに入る前に 1 回。
    if (budgetOf(deps, deadline) === null) break;

    // 逐次 await は意図的。残り時間を見ながら 1 件ずつ着手する形であり、並列化すると配った budget の
    // 合計が締切を超える。
    //
    // **読み取りの失敗をここで捕らえる。** 外へ出すと関数ごと終わり、**1 巡目で集めた札まで押されない**
    // ——KV が一時的に読めないだけで、既に判っている札の配信が巻き添えになる。当該の名前だけを諦める。
    let entry: ShortNameEntry | null;
    try {
      // oxlint-disable-next-line no-await-in-loop
      entry = await readShortName(deps.store, key);
    } catch {
      continue;
    }
    if (entry === null) {
      // 読み取りの後に引き直す。ここまでに時間が過ぎている。
      const budget = budgetOf(deps, deadline);
      if (budget === null) break;
      started += 1;
      try {
        // **既に使われている札を渡す。** 在メモリの辞書から取るので追加の I/O は要らない。衝突を
        // 完全には防げない（判断 7）が、起きにくくはできる。
        // oxlint-disable-next-line no-await-in-loop
        entry = await generateShortName(deps, key, declaredName, budget, takenLabels(known));
      } catch {
        // 保存できていない（`generateShortName` は書き込みの失敗を拒否で伝える）。**既知にしない**
        // ——加えれば、辞書に無いのに二度と生成されない名前が生まれる。次の到着で再検出される。
        continue;
      }
    }
    known.set(key, entry);
    if (entry.kind === "short") labels[key] = entry.label;
  }

  // **既知も新規も同じ積荷に載せて押す。** 生成を飛ばしただけでは、別店舗が初めて観測した商品に札が
  // 永久に届かない（判断 29）。失敗は握り潰す——同じ商品が次に観測されれば同じ札がまた積まれる。
  if (Object.keys(labels).length > 0) {
    try {
      await push(storeId, labels);
    } catch {
      // 押し込めなかった。辞書には在るので、次の観測で積み直される。
    }
  }
}

/**
 * 締切までの残りから 1 件の budget を決める。始めるに足りなければ `null`。
 *
 * 残り時間を読む規則はここだけに在る。`await` のたびに呼び直すことを前提とした形であり、呼び出し側は
 * 引いた値を持ち回さない。
 */
function budgetOf(deps: ShortNameDeps, deadline: number): number | null {
  const remaining = deadline - deps.now();
  if (remaining < SHORT_NAME_MIN_BUDGET_MS) return null;
  return Math.min(SHORT_NAME_DEADLINE_MS, remaining);
}

/** 既に使われている札の一覧（`short` のものだけ）。生成の指示へ渡し、重複を起きにくくする。 */
function takenLabels(known: ReadonlyMap<string, ShortNameEntry>): readonly string[] {
  const labels: string[] = [];
  for (const entry of known.values()) if (entry.kind === "short") labels.push(entry.label);
  return labels;
}
