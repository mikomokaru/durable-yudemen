# src/observe — 観測ハーネスの純粋層

hibernation 観測ハーネス（spec: `hibernation-observability`）の**純粋関数**を置く。
`src/core/` と同じく「他基盤へ運べる」純度を持つが、**製品の core ではない**。
core を汚さないため、観測のための計算をここに独立させる。

## 純度の契約（構造で守る不変点）

このディレクトリのモジュールは、次のいずれにも依存してはならない。

- `cloudflare:workers`（DO / WS / storage などのプラットフォーム作用）
- `fs` / `node:fs` ほか Node の I/O（JSONL ファイル読み書き）
- WebSocket クライアントライブラリ（`ws` 等）
- `console.log` 出力・`Date.now()` などの暗黙の時計（時刻は引数で受け取る）

ここに置くのは、決定的な純粋関数のみ。

- log codec（Operation_Log / Instrumentation_Log の直列化・解析）
- 起動引数の検証（`validateProbeArgs`）
- シナリオの型・検証・整列・待機判定（`validateScenario` / `orderedSteps` / `shouldStopAwaiting`）
- Correlator（`mergeByTime` / `classifyInstances` / `verifyAlarmFiredInIdle` / `verifyRehydrateCount` / `determineVerdict`）

## なぜ純粋に保つか

観測の核心は「二つのログが何を意味するか」の判定である。これを純粋関数に閉じ込めれば、
判定ロジックを実 Cloudflare もファイルも実時間も介さず、生成した大量のログ列に対して
property（fast-check）で検証できる。I/O・実時間・WS・`console.log` は端
（`tools/observe/`・`src/shell/`）へ寄せる。

## デプロイ Worker バンドルに含めない

`src/observe/` は `src/worker.ts` から import されない。デプロイされる Worker バンドル
（`src/worker.ts` → `src/shell` / `src/core` / `src/client`）には含めず、バンドルを膨らませない。
