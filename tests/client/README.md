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

**型は実装の公開型を import する。** テスト側で同じ概念を再定義しない（`ClientView` / `ClientTimer` /
`ClientEvent` / `Connectivity` / `TimerOrigin` / `SyncPhase` / `UnreachableReason` は
`src/client/connection.ts`、`PersistedView` は `src/client/persistence.ts`、ワイヤ型（`TimerFact` /
`ServerMessage` / `PendingOrder` / `CookRecommendation`）は `src/domain/` から引く・要件12.2）。ビューは
`EMPTY_VIEW` を基点に差分を上書きして組む——公開型にフィールドが増えても生成器は既定値で追随する。

次を構造的にサンプリングできる（要件13.3・design.md「生成器の前提」）:

- server / local 混在の `ClientTimer`（起源タグ `TimerOrigin` = `server` / `local` 双方）
- `endTime == correctedNow` 境界（および直前・直後）— `genCorrectedNow(view)`
- 範囲外 `boilSeconds`（0・負・1801 以上・非整数）— `genBoilSeconds`
- 処理済み id の重複（`processedIds` が `timers` の id と重なる／無関係 id を含む）
- 直前結果 `lastResults` の 空 / 占有スロット上 / 空きスロット上（占有クリアと差分記録の双方）
- 到達不能理由 `unreachableReason` の 3 値（`offline` / `noAccess` / `signInRequired`）
- `ClientEvent` の 9 系統すべて（`LocalComplete` / `Classify` を含む。`LocalCancel` / `LocalComplete` は
  除去時刻 `now` を運ぶ）— `genEvent(view)` / `genEventStream(view)`
- cancel 済み server の snapshot 復活（`processedIds` 登録済み id が snapshot / Reconcile に再出現）
- 不正 / 不在の永続ブロブ（壊れた JSON・未知 version・型不一致・空文字・null）— `genPersistedBlob`

`generators.smoke.test.ts` は、これらの生成器が単体で実行可能で上記入力空間を**実際に踏む**ことを確認する
スモークである（Correctness Property 本体ではない）。ビューのフィールド集合を `EMPTY_VIEW` と突き合わせ、
イベントは 9 系統すべての出現を要求する——公開型が育ったときに生成器の取り残しを実行時に検出する番人。
