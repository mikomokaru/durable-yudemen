# 実環境確認の記録 — console → Tail → Pipelines → Iceberg（2026-09-12）

対象 spec: [operation-history-log](../../.kiro/specs/operation-history-log/design.md) タスク 2〜3。**本番の Timer には触れていない。** 流れた行はすべて専用の合成 Producer が出したもので、実店舗のデータは含まない。

アカウントは Yamaokaya（`305d89a643ac689b4204454c5493cbde`）。Pipelines・R2 Data Catalog・R2 SQL はいずれも open beta。

## 作った資源

| 種別 | 名前 | ID | 備考 |
| --- | --- | --- | --- |
| R2 bucket | `yude-men-history` | — | Data Catalog 有効 |
| Catalog | warehouse `305d89a643ac689b4204454c5493cbde_yude-men-history` | — | URI は `https://catalog.cloudflarestorage.com/305d89a643ac689b4204454c5493cbde/yude-men-history` |
| Stream | `operation_arrivals_v1` | `19673a8daaed45379ea5f491e8ecf660` | HTTP 取込は無効。schema は [arrivals-v1.schema.json](../../config/history-pipelines/arrivals-v1.schema.json) |
| Sink | `operation_arrivals_v1_sink` | `fd7d1d369e0b452a8d1d29e9a7a62287` | parquet / zstd / roll 60 秒 → `history.operation_arrivals_v1` |
| Pipeline | `operation_arrivals_v1_pipe` | `6861743917f7465a9ad0927204f0df65` | `INSERT INTO operation_arrivals_v1_sink SELECT * FROM operation_arrivals_v1;` |
| Worker | `yude-men-history-tail` | — | binding `HISTORY_ARRIVALS` のみ。route も workers.dev も持たない |
| Worker | `yude-men-history-probe` | — | 毎分の定期実行。`tail_consumers` で上の Tail へ繋ぐ |

**2026-09-16 の追加。** 遅延ログ用に stream `lift_delay_arrivals_v1`（`f620eedb2b9943ada520664aab522173`）、sink `lift_delay_arrivals_v1_sink`、pipeline `lift_delay_arrivals_v1_pipe` を同じ物理 schema で作成した。Tail は dataset ごとに別 binding で送り分ける。合成プローブも遅延の行を出すようにした。本番の Timer では遅延ログの旗（`LIFT_DELAY_ENABLED`）が未設定で、実店舗の遅延行はまだ流れていない。

診断のために一時的に作り、**確認後に削除したもの**: 素の R2 sink `probe_r2_objects` と pipeline `probe_r2_pipe`（JSON でそのまま書き出して行の姿を見るため）、バケット閲覧用の Worker `yude-men-history-inspect`。前者が書いた `probe-objects/` 以下の JSON は残してある。

合成 Producer は確認後に**削除して止めた**（毎分の書き込みを無人で続けないため）。設定 [wrangler.history-probe.jsonc](../../wrangler.history-probe.jsonc) は残してあるので、再開は `pnpm wrangler deploy --config wrangler.history-probe.jsonc` の一回で済む。

残した資源は bucket・Catalog・Stream・sink・pipeline と Tail Worker で、書き込む側が居ないので新しい行は増えない。確認済みの行はそのまま読める。

## 確認できたこと

- **Tail Worker から Pipelines の Stream binding を使える。** 公式資料に記載がなく未確認だった点。`tail` handler 内で `send()` を呼び、`waitUntil` で追跡した。観測した invocation はいずれも `outcome: ok`、例外 0 件、診断ログ 0 件。初回の壁時計は 2516 ミリ秒、CPU は 2 ミリ秒。
- **camelCase の列名がそのまま通る。** stream schema は宣言どおり受理され、R2 SQL でも**引用符なしで**参照できた。Snowflake 側は未確認。
- **int64 を JSON 数値で送って通る。** wrangler が出す送信例は int64 を文字列にしているが、epoch ミリ秒を数値のまま送っても受理され、`long` 列として保存された。
- **原文と観測 metadata が設計どおり保存される。** `canonicalPayload` は Producer が出した一行そのまま、`sourceMetadata` は版付き JSON で切詰めの三値と根拠を持つ。`isSynthetic` と `probeId` は Producer script の allowlist から決まる。
- **R2 SQL で ID 単位の照合ができる。** `count(*)`、`WHERE probeId = '...'`、`ORDER BY ... DESC LIMIT` が動いた。結果には走査したファイル数と byte 数が出る。
- **テーブルは行より先にできる。** sink 作成後、最初のデータファイルが来るまでの query は `Query executed successfully with no results` を返した。テーブル不在（`40010`）とは別の状態として扱う。

