# CP-SAT 観測 interface（schemaVersion 1）

タスク1用。公開名は2026-09-09にユーザー承認済み。計画の `cpsat/v1` envelope、既存4種類の seam、Operation History、WS のいずれとも別の契約である。

## 呼出側と責務

`observation.ts` の `buildCpsatObservation`／`parseCpsatObservation`／`serializeCpsatObservation` は純粋。`observe.ts` の `observeCpsat` だけが同期 sink（既定は console）へ出力する。時刻・UUIDの発行は呼出側の責務であり、ここでは行わない。秘密値・入力全文は受け取らない。

- `buildCpsatObservation` は schemaVersion を1に固定し、検査済みコピーか `null` を返す。
- `parseCpsatObservation` は単一 JSON 行または unknown 値を検査する。失敗時に入力や例外本文を返さない。
- `serializeCpsatObservation` は再検査後、キー順を正準化した JSON 行か `null` を返す。
- `observeCpsat` は成功時 `true`、検査・出力失敗時 `false`。失敗を Timer 操作へ throw しない。sink は同期であり、Promise を返す exporter を渡さない。
- 出力失敗は無かったことにしない。呼出側／取得側は coverage に不完全性を記録する。記録のための DO storage・Alarm・自己再試行は追加しない。

### 3つの入口

同じ `observeCpsat` を、次の**異なる瞬間**に呼ぶ。現在の実行例は [fake interpreter の H1〜H3](../../tests/observe/cpsat.example.test.ts)。実アプリの経路へ接続済みという意味ではない。

| 入口 | fact.type | 識別と呼出順 |
| --- | --- | --- |
| H1 | `cpsat.request-generated` | `decide` の戻り値から RequestPlan を見つけた直後、Persist より前。instanceId＋decisionId＋Effect の位置 |
| H2 | `cpsat.request-dispatched` | 輸送抑制を通過し、実際の binding 呼出を試みる直前。requestId ごとに1試行 |
| H3 | `cpsat.solve-started` | 初期化・モデル生成・直列化の後、WASM 呼出直前。requestId＋solver instance／invocation |

ID と `at` は作用側で発行して明示的に渡す。`parentEventId` は直接の先行事実を指す。ログ到着順や、別 isolate の時計の大小で順序を推定しない。

fake interpreter は既存の `decide` が作った Persist 先頭の列を使う。生成口の後で put が失敗すれば生成1／送出0。202受理だけで求解しなければ送出1／求解0。同期 fake の完走は cloud の受理・求解分離の証拠ではない。

## 行の契約

- `storeRef` と Timer／品目の参照は64桁の仮名。実店舗名・注文識別子をそのまま渡さず、必要な対応表は非公開側に置く。
- `backend` は ts／cpsat、`mode` は live／probe／fake。直接 probe は `origin.kind = probe` とし、engine の生成を作らない。
- `eventId`、`instanceId`、`invocationId`、decision／request ID は独立の識別子。eventId はログの再配送でも変えない。requestId は送出試行ごとに新しくする。
- `versions` は code／model／codec／WASM SHA-256／生成JS SHA-256／profile SHA-256／budget の識別。知らない値は `null` と missingReason を持つ。fake と実測の版を取り違えない。
- fact は閉じた種類・フィールドだけを受け付ける。未知フィールド、例外本文、正準入力、注文、認証値、独自 toJSON は出力しない。

H1→persist-result→H2 が今回の状態変更列。抑制は H1 に対応づける。H2→solver-accepted→H3→solve-finished と進み、dispatch-result（202／失敗／busy）は H2 に直接対応づける。受理と求解開始は別である。preparation-failed は solver-accepted に対応づけ、求解失敗回数には加えない。

採用関係は solve-finished→plan-decided→plan-persisted→plan-broadcast と分ける。`adopted` は採用判断の通過であって put 成功ではなく、`planSaved` を別に見る。後の invocation に届いた重複応答の棄却も別の判断として数える。callback-returned は DO の処理を含む呼出の戻りであり、呼出開始ではない。

同じ request に関わる行は model／codec／WASM／JS／profile／budget の識別を引き継ぐ。app と solver 自身の code 識別は異なってもよい。`parentEventId` と request／decision が食い違う行は計数可能としない。

### 時間と資源

