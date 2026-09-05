---
status: accepted
date: 2026-09-04
specs: lift-group-planning, lift-group-display
---

# Timer は由来する卓（tableId）を `orderItem` の内側に持つ。engine 専用・永続する・client ワイヤには出さない

> **（2026-09-05 改訂）** 表題の「client ワイヤには出さない」は `lift-group-display` が改めた（Consequences の 2 点目）。卓が `orderItem` の内側に宿る判断と永続の版は変わらない。

群の最初の 1 本を始めると PendingOrder は消費され、走行中 Timer がどの卓のものかは状態から辿れなくなる。そのまま再計画すると残りの品目は「1 本目抜き」で揃え直され、群は最初の一手で崩れる。これを防ぐため `Timer` に `tableId`（`string | null`）を持たせ、同じ卓の走行中 Timer を採点の成員（実効 endTime を serveAt とし、動かせない）に含める。群の錨は `max(走行中の実効 endTime の最大, 未着手の earliest の最大)` の一つの max であり、boiled（実効 endTime が過去）が残っていても錨は過去へ落ちない。

`tableId` はオーダーの事実であり、Timer が既に持つ `orderItem`（v7 で追加・欠如は null）の**内側**に置く。Timer の直下に置けば `(orderItem = null, tableId = "T1")`、つまり POS を経ていないのに卓を知る Timer が型として構築できてしまう。オーダーの参照の内側にあれば、その状態は表現不能になる。走行中から卓ごとの提供時刻を引く射影（`tableMembers`）は解放表（`initialRelease`）と同じ資格の第二の表で、実効 endTime の唯一の出所と同じファイルに置く。配置も採点も表だけを読む。計画が出した `serveAt` を開始時に Timer へ写す案は導出値を状態に昇格させるので採らない。開始しても PendingOrder を消さず「開始済み」の印を付ける案は、Timer から導ける事実を二重に持つので採らない。

## Consequences

- 永続スキーマの版が上がる（v9 → v10）。v9 以前の Timer は `tableId = null` として移行する。同じ版で `AcceptedSlice.score` を落とす（ADR-0001）。
- ~~`TimerFact`（client ワイヤ）には出さない。走行中カードに卓を表示する必要が生じたとき、その spec が判断する。~~ **（2026-09-05 改訂・`lift-group-display` 判断 16）** `lift-group-display` が `orderItem`（品目参照と `tableId`）を `TimerFact.orderItem: OrderItemOrigin | null`（`src/domain/timer.ts`）としてワイヤに載せた。用途は群の開始（Group_Started）の判定だけ——同じ卓の走行中 Timer のうち `endTime` が群の `serveAt` に等しいものが在るか——で、走行中カードに卓は表示しない。engine 専用の `Ordered` は消え、`Timer` は `TimerFact` から `orderItem` を継承する。ワイヤで不正（空文字・負の index）なら復号失敗、欠如は null に畳む。`RequestPlan` の `running` には従来どおり出る——外部ソルバが錨を再現するのに要る。
- modification で品目の卓が移っても、走行中 Timer の `tableId` は追随しない。その Timer は既に旧卓の群として茹でている事実であり、再送で届いた未着手の品目は新しい卓の群に入る。
- 錨より earliest が遅い品目があれば群ごと錨より後ろへずれ、走行中との差は減点として残る。ADR-0001 の「一致は保証ではない」の一例である。
