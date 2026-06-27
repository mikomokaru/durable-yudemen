# tools/observe — 観測ハーネスの端（Node 実行体）

hibernation 観測ハーネス（spec: `hibernation-observability`）の **Node ランタイムの端**を置く。
workerd ではなく Node 上で動く実行体であり、I/O・実時間・終了コードはここに閉じる。

- Probe_Client（`probe.ts`）— `wss://` `/ws` 接続・`start`/`cancel` 送信・受信記録
- Scenario_Runner（`runner.ts`）— 宣言的シナリオを実時間に沿って駆動
- 突き合わせ CLI（`correlate-cli.ts`）— 二つのログを読み `src/observe/` の純粋関数で判定
- CLI エントリ（`probe-cli.ts`）・Deploy_Procedure（本 README 末尾「Deploy Procedure」節）

## 端の契約

- 純粋論理（log codec・scenario 検証・Correlator・引数検証）は `src/observe/` から **import するだけ**。
  ここに純粋論理を再実装しない（判定は Correlator に一元化する）。
- WS・JSONL ファイル IO・実時間スケジューリング・`process.exit`・終了コードはこの層に閉じる。
- **`setInterval` / 終わらない `setTimeout` を持ち込まない。** 各ステップは一度きりの遅延起動で、
  シナリオ完了で必ず終わる（hibernation 規律「待つなら寝かせる、抱えると漏れる」）。

## WS クライアントライブラリの閉じ込め（重要）

CLI が使う WebSocket クライアントライブラリ（`ws` 等）は **この `tools/observe/` 配下に閉じる**。
`src/observe/`（純粋層）には決して漏らさない。`src/observe/` は WS に依存してはならない。

- 依存追加は `pnpm add -D <pkg>`（npm / yarn / npx は使わない。steering: tooling.md）。
- ユーザー向け出力（CLI のコマンドメッセージ・ヘルプ・エラー表示）は**英語のみ**（要件9.4）。

## Deploy Procedure

> This section is the **Deploy_Procedure** (requirements 8.1–8.5): deploy the Worker and
> `StoreTimerDO` to production Cloudflare, enable the instrumentation debug flag, observe the
> four seams (`construct` / `rehydrate` / `alarm` / `broadcast`) live, then restore the default
> (disabled) state and confirm no output remains.
>
> The authenticated commands below (`wrangler deploy`, `wrangler tail`) require Cloudflare
> credentials and are **issued by you** — this repository only documents the steps. Run every
> command from the repository root. The stack is pnpm + Wrangler v4 (do not use npm / yarn / npx);
> invoke the locally installed Wrangler with `pnpm wrangler …`.

### Prerequisites

- Authenticate Wrangler once (`pnpm wrangler login`, or set `CLOUDFLARE_API_TOKEN` for CI).
- `wrangler.jsonc` is the single source of truth for Worker configuration. The debug flag
  `OBSERVE_DEBUG` is defined there and defaults to `"0"` (instrumentation disabled). Leave that
  default committed — the steps below override it only for the observation window.

### 1. Build and deploy (Req 8.1)

```sh
pnpm build          # tsc --noEmit && vite build (type-check, then production bundle)
pnpm wrangler deploy
```

Confirm the deploy succeeded and the Durable Object is published:

- The `wrangler deploy` summary reports the Worker name (`yude-men-timer`), the uploaded
  version id, and the deployed URL.
- The same summary lists the Durable Object binding `STORE_TIMER_DO` bound to class
  `StoreTimerDO` (defined under `durable_objects.bindings` in `wrangler.jsonc`). Seeing this
  line confirms the `StoreTimerDO` binding is published.

### 2. Enable the debug flag for the observation window (Req 8.3)

With `OBSERVE_DEBUG="0"` (the committed default) the DO's `emitSeam` gate returns early and emits
nothing. Enable instrumentation by overriding the variable at deploy time, which keeps the
`wrangler.jsonc` default unchanged:

```sh
pnpm wrangler deploy --var OBSERVE_DEBUG:1
```

`--var` overrides the `wrangler.jsonc` value for this deployment; the value is passed to the
Worker as the string `"1"`, which is exactly what `instrumentationEnabled`
(`env.OBSERVE_DEBUG === "1"`) checks before any seam is emitted.

### 3. Observe the four seams live (Req 8.2)

Open a live tail in one shell:

```sh
pnpm wrangler tail yude-men-timer --format pretty
```

In a second shell, drive the harness against the deployed endpoint so each seam is exercised:

```sh
pnpm dlx tsx tools/observe/probe-cli.ts <wss-endpoint> <store-id> <scenario.json> <operation-log.jsonl>
```

Each seam is emitted by `emitSeam` as a single `console.log(JSON.stringify(entry))` line (the entry
is built by `buildSeamEntry` in `src/observe/log.ts`). Confirm all four `seam` values appear in the
tail output:

- `construct` — a new in-memory DO instance is created (cold start, redeploy, or hibernation wake).
- `rehydrate` — `ensureLoaded` rebuilds `Working_Copy` from the persisted snapshot
  (carries `restoredCount`).
- `alarm` — a scheduled alarm fires (drive a timer to expiry to trigger it).
- `broadcast` — the DO broadcasts a `ServerMessage` after a state change (carries `messageType`);
  a `start` / `cancel` / `done` exercises it.

To reduce noise you can filter the tail to seam lines, e.g. `--search '"seam"'`.

### 4. Collect the Instrumentation_Log for correlation (Req 8.2)

For correlation with `correlate-cli`, the Instrumentation_Log must be a text file where each line is
one seam JSON object that `parseInstrumentationLine` accepts. `wrangler tail --format json` wraps
each event in an envelope and places the `console.log` string at `.logs[].message[]`, so extract
that field and redirect it to a file:

```sh
pnpm wrangler tail yude-men-timer --format json | jq -rc '.logs[].message[]' >> instrumentation-log.txt
```

`jq -rc '.logs[].message[]'` emits the raw seam JSON string (one per line). `parseInstrumentationLine`
(invoked per line by `correlate-cli`'s `parseInstrumentationLog`) is tolerant: any line that is not a
valid seam object (connection notices, envelope noise) is recorded as a parse failure and never
mistaken for a valid entry, so a slightly noisy capture does not corrupt the verdict.

Then correlate the Probe_Client's Operation_Log against the collected Instrumentation_Log:

```sh
pnpm dlx tsx tools/observe/correlate-cli.ts <operation-log.jsonl> instrumentation-log.txt
```

Exit codes: `0` confirmed, `1` fail, `2` inconclusive, `64` usage error, `66` input error.

### 5. Restore the default (disable) and confirm no output (Req 8.4)

When observation is complete, redeploy **without** the override so `OBSERVE_DEBUG` returns to its
committed default `"0"`:

```sh
pnpm wrangler deploy
```

Verify instrumentation is silent: tail again and exercise the seams (construct/rehydrate via a
redeploy or reconnect, broadcast via `start`/`cancel`). With the flag back at `"0"`, `emitSeam`
returns early and **no** `seam` lines appear in the tail output.

```sh
pnpm wrangler tail yude-men-timer --format pretty   # exercise the seams; expect no seam lines
```

### Security: the WebSocket endpoint is unauthenticated (Req 8.5)

The `/ws` endpoint targeted by this harness is published **without authentication**. Any third
party who knows a store identifier can connect over `wss://` and send `start` / `cancel` messages.
This is accepted **only under the pilot premise** (a limited network and a short verification
window), and adding access control is **out of scope** for this harness. **Before any production
rollout, an authentication layer is mandatory.**
