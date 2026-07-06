import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// テストは三つのプロジェクトに分かれる。
//   - workers : core の純粋関数・shell/DO 統合・client は workerd 上（Workers pool）で実行する。
//               観測ハーネスの shell 計装統合テスト（tests/observe/**/*.integration.test.ts）も
//               DO を要するためここに含める。
//   - observe : 観測ハーネスの純粋層（src/observe/）の property/example テスト。time も storage も
//               WS も持たない決定的純粋関数の検証であり、Workers pool は不要なので node で実行する。
//   - static  : ソーステキストの静的検査。実 fs でソースを読むため、workerd ではなく通常の node
//               環境で実行する（Workers サンドボックスは workspace の fs を読めない）。
//
// 設定の出所は wrangler.jsonc を唯一とする（cloudflareTest の configPath）。設定を二重管理しない。
export default defineConfig({
  test: {
    // 段階実装中、まだテストファイルを持たない project（observe 等）があっても実行を止めない。
    // 各 project のテストは後続タスク（2 以降）で追加される。
    passWithNoTests: true,
    projects: [
      {
        // 静的検査プロジェクト。node:fs でソースを直接読むため Workers pool を使わない。
        test: {
          name: "static",
          environment: "node",
          include: [
            "tests/static-analysis.example.test.ts",
            "tests/offline-degradation.static.test.ts",
            // 撤去・不変・漏洩不能の静的検査（タスク7.3）。node:fs でソースを読むため node 環境で実行する。
            "tests/per-store-provisioning.static.test.ts",
            // Wake_Lock マウントの依存確認（タスク6.1）。node:fs で App.tsx を読むため node 環境で実行する。
            "tests/client/audioWakeLock.example.test.ts",
          ],
        },
      },
      {
        // 観測ハーネスの純粋層テスト。Workers pool 不要（src/observe/ は workerd に依存しない）。
        test: {
          name: "observe",
          environment: "node",
          include: ["tests/observe/**/*.property.test.ts", "tests/observe/**/*.example.test.ts"],
        },
      },
      {
        // レジストリの純粋層テスト。src/registry/ は cloudflare:workers・storage に依存しない純粋関数群
        // ゆえ Workers pool 不要。node 環境（既定 pool）で実行する（design.md「純粋関数群は既定 pool」）。
        test: {
          name: "registry",
          environment: "node",
          include: ["tests/registry/**/*.property.test.ts", "tests/registry/**/*.example.test.ts"],
        },
      },
      {
        // Worker 認可の純粋層テスト。src/worker-auth.ts（timingSafeEqual / isAdminAuthorized）は
        // cloudflare:workers・storage に依存しない純粋関数ゆえ Workers pool 不要。node 環境（既定 pool）で
        // 実行する（design.md Property 21・タスク 5.4「既定 pool」）。統合テスト（*.integration.test.ts）は
        // DO を要するため下の workers プロジェクトに残す。
        test: {
          name: "worker",
          environment: "node",
          // example テスト（entry.example.test.ts）も純粋核（worker-entry.ts・registry/authz.ts・
          // registry/roster.ts）だけを import し cloudflare:workers を引き込まないため、property と同じく
          // node（既定 pool）で実行する（下の workers project からは同名 glob を exclude で除外する）。
          include: ["tests/worker/**/*.property.test.ts", "tests/worker/**/*.example.test.ts"],
        },
      },
      {
        // デプロイ前検査 CLI（tools/check-access-enablement.ts）の example テスト。CLI モジュールは
        // node:fs / node:child_process / node:process に依存する端ゆえ Workers pool では動かない。純粋核
        // accessEnablementPreflight を作用なしで検証するため node 環境（既定 pool）で実行する（design「既定 pool」）。
        test: {
          name: "tools",
          environment: "node",
          include: ["tests/check-access-enablement.example.test.ts"],
        },
      },
      {
        // 既存のテスト群＋観測ハーネスの shell 計装統合テスト。workerd を要するため cloudflareTest を用いる。
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/**/*.test.ts"],
          // 静的検査と、observe の純粋層テスト（node project が担当）は Workers pool から除外する。
          // observe の統合テスト（*.integration.test.ts）はここに残し Workers pool で実行する。
          exclude: [
            "tests/static-analysis.example.test.ts",
            "tests/offline-degradation.static.test.ts",
            // node:fs でソースを読む静的検査は static プロジェクト（node）が担当する。
            "tests/per-store-provisioning.static.test.ts",
            "tests/client/audioWakeLock.example.test.ts",
            "tests/observe/**/*.property.test.ts",
            "tests/observe/**/*.example.test.ts",
            // src/registry/ の純粋層テストは registry プロジェクト（node）が担当する。
            "tests/registry/**/*.property.test.ts",
            "tests/registry/**/*.example.test.ts",
            // src/worker-auth.ts の純粋層テストは worker プロジェクト（node）が担当する。
            "tests/worker/**/*.property.test.ts",
            // worker の純粋 example テスト（entry.example.test.ts）も worker プロジェクト（node）が担当する。
            "tests/worker/**/*.example.test.ts",
            // デプロイ前検査 CLI の example テストは tools プロジェクト（node）が担当する（node 組み込み依存）。
            "tests/check-access-enablement.example.test.ts",
          ],
        },
      },
    ],
  },
});
