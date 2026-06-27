// observe/args.ts — Probe_Client 起動引数の検証（純粋）。
// cloudflare:workers にも fs にも WebSocket にも process にも触れない。実時間も持たない
// （純度の契約は src/observe/README.md）。接続試行・送信失敗・タイムアウト・非ゼロ終了は
// 端（tools/observe/probe.ts）の責務で、ここには「引数が受理可能か」だけを語る。
//
// 本ファイルは「wss:// スキームかつ空でない店舗識別子のときのみ接続を許す」という
// 唯一の判定（要件1.1）を純粋関数に閉じ込める。これにより端は判定を持たず、
// 判定は property（Property 12）で機械検証できる。

// ── 起動引数の検証結果（不正な状態を構築不能にする discriminated union） ─────────

/**
 * 起動引数の検証結果。受理なら正規化済みの endpoint / storeId、拒否なら理由を保持する。
 *
 * ok を判別子とし、拒否時に endpoint / storeId を持たないことを型で保証する——
 * 「拒否なのに接続先がある」という不正な状態を表現可能にしない（設計哲学）。
 *  - NotWssScheme: エンドポイントが wss:// スキームでない（要件1.1）。
 *  - EmptyStoreId: 店舗識別子が空（空白のみを含む・要件1.1）。
 */
export type ProbeArgs =
  | { readonly ok: true; readonly endpoint: string; readonly storeId: string }
  | { readonly ok: false; readonly reason: "NotWssScheme" | "EmptyStoreId" };

// ── 検証 ─────────────────────────────────────────────────────────────────────

/**
 * 起動引数を検証する（要件1.1）。
 *
 * エンドポイントが wss:// スキームであり、かつ店舗識別子が空でないときに限り ok:true を返す。
 * スキームを先に検査する（設計の判定順序）——スキームが不正なら接続先として成立しないため、
 * 店舗識別子の如何に依らず NotWssScheme を返す。次に店舗識別子の空（空白のみを含む）を検査する。
 *
 * 店舗識別子の「空」は前後の空白を除いた長さが 0 であることを指す（空白のみは空とみなす）。
 * 純粋関数であり、毎回新しい結果値を構築して返すだけで、いかなる外部状態も読まず変えない。
 */
export function validateProbeArgs(rawEndpoint: string, rawStoreId: string): ProbeArgs {
  // スキームを先に検査する（要件1.1・設計の判定順序）。
  if (!isWssEndpoint(rawEndpoint)) {
    return { ok: false, reason: "NotWssScheme" };
  }

  // 店舗識別子の空（空白のみは空とみなす）。
  if (rawStoreId.trim() === "") {
    return { ok: false, reason: "EmptyStoreId" };
  }

  return { ok: true, endpoint: rawEndpoint, storeId: rawStoreId };
}

// ── 内部判定 ─────────────────────────────────────────────────────────────────

/**
 * エンドポイントが wss:// スキームか。
 *
 * スキームは大文字小文字を区別しない（URL 仕様）。`wss:` で始まり、かつ権限部の区切り `//` が
 * 続くものだけを受理する（`wss:foo` のような非階層形を弾く）。ws:// / http:// / https:// /
 * 空文字 / 非 URL はいずれも false。
 */
function isWssEndpoint(endpoint: string): boolean {
  return /^wss:\/\//i.test(endpoint);
}
