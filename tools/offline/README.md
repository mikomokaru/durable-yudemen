# tools/offline — オフライン縮退ライブ CLI（Node 実行体）

`offline-degradation` の縮退ライフサイクル（degraded → ローカル操作 → 復帰）を、**実行中のサーバ**に対して
ライブに駆動・検証する Node の端。本番実装（`src/client/` / `src/shell/`）は一切変更しない。

- `link-gate.ts` — リンク遮断ゲート。本番の `SocketOpener` 継ぎ目に嵌まる Node(`ws`) 実装。
- `degrade-cli.ts` — 縮退ライフサイクル CLI。本番の `openTimerConnection` をそのまま駆動する。
- `harness.vite.config.ts` — vite-node 用の最小 Vite 設定（`import.meta.env` 解決のためだけ）。

## 本番実装を変えない（注入継ぎ目だけを使う）

縮退の遷移ロジック（`watchConnectivity` / `decideView` / Reconcile）は**本番コードがそのまま走る**。
CLI は `openTimerConnection` が最初から公開している注入点だけを使う:

- `openSocket` — `ws` 製の `SocketOpener` ＋ リンク遮断ゲート（`tools/offline` に閉じる）。
- `persistence` — `localStorage` に触れないインメモリ `ViewStore`。
- `now` / `onBoilAlert` — 時刻採取とローカル発火の観測。

`vite-node` を使うのは Node 上で `import.meta.env` を解決して本番モジュールをそのまま import するためで、
本番改修ではない。WebSocket ライブラリ（`ws`）はこの `tools/offline/` 配下に閉じ、`src/` には漏らさない。

## なぜ ping blackhole ではなくリンク遮断か

要件14 の `withPingBlackhole` は **送信 ping のみ破棄**（ping-only）で、受信も再接続も素通しする。
実サーバ相手では silent-loss で一度 `down` になっても、`Connectivity_Watch` がすぐ再接続し、accept 時の
全量 snapshot 受信で `up` に戻る（degraded が 1 秒程度の瞬きになる）。degraded 中に落ち着いて操作し、その
復帰を観測するには「断の間は接続自体が確立しない」安定窓が要る。本 CLI のリンク遮断ゲートは、遮断中に
(a) 生接続を能動的に閉じ（明示的切断・要件2.1）、(b) 以後の再接続も即失敗させて、復旧まで `down` を維持する。

> ブラウザの dev トグル（要件14 の ping blackhole）と本 CLI のリンク遮断は別物。前者は手動 UI で
> silent-loss 検知経路（要件1.4）を試す足場、後者は安定した degraded 窓でライフサイクル全体をライブ検証する端。

## 実行方法

dev サーバを起動しておく（別シェル）:

```sh
pnpm dev   # http://localhost:5173/ （/ws も同オリジンで提供される）
```

別シェルで CLI を走らせる（ワンショット。tooling 規律に従い npm/yarn/npx は使わない）:

```sh
pnpm exec vite-node -c tools/offline/harness.vite.config.ts tools/offline/degrade-cli.ts
# 接続先を変える場合は第 1 引数で上書き:
pnpm exec vite-node -c tools/offline/harness.vite.config.ts tools/offline/degrade-cli.ts ws://localhost:5173/ws
```

## 検証するライフサイクルと合否

1. 接続 → 全量 snapshot 受信で `up`（Mode=live）。
2. （best-effort）live で `start` を 1 件送り、server-confirmed Timer が乗るのを観測。
3. リンク遮断 → 明示的切断（要件2.1）で `down`（Mode=degraded）。
4. degraded 中に `start` → Provisional_Timer（`origin=local`）が注入される（要件6）。
5. リンク復旧 → 再接続 + 全量 snapshot で `up`（Mode=live）へ復帰。
6. **復帰検証**: Mode=live・server-confirmed が snapshot で再整合・provisional 保持（決定 B・要件11.5/11.6）。

終了コードは `0`（復帰検証合格）/ 非ゼロ（タイムアウトや検証不一致）。ユーザー向け出力は英語、コメントは日本語。

## 前提と限界

- 対象は**ローカル dev サーバ**を想定（`ws://`）。本番（`wss://`）でも接続先を渡せば動くが、本番バンドルの
  クライアントとは無関係（本 CLI は Node 上で本番モジュールを駆動する別経路）。
- クロスデバイスのダブルブッキングや耐久的書き戻し（reconciliation）はスコープ外（要件9.3 / 12.5）。
- `setInterval` / 終わらない `setTimeout` を持ち込まない（hibernation 規律）。待機は購読 + 単一タイムアウト。
