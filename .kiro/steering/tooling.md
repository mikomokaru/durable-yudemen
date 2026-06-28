# ツール選定と利用優先順位

本プロジェクト（ゆで麺タイマー / Cloudflare Durable Objects パイロット）で採用するツールと、その使い方の規律を定める。Kiro はこれを内面化し、セットアップ・実装・テスト・デプロイの全工程で一貫して従う。新しいツールを場当たり的に持ち込まない（YAGNI）。

## 確定採用スタック

| 区分 | ツール | 用途 | 備考 |
| --- | --- | --- | --- |
| パッケージ管理 | **pnpm**（v11 系） | 依存解決・スクリプト実行 | npm / yarn / bun は使わない |
| 言語 | **TypeScript**（strict） | 全コード | `tsc --noEmit` で型検査 |
| ビルド/Dev | **Vite**（v8 系）＋ **@cloudflare/vite-plugin**（v1 系） | dev サーバ・本番ビルド | コードは dev でも workerd 上で実行 |
| UI | **React**（v19）＋ **@vitejs/plugin-react** | iPad フロント | 新 JSX transform（`jsx: react-jsx`） |
| Workers 構成/型/デプロイ | **Wrangler**（v4 系） | `wrangler.jsonc`・`wrangler types`・デプロイ | **確定採用。Workers 設定の正本** |
| テスト | **Vitest**（v4 系）＋ **@cloudflare/vitest-pool-workers** | 単体・PBT・DO 統合テスト | engine/domain は workerd 不要、shell/DO は Workers pool |
| Property-Based Testing | **fast-check**（v4 系） | Correctness Property 検証 | PBT は自前実装しない |
| Lint | **Oxc / oxlint**（v1 系） | 静的解析 | ESLint は使わない |

## Wrangler の位置づけ（確定採用）

Wrangler は本プロジェクトの **Workers 設定の単一の正本**である。

- 構成は `wrangler.jsonc`（TOML ではなく JSONC で統一）。DO バインディング・`migrations`（`new_sqlite_classes`）・`assets` をここで定義する。
- 型は `pnpm cf-typegen`（= `wrangler types`）で `worker-configuration.d.ts` を生成する。**`wrangler.jsonc` を変更したら必ず再生成する。**
- `@cloudflare/vite-plugin` と `@cloudflare/vitest-pool-workers` はいずれも `wrangler.jsonc` を `configPath` として読む。設定の二重管理をしない（wrangler.jsonc が唯一の出所）。
- デプロイは `wrangler deploy`（または `vite build` → `wrangler deploy`）。

## コマンド（package.json scripts）

- `pnpm dev` — Vite dev サーバ（workerd 実行・HMR）
- `pnpm build` — `tsc --noEmit && vite build`（型検査 → 本番ビルド）
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — `oxlint`
- `pnpm test` — `vitest --run`（単発実行。watch は使わない）
- `pnpm cf-typegen` — `wrangler types`（`Env` 型の再生成）

Kiro はパッケージ追加に `pnpm add` / `pnpm add -D` を用い、`npm` / `yarn` / `npx` を使わない（ワンショット実行が必要なら `pnpm dlx`）。

## pnpm v11 の注意点（最新版 tips）

- **ビルドスクリプトの承認は `pnpm-workspace.yaml` の `allowBuilds` で行う。** v11 では `package.json` の `pnpm.onlyBuiltDependencies` フィールドは**読まれない**（無視される）。`pnpm config list` で `onlyBuiltDependencies` が見えても、未承認ビルドがあると `pnpm install` は `ERR_PNPM_IGNORED_BUILDS` で失敗する。
  - 正しい形式は名前→真偽値のマップ:
    ```yaml
    # pnpm-workspace.yaml
    allowBuilds:
      esbuild: true
      sharp: false
      workerd: true
    ```
  - 本プロジェクトの確定値: **`workerd: true`・`esbuild: true`**（Vite/Wrangler の実行に必須）。**`sharp: false`**（ソースビルドに失敗する間接依存で、本プロジェクトでは不要）。
- `pnpm install` が `ERR_PNPM_IGNORED_BUILDS` を出すと **exit code 1** になり、`wrangler types` など内部で `pnpm install` を呼ぶコマンドが連鎖的に失敗する。先に `allowBuilds` を確定させること。
- `pnpm-workspace.yaml` は単一パッケージでも pnpm の設定ファイルとして機能する（ワークスペースでなくても可）。

## Cloudflare 固有の確定事項（実装時に変えない）

- **Vitest は v4 系の新 API**：`@cloudflare/vitest-pool-workers` の `cloudflareTest()` プラグインを `vitest/config` の `defineConfig({ plugins: [...] })` に渡す。旧 `defineWorkersConfig` / `defineWorkersProject`（`@cloudflare/vitest-pool-workers/config`）は v0.13 以降**廃止**されており使わない。
- **compatibility_date は `2026-06-26`**。`web_socket_auto_reply_to_close` はこの日付で既定化済みのため `compatibility_flags` に**明示しない**（明示すると workerd 起動が失敗する）。`webSocketClose` 内の `ws.close()` は既定で不要。
- **ストレージは SQLite バックエンド（`new_sqlite_classes`）＋ 非同期 KV API のみ**。`ctx.storage.sql`・テーブル・SQL クエリは使わない（design.md / 要件8.2 の不変点）。
- **assets バインディングは `ASSETS`**、`not_found_handling: "single-page-application"`（React SPA フォールバック）。`env.ASSETS.fetch` を使うため `binding` 名の指定は必須。

## ディレクトリ規約

- `src/engine/` — サーバ側の純粋な状態遷移エンジン（`decide` ほか。`cloudflare:workers`・storage に依存しない）。他基盤へ運べる。
- `src/domain/` — ドメイン契約（`TimerFact`・`WireTimer`・メッセージ型）。両端が共有する語彙の正本。基底インターフェイスの定義はここに集約する（steering/timer-model.md）。
- `src/transport/` — トランスポート機構（`heartbeat` の心拍フレーム）。ドメインではなく接続維持の関心事で、client と shell が共有する。
- `src/shell/` — DO クラス・Effect インタプリタ（プラットフォーム作用の端）。
- `src/client/` — React フロント。
- `src/worker.ts` — 極薄の Worker エントリ。
- `tests/` — PBT・example・統合テスト・静的検査。

依存方向は `engine` → `domain`、`client` → `domain`、`shell` → `engine`/`domain`/`transport`。`domain` は何にも依存しない中立の契約ハブ。`engine` という名は「サーバ側の決定機構」であって中核を僭称しない（中核はドメイン契約）。

設計哲学（`design-philosophy.md`）の「構造の主権」に従い、Cloudflare 固有依存は `src/shell` と `src/worker.ts` に隔離し、`src/engine` は純粋に保つ。
