# タスク2.2：配備差分と復帰手順（投入前・承認資料）

**2026-09-10後続の現在地：手順2・3まで実行。** 件数差を許容する追加承認と再照合後、非公開solverの無効初期版とTS bindingのみのshimを配備。ログ取得APIの403により手順4以降は停止している。アプリ再配備・合成レコード作成は未実施。[版・疎通・残予算・停止理由](./transport-bootstrap-cloud-20260910.md)。以下の「未配備」「未承認」は資料提出時点の履歴である。

**最新状態（2026-09-10）：8項目の投入承認を受領、未配備。** 再照合でアカウント全体のDO namespace件数が12→11へ変わったため、承認条件に従い停止している。[承認と再照合記録](./cloud-approval-20260910.md)を参照。以下の承認待ちの表現は資料提出時点の履歴であり、現在は投入承認ではなく再照合差異の扱いが確認待ちである。

2026-09-10 作成。**未配備・未承認。** 本書は 2.1 の 5 項目へ明示承認を求めるための資料であり、承認そのものではない。数値・版は [2.1 の読み取り調査](./cloud-targets-20260909.json)（2026-09-09 12:10:55 UTC）に基づく。**投入直前に再照合し、変わっていれば停止する。**

## 0. 前回資料からの重要な訂正

**新規 Worker は 1 つではなく 2 つである。** 2.1 の承認項目1は「非公開 solver を新規配備する」とだけ書いていたが、ローカルで確立した経路は次のとおりで、輸送 shim も独立した Worker を要する。

```
実StoreTimerDO → 既存 SOLVER binding → 輸送shim → 固定CP-SAT solver → 同じDOのdeliverPlan
                                    └→ 対象外店舗は shim が TS solver へ1回転送
```

したがって**アプリの既存 `SOLVER` binding は張り替えになる**。通常店舗の計画要求も例外なく shim を通る。これは項目5が扱う影響そのもので、承認資料の中心に置く。

## 1. 作成・再配備する Worker と binding 一覧

### 1.1 新規作成（2件）

| Worker | 役割 | 公開範囲 | 確認済みの現状 |
| --- | --- | --- | --- |
| `yude-men-cpsat-planner-dev` | 固定問題の CP-SAT 求解。単一 frozen-clock WASM instance | routes 無し・`workers.dev=false`・`preview_urls=false` | settings／subdomain／deployments すべて404（code 10007）＝新規 |
| `yude-men-cpsat-transport-shim-dev` | `SOLVER` の受け口。対象店舗は固定問題へ変換、対象外は TS へ1回転送 | 同上 | 未作成 |

### 1.2 binding の変更前後

**アプリ `yude-men-timer`（`timer-dev.yamaokaya.org`）**

| binding | 変更前 | 変更後 |
| --- | --- | --- |
| `SOLVER` | → `yude-men-solver` | → `yude-men-cpsat-transport-shim-dev` |
| `CPSAT_SOLVER` | （無し） | → `yude-men-cpsat-planner-dev` |
| named entrypoint | （無し） | `CpsatTransportProbe`／`CpsatTransportOperations` を export |
| `STORE_TIMER_DO`／`STORE_REGISTRY_DO`／`ASSETS`／secrets | 変更なし | 変更なし |

**輸送 shim（新規）**

| binding | 向き先 | 追加する段階 |
| --- | --- | --- |
| `SOLVER` | → `yude-men-solver`（対象外店舗の転送先。現行と同一） | 手順3 |
| ~~`CPSAT_SOLVER`~~ | ~~→ `yude-men-cpsat-planner-dev`~~ | **2026-09-12 に撤回**。求解 Worker への直接 binding は置かない |
| `CPSAT_PLAN_QUEUE`（producer） | → queue `cpsat-plan-requests` | 手順4（差し替え） |

**固定 CP-SAT solver（新規）**

| binding | 向き先 | 用途 |
| --- | --- | --- |
| `STORE_TIMER_DO` | → 既存 namespace `a3ac2d321837499188ee9cb979a4efdc`（`class_name: StoreTimerDO`、`script_name` はアプリ Worker） | callback。`deliverPlan` を同じ DO へ返すために必要。**新しい namespace は作らない** |

solver は任意 URL への callback を持たない。宛先は要求の `storeId` から `idFromName` で引く。

**`yude-men-solver`（TS）**：再配備しない。現稼働版 `e134e93b-1208-452f-847f-cbf344777119`、`workers.dev`／preview とも無効のまま。

### 1.3 変更しないもの

