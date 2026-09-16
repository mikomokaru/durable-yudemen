// display/dictionary.ts — 札の辞書（KV）の読み書き。3 操作しか持たない。
//
// **KV の実体を import しない。** store は引数で受け、型だけを参照する（`KVNamespace` は生成 Env と同じ
// ambient 型）。ゆえに本モジュールは `cloudflare:workers` にも storage にも触れず、node 環境で検証できる。
// 実 binding を通す検査は Worker 配線の統合テストが担う。
//
// **鍵は名前ごとに 1 件。** 単一の値へ畳むと、同時書き込みが他のエントリごと巻き戻す。名前ごとなら書き込みが
// 独立し、巻き戻りは同じ名前の中に閉じる（requirements 判断 17）。
//
// **札は metadata に置き、値は監査の記録に使う。** 全件は `list()` 1 回（続きは cursor）で読め、値を読む必要が
// ない——これが `readShortNames` を安く保つ要である（metadata の上限は 1,024 バイト）。値は配信経路に載らない。
//
// **上書きを防がない。** 条件付き書き込みも一意性の予約も持たない。並行生成の後勝ちは許容する判断であり
// （判断 12）、防ぐには単一の書き手と強整合のストレージが要る。人が書き換える・削除する経路も持たない（判断 11）。

import { isRecord } from "../domain/predicate";
import type { ShortNameEntry } from "./short-name";

/**
 * 本モジュールが使う KV の能力だけを写した型。`KVNamespace` 全体を受けない。
 *
 * 全体を受ければ「`delete` も `get` も使うかもしれない」と型が嘘をつく。3 操作に絞ることが、上書きを防がず
 * 削除の経路も持たないという判断を型で表明する手段でもある。`KVNamespace` がこの形を満たすことは
 * テスト側の型検査で固定する。
 */
export interface ShortNameStore {
  list(options?: { readonly cursor?: string }): Promise<{
    readonly keys: readonly { readonly name: string; readonly metadata?: unknown }[];
    readonly list_complete: boolean;
    readonly cursor?: string | undefined;
  }>;
  getWithMetadata(key: string): Promise<{
    readonly value: string | null;
    readonly metadata: unknown;
  }>;
  put(key: string, value: string, options?: { readonly metadata?: unknown }): Promise<void>;
}

/**
 * 生成の記録。**配信経路に載らない**（`GET /display/short-names` は metadata の札だけを返す）。
 *
 * 訂正の経路を持たないと決めた以上（判断 11）、「なぜこの札になったか」を後から読めることが唯一の手がかりに
 * なる。ゆえに `declaredName` は**正規化前の申告値そのまま**を持つ——鍵（正規化後）からは復元できない。
 * `attempts` には落ちた候補とその理由を残す。空配列は「一度で通った」を意味する。
 */
export interface ShortNameRecord {
  /** POS が申告した生の商品名（半角カナを含みうる）。鍵は正規化後なので、ここにしか残らない。 */
  readonly declaredName: string;
  /** 判断が確定した時刻（エポックミリ秒）。 */
  readonly decidedAt: number;
  /** 呼んだモデルの ID。8 字以内で AI を呼ばなかった場合は null。 */
  readonly model: string | null;
  /** 落ちた候補と理由。通らなかった試行だけを順に残す。 */
  readonly attempts: readonly { readonly candidate: string | null; readonly rejected: string }[];
}

/** metadata の形。`list()` が返す 1,024 バイトの枠に収めるため鍵を 1 文字にする。 */
type EntryMetadata = { readonly k: "s"; readonly l: string } | { readonly k: "p" };

/**
 * 辞書の全件を読む。`list()` を回し、`list_complete` が偽なら `cursor` で続きを読む。
 *
 * **値を読まない。** 判別と札は metadata に在り、値（監査の記録）は配信にも初出判定にも要らない。全件で
 * `get` を回せば件数分の読み取りになる——`list()` が metadata を返すことが、この設計を成り立たせている。
 *
 * metadata が読めない鍵は**その 1 件だけを落とす**。壊れた 1 件で辞書全体を失えば、全商品が全名へ戻る。
 * 落ちた鍵はエントリを持たないものとして扱われ、次の到着で改めて生成される。
 */
export async function readShortNames(store: ShortNameStore): Promise<Map<string, ShortNameEntry>> {
  const entries = new Map<string, ShortNameEntry>();
  let cursor: string | undefined;
  do {
    // 逐次 await は意図的。次のページの鍵は前のページが返す cursor でしか得られず、
    // 並列化（Promise.all）が成り立たない形の走査である。
    // oxlint-disable-next-line no-await-in-loop
    const page = await store.list(cursor === undefined ? undefined : { cursor });
    for (const key of page.keys) {
      const entry = toEntry(key.metadata);
      if (entry !== null) entries.set(key.name, entry);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return entries;
}

/**
 * 1 件を読む。未登録なら `null`。
 *
 * **未登録と `plain` を区別する**——前者は「まだ考えていない」で生成の起点になり、後者は「考えた結果」で
 * 二度と AI を呼ばない。存在の判定は値の有無で行う（書き込みは常に記録を値として置くため、値が無い鍵は
 * 存在しない鍵である）。値が在るのに metadata が読めない鍵は、壊れているので未登録として扱う。
 */
export async function readShortName(
  store: ShortNameStore,
  key: string,
): Promise<ShortNameEntry | null> {
  const found = await store.getWithMetadata(key);
  if (found.value === null) return null;
  return toEntry(found.metadata);
}

/**
 * 1 件を書く。判別と札は metadata へ、記録は値へ。
 *
 * **既存を読まない。** 条件付き書き込みも存在確認もしない——後勝ちを許容する判断（判断 12）を、防ごうとして
 * 中途半端に守る形にしない。読んで分岐すれば「読んだ後・書く前」の窓が残り、防げていないのに防いだつもりの
 * コードになる。
 */
export async function writeShortName(
  store: ShortNameStore,
  key: string,
  entry: ShortNameEntry,
  record: ShortNameRecord,
): Promise<void> {
  const metadata: EntryMetadata = entry.kind === "short" ? { k: "s", l: entry.label } : { k: "p" };
  await store.put(key, JSON.stringify(record), { metadata });
}

/** metadata をエントリへ写す。読めなければ `null`（呼び出し側は未登録と同じに扱う）。 */
function toEntry(raw: unknown): ShortNameEntry | null {
  if (!isRecord(raw)) return null;
  if (raw.k === "p") return { kind: "plain" };
  if (raw.k !== "s") return null;
  // 札が空文字・非文字列の metadata は壊れている。空の札を配れば全名との区別が付かない。
  return typeof raw.l === "string" && raw.l.length > 0 ? { kind: "short", label: raw.l } : null;
}
