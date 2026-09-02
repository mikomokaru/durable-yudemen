import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// テストはプロジェクトに分かれる（主なもの）。
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
            // Pass_Through の適用層の静的検査（pos-order-ingress タスク24）。TypeScript AST でソースを読む。
            "tests/pos-order-ingress.static.test.ts",
            // Operation History O1〜O3 の no-wake/no-storage 検査。node:fs と TypeScript AST を使う。
            "tests/operation-history/no-wake.static.test.ts",
            // Operation History の Timer モデル規律。node:fs で導出ソースを読むため node 環境で実行する。
            "tests/operation-history/timer-model.static.test.ts",
            // Operation History の設定キー確認（タスク11.1）。node:fs で導入済み Wrangler schema を読む。
            "tests/operation-history/wrangler-config-keys.static.test.ts",
            // Operation History の設定 graph（タスク11.4）。node:fs で三つの wrangler.jsonc を読む。
            "tests/operation-history/config-graph.static.test.ts",
            // Operation History の縮退経路の不在（タスク12.2）。全設定・src 全体・CI をソースから読む。
            "tests/operation-history/no-backfill.static.test.ts",
            // Operation History の Snowflake 取込 SQL（タスク13.1）。SQL テキストを読む静的検査ゆえ node で実行する。
            "tests/operation-history/snowflake-ingest.static.test.ts",
            // Operation History の相関・品質率 SQL（タスク13.2）。同じく SQL テキストを読む静的検査。
            "tests/operation-history/snowflake-quality.static.test.ts",
            // Wake_Lock マウントの依存確認（タスク6.1）。node:fs で App.tsx を読むため node 環境で実行する。
            "tests/client/audioWakeLock.example.test.ts",
            // Entry（`/`）が Worker に届くことの設定検査。node:fs で wrangler.jsonc を読む。
            "tests/entry-routing.static.test.ts",
            // Service_Worker が認証経路を横取りしないことの設定検査。node:fs で vite.config.ts を読む。
            "tests/service-worker-config.static.test.ts",
            // ping blackhole が dev/test 限定に閉じていることのゲート検査（offline-degradation タスク12.3）。
            // node:fs で src/client のソースを読み TypeScript AST で判定するため node 環境で実行する。
            "tests/ping-blackhole.static.test.ts",
            // 一括消し込みの不変点検査（sync-set-batch-complete タスク5.1）。node:fs で src のソースを読む。
            "tests/sync-set-batch-complete.static.test.ts",
            // Boil_Sync の純粋性検査（synchronized-boil-adjustment タスク12.1）。TypeScript AST でソースを読む。
            "tests/static/boil-sync-purity.test.ts",
            // 占有ゲート・解決規則が src/client に閉じていることの検査（degraded-slot-superimposition
            // タスク5.2）。node:fs で src/engine / src/domain のソースを読むため node 環境で実行する。
            "tests/degraded-slot-superimposition.static.test.ts",
            // 左レール化の配置と出所の検査（pending-order-list-left-rail タスク5.1）。node:fs で
            // src/client のソースと styles.css を読むため node 環境で実行する。
            "tests/pending-order-list-left-rail.static.test.ts",
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
        // 上流ペイロード解釈の純粋層テスト。src/ingress/ は cloudflare:workers・storage に触れず
        // domain へ一方向に依存するだけの純粋関数群ゆえ Workers pool 不要。node 環境（既定 pool）で
        // 実行する（design.md「src/ingress/ と src/registry/ の純粋層は workerd 不要」）。
        // 取り込み経路の統合テストは tests/shell/ に置き、置き場を pool の境界と一致させる。
        test: {
          name: "ingress",
          environment: "node",
          include: ["tests/ingress/**/*.property.test.ts", "tests/ingress/**/*.example.test.ts"],
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
        // React 実描画テスト。下の workers プロジェクトは workerd 上で走り DOM を持たないため、
        // 実際に描画して DOM へ問う主張はここでしか立てられない（happy-dom を環境に据える）。
        // 境界は拡張子 .tsx に置く：JSX を書くのは実描画テストだけであり、置き場と pool の境界が一致する。
        plugins: [react()],
        test: {
          name: "render",
          environment: "happy-dom",
          include: ["tests/**/*.test.tsx"],
        },
      },
      {
        // 既存のテスト群＋観測ハーネスの shell 計装統合テスト。workerd を要するため cloudflareTest を用いる。
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // SOLVER（Solver_Worker への Service binding）の相手先を補助 Worker として立てる。
            // workerd は binding が指す service が定義されていないと起動そのものを拒むため、
            // wrangler.jsonc に services を書いた時点でテスト環境にも相手先が要る。
            //
            // **実体（src/solver/index.ts）は置けない。** 補助 Worker は Vite のビルドを経ず、TypeScript の
            // エントリをそのまま渡せないためである（実体のデプロイは wrangler.solver.jsonc の担当）。
            // ゆえに往路の受理（202）だけを返す。これは骨格 Solver の観測可能な振る舞いと一致し、
            // 復路（deliverPlan）はテストから直接呼ぶ（design の Integration 表・tasks.md 20.6）。
            miniflare: {
              workers: [
                {
                  name: "yude-men-solver",
                  modules: true,
                  script: "export default { fetch: () => new Response(null, { status: 202 }) };",
                },
              ],
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/**/*.test.ts"],
          // DO 統合テストの時間予算はプロジェクト単位で決める。個別の it(..., { timeout }) にしない
          // のは、同種の DO 統合テストが増えるたびに書き足す形を避け、概念を 1 箇所へ収めるためである。
          // 20 秒の根拠：100 店 fan-out（tests/shell/registry-fanout.integration.test.ts）の実測が
          // 全量実行時 4.3〜5.2s で、既定 5s をほぼ使い切る。4 倍の余裕を持たせつつ、真の hang は
          // 依然検出できる幅に留める。
          testTimeout: 20_000,
          // 静的検査と、observe の純粋層テスト（node project が担当）は Workers pool から除外する。
          // observe の統合テスト（*.integration.test.ts）はここに残し Workers pool で実行する。
          exclude: [
            "tests/static-analysis.example.test.ts",
            "tests/offline-degradation.static.test.ts",
            // node:fs でソースを読む静的検査は static プロジェクト（node）が担当する。
            "tests/per-store-provisioning.static.test.ts",
            "tests/pos-order-ingress.static.test.ts",
            "tests/operation-history/no-wake.static.test.ts",
            "tests/operation-history/timer-model.static.test.ts",
            "tests/operation-history/wrangler-config-keys.static.test.ts",
            "tests/operation-history/config-graph.static.test.ts",
            "tests/operation-history/no-backfill.static.test.ts",
            "tests/operation-history/snowflake-ingest.static.test.ts",
            "tests/operation-history/snowflake-quality.static.test.ts",
            "tests/client/audioWakeLock.example.test.ts",
            "tests/entry-routing.static.test.ts",
            "tests/service-worker-config.static.test.ts",
            "tests/ping-blackhole.static.test.ts",
            "tests/sync-set-batch-complete.static.test.ts",
            "tests/static/boil-sync-purity.test.ts",
            "tests/degraded-slot-superimposition.static.test.ts",
            "tests/pending-order-list-left-rail.static.test.ts",
            "tests/observe/**/*.property.test.ts",
            "tests/observe/**/*.example.test.ts",
            // src/registry/ の純粋層テストは registry プロジェクト（node）が担当する。
            "tests/registry/**/*.property.test.ts",
            "tests/registry/**/*.example.test.ts",
            // src/ingress/ の純粋層テストは ingress プロジェクト（node）が担当する。
            "tests/ingress/**/*.property.test.ts",
            "tests/ingress/**/*.example.test.ts",
            // src/worker-auth.ts の純粋層テストは worker プロジェクト（node）が担当する。
            "tests/worker/**/*.property.test.ts",
            // worker の純粋 example テスト（entry.example.test.ts）も worker プロジェクト（node）が担当する。
            "tests/worker/**/*.example.test.ts",
            // デプロイ前検査 CLI の example テストは tools プロジェクト（node）が担当する（node 組み込み依存）。
            "tests/check-access-enablement.example.test.ts",
            // React 実描画テストは render プロジェクト（happy-dom）が担当する。上の include（*.test.ts）は
            // 既に .tsx を拾わないが、他の node プロジェクトと同じく include と exclude を対で置く
            // ——include を広げたときに二重実行へ崩れないように。
            "tests/**/*.test.tsx",
          ],
        },
      },
    ],
  },
});