DO namespace（`StoreTimerDO` `a3ac2d321837499188ee9cb979a4efdc`／`StoreRegistryDO` `cedc7e2c44b44c828c1a96a37eee5702`、いずれも SQLite backend）、既存の認証・secret・店舗設定・公開範囲、root `wrangler.jsonc`（現状 HEAD と同一）、`src/worker.ts`・`src/shell/store-timer-do.ts`・engine・UI・永続形式。

## 2. 通常店舗の TS 経路への影響

**「通常店舗は TS で求解する」と「従来の TS 直結経路が無変更」は同義ではない。** 張り替え後、対象外店舗の計画要求は次を追加で通る。

| 追加される要素 | 内容 |
| --- | --- |
| ホップ 1 段 | app → shim → TS solver。service binding は既定で同一スレッド実行であり、配置は CPU 分離の保証ではない |
| routing 検査 | 本文を最大 1 MiB まで読み、UTF-8／JSON／`storeId` を検査してから転送先を決める |
| 新たな失敗点 | shim 自身の例外・CPU・デプロイ不整合。1 MiB 超過は shim が 400 を返し、**従来なら TS へ届いていた要求が届かない** |
| 遅延 | 上記の読み取りと転送分。実測は未取得（2.3） |

緩和：`requestPlan` は応答を読まず例外も握るため、**shim の失敗は Timer 操作・注文受理へ伝播しない**（計画要求が 1 回失われるだけで、次の状態変化で再要求される）。これは既存契約の帰結であって、shim が安全であることの証明ではない。

実測見込み：`PlanRequest` は計画対象最大64件＋Timer＋設定で、概ね数十 KiB。1 MiB 超過は現実的でないが、**上限に当たったときの挙動が従来と異なる**ことは投入条件として承認対象に含める。

## 3. 投入順序・停止条件・復帰

### 3.1 投入順序

1. **配備直前の再照合。** 対象ドメイン・実 Worker・現稼働版・DO ID・Access 設定・公開範囲・CPU 上限・観測設定・合成 ID の空きを取り直す。1つでも 2.1 の記録と異なれば停止する。ローカル HEAD の一致は代用にならない。
2. **solver を配備**（`yude-men-cpsat-planner-dev`）。アプリからは未接続のまま、非公開の検証経路で往復を確認する。
3. **shim を配備**（`SOLVER` → `yude-men-solver` のみを持つ状態で）。この時点でアプリは未変更。
4. **shim に Queue の producer を追加して再配備。** 既に `CPSAT_SOLVER` を持つ版が配備済みなので、この再配備は「**`CPSAT_SOLVER` の削除と producer の追加**」という変更になる（2026-09-12 の方式変更）。手順3と分けるのは、TS 転送だけの shim を先に単体で確認するため。
   - 旧手順の疎通確認 `check-bootstrap-cloud.mjs` の非 shim 経路は、その binding を叩くものだったので**もう走らない**。理由を添えて止まるようにしてある。旧設定 `wrangler.remote-bootstrap.jsonc` の `CPSAT_SOLVER` も削除済みで、いずれも旧手順の記録である。
5. **合成レコード作成。** チェーン1・店舗4件。作成直前に未登録を再確認し、衝突なら**上書きせず停止**。
6. **アプリを再配備。** `SOLVER` の張り替え・**Queue producer の追加**・2 entrypoint の export。通常計画器は TS のまま。**`CPSAT_SOLVER` は追加しない**——直接 probe も Queue に載せたので、アプリから求解 Worker へ届く binding は存在しない（2026-09-12）。
   - 配備設定は root の `wrangler.jsonc` ではなく vite が生成する `dist/yude_men_timer/wrangler.json` である。root を編集したら**再ビルドしないと配備に効かない**。生成物に `queues` が通ることは確認済み。
   - Access の 3 値（`ACCESS_REQUIRED`・`TEAM_DOMAIN`・`POLICY_AUD`）は `--var` で明示指定する。`--keep-vars` は**設定に載っている var を保護しない**（消さないだけで設定値は書き込まれる）。実値は `wrangler versions view --json` が切り詰めずに返す。
7. 2.3〜2.5 の計測を実施する。

### 3.2 停止条件

