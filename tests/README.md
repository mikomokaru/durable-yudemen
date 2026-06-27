# Tests

PBT・example・統合テスト・静的検査を配置する。

## PBT 規約（steering: tooling.md / design.md）

- ライブラリは **fast-check**。PBT を自前実装しない。
- 各 Correctness Property（P1〜P16）は**単一の** property テストとして実装する（1 プロパティ = 1 テスト）。
- 反復は**最低 100 回**（fast-check の `numRuns: 100` 以上）。
- 各 property テストに対応プロパティをタグコメントで明記する:
  `// Feature: yude-men-timer, Property {番号}: {本文}`
- core の純粋関数テストは workerd 不要。shell / DO の統合テストは `@cloudflare/vitest-pool-workers`（Workers pool）上で実行する。
