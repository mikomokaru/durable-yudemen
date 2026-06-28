import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
    // PWA 基盤（要件10.1/10.3）。App_Shell（HTML/JS/CSS）を Workbox で precache し、
    // オフライン起動を成立させる。VitePWA は client ビルドの closeBundle 後に
    // precache manifest を生成するため、cloudflare() の後ろに置く。
    VitePWA({
      // 更新戦略: バックグラウンドで新 Service Worker を取得し、次回ナビゲーションで
      // 自動適用する（autoUpdate）。厨房スタッフに更新操作を求めず、リロードボタンも
      // 出さない（要件10.3）。リロード抑止は standalone + overscroll に限定し（決定 A・
      // 要件10.5）、ここで追加の更新プロンプト層は設けない。
      registerType: "autoUpdate",
      // ユーザー向け表示文言は英語（要件13.6）。display: standalone で全画面動作（要件10.3）。
      manifest: {
        name: "Yude-men Timer",
        short_name: "Yude-men",
        description: "Kitchen noodle boiling timer that keeps counting down offline.",
        lang: "en",
        display: "standalone",
        start_url: "/",
        scope: "/",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        orientation: "portrait",
      },
      workbox: {
        // App_Shell の precache 対象（HTML/JS/CSS とアイコン等の静的アセット・要件10.1）。
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        // SPA フォールバックと整合させる（wrangler.jsonc の
        // not_found_handling: "single-page-application"）。ナビゲーション要求は
        // precache 済みの index.html を返し、オフラインでも起動できる（要件10.2）。
        navigateFallback: "/index.html",
        // /ws（WebSocket アップグレード）と DO API はキャッシュ対象から除外する。
        navigateFallbackDenylist: [/^\/ws$/],
        // 新 Service Worker を即時有効化し、開いている画面の制御を引き継ぐ。
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
});
