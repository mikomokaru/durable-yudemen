// Workers pool（@cloudflare/vitest-pool-workers）の `cloudflare:test` モジュール型を
// `tsc --noEmit`（pnpm typecheck）の走査に載せる。パッケージの既定 types エントリ
// （dist/pool/index.d.mts）は pool 設定型のみで `cloudflare:test` を宣言しないため、
// `/types` サブパス（types/cloudflare-test.d.ts）を明示参照して解決する。
// env は worker-configuration.d.ts の `Cloudflare.Env`（= 本 Worker の Env）で型付く。
/// <reference types="@cloudflare/vitest-pool-workers/types" />
