# tests/client

iPad_Client（`src/client/`）の純粋層 PBT・example・端の統合テストを配置する。ルートの `tests/README.md`
（プロジェクト共通の PBT 規約）に加え、本ディレクトリ固有の規約を以下に定める。

## 共通 PBT 規約（再掲・ルート tests/README.md に従う）

- ライブラリは **fast-check**（既存依存をそのまま用いる。新規依存を追加しない）。PBT を自前実装しない。
- 各 Correctness Property は**単一の** property テストとして実装する（1 プロパティ = 1 テスト）。
- 反復は**最低 100 回**（fast-check の `numRuns: 100` 以上）。
- 各 property テストに対応プロパティをタグコメントで明記する。

## offline-degradation のタグコメント規約

本機能（offline-degradation）の各 property テストには、次の形式のタグコメントを付す:

```ts
// Feature: offline-degradation, Property N: {プロパティ本文}
```

`N` は design.md「Correctness Properties」の番号（P1〜P9）に対応させ、本文は当該プロパティの言明を写す。
あわせて各 property テストに `**Validates: Requirements x.y**` を併記する（design.md / tasks.md の対応）。

例:

```ts
fc.assert(
  // Feature: offline-degradation, Property 1: Mode は Connectivity から全域的・決定的に導出される
  // Validates: Requirements 3.1, 3.2, 3.3
  fc.property(genClientView, (view) => {
    /* ... */
  }),
  { numRuns: 100 },
);
```

## 純粋層テストの方針 — 暗黙時計に漏らさない（要件13.4）

純粋層（`decideView` / `mode` / `dueLocalTimers` / `serializeView` / `parsePersistedView` と既存の
`clock.ts` / `notification.ts`）のテストでは、次を**用いない**:

- `Date.now` 等のスタブ・モック
- `vi.useFakeTimers()` / `vi.setSystemTime()`

時刻・生成 id・受信時刻は**すべて引数として**生成器から渡す（`genCorrectedNow` / `genReceivedAt` 相当・
イベントの `correctedNow` / `receivedAt` / `newTimerId`）。純粋関数が暗黙の時計や乱数へ漏れていれば、それは
境界の引き方を疑うサインである（design.md「暗黙時計に漏れたら境界を疑う」）。faketime / Date スタブが必要な
のは WS 生存検出・実時間ティック・auto-response といった**端**の統合テストに限り、それらは純粋層テストとは
別ファイルに置く。

## 生成器の土台（`generators.ts`）

本機能の property テストが共有する fast-check 生成器を `tests/client/generators.ts` に集約する。
次を構造的にサンプリングできる（要件13.3・design.md「生成器の前提」）:

- server / local 混在の `ClientTimer`（起源タグ `TimerOrigin` = `server` / `local` 双方）
- `endTime == correctedNow` 境界（および直前・直後）— `genCorrectedNow(view)`
- 範囲外 `boilSeconds`（0・負・1801 以上・非整数）— `genBoilSeconds`
- 処理済み id の重複（`processedIds` が `timers` の id と重なる／無関係 id を含む）
- cancel 済み server の snapshot 復活（`processedIds` 登録済み id が snapshot / Reconcile に再出現）
- 不正 / 不在の永続ブロブ（壊れた JSON・未知 version・型不一致・空文字・null）— `genPersistedBlob`

> 注: 検証対象の公開型（`ClientView` / `ClientTimer` / `ClientEvent` / `PersistedView`）は後続タスク
> 2.1 / 3.1 で `src/client/` に定義される。`generators.ts` は確定命名（design.md「公開シンボル命名の確認
> > 確定」節）に沿ったローカル型を暫定的に置いており、当該公開型が定義され次第 import へ差し替える。
> ワイヤ型（`WireTimer` / `ServerMessage`）は `src/shared/messages.ts` の既存定義をそのまま用いる（要件12.2）。

`generators.smoke.test.ts` は、これらの生成器が単体で実行可能で上記入力空間を踏むことだけを確認する
スモークである（Correctness Property 本体ではない）。