- 再照合の不一致、合成 ID の衝突、対象外店舗への到達が1件でも観測されたとき
- 台帳が停止したとき。枯渇（`dispatch-limit`／`operation-limit`／`connection-limit`／`dispatch-allowance`）と契約違反（`concurrent-limit`／`unreserved-dispatch`）を区別して記録する。`open-connection-limit` は想定内の満杯であり停止条件ではない
- 通常系で CPU・メモリ・`waitUntil` 余裕（10,000 ms 以上）を満たさないとき
- 費用の見積りが US$20 を超えたとき、または観測不能になったとき
- 実店舗への影響が疑われるとき（**アプリ復帰を最優先し、試験の後始末を待たない**）

### 3.3 復帰先の版と設定

| 対象 | 復帰方法 |
| --- | --- |
| Queue `cpsat-plan-requests` / `cpsat-plan-requests-dlq` | 試験後に削除する。producer binding（アプリ・shim）を先に外し、consumer 配備を戻してから queue を消す——順序を逆にすると、行き先を失った送出が黙って失敗する |
| アプリ `yude-men-timer` | 版 `be146588-b3f0-4f54-9134-f5baf744d8fd`（deployment `6cdfed3e-5b87-49c5-b549-b091eb4f0991`、100%、2026-09-09 07:20:35 UTC）へ戻す。候補コマンド `pnpm exec wrangler rollback be146588-... --name yude-men-timer`（**未実行**）。`SOLVER` が `yude-men-solver` 直結へ戻ることを GET で照合する |
| 輸送 shim | 初回配備のため復帰先の旧版が無い。**停止版**（下記）を配備して閉じる。削除はしない |
| CP-SAT solver | 同上。停止版を配備して閉じる |
| 合成店舗 | 非活性化。レコードは証拠として残す。削除は別途承認 |
| DO・業務データ | 触らない。snapshot 巻き戻し・namespace 再作成・スキーマ版更新はいずれも復帰条件にしない |

