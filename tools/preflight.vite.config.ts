import { defineConfig } from "vite";

// preflight.vite.config.ts — デプロイ前検査 CLI（tools/check-access-enablement.ts）専用の最小 Vite 設定。
//
// なぜアプリ本体の vite.config.ts を使わないか: あちらは @cloudflare/vite-plugin を登録し、
// vite-node はロード時にそのプラグインが workerd ランタイムを起動する。workerd はハンドルを開いたまま
// Node のイベントループを生かし続けるため、node 組み込み + 相対 .ts しか読まない純粋な CLI であっても
// プロセスが終了しない（pnpm access-preflight がハングする）。デプロイ前検査はアプリ設定を一切必要と
// しない（wrangler.jsonc をテキストとして読み、pnpm cf-typegen を spawn するだけ）ため、プラグインを
// 持たないこの設定に vite-node を向け、workerd 起動を回避して即座・確定的に終了させる。
export default defineConfig({
  plugins: [],
});
