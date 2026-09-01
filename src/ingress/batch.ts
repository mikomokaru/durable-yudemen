// src/ingress/batch.ts — Arrival_Batch の解釈。生値 → 検証済みの形 または null（既存の toPendingOrders /
// toOrderIntent と同型の規律）。cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここは上流ペイロードが本経路へ入る唯一の関門である。domain（PendingOrder・Firmness）へ一方向に依存する
// 場所であって、domain はこの形を知らない——運搬の形は共有契約の中立地帯へ置かない。
//
// **payload の構造を型として書かない**（Pass_Through の型による表明）。ここに POS ペイロードの構造を
// 書けば、ベンダーがフィールドを 1 つ足した瞬間に型が嘘になる。構造を知るのは翻訳の局所だけで、
// 運搬の型は知らない。ゆえに payload は Record<string, unknown> のまま運ぶ。

/**
 * ArrivalBatch — 上流が送る 1 リクエストのボディ。
 *
 * **records の各要素を生値のまま保つ。** 検証に落ちた要素は隔離（contract-violation）へ回る経路が
 * 検証前の生値を要するため、この段で落とせば欠落になる（型違反の Record は ArrivalRecord を構築できない）。
 * ゆえに本型が表明するのは「ボディが records 配列を成している」というただ一つの事実であり、
 * 個々の Record の分類は別の型（RecordOutcome）が表す。
 */
export interface ArrivalBatch {
  readonly records: readonly unknown[];
}

/**
 * ArrivalRecord — Arrival_Batch の 1 要素で、4 つの構造検証を通ったもの。
 *
 * payload は解釈せず生のまま持つ。path・arrivalTimestampMs・sequenceNumber は上流が観測から付与する
 * メタデータであり、payload とは層が違う——これらに構造・型の要件を課すことは素通し原則の例外にあたらない
 * （AC 14.10・14.11）。
 */
export interface ArrivalRecord {
  readonly path: string;
  readonly payload: Record<string, unknown>;
  readonly arrivalTimestampMs: number;
  readonly sequenceNumber: string;
}

/**
 * toArrivalBatch — リクエストボディの生値を Arrival_Batch へ写す。
 *
 * **null を返すのはボディが records 配列を成さないときだけである**（それが 400 になる・AC 1.11）。
 * 個々の Record の妥当性を理由にバッチを落とさない——Record 間に原子性は無く（Arrival_Batch は上流
 * ストリームの配信単位にすぎない）、1 件の異常でバッチ全体を落とせば同一バッチの他店舗まで止まる。
 *
 * 空配列は受理する（全件が上流で除外された結果の空配列を失敗としない・AC 1.12）。
 */
export function toArrivalBatch(raw: unknown): ArrivalBatch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const records = (raw as Record<string, unknown>).records;
  if (!Array.isArray(records)) return null;
  // 余剰フィールドを落として正規化する（ボディの混ぜ物を下流へ運ばない）。要素自体は書き換えない。
  return { records };
}

/**
 * MissingStructure — 4 構造検証のうち最初に破れたもの。
 *
 * **破れた構造を名で返すのは、破れ方によって結末が違うためである。** `path` / `payload` /
 * `sequence_number` の欠落は毒（飛ばして数える）、`arrival_timestamp_ms` の型違反は上流の契約違反
 * （隔離する）へ写る。真偽値だけを返せば、この名づけを分類側（outcome.ts）が同じ 4 つの述語を書き直して
 * 行うことになり、どちらで見たかによって同じ Record の可否が分かれる余地が生まれる。
 */
export type MissingStructure = "path" | "payload" | "arrival-timestamp" | "sequence-number";

/** 構造検証の結果。通れば検証済みの Record、破れれば破れた構造の名を運ぶ。 */
export type RecordStructure =
  | { readonly ok: true; readonly record: ArrivalRecord }
  | { readonly ok: false; readonly missing: MissingStructure };

/**
 * readRecordStructure — records の 1 要素の構造を読む。**検証するのはこの 4 つだけで、ここだけである。**
 *
 * ・path が非空文字列である（分岐の判別基準が空文字では立たない）
 * ・payload がオブジェクトである（配列・null は payload の形ではない）
 * ・arrivalTimestampMs が非負整数である（Order_Arrival_Time の起点になる値・AC 8.6）
 * ・sequenceNumber が非空文字列である（冪等の単調性の比較対象・空文字は何も上回れない）
 *
 * **payload の中身は一切検証しない。** 未知フィールド・想定外の値・想定と異なる型はいずれも拒否事由に
 * しない（AC 14.2〜14.4・14.6）。payload は書き換えず、その参照をそのまま運ぶ（AC 14.5）。
 *
 * 検証規則をこの 1 箇所に閉じるのは、分類（RecordOutcome）も再生も同じ規則を通すためである。
 */
export function readRecordStructure(raw: unknown): RecordStructure {
  if (typeof raw !== "object" || raw === null) return { ok: false, missing: "path" };
  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.path !== "string" || candidate.path.length === 0)
    return { ok: false, missing: "path" };

  const payload = candidate.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, missing: "payload" };
  }

  // NaN / Infinity は比較をすり抜けるため整数性を先に要求する。
  const arrivalTimestampMs = candidate.arrival_timestamp_ms;
  if (
    typeof arrivalTimestampMs !== "number" ||
    !Number.isInteger(arrivalTimestampMs) ||
    arrivalTimestampMs < 0
  ) {
    return { ok: false, missing: "arrival-timestamp" };
  }

  const sequenceNumber = candidate.sequence_number;
  if (typeof sequenceNumber !== "string" || sequenceNumber.length === 0) {
    return { ok: false, missing: "sequence-number" };
  }

  // 余剰フィールドを落として正規化する。payload だけは中身に触れず参照のまま運ぶ。
  return {
    ok: true,
    record: {
      path: candidate.path,
      payload: payload as Record<string, unknown>,
      arrivalTimestampMs,
      sequenceNumber,
    },
  };
}

/**
 * toArrivalRecord — records の 1 要素を ArrivalRecord へ写す。破れた構造の名を要さない呼び出し元のための形。
 *
 * 検証は `readRecordStructure` に閉じており、ここは名を落とすだけである（規則を二度書かない）。
 */
export function toArrivalRecord(raw: unknown): ArrivalRecord | null {
  const structure = readRecordStructure(raw);
  return structure.ok ? structure.record : null;
}