**訂正：** 以前「binding は version rollback に含まれない」と書いたのは誤り。**Worker version は binding を含む**ので、version を戻せば binding も戻る（[公式](https://developers.cloudflare.com/workers/versions-and-deployments/)）。戻らないのは**接続先リソースの状態**——合成店舗のレコード、DO に書かれたデータ、作成済みの Worker そのもの——であり、それは別に片づける。復帰後に binding・vars・公開範囲を GET で照合する手順は、rollback が期待どおり効いたことの確認として残す。

### 3.4 停止版の成果物・設定・コマンド（準備済み）

shim・solver とも初回配備で戻る先が無いため、「閉じるための版」を用意した。**未配備。**

| ファイル | SHA-256 |
| --- | --- |
| `experiments/cpsat-workers/transport/halt.ts` | `89275761447b7a129d42cfd6829b059e1508ddbebfdede740d5af3d375010eb1` |
| `experiments/cpsat-workers/transport/wrangler.halt-shim.jsonc` | `116c283e6a0d0c9cc988de5bd938086212f74c6e985cb68125f175ed1ee582cc` |
| `experiments/cpsat-workers/transport/wrangler.halt-planner.jsonc` | `ffba714ba4e7ab06ea8f84473a03f2362a0aae8217f768ece31d46dc209eb626` |
| `tests/cpsat-transport-halt.example.test.ts` | `d4b5047c7a7099d2c2d007bd0776bf04f17658197e5e1afb59f79e66f6745aaf` |

**shim は CP-SAT 向けにだけ何も送らない。** manifest が無効でも、**対象外店舗の要求は TS へ転送される**（店舗照合が窓の検査より前にあるため、意図的にそうしている）。手順 6 の前に通常店舗へ影響が無い根拠は、manifest の状態ではなく**アプリがまだ shim を指していないこと**である。

**拒否は構造による。** `halt.ts` は import を持たず `env` を読まない。binding も Wasm も fixtures も manifest も無いので、**求解も転送も callback も到達手段がない**——この版の分岐が正しいかどうかに依存しない。`fetch` は引数を 1 つも取らないが、**これ単独では入力非依存の証明にならない**（引数を無視してグローバルを読むこともできる）。保証の根拠は「当該ハッシュのソースが 503 だけを返すこと」と「設定・テストの照合」であり、引数の個数は形が変わったことを検出する signal として記録している。

検査（`pnpm test` に含む）：

- ハンドラが 503・`Cache-Control: no-store`・空ボディを返す（引数の個数も記録するが、それ自体を保証の根拠にしない）
- ソースに `import` が無く `env.` を読まない
- 両設定とも `name` が対象 Worker、`main` が `./halt.ts`、`workers_dev`／`preview_urls` が false
- 両設定に `services`・`durable_objects`・`vars`・`kv_namespaces`・`r2_buckets`・`routes`・`route`・`rules`・`limits` の**いずれも存在しない**

`wrangler deploy --dry-run` でも確認した（両設定とも 0.21 KiB・**No bindings found.**）。

```sh
# 事前確認（配備しない）
pnpm exec wrangler deploy --dry-run \
  --config experiments/cpsat-workers/transport/wrangler.halt-shim.jsonc \
  --outfile /tmp/halt-shim.bundle

# 実行（アプリ復帰の確認後）
pnpm exec wrangler deploy --config experiments/cpsat-workers/transport/wrangler.halt-shim.jsonc
pnpm exec wrangler deploy --config experiments/cpsat-workers/transport/wrangler.halt-planner.jsonc
```

### 3.4.1 観測に関する 2 つの訂正（2026-09-10・ユーザー指摘）

**手順 4（shim へ producer 追加）だけでは観測行は出ない。** チェックイン済み manifest は `enabled: false` なので、binding を足しても固定問題の送出・求解は動かない。観測には (a) 期限付きの有効化と (b) 台帳で予約した試験要求が別途要る。実 engine の生成計数（H1）はタスク 3.5 に残ったままである。

**`head_sampling_rate: 1` は「設定上の間引きが無い」ことの証拠であって、欠落ゼロの保証ではない。** ログの上限・切り詰めは別条件で決まる（[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)）。収集記録では sampling が既知であることと、取りこぼしが無いこととを別の主張として扱う。

**retention は未確認。** 収集器は `retainedFrom` を null のままにし、`usableForRates` は false を維持する。正式な頻度評価（R8.10）の前に確認する。

### 3.4.2 初回試験の設定（仮置き・ユーザー提案）

**性能の実測に基づく値ではない。** 初回運用の仮置きとして置き、実測後に見直す。

| 項目 | 値 |
| --- | --- |
| 有効化窓 | **30 分**。うち **20 分で新規投入を止め**、残り 10 分を結果回収と切断確認に使う |
| 台帳 | 承認済みの累積上限を維持し、**bootstrap で消費した予約も引き継ぐ**。新しい台帳で予算をリセットしない |
| 実行 | 並列化しない。小問題 1 件 → callback・観測の確認 → 難問 1 件。**欠測や不整合があれば拡大しない** |
| 窓の開始 | 合成レコード・ドライバ・復帰手順の準備が揃ってから。**準備中に期限を消費しない** |

retention 未確認のままなら、**輸送の個別確認と正式な頻度評価は分ける**。

#### 台帳の同一性を campaign 単位へ直した

「予算を引き継ぐ」を実装が満たしていなかった。`trialFingerprint` が `notBefore`／`expiresAt` を含んでいたため、**新しい窓を開くたびに別の試行と判定され、ジャーナルが拒否されて予算がゼロから始まる**。

同一性を campaign（code／codec／profile／wasm／glue／店舗集合）で定め、窓は identity から外して**各セッションの事実として `window` 行に記録する**形へ直した。窓が違っても同じジャーナルを継続し、profile 等が違えば従来どおり拒否する。回帰試験を追加し、窓を指紋へ戻すと落ちることを確認した。

### 3.4.3 実施記録（2026-09-10）

| 手順 | 状態 | 記録 |
| --- | --- | --- |
| 1 再照合 | 完了 | [cloud-targets-predeploy-20260910.json](./cloud-targets-predeploy-20260910.json) |
| 2 solver 配備 | 完了 | [cloud-targets-bootstrap-planner-20260910.json](./cloud-targets-bootstrap-planner-20260910.json) |
| 3 shim 配備（TS 直結のみ） | 完了 | [cloud-targets-bootstrap-shim-20260910.json](./cloud-targets-bootstrap-shim-20260910.json) |
| 4 shim に `CPSAT_SOLVER` 追加 | 完了 | version `915a98ed…` → `e77b17a7-4a8b-42e2-803a-187041345dd6`、deployment `3b38d8dd-b14f-47ac-941f-36fbe6e62484`。binding は `CPSAT_SOLVER→yude-men-cpsat-planner-dev` と `SOLVER→yude-men-solver` の 2 件のみ、`workers.dev` は無効を確認 |
| 5 合成レコード作成 | 完了 | [provision-check-20260910.json](./provision-check-20260910.json)（事前確認・5 件とも 404）、[provision-20260910.json](./provision-20260910.json)（チェーン 200、店舗 4 件 201） |
| 6 アプリ再配備 | **未実施** | 承認項目 5 が実際に効く段階。有効化・試験開始とまとめて判断する |

**手順 5 の時点でもまだ何も動かない。** アプリは shim を指しておらず、manifest も無効なので、合成店舗が 4 件存在するだけである。

観測ログの取得経路は別途確認済み（telemetry query 200、両 Worker の `head_sampling_rate: 1` を配備済み設定から取得）。retention は未確認のままで `usableForRates` は false。

#### 資格情報について（2026-09-10・付随して判明）

手順 5 の実行で、**ローカル `.dev.vars` の `ADMIN_TOKEN` が `timer-dev` の配備済み secret と一致している**ことが分かった（401 ではなく 404 が返った）。同ファイルには Cloudflare Access の service token も平文で置かれている。本 spec の変更対象ではないが、試験の後始末とは別に扱いを見直す価値がある。

### 3.5 復帰の順序（固定）

**アプリを先に戻す。** shim を先に止めると、アプリの `SOLVER` が 503 を返す先を指したままになり、**通常店舗の計画要求が失われる**。

| # | 操作 | 確認 |
| --- | --- | --- |
| 1 | アプリを `be146588-b3f0-4f54-9134-f5baf744d8fd` へ rollback | GET で `SOLVER` → `yude-men-solver`、`CPSAT_SOLVER` と named entrypoint が消えていること。version は binding を含むので rollback で戻る |
| 2 | 通常店舗の計画要求が TS へ直結で届くことを確認 | 1 が済むまで 3 へ進まない |
| 3 | shim へ停止版を配備 | この時点で shim を指すものは無い。`No bindings found.` を配備ログで確認 |
| 4 | solver へ停止版を配備 | 同上 |
| 5 | 合成店舗 4 件を非活性化 | レコードは証拠として残す。削除は別途承認 |
| 6 | 試験ドライバのロック・ジャーナルを回収 | 再導出できない停止でロックが残っていれば、その理由を記録する |

異常時は 1 を最優先し、試験の後始末（3〜6）を待たない。

## 4. 上限一覧

| 量 | 値 | 定義 | 出所 |
| --- | ---: | --- | --- |
| 累積送出 | 128 | 試行全体で固定 solver へ送る回数。失敗・再送も消費 | 2.1 承認済み案 |
| 累積操作 | 512 | 業務遷移を起こす操作の回数。各1件の送出枠を先払い | 同上 |
| **累積 WS 接続試行** | **32** | **試行全体の接続試行数。再接続・失敗も消費し、切断しても戻さない。各1件の送出枠を先払い**（復帰を起こす接続は constructor の Reconcile → `runEffects` で要求を生み得るため） | **本書で承認を求める（2026-09-10 追加）** |
| **同時 WS 接続** | **4** | **接続中・接続済みの本数。接続開始前に確保し、接続失敗または切断確認で解放する。累積32件の予約は戻さない。`concurrent` とは独立に検査する** | **本書で承認を求める（2026-09-10 追加・実装済み）** |
| **予約作業の同時実行** | **4** | **台帳の予約処理を同時に走らせる上限。開いたままの WS の本数ではない**（WS は受理直後に `settle` するため枠を保持しない） | 2.1 承認済み案（**定義を訂正**） |
| solver の isolate 内同時求解 | 1 | isolate ごと。isolate をまたぐ集計ではない | 実装 |
| solver の isolate 内受理 | 128（`maxDispatches`） | isolate ごと。累積の権威は台帳 | 実装 |
| 探索予算 | small 0.01 / hard 0.14 | deterministic time。実時間ではない | fixtures |
| solver CPU 上限 | 10,000 ms | 配備値 | manifest |
| `waitUntil` 必要余裕 | 10,000 ms 以上 | 消費 20,000 ms 以下 | 2.1 §3 |
| 往路・protobuf・復路 | 各 1 MiB | shim の routing 読み取りも 1 MiB | 実装 |
| 費用 | US$20 | 公開単価による予算。課金のハードキャップではない | 2.1 承認済み案 |

### 4.1 用語の訂正と、追加した同時接続上限

**`concurrent: 4` は「開いたままの WS の同時接続上限」ではない。** 台帳は WS が 101 を返した直後に `settle` するため、開いている WS は同時実行枠を保持しない。この値が縛るのは**予約処理そのものの同時実行**である。

訂正前の記述は「同時接続は無制限」としていたが、これも不正確だった。**正しくは「独立した同時接続上限が無い」**である——累積 32 件が正しく強制される範囲では、同時接続も最大 32 本で有界だった。

**採択（(ii)）：独立した同時 WS 接続上限 4 本を実装した。**

| 規則 | 実装 |
| --- | --- |
| 接続開始前に枠を確保する | `reserve("connection")` が耐久予約と同じ直列化の中で枠を取る |
| 接続中・接続済みの両方を数える | 枠は受理では戻らない |
| 接続失敗または切断確認で解放する | `releaseConnection(id, reason)` |
| 累積32件の予約は戻さない | 解放はジャーナルへ `release` 行を追記するだけで、`connection` の累計は減らない |
| `concurrent: 4` とは独立に検査する | 別の集合（`#open`）で数え、別の理由（`open-connection-limit`）で拒否する |

**この拒否だけは恒久停止にしない。** 区別の根拠は「枠が戻るか」ではなく、**想定内の満杯か、ドライバの契約違反か**である。

| 拒否 | 性質 | 扱い |
| --- | --- | --- |
| `open-connection-limit` | **想定内の満杯** | 新規接続だけを拒否する。既存接続と試行は継続し、切断確認後の**明示的な**再試行を許す |
| `concurrent-limit` | **契約違反** — 予約から `settle` までの外部作業を最大4件に制限するドライバ契約に違反した | 試行を停止する |
| `unreserved-dispatch` | **契約違反** — 予約と観測の不整合。予約漏れ、または「1操作につき送出は最大1」の仮説が偽であることを示す。**総量を使い切ったのではない**（上限から遠くても起こる） | 試行を停止し、調査する |
| `dispatch-limit` / `operation-limit` / `connection-limit` / `dispatch-allowance` | **枯渇** | 総量が戻らないので後続の成功があり得ない。停止する |

**自動リトライは持たない。** 台帳は満杯を報告するだけで、いつ閉じていつ取り直すかは呼び出し側が決める。次の一連の系列をテストで固定した。

1. 上限で新規接続を拒否（`stopped` は null のまま、既存接続はそのまま）
2. 1 本の切断確認（`releaseConnection`）で同時枠だけが 1 戻り、累積は戻らない
3. 呼び出し側の明示的な再取得が成功する（同時 2・累積 3）
4. 再び満杯になっても、ここまでで試行は一度も停止していない

> **前提条件：** `concurrent` は「予約から `settle` までの外部作業を最大4件に制限するドライバ契約」である。**ジャーナル操作の直列化はこれとは独立した整合性の仕組み**であり、`concurrent` が守っているものではない（直列化は `#tail` による書き込みの順序化が担う）。`concurrent` を通常の混雑処理にも使う設計へ変えた場合は、この分類を見直す。

## 5. 2.1 の 5 項目に対する承認資料

| 項目 | 本書での具体化 | 状態 |
| --- | --- | --- |
| 1. 新規 solver | **2件に訂正**（solver＋輸送shim）。§1.1。shim の Worker 名も承認対象 | 未承認 |
| 2. 現行アプリの再配備 | §1.2 の binding 差分。`SOLVER` の張り替えを含む。通常計画器は TS のまま、probe は4合成店舗に限定 | 未承認 |
| 3. 合成レコード作成 | チェーン `cpsat-transport-20260909` 1件、店舗 `-01`〜`-04`。01・02 は直接probe、03・04 は shim 刺激。衝突時は上書きせず停止 | 未承認 |
| 4. 追加費用 | US$20。§3.2 の停止条件に費用超過・観測不能を含む | 未承認 |
| 5. 通常TS経路への影響 | §2。ホップ1段・1 MiB routing 読み取り・新たな失敗点・遅延未実測。**「TS を選び続ける」は経路無変更の証拠にしない** | 未承認 |

追加で承認を求める項目（本書で新出）：

| 追加項目 | 内容 |
| --- | --- |
| 6. 累積 WS 接続試行 32 | §4 |
| 7. 同時接続の扱い | §4.1 の (i)/(ii) |
| 8. shim の Worker 名 | `yude-men-cpsat-transport-shim-dev`（案） |

## 6. 引き続き未検証（2.3 の範囲）

- **remote binding 越しの到達性。** ローカルドライバ → 認証済み remote service binding → app の named entrypoint が実配置で成立するかは未検証。既存 Access 方針等で成立しない場合、**方針を緩めたり公開 URL へ迂回せず停止して確認する**
- cloud での受理と求解の分離、CPU・isolate 全体メモリ・`waitUntil` の消費と余裕、DO 復帰（hibernation）
- shim を経由する通常店舗の遅延・失敗率
- H1・由来 ID の実測（タスク3.5以降）
