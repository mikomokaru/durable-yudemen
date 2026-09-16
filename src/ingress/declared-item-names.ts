// src/ingress/declared-item-names.ts — Arrival_Batch から親品目の申告名だけを拾う。
//
// 置き場が `src/ingress/` なのは、**payload の構造を知る層だから**である。`noodle-spec.ts` が
// 「1 品目を茹でるための 3 つの事実」を読むのに対し、ここは「その品目が何と名乗ったか」だけを読む。
// 同じ payload を 2 つの目的で読むが、知っているのは `order_items[].item_name` という 1 本の道だけで、
// `child_items` にも `plu_no` にも触れない（麺量の名前は札の対象ではない・固定表で 1 文字に畳む）。
//
// `cloudflare:workers` にも storage にも触れない純粋関数。呼ぶのは POS_Ingress の Worker だけで、
// 宛先 DO へは何も渡らない——札は厨房の事実ではない。
//
// **素通し原則に従う。** 読めない形は当該要素を飛ばすだけで、Record を拒否しない。名前が 1 件も取れなくても
// それは正常な入力であり（全品目が非麺の注文など）、呼び出し側は空の列を受ける。

import { isRecord } from "../domain/predicate";
import type { ArrivalRecord } from "./batch";

/**
 * Record 群から親品目の申告名を到着順に拾う。**正規化も重複除去もしない。**
 *
 * どちらも札の辞書側（`detectFirstAppearance`）の仕事である——鍵で畳みつつ生の表記を 1 つ保つ規則を
 * 二箇所に置かない。ここが返すのは「申告された生の文字列が、この順で届いた」という事実だけである。
 *
 * **`item_type` を読まない。** 茹で対象かどうかの判定は麺量 child の有無で決まり（`noodle-spec.ts`）、
 * その判定をここで真似れば二つ目の真実になる。結果として非麺の品目名（`半ﾗｲｽ` など）も混ざるが、
 * 辞書に余分なエントリが増えるだけで害はない——札は表示の被せ物であり、誤って混ざったものは
 * 画面に現れない（その名前の `OrderItem` が存在しないため）。
 *
 * 空文字は落とす。空の名前は鍵にならず、辞書の側でも弾かれる。
 */
export function declaredItemNames(records: readonly ArrivalRecord[]): readonly string[] {
  const names: string[] = [];
  for (const record of records) {
    const items = record.payload.order_items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isRecord(item)) continue;
      const name = item.item_name;
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  }
  return names;
}
