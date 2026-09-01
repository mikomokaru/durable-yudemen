// src/ingress/outcome.ts — 1 Record の分類。生値 1 件が本経路でどう扱われるかを判別可能な和型で表す。
//
// batch.ts が「ボディが records 配列を成すか」という 1 つの事実だけを表明するのに対し、ここは
// 個々の Record の帰結を表す。両者を分けるのは、Record 間に原子性が無いためである——Arrival_Batch は
// 上流ストリームの配信単位にすぎず、1 件の異常でバッチ全体を落とせば同一バッチの他店舗まで止まる。
//
// cloudflare:workers にも storage にも触れない純粋モジュール。

import { isWithinArrivalWindow } from "./arrival-window";
import { type ArrivalRecord, readRecordStructure } from "./batch";
import { toUniqueKey } from "./unique-key";

/**
 * PoisonReason — 毒レコードの事由。診断ログが `sequence_number` と理由の 2 項目を要するため
 * （AC 9.3）、理由は文字列として運べる閉じた集合で表す。ペイロード本体はログへ出さない。
 *
 * **4 事由に限る。** 未知フィールドの混入・想定外の値・想定と異なる型はいずれも毒の事由にしない
 * （Pass_Through・Requirement 14）。ここに挙がるのはどれも「処理を進めるために要る構造が欠けている」
 * ものだけであり、retry しても直らない。
 */
export type PoisonReason =
  /** `path` が無い・空文字。`path` による分岐（Requirement 7）の判別基準が立たない。 */
  | "path-missing"
  /** `payload` がオブジェクトとして無い。Unique_Key の 4 要素を読み出す先が無い。 */
  | "payload-missing"
  /** `sequence_number` が無い・空文字。単調性の比較対象が無く冪等が成立しない（Req 10.4）。 */
  | "sequence-number-missing"
  /** Unique_Key の 4 要素のいずれかが欠落・null・空文字。オーダーを識別できない（AC 6.18）。 */
  | "unique-key-incomplete";

/**
 * RecordOutcome — 1 Record の分類。5 種のいずれかに必ず落ちる（分類は全域である）。
 *
 * **Transient_Failure をここに含めない。** 一時的失敗は Record の分類ではなく「処理が進められなかった」
 * という別の軸である（`ReceiveOutcome` と例外が表す）。混ぜれば「一時的な Record」という表現不能な
 * 概念が型に現れる。
 *
 * `sequenceNumber` を optional にするのは、seq を取り出せない Record（`sequence-number-missing` の毒、
 * および型違反）が実在するためである。`exactOptionalPropertyTypes` ゆえ、値が無い場合は
 * `sequenceNumber: undefined` ではなくフィールドを省く。
 */
export type RecordOutcome =
  /** Order_Path。Pending_Order への写像（Requirement 6）の対象はこれだけである（AC 7.2）。 */
  | { readonly kind: "order"; readonly record: ArrivalRecord; readonly uniqueKey: string }
  /**
   * Status_Path。意図的な破棄先（blackhole）へ落とす（AC 7.5）。
   *
   * **`unknown-path` と別種別に保つ。** 破棄という挙動は同一だが事由が異なる——こちらは既知の
   * `path` であって本 spec が扱わないだけであり、Permanent_Failure ではない（AC 7.8）。件数も別の
   * カウンタで数える（AC 7.9）。混ぜれば「未知 `path` が毎秒届いている」という誤った観測になる。
   */
  | { readonly kind: "status"; readonly sequenceNumber?: string }
  /** 既知 `path` のいずれでもない。Permanent_Failure として飛ばして数える（AC 7.3・7.4）。 */
  | { readonly kind: "unknown-path"; readonly sequenceNumber?: string }
  /** 毒レコード。飛ばして継続し、seq と理由の 2 項目を診断ログへ出す（AC 9.2・9.3）。 */
  | { readonly kind: "poison"; readonly reason: PoisonReason; readonly sequenceNumber?: string }
  /**
   * 上流の契約違反。`contract-violation:{storeCode}` へ 2 時間隔離する（再生しない）。
   *
   * **検証前の生値を運ぶ。** 型違反の Record は `ArrivalRecord` を構築できない
   * （`arrivalTimestampMs: number` を満たせない）ため、隔離の対象は検証前の値である。値域窓の外
   * （型は正しいが値が窓外・AC 8.15）も同じ形で運び、落とし所を 1 つに保つ——両者は原因が同じ
   * （上流が保証すべき値の異常）で扱いも同じゆえ、種別を分けない。
   */
  | {
      readonly kind: "contract-violation";
      readonly raw: unknown;
      readonly sequenceNumber?: string;
    };

/** 既知 `path` が導く分類。未知は集合の外にあることの帰結ゆえ、ここには現れない。 */
export type KnownPathKind = Extract<RecordOutcome["kind"], "order" | "status">;

