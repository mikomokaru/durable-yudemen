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
            "tests/client/audioWakeLock.example.test.ts",
            "tests/observe/**/*.property.test.ts",
            "tests/observe/**/*.example.test.ts",
          ],
        },
      },
    ],
  },
});
