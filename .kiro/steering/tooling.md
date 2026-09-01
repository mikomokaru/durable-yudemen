# ツール選定と利用優先順位

本プロジェクト（ゆで麺タイマー / Cloudflare Durable Objects パイロット）で採用するツールと、その使い方の規律を定める。Kiro はこれを内面化し、セットアップ・実装・テスト・デプロイの全工程で一貫して従う。新しいツールを場当たり的に持ち込まない（YAGNI）。

## 確定採用スタック

| 区分 | ツール | 用途 | 備考 |
| --- | --- | --- | --- |
| パッケージ管理 | **pnpm**（v11 系） | 依存解決・スクリプト実行 | npm / yarn / bun は使わない |
| 言語 | **TypeScript**（strict） | 全コード | `tsc --noEmit` で型検査 |
| ビルド/Dev | **Vite**（v8 系）＋ **@cloudflare/vite-plugin**（v1 系） | dev サーバ・本番ビルド | コードは dev でも workerd 上で実行 |
| UI | **React**（v19）＋ **@vitejs/plugin-react** | iPad フロント | 新 JSX transform（`jsx: react-jsx`） |
| スタイル | **Tailwind CSS**（v4 系）＋ **@tailwindcss/vite** | デザインシステム（`@theme` トークン） | 設定ファイル不要・ソース自動走査。`src/client/styles.css` が唯一の取り込み点。CSS-in-JS は使わない |
| Workers 構成/型/デプロイ | **Wrangler**（v4 系） | `wrangler.jsonc`・`wrangler types`・デプロイ | **確定採用。Workers 設定の正本** |
| テスト | **Vitest**（v4 系）＋ **@cloudflare/vitest-pool-workers** | 単体・PBT・DO 統合テスト | engine/domain は workerd 不要、shell/DO は Workers pool |
| Property-Based Testing | **fast-check**（v4 系） | Correctness Property 検証 | PBT は自前実装しない |
| Lint | **Oxc / oxlint**（v1 系） | 静的解析 | ESLint は使わない |
| フォーマット | **Oxc / oxfmt**（`0.65.0` 厳密固定） | 整形・Tailwind クラス並べ替え | Prettier は使わない。0.x のため `^` を付けない |

## Wrangler の位置づけ（確定採用）

Wrangler は本プロジェクトの **Workers 設定の単一の正本**である。

- 構成は `wrangler.jsonc`（TOML ではなく JSONC で統一）。DO バインディング・`migrations`（`new_sqlite_classes`）・`assets` をここで定義する。
- 型は `pnpm cf-typegen`（= `wrangler types`）で `worker-configuration.d.ts` を生成する。**`wrangler.jsonc` を変更したら必ず再生成する。**
- `@cloudflare/vite-plugin` と `@cloudflare/vitest-pool-workers` はいずれも `wrangler.jsonc` を `configPath` として読む。設定の二重管理をしない（wrangler.jsonc が唯一の出所）。
- デプロイは `wrangler deploy`（または `vite build` → `wrangler deploy`）。

## Tailwind v4 の位置づけ（デザインシステムの正本）

UI のスタイルは **Tailwind CSS v4** に統一する。素の CSS クラスや CSS-in-JS（styled-components / emotion 等）を併用しない。

- **トークンは `@theme` に集約。** 色（`--color-*`）・フォント（`--font-*`）・アニメーション（`--animate-*`）を `src/client/styles.css` の `@theme` 1 箇所で定義し、`bg-panel` / `text-running` / `border-line` / `animate-boiled` 等のユーティリティが自動生成される。色を変えるときはここだけを触る（SSOT）。
- **設定ファイル不要。** v4 はソースを自動走査するため `tailwind.config.*` を置かない。プラグインは `@tailwindcss/vite` を `vite.config.ts` の plugins へ追加する（`tailwindcss()`）。
- **取り込み点は 1 つ。** `main.tsx` が `styles.css` を副作用 import する唯一の経路を保つ。CSS の二重取り込みをしない。
- **状態の色分けは条件付きクラス**（`cn` ヘルパ＝`src/client/cn.ts`）で TSX 側に出し分ける。`color-mix` を含む複数 box-shadow など、ユーティリティ化が辛いものだけ `@keyframes` として CSS に残す。実行時に変わる値（ラジアルの花びら座標）はインライン `style`。
- **Lint は引き続き oxlint。** Tailwind 用の追加 lint は導入しない。
- **クラスの並び順は oxfmt が決める。** `sortTailwindcss` を有効にしているため、`className` と `cn()` 引数のクラス順は整形時に正規化される。並び順を手で議論しない。`prettier-plugin-tailwindcss` は導入しない（oxfmt に内蔵）。

## oxfmt の位置づけ（整形の正本）

整形は **oxfmt** に一元化する。整形は設計判断ではない——判断を含まない領域を機械へ渡し、差分が意味の変化だけを指すようにするための道具である。