## 可視までの実測

| 事象 | 時刻 |
| --- | --- |
| プローブの操作時刻（`eventTime`） | 06:29:16.873Z |
| Pipelines の取込（`__ingest_ts`） | 06:29:17Z |
| R2 SQL で読めた時刻 | 06:30:51.9Z |

操作から取込までは 1 秒未満。**操作から R2 SQL で読めるまでは約 95 秒**で、15 秒ごとに問い合わせた計測なので真の値は 80〜95 秒の間にある。roll interval 60 秒の設定と整合する。プローブの確認期限を決める材料になる（初期案の 15 分には十分な余裕がある）。

## Iceberg テーブルの実際の形

`format-version: 2`。列 ID と型は次のとおりで、**取込時刻列は Cloudflare 側が先頭（ID 1）に足す**。宣言した 14 列は ID 2 以降に宣言順で並ぶ。

| ID | 列 | 型 | required |
| --- | --- | --- | --- |
| 1 | `__ingest_ts` | timestamp | Yes |
| 2–15 | `dataset` / `physicalVersion` / `payloadVersion` / `arrivalId` / `eventId` / `storeId` / `source` / `guarantee` / `eventTime` / `observedAt` / `canonicalPayload` / `sourceMetadata` / `isSynthetic` / `probeId` | string / int / int / string / string / string / string / string / long / long / string / string / boolean / string | `eventId`・`observedAt`・`probeId` だけ No |

partition spec は 1 つだけで、`__ingest_ts_day = day(__ingest_ts)`。**イベント日では partition されない。** query はイベント期間と取込走査期間を別に指定する（要件 6.2）。`__ingest_ts` は マイクロ秒精度の UTC timestamp として返る。

## まだ確認していないこと

- Snowflake からの読み取り（external volume・catalog integration・AUTO_REFRESH の費用と周期）。
- schema に合わない行が取込後に落ちる挙動と、その user error metrics の見え方。送信前の validator があるため、実験には意図的に壊した行を送る必要がある。
- 本番 Producer からの経路。root の `tail_consumers` は未 attach のままで、root 設定は現在 CP-SAT 試験の入口を指している。
- 長期の可視遅れ・費用の実測。ここで得た値は数分間の観測にすぎない。

## 配備でつまずいた点（2026-09-16）

`wrangler deploy` は `.wrangler/deploy/config.json` があると、そこが指す生成物（`dist/yude_men_timer/wrangler.json`）を設定として読む。`@cloudflare/vite-plugin` の `vite build` が置く転送ファイルである。**`wrangler.jsonc` を直接編集しても、ビルドし直さない限り配備へ反映されない。**

実際にこれで、12時14分のビルドを本番へ出した。新しく足した `LIFT_DELAY_ENABLED` が配備後の binding 一覧に現れないことで気づいた。`pnpm build` でビルドし直してから配備すると反映される。

もう 1 点。リポジトリの `wrangler.jsonc` は `ACCESS_REQUIRED` が `"0"`、`TEAM_DOMAIN` と `POLICY_AUD` がプレースホルダである。本番は CI と同じ `--var` 上書きで配備する必要がある。上書きを忘れると Access の保護が外れる。

```sh
pnpm build
pnpm wrangler deploy \
  --var ACCESS_REQUIRED:1 \
  --var TEAM_DOMAIN:https://ymoky.cloudflareaccess.com \
  --var POLICY_AUD:<CI と同じ値>
```

## 認証情報

catalog sink の作成と R2 SQL の実行に使うトークンは macOS キーチェーンに置く。service 名は `cloudflare-r2-catalog`、account は `$USER`。値は repo にも手順書にも書かない。読み出し方は [config/history-pipelines/README.md](../../config/history-pipelines/README.md) を参照。
