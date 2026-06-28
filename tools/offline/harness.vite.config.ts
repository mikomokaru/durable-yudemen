// tools/offline/harness.vite.config.ts — ライブ縮退 CLI を vite-node で動かすための最小 Vite 設定。
//
// なぜ専用設定か: ルートの vite.config.ts は cloudflare() / react() / PWA プラグインを含み、
// vite-node でロードすると workerd 起動などの重い副作用を伴う。本 harness が必要とするのは
// 「Node 上で src/client の本番モジュールを import.meta.env 付きで評価できること」だけなので、
// プラグインを持たない素の dev 設定に絞る。これにより import.meta.env.DEV が true になり、
// 本番モジュール（openTimerConnection など）をそのまま実行できる（本番実装は一切変更しない）。
//
// 縮退の作為（リンク遮断）は CLI 側の注入オープナ（link-gate.ts）が担うため、ここでは
// VITE_PING_BLACKHOLE_DEBUG を有効化しない。.env.development を読み込んでも、CLI は
// setPingBlackholeActive を呼ばないため内部 blackhole は不活性のまま（素通し）である。

import { defineConfig } from "vite";

export default defineConfig({});