- **設定は `.oxfmtrc.json`（リポジトリ直下）が唯一の出所。** CLI での上書き（`--no-semi` 等）はそもそも非対応。エディタ統合と CLI で同一の結果を得るため、設定はこのファイルだけに置く。
- **版は厳密固定（`^` を付けない）。** oxfmt は 0.x であり、マイナー更新で出力が変わりうる。固定しない限り、無関係な更新がリポジトリ全体の再整形差分を生む。**版を上げるときは、整形差分だけの単独コミットで行う。**
- **設定は既定値を明示しない。** `printWidth`（既定 100）・`tabWidth`（既定 2）・`semi`・引用符は書かない。版が固定されている以上、既定は勝手に動かない。書けば二つ目の真実になる。
- **Markdown は対象外。** `ignorePatterns` で `**/*.md` / `**/*.mdx` を除外する。`.kiro/specs/` と `docs/` の日本語散文が大半で、改行位置の書き換えは要件文・EARS 文の差分をレビュー不能にする。得るものがない。
- **`pnpm-lock.yaml` は対象外。** 生成物であり、整形の対象にすると pnpm の出力と競合する。
- **`.gitignore` は自動で尊重される。** `dist` / `.wrangler` / `worker-configuration.d.ts` / `graphify-out` は明示的な除外を書かなくても飛ばされる（oxfmt は `.gitignore` を既定の ignore ファイルとして読む）。
- **`sortImports` は無効のまま。** 有効化は import 順をリポジトリ全体で書き換える判断であり、導入と分けて決める。
- **一括整形は未了。** 導入時点で 382 ファイル中 269 ファイルが未整形である。作業ツリーがクリーンなときに `main` から専用ブランチを切り、`pnpm fmt` の結果だけを単独コミットにして入れる。そのコミットハッシュを `.git-blame-ignore-revs` に載せる。**CI の `fmt:check` ステップは、その一括整形と同じコミットで追加する**（先に入れると未整形のコードで CI が落ちる）。

## コマンド（package.json scripts）

- `pnpm dev` — Vite dev サーバ（workerd 実行・HMR）
- `pnpm build` — `tsc --noEmit && vite build`（型検査 → 本番ビルド）
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — `oxlint`
- `pnpm fmt` — `oxfmt`（整形して書き込む）
- `pnpm fmt:check` — `oxfmt --check`（書き込まず差分の有無を検査。CI 用）
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
- **oxlint / oxfmt は `allowBuilds` への追記が不要。** どちらもプラットフォーム別のプリビルド binding を `optionalDependencies` で配るだけで、`scripts` を持たない。ビルドが走らないため承認の対象にならない。
- `pnpm install` が `ERR_PNPM_IGNORED_BUILDS` を出すと **exit code 1** になり、`wrangler types` など内部で `pnpm install` を呼ぶコマンドが連鎖的に失敗する。先に `allowBuilds` を確定させること。
- `pnpm-workspace.yaml` は単一パッケージでも pnpm の設定ファイルとして機能する（ワークスペースでなくても可）。

## Cloudflare 固有の確定事項（実装時に変えない）

- **Vitest は v4 系の新 API**：`@cloudflare/vitest-pool-workers` の `cloudflareTest()` プラグインを `vitest/config` の `defineConfig({ plugins: [...] })` に渡す。旧 `defineWorkersConfig` / `defineWorkersProject`（`@cloudflare/vitest-pool-workers/config`）は v0.13 以降**廃止**されており使わない。
- **compatibility_date は `2026-06-26`**。`web_socket_auto_reply_to_close` はこの日付で既定化済みのため `compatibility_flags` に**明示しない**（明示すると workerd 起動が失敗する）。`webSocketClose` 内の `ws.close()` は既定で不要。
- **ストレージは SQLite バックエンド（`new_sqlite_classes`）＋ 非同期 KV API のみ**。`ctx.storage.sql`・テーブル・SQL クエリは使わない（design.md / 要件8.2 の不変点）。
- **assets バインディングは `ASSETS`**、`not_found_handling: "single-page-application"`（React SPA フォールバック）。`env.ASSETS.fetch` を使うため `binding` 名の指定は必須。

## ディレクトリ規約

- `src/engine/` — サーバ側の純粋な状態遷移エンジン（`decide` ほか。`cloudflare:workers`・storage に依存しない）。他基盤へ運べる。
- `src/domain/` — ドメイン契約（`TimerFact`／`NonEmptyArray`・メッセージ型・`StoreConfig` 等）。両端が共有する語彙の正本。基底インターフェイスの定義はここに集約する（steering/timer-model.md）。
- `src/transport/` — トランスポート機構（`heartbeat` の心拍フレーム）。ドメインではなく接続維持の関心事で、client と shell が共有する。
- `src/shell/` — DO クラス・Effect インタプリタ（プラットフォーム作用の端）。
- `src/client/` — React フロント。
- `src/worker.ts` — 極薄の Worker エントリ。
- `tests/` — PBT・example・統合テスト・静的検査。

依存方向は `engine` → `domain`、`client` → `domain`、`shell` → `engine`/`domain`/`transport`。`domain` は何にも依存しない中立の契約ハブ。`engine` という名は「サーバ側の決定機構」であって中核を僭称しない（中核はドメイン契約）。

設計哲学（`design-philosophy.md`）の「構造の主権」に従い、Cloudflare 固有依存は `src/shell` と `src/worker.ts` に隔離し、`src/engine` は純粋に保つ。