/**
 * KNOWN_RECORD_PATHS — 既知 `path` の集合（AC 7.7）。
 *
 * **`path` → 分類の写像として持つ。** 単なる集合にすれば「既知か」と「どちらの既知か」を別々に
 * 書くことになり、判別基準が二箇所に分かれる。写像なら、引けたことが既知であることであり、
 * 引いた値がそのまま分岐である。引けなければ `unknown-path` である。
 *
 * `Map` で持つのは任意の文字列を引数に取れる形にするためである（`Record` のリテラルキーでは
 * 引くたびに型の言い換えが要る）。`CodeIndex = ReadonlyMap<string, StoreId>` と同型。
 */
export const KNOWN_RECORD_PATHS: ReadonlyMap<string, KnownPathKind> = new Map<
  string,
  KnownPathKind
>([
  ["/lio/order", "order"],
  ["/lio/status", "status"],
]);

/**
 * toRecordOutcome — 生値 1 件を `RecordOutcome` へ分類する。**全域である**（どの入力にも 5 種のいずれかを
 * 返し、例外を投げない・Property 1）。
 *
 * **Worker にボディ解釈のロジックを持たせないための関門である**（AC 1.8）。Worker が持つのは分類の結果に
 * 対する分岐（届ける・数える）だけで、何が毒で何が契約違反かの判断はここに閉じる。
 *
 * `now` を引数で受け取り、内側で時計を読まない（純粋関数に時計を持ち込まない既存の規律）。窓の検査に
 * 要る唯一の外部の事実がこれである。
 *
 * 分類の順は次のとおりで、いずれも「その先の判断が立つか」で決まっている。
 *
 * 1. 構造（`readRecordStructure`）— 破れていれば毒か契約違反。**可否を決めるのは batch.ts ただ一箇所**で、
 *    ここは破れた構造の名を結末へ写すだけである。
 * 2. 値域窓 — 型は正しいが窓の外にある到着時刻は隔離へ（AC 8.15）。構造検証で落ちた型違反と原因が同じ
 *    （上流が保証すべき値の異常）で扱いも同じゆえ、落とし所を 1 つに保つ。
 * 3. `path` — 既知の 2 値のいずれでもなければ `unknown-path`（AC 7.3）。
 * 4. Unique_Key — Order_Path に限って導く。Status_Path は破棄先へ落ちるため識別子を要さない
 *    ——ここで先に導けば、破棄されるだけの Record が毒として数えられ「未知の注文が毒で消えている」
 *    という誤った観測になる（AC 7.9 の分離と同じ理由）。
 */
export function toRecordOutcome(raw: unknown, now: number): RecordOutcome {
  // 診断ログ（seq と理由の 2 項目・AC 9.3）のため、構造が破れた Record からも seq だけは拾う。
  const sequenceNumber = readSequenceNumber(raw);
  const structure = readRecordStructure(raw);
  if (!structure.ok) {
    switch (structure.missing) {
      case "path":
        return poisonOutcome("path-missing", sequenceNumber);
      case "payload":
        return poisonOutcome("payload-missing", sequenceNumber);
      case "sequence-number":
        return poisonOutcome("sequence-number-missing", sequenceNumber);
      case "arrival-timestamp":
        // 上流の契約違反（Upstream_Contract は型を保証する）。毒にすれば上流のバグでデータが静かに
        // 消えるため、生値のまま隔離へ運ぶ（AC 8.8・Duplicate_Bias）。
        return contractViolationOutcome(raw, sequenceNumber);
    }
  }
  const record = structure.record;
  if (!isWithinArrivalWindow(record.arrivalTimestampMs, now)) {
    return contractViolationOutcome(raw, record.sequenceNumber);
  }
  const known = KNOWN_RECORD_PATHS.get(record.path);
  if (known === undefined) {
    return { kind: "unknown-path", sequenceNumber: record.sequenceNumber };
  }
  if (known === "status") {
    return { kind: "status", sequenceNumber: record.sequenceNumber };
  }
  const uniqueKey = toUniqueKey(record.payload);
  if (uniqueKey === null) {
    return poisonOutcome("unique-key-incomplete", record.sequenceNumber);
  }
  return { kind: "order", record, uniqueKey };
}

/**
 * 構造が破れた生値からも `sequence_number` だけを拾う（診断ログの 2 項目の片方）。
 *
 * 読めるのは非空文字列のみで、`readDeclaredText` の緩さ（数値も読む）を持ち込まない——ここで数値を
 * 文字列へ写せば、`sequence-number-missing` の毒と診断ログに載る seq が食い違う。
 */
function readSequenceNumber(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const sequenceNumber = (raw as Record<string, unknown>).sequence_number;
  return typeof sequenceNumber === "string" && sequenceNumber.length > 0 ? sequenceNumber : null;
}

// seq が取れない Record が実在するため、`exactOptionalPropertyTypes` の下ではフィールドを省く形が要る
// （`sequenceNumber: undefined` は「値が無い」ではなく「undefined という値がある」ことになる）。
function poisonOutcome(reason: PoisonReason, sequenceNumber: string | null): RecordOutcome {
  return sequenceNumber === null
    ? { kind: "poison", reason }
    : { kind: "poison", reason, sequenceNumber };
}

function contractViolationOutcome(raw: unknown, sequenceNumber: string | null): RecordOutcome {
  return sequenceNumber === null
    ? { kind: "contract-violation", raw }
    : { kind: "contract-violation", raw, sequenceNumber };
}