`cpsat.measurement` は metric、requestId、reading を持つ。取得元 invocation は行の invocationId で対応づける。測定値がない場合は `{ value: null, reason }`。進まない時計を CPU 0 にしない。

| metric | 単位／取得範囲 |
| --- | --- |
| cpu-limit-ms | 構成したCPU上限。探索量とは別 |
| cpu-ms／invocation-wall-ms | プラットフォーム invocation 全体。solver 専用 CPU と呼ばない |
| acceptance-wall-ms | 実送出→202受理を host で観測 |
| solve-callback-wall-ms | 求解開始→DO の処理を含む callback 戻りを host で観測 |
| wait-until-wall-ms | 応答送信→全 waitUntil 終端なら exact。終端を含むと確認した invocation 全体で代用する場合は upper |
| wasm-bytes／isolate-bytes | 確保容量／取得可能な isolate 全体メモリのバイト数。別の量 |
| budget-deterministic／consumed-deterministic | 指定・消費探索量。実時間の秒数ではない |
| variables／constraints／model-bytes | 生成したモデルの個数／バイト数 |

waitUntil の終端を含むことの実環境での確認はタスク2。名前だけで包含を証明したことにしない。upper から計算する30秒枠の余裕は lower であり、今回の集計CLIはこの実測や余裕判定を行わない。

`cpsat.timer` は `plannedServeAt`、Boil_Sync 後の `effectiveEndTime`、自動発火 `boiledAt` を別の epoch ms 欄で保持する。boiledAtState は observed／not-fired／missing。復帰時に異なる endTime が同じ boiledAt になり得る。人の麺揚げ操作や Complete の時刻ではない。Timer の実経路への接続はタスク6.5。

## 集計と欠測

[summarizeCpsatObservations](../observe/cpsat.ts) はログ系列と `CpsatObservationCoverage` を受け取る純粋関数。`src/observe` は Worker へ import しない。

- 評価区間 `[from,to)`、取得区間 `[capturedFrom,capturedTo)`、保持開始 retainedFrom、samplingRate、exportComplete、scope の一覧、欠落区間 gaps、稼働頻度の frequencyLimits を明示する。
- 評価窓をまたぐ先行行は、取得区間内の文脈として渡す。評価外の行を計数へ足さないが、相関には使う。
- 同じ eventId の同じ行は重複として除外。違う内容や、IDを変えた同じ生成／送出は衝突として判定する。instance 内の累積カウンタは使わない。
- 店舗×backend×mode ごとに全区間と固定1分窓を出す。端の1分未満の窓は端数として表示し、頻度上限の合否は判定しない。
- `observed` は取得できた行の件数。欠測があれば `counts = null`。未取得を0件へ補完せず、sampling の逆数による推計もしない。
- 行の破損・相関不正・ID衝突は保守的に全窓を不明とする。既知の gap だけであれば、その gap と重なる窓を不明とする。
- unknown の起動理由と再送分類には独立の件数がある。knownSameInputRetries が0でも、retryClassificationUnknown があれば「再送なし」ではない。
- `usableForRates` は観測の計数に利用できるという意味のみ。求解成功、採用成功、P14以外のゲート合格を意味しない。
- frequencyLimits は稼働中の1分あたり件数。未設定なら not-configured、欠測なら not-assessed、超過なら exceeded。稼働中の超過時は要求の契機・輸送上限・対象上限を見直す。試験時の費用枠は別に定める。

相関は、子が参照する中間行の欠落を検出できる。しかし末端行や、要求一式が丸ごと消えた場合をログだけから証明することはできない。coverage は取得側の証拠で与え、ログが空という理由だけで exportComplete を true にしない。cold／hibernation／deployment も取得側の根拠がある場合だけ分類し、constructor の存在だけなら unknown。

## ローカル再実行

```sh
pnpm test --project observe
pnpm exec vite-node --config tools/preflight.vite.config.ts tools/observe/cpsat-summary.ts tests/observe/fixtures/cpsat-counts.json
```

CLI は最大32 MiBの `{ coverage, rows }` JSON を読み、stdout に集計を返す。既存のプラグイン無し Vite 設定を使い、Cloudflare を起動・呼出ししない。exit 0＝計数可、1＝欠測／不整合、2＝不正入力。Workers 生ログの抽出・取得証明はタスク2で接続する。
