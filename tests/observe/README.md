# tests/observe — 観測ハーネスのテスト

hibernation 観測ハーネス（spec: `hibernation-observability`）の property / example / 統合テストを置く。

## テストプールの分離（純粋層は Workers pool 不要）

観測ハーネスのテストは純度で二分し、Vitest の project を分けて実行する
（`vitest.config.ts`。設定の出所は `wrangler.jsonc` を唯一とする）。

| 種別 | 対象 | プール | ファイル命名 |
| --- | --- | --- | --- |
| 純粋層テスト | `src/observe/`（log codec・引数検証・scenario・Correlator） | **node**（Workers pool 不要） | `*.property.test.ts` / `*.example.test.ts` |
| shell 計装 統合テスト | `src/shell/store-timer-do.ts` の 4 継ぎ目計装 | **Workers pool**（`@cloudflare/vitest-pool-workers`） | `*.integration.test.ts` |

- 純粋層テスト（`tests/observe/**/*.property.test.ts`・`*.example.test.ts`）は workerd を要さない
  決定的純粋関数の検証であり、`node` 環境の project（`observe` project）で実行する。
- shell 計装の統合テスト（`tests/observe/**/*.integration.test.ts`）は DO を構築・rehydrate・
  alarm 発火・broadcast させるため Workers pool（`workers` project）で実行する。

## PBT 規約（steering: tooling.md / design.md）

- ライブラリは **fast-check**。PBT を自前実装しない。
- 各 Correctness Property（**P1〜P13**）は**単一の** property テストとして実装する（1 プロパティ = 1 テスト）。
- 反復は**最低 100 回**（fast-check の `numRuns: 100` 以上）。
- 各 property テストに対応プロパティをタグコメントで明記する:

  ```ts
  // Feature: hibernation-observability, Property {番号}: {本文}
  ```

- 純粋層テストは `Date.now()` のスタブや `vi.useFakeTimers()` を**用いない**。
  時刻は引数で渡す（暗黙時計への漏れは境界の引き直しサイン）。

## 純度の規律（テストでも守る）

- 純粋層テスト（`src/observe/` 対象）は WS・`fs`・`console.log`・実時間に依存しない。
- WS クライアントライブラリ（`ws` 等）は `tools/observe/` に閉じ、`src/observe/` には漏らさない
  （依存追加は `pnpm add -D`）。CLI 端（`tools/observe/`）の検証は統合 / example / smoke で行う。
- CLI のユーザー向け出力は英語のみ（要件9.4）。
