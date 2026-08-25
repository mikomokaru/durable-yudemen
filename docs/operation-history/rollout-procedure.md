# Observability_Pipeline を段階 rollout する手順（operation-history-log）

> 対象 spec: `operation-history-log` / タスク 15.2「下流 smoke」・15.3「Tail fixture smoke」・15.4「最終
> attachment／Logpush 有効化」・15.5「Producer 逆呼出しゼロの観測」
> 種別: ［手続き＋記録］（実デプロイ、account plan 確認、credential を要する操作はすべて**ユーザー実行**。
> リポジトリからは適用されない）
> 正本: `requirements.md` 要件 1.8〜1.10 / 2.15 / 4.1〜4.15 / 5.5 / 5.7 / 6.5〜6.8 / 6.11 / 6.12、
> `design.md` 節「Rollout order」・節「Deployment and Configuration Ownership」・節「No-wake / No-rehydrate
> Proof Obligations」（O1〜O7）
> 適用する設定正本: root [`wrangler.jsonc`](../../wrangler.jsonc)（Producer）、
> [`wrangler.telemetry-tail.jsonc`](../../wrangler.telemetry-tail.jsonc)（Tail Worker）、
> [`wrangler.raw-arrival-consumer.jsonc`](../../wrangler.raw-arrival-consumer.jsonc)（Queue Consumer）
> 前段（Snowflake 側・R2 保持・access の手順は既存 6 本が正本）:
> [`snowflake-ingest-procedure.md`](./snowflake-ingest-procedure.md)、
> [`snowflake-quality-procedure.md`](./snowflake-quality-procedure.md)、
> [`snowflake-disclosure-procedure.md`](./snowflake-disclosure-procedure.md)、
> [`snowflake-slo-procedure.md`](./snowflake-slo-procedure.md)、
> [`retention-procedure.md`](./retention-procedure.md)、
> [`snowflake-access-procedure.md`](./snowflake-access-procedure.md)
>
> **本書の状態: 未実施。** 第 2〜5 章の「観測」欄と判定欄は**すべて空欄**である。実施者が実機で観測した事実
> だけを記入する。**期待を観測欄へ写さない。**

---

## 0. この文書の位置づけ

### なぜ 4 タスクを 1 本にまとめたか

15.2（下流）→ 15.3（Tail fixture）→ 15.4（attachment）は**一つの順序**であり、15.5（Producer 逆呼出し
ゼロ）は全段で参照する横断確認である。文書を分けると順序が読めなくなり、段を飛ばした実行を招く。ゆえに
rollout 手順として 1 本にまとめ、章の番号を段の番号に対応させる。

| 段 | 章 | 内容 | 前段の合格が前提か |
| ---: | --- | --- | --- |
| 1 | 第 2 章 | 下流疎通（R2 → Queue／Consumer → Snowpipe → Snowflake → 保持／通知／access） | — |
| 2 | 第 3 章 | Tail Worker を fixture で検証 | 段 1 |
| 3 | 第 4 章 | Producer `tail_consumers` attachment（Tail 利用不可環境は Logpush → R2） | 段 1・段 2 |
| 横断 | 第 5 章 | Tail／Consumer／Snowpipe 障害下で Producer 逆呼出しが 0 件 | 各段で参照 |

### 順序を固定する理由

`tail_consumers` に挙げた Worker は `tail()` handler を持つ**実在 script** でなければならず、未デプロイの
service を指すと `wrangler deploy` が失敗する。さらに main への push は CI（`.github/workflows/ci-cd.yml`）が
`wrangler deploy` を自動実行するため、Tail Worker のデプロイ前に attachment を有効化すると**本番デプロイを
壊す**。ゆえに順序は「下流 → Tail fixture → Producer attachment または Logpush」に固定する
（root `wrangler.jsonc` の当該コメントと同じ規律・design「Rollout order」）。

### 既存 6 本との分担

Snowpipe の `insertFiles`、品質率の定義、best-effort 表示、到達 SLO と通知、R2 90 日と Snowflake 25 UTC 暦月の
保持、分類と access role は**既存 6 本が正本**である。本書はそれらを写さず、**どの段でどれを実行するか**と、
**下流・Tail・attachment に固有の確認**だけを持つ。

### Timer 本体との関係

本手順のどの操作も Producer と `StoreTimerDO` を呼ばない（要件 4.13 / 4.14）。どの段の停止も Timer 本体の
state migration、backfill、Producer 再出力、DO 再起動をいずれも必要としない（要件 1.8 / 4.8。第 6 章）。
観測できなかった telemetry は欠落のまま残す。

---

## 1. 前提（全段共通）

### 1-A. plan と権限

- [ ] 対象環境が **Workers Paid または Enterprise** である（Tail Workers の利用条件）。満たさない場合は段 3 で
      attachment ではなく Logpush → R2 を選ぶ（4-6）。**plan 照会はユーザー実行**である。
- [ ] Workers Scripts の編集権限を持つ API token または `wrangler login` 済みの認証がある。
- [ ] Queues の編集権限（**Queues Edit**）を持つ API token がある（2-3 の HTTP push に使う）。
- [ ] R2 の bucket 作成・lifecycle 設定権限がある（**Workers R2 Storage Write**）。
- [ ] Snowflake 側の role がある（要件・範囲は既存 6 本の各 §1 が正本）。
- [ ] credential をリポジトリへ書かない。置換した設定ファイルを commit しない。

### 1-B. リポジトリ側のローカル検証が済んでいる

- [ ] タスク 14.1 のチェックポイントが完了している（O1〜O7、設定 graph、fault injection、Tail fixture、
      R2 ack、raw 重複保持、品質／SLO／保持／access の各検証）。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` が成功している。

本書の smoke は**ローカル検証の代わりではない**。codec の失敗分類、envelope filter の全条件、put 失敗時の
ack 0 件、逆方向 capability の不在は `tests/operation-history/` の検査が正本であり、本書は**実物の
account 上で同じ性質が成り立つか**だけを見る。

### 1-C. 資源名（設定正本から写した値・変更しない）

| 資源 | 名前 | 正本 |
| --- | --- | --- |
| Producer script | `yude-men-timer` | root `wrangler.jsonc` の `name` |
| Tail Worker script | `yude-men-telemetry-tail` | `wrangler.telemetry-tail.jsonc` |
| Consumer script | `yude-men-raw-arrival-consumer` | `wrangler.raw-arrival-consumer.jsonc` |
| Queue | `operation-records` | 両 Data Platform 設定 |
| Dead letter queue | `operation-records-dlq` | `wrangler.raw-arrival-consumer.jsonc` |
| R2 bucket | `operation-raw-arrivals` | `wrangler.raw-arrival-consumer.jsonc` |

Producer script 名は **envelope filter の条件**でもある（`src/operation-history/tail.ts` の
`PRODUCER_SCRIPTS` はこの一つだけを持つ）。第 3 章の期待結果はこの事実から決まる。

### 1-D. 試行の識別（段ごとにコピーして埋める）

```
- 実施日時   : （タイムゾーン明記）
- 実施者     : 
- 段         : 1 下流 / 2 Tail fixture / 3 attachment / 横断 逆呼出し
- account    : 
- 環境       : 
- wrangler   : pnpm exec wrangler --version の出力
- 判定       : [ ] 合格  [ ] 不合格（停止条件に該当）
```

---

## 2. 段 1 — 下流疎通（タスク 15.2）

### 2-0. なぜ Tail 抜きで下流を先に通せるか

Queue へは HTTP で直接 message を publish できる（Queues REST の
`POST /accounts/{account_id}/queues/{queue_id}/messages`。**Queues Edit** 権限が要る）。ゆえに Tail Worker も
Producer attachment も無い状態で、Queue → Consumer → R2 → Snowpipe → Snowflake を貫ける。

この push は**ユーザーの credential で外から入れる**ものであり、Producer への経路を一切作らない。Producer は
Queue を知らないまま（root に Queue binding が無いまま）である（要件 4.10 / 4.13）。

### 2-1. R2 bucket と 90 日 lifecycle

```sh
pnpm exec wrangler r2 bucket create operation-raw-arrivals
pnpm exec wrangler r2 bucket info operation-raw-arrivals
```

- [ ] bucket が存在すること。
- [ ] lifecycle（90 日）を [`retention-procedure.md`](./retention-procedure.md) §2 の手順で適用したこと。
      **本書に手順を写さない。**

### 2-2. Queue と Consumer

```sh
pnpm exec wrangler queues create operation-records
pnpm exec wrangler queues create operation-records-dlq
pnpm exec wrangler queues info operation-records
```

- [ ] 両 queue が存在すること。
- [ ] この時点では **Consumer をまだデプロイしない**（2-4 で「保存前 ack 0 件」を見るため）。

### 2-3. fixture を Queue へ push する

body は Tail Worker が送る形（`src/data-platform/tail-worker.ts` の `OperationRecordMessage`）と同じ三つの
属性を持つ。`canonicalLine` は canonical 一行そのままである。

**fixture は lifecycle を閉じた二行にする。** boil-started 一件だけを入れると、そこから boiled の存在が
復元されて **欠落**に数えられる（`03` / `04` の復元規則。要件 5.9）。boiled 一件だけを入れると開始事実へ
相関できず **孤児**に数えられる（要件 5.11）。

**storeId は smoke 専用にする。** 品質率と SLO は店舗×期間ごとに出るため、実店舗の id を使うと実店舗の率へ
smoke の重複が混ざる。`smoke-downstream` は storeId の許容形（`[a-z0-9-]{1,64}`）を満たす。

`<T0>` / `<T1>` は 0 より大きい整数の epoch millisecond へ置換する（`<T1>` は `<T0>` より後）。
`<T0F>` / `<T1F>` は観測側の初回観測時刻であり、R2 の object key の日付 prefix を決める。

```sh
ACCOUNT_ID=<account_id>
QUEUE_ID=<queue_id>   # GET /accounts/{account_id}/queues の応答 queue_id、または dashboard から得る
TOKEN=<Queues Edit の API token>

# ① boil-started
curl "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/messages" \
  -X POST -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  --data '{"body":{"canonicalLine":"{\"storeId\":\"smoke-downstream\",\"timerId\":\"smoke-timer-1\",\"operationKind\":\"boil-started\",\"eventTime\":<T0>,\"slotIds\":[\"slot-1\"],\"noodleType\":\"Thin\",\"firmness\":\"normal\",\"startTime\":<T0>,\"endTime\":<T1>}","firstObservedAt":<T0F>,"producerScript":"yude-men-timer"}}'

# ② boiled（Event Time は復元規則に合わせて endTime と同値）
curl "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/messages" \
  -X POST -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  --data '{"body":{"canonicalLine":"{\"storeId\":\"smoke-downstream\",\"timerId\":\"smoke-timer-1\",\"operationKind\":\"boiled\",\"eventTime\":<T1>,\"slotIds\":[\"slot-1\"],\"noodleType\":\"Thin\",\"firmness\":\"normal\",\"endTime\":<T1>,\"boiledAt\":<T1>}","firstObservedAt":<T1F>,"producerScript":"yude-men-timer"}}'
```

- [ ] body に三つの属性（`canonicalLine` / `firstObservedAt` / `producerScript`）だけを置くこと。
- [ ] ①②の応答が成功（`"success": true`）であること。
- [ ] **重複到達の確認用に、②と完全に同じ push をもう一度実行すること**（同一 canonical 一行が二度到達する）。

```sh
pnpm exec wrangler queues info operation-records
```

- [ ] backlog が 3 件（①＋②＋②の重複）であること。

### 2-4. 保存成功前 ack 0 件を確認する（要件 4.5 / 4.15）

Consumer が未デプロイの間、message は Queue に残る。**保存が起きていないのだから ack も起きていない。**

| 確認 | 期待 | 観測（実施者が記入） |
| --- | --- | --- |
| Queue の backlog | 3 件のまま減らない | |
| R2 の object 数 | 増えない（`raw/` 配下 0 件） | |
| Producer／StoreTimerDO への ack | 0 件（ack の宛先は Consumer → Queue だけであり、Producer 側に受け口が無い） | |

任意（推奨）: put が失敗する message を一件混ぜ、**失敗時も ack されない**ことを見る。`canonicalLine` を
持たない body を push すると Consumer 側の保存が成立しない。期待は「R2 に対応 object が現れず、message は
ack されずに再配送され、`max_retries` 5 回の後に `operation-records-dlq` へ入る」である。実際の分類（put が
失敗したのか、想定外の key を持つ object ができたのか）は観測欄に記入する。実路では body の形を Tail Worker が
固定するため、この形の message は現れない。

- [ ] 観測（任意手順を実施した場合）: 

put 失敗時の ack 0 件の**規範的な検査**は `tests/operation-history/tail-queue-r2.integration.test.ts` と
`tests/operation-history/raw-arrival-consumer.example.test.ts` が持つ。本節はそれを実物で追認するだけである。

### 2-5. Consumer をデプロイして R2 保存を確認する

```sh
pnpm exec wrangler deploy --config wrangler.raw-arrival-consumer.jsonc
pnpm exec wrangler queues info operation-records
```

| 確認 | 期待 | 観測 |
| --- | --- | --- |
| backlog | 0 件へ減る（保存成功後に ack された） | |
| object key の形 | `raw/{YYYY}/{MM}/{DD}/{firstObservedAt}-{queueMessageId}-{deliveryAttempt}.json`（文法の正本は `src/data-platform/raw-arrival-consumer.ts`） | |
| object 本体 | canonical 一行と byte 単位で一致（前後の空白・引用符が付かない） | |
| customMetadata | `firstObservedAt` / `arrivedAt` / `producerScript` / `queueMessageId` / `deliveryAttempt` / `canonicalHash` を持つ | |
| 重複到達（要件 5.5 / 5.7） | 同一 canonical 一行が**別 object として 2 件**残る（上書きも削除もされない） | |

object の一覧は Snowflake stage の `LIST @OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVALS;`（2-6 の後）または
dashboard の R2 object browser で見る。**`wrangler r2 object` は v4.105.0 で `get` / `put` / `delete` だけを
持ち、一覧の subcommand を持たない。** 個別取得は key を指定して行う。

```sh
pnpm exec wrangler r2 object get operation-raw-arrivals/raw/<YYYY>/<MM>/<DD>/<key>.json --pipe
```

### 2-6. Snowpipe → Snowflake（既存手順）

- [ ] [`snowflake-ingest-procedure.md`](./snowflake-ingest-procedure.md) §2〜§4 を実行し、canonical と観測側
      metadata の分離（§4-1）、`firstObservedAt` ↔ `firstSnowflakeAt` の関連付け（§4-2・要件 6.1）、重複
      raw の全件保持（§4-3・要件 5.5 / 5.7）を確認したこと。
- [ ] `insertFiles` の駆動主体（Data Platform 所有）が未実装である点は同手順 §3 のとおりであり、**本 smoke
      では `ALTER PIPE ... REFRESH` で駆動する**。常用の駆動主体を本書で発明しない。

### 2-7. 品質・表示・SLO・保持・access（既存手順）

- [ ] [`snowflake-quality-procedure.md`](./snowflake-quality-procedure.md): 四品質状態と四品質率。smoke の
      lifecycle が閉じているため、`smoke-downstream` の期間に **欠落 0・孤児 0・重複 1** が出るのが期待である。
- [ ] [`snowflake-disclosure-procedure.md`](./snowflake-disclosure-procedure.md): best-effort 表示と、完全
      未観測率が `unmeasurable` であること（要件 5.14）。
- [ ] [`snowflake-slo-procedure.md`](./snowflake-slo-procedure.md): 月次到達 SLO（要件 6.2〜6.4 / 6.13）と
      30／60 分通知（要件 6.5 / 6.6）。通知先未設定なら帯を進めない（fail closed）。
- [ ] [`retention-procedure.md`](./retention-procedure.md): R2 90 日（要件 6.7）と Snowflake 25 UTC 暦月
      （要件 6.8）。期限前の削除が 0 件であること（要件 6.9）。
- [ ] [`snowflake-access-procedure.md`](./snowflake-access-procedure.md): 分類（要件 6.10）、承認済み分析
      担当者だけの許可（要件 6.11）、未承認主体の拒否とデータ・承認状態の不変（要件 6.12）、R2 側に公開
      経路が無いこと。

### 2-8. 段 1 の停止条件と切戻し

| 症状 | 停止するか | 切戻し |
| --- | --- | --- |
| R2 保存前に ack される（backlog が保存なしに減る） | **停止する。** 段 2 へ進まない | Consumer を `wrangler delete yude-men-raw-arrival-consumer` で外す |
| 重複到達が 1 件へ潰れる、または raw が消える | **停止する**（要件 5.5 / 5.7 の未達） | 同上。key 文法（`raw-arrival-consumer.ts`）と Snowflake 側の view を疑う |
| Snowpipe が取り込まない | 段 2 へ進まない | pipe を一時停止（ingest 手順 §5） |
| 保持・通知・access が未達 | 段 2 へ進まない | 各既存手順の「停止と切戻し」節へ |

いずれの停止も Timer 本体に触らない。Producer は未 attach であり、この段の失敗は Timer 操作へ波及しない。

---

## 3. 段 2 — Tail Worker を fixture で検証（タスク 15.3）

### 3-0. 事前に確かめられること／確かめられないこと

envelope filter の第一条件は「想定 Producer script の event である」ことで、その集合は
`yude-men-timer` ただ一つである（1-C）。ゆえに attachment 前に別 script の fixture で駆動すると、**全行が
script 条件で落ちる**。これは欠陥ではなく filter の設計である（未知の console 出力を Queue へ入れない）。

| 確認対象 | 段 2（attachment 前）で確かめられるか |
| --- | --- |
| Tail Worker が実際に別 Worker 実行として起動する | 是（fixture producer の attachment で起動する） |
| Tail Worker に逆方向 capability が無い | 是（3-1） |
| 想定外 script の行が Queue へ進まない | 是（3-2。0 件を見る） |
| 想定 envelope が Queue へ進む | **否。** script 条件を満たすのは実 Producer だけ。段 3 の 4-5 で確かめる |
| 不正行の位置と分類が観測側に残る | **否。** script 条件は codec より前にあるため、fixture では codec へ到達しない。段 3 の 4-5 で確かめる |

fixture producer を `yude-men-timer` という名前でデプロイして「想定 envelope」を作ることは**しない**。その
名前は実 Producer であり、上書きは本番を壊す。

filter の全条件（script、level、引数数、引数型、行の妥当性、canonical 一致）と失敗分類の網羅は
`tests/operation-history/tail.property.test.ts`・`tail-worker.example.test.ts`・
`tail-queue-r2.integration.test.ts` が正本である。

### 3-1. Tail Worker をデプロイして能力を確認する

```sh
pnpm exec wrangler deploy --config wrangler.telemetry-tail.jsonc
```

| 確認 | 期待 | 観測 |
| --- | --- | --- |
| binding 一覧（deploy 出力） | `OPERATION_RECORDS`（Queue producer）だけ | |
| `STORE_TIMER_DO` / `STORE_REGISTRY_DO` / Producer への Service binding | 0 件 | |
| route・workers.dev URL・preview URL | 0 件（`workers_dev: false` / `preview_urls: false`） | |
| fetch handler | 無い（正当な到達経路は tail attachment だけ） | |

### 3-2. fixture producer で駆動する

**リポジトリ外**に throwaway の Worker を作る（commit しない）。役割は fixture 行を `console.log` する
ことだけであり、段 2 の終了後に削除する。

```sh
mkdir -p /tmp/telemetry-tail-fixture && cd /tmp/telemetry-tail-fixture
```

`wrangler.jsonc`:

```jsonc
{
  "name": "yude-men-telemetry-tail-fixture",
  "main": "index.ts",
  "compatibility_date": "2026-06-26",
  "observability": { "enabled": true },
  "workers_dev": true,
  "tail_consumers": [{ "service": "yude-men-telemetry-tail" }]
}
```

`index.ts`（4 通りの行を出す。canonical 一行、不正 JSON、二引数、`warn` level）:

```ts
export default {
  fetch(): Response {
    console.log('{"storeId":"smoke-downstream","timerId":"smoke-tail-1","operationKind":"completed","eventTime":1,"slotIds":["slot-1"],"noodleType":"Thin","firmness":"normal"}');
    console.log("{not json");
    console.log("prefix", '{"storeId":"smoke-downstream"}');
    console.warn('{"storeId":"smoke-downstream","timerId":"smoke-tail-2","operationKind":"cancelled","eventTime":1,"slotIds":["slot-1"],"noodleType":"Thin","firmness":"normal"}');
    return new Response(null, { status: 204 });
  },
};
```

> この fixture Worker は認証を持たない公開 URL を一時的に作る。出力は固定の fixture 行だけで、秘密も
> 実データも扱わないが、**段 2 の終了後に必ず削除する**（3-4）。

```sh
pnpm exec wrangler deploy            # /tmp/telemetry-tail-fixture で実行
curl -s -o /dev/null -w '%{http_code}\n' https://yude-men-telemetry-tail-fixture.<subdomain>.workers.dev/
```

| 確認 | 期待 | 観測 |
| --- | --- | --- |
| Tail Worker が起動した | `yude-men-telemetry-tail` の Workers Logs（または `pnpm exec wrangler tail yude-men-telemetry-tail`）に invocation が現れる | |
| Queue へ進んだ件数 | **0 件**（`wrangler queues info operation-records` の backlog が増えない。R2 の object も増えない） | |
| codec 失敗の記録 | **0 件**（script 条件が codec より前にあるため、`observation: "codec-failure"` は出ない） | |
| Producer 逆呼出し | 0 件（第 5 章の観測手順で確認する） | |

- [ ] Queue が 0 件でなかった場合は**停止する**。script filter が想定と違う（`PRODUCER_SCRIPTS` と実 script
      名を照合する）。

### 3-3. attachment 後へ引き渡す確認

- 想定 envelope が Queue へ進むこと → 4-5 の表①
- 不正行の 1 始まり位置と失敗分類が観測側に残ること → 4-5 の表②

### 3-4. fixture の後片付け（段 3 へ進む前に必須）

```sh
pnpm exec wrangler delete yude-men-telemetry-tail-fixture   # /tmp/telemetry-tail-fixture で実行
rm -rf /tmp/telemetry-tail-fixture
```

- [ ] fixture script が消えたこと。**残すと、Tail Worker が実 Producer 以外の script からも起動し続ける**
      （行は落ちるが実行費用は発生する）。
- [ ] smoke で作った R2 object と Snowflake の raw arrival は**消さない**（要件 5.7。保持期限だけが削除の
      根拠である）。`smoke-downstream` は smoke 用 storeId ゆえ、実店舗の分析に混ざらない。

### 3-5. 段 2 の停止条件と切戻し

| 症状 | 停止するか | 切戻し |
| --- | --- | --- |
| Tail Worker が起動しない | **停止する。** plan（1-A）と attachment を疑う | fixture を削除する（3-4） |
| 想定外 script の行が Queue へ進む | **停止する。** 段 3 へ進まない | Tail Worker を `wrangler delete yude-men-telemetry-tail` で外す |
| Tail Worker に逆方向 binding が見える | **停止する** | 同上。設定正本（`wrangler.telemetry-tail.jsonc`）を疑う |

切戻しは script の削除だけで済み、Timer 本体に触らない。

---

## 4. 段 3 — Producer attachment（タスク 15.4）

### 4-1. 前提ゲート

- [ ] 段 1 が合格した（2-8 の停止条件に該当しない）。
- [ ] 段 2 が合格し、fixture script を削除した（3-4）。
- [ ] `yude-men-telemetry-tail` が**デプロイ済みで実在する**（3-1）。

### 4-2. attachment を有効化する（Tail 利用可能環境）

root [`wrangler.jsonc`](../../wrangler.jsonc) の**次の 3 行のコメントを外す**（`//` を削る）。

```jsonc
  // "tail_consumers": [
  //   { "service": "yude-men-telemetry-tail" }
  // ],
```

外した後の形:

```jsonc
  "tail_consumers": [
    { "service": "yude-men-telemetry-tail" }
  ],
```

root 設定を変更したので**生成型を作り直す**。

```sh
pnpm cf-typegen
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

| 確認 | 期待 | 観測 |
| --- | --- | --- |
| `worker-configuration.d.ts` の Producer `Env` | Queue・R2・Consumer・Snowpipe・Snowflake・逆方向 DO の能力が**増えない**（`tail_consumers` は binding ではない。要件 1.3 / 1.7 / 4.10） | |
| 4 コマンド | すべて成功 | |

デプロイはユーザー実行である。main へ push すれば CI が `wrangler deploy` する。手で出す場合は
`pnpm exec wrangler deploy`（CI と同じ `--var` を渡すこと。渡さないと `ACCESS_REQUIRED` などが
`wrangler.jsonc` の既定へ戻る）。

- [ ] deploy が成功したこと（失敗する場合は Tail Worker が実在しない・plan 不足を疑う）。
- [ ] named environment を使う場合、`tail_consumers` は環境へ継承されないため環境ごとに書くこと。

### 4-3. 観測を ON にする（`OPERATION_HISTORY_ENABLED`）

attachment は搬送路の接続であり、**Producer の出力そのものは別のゲート**である。root `wrangler.jsonc` の
`vars.OPERATION_HISTORY_ENABLED` は既定 `"0"`（出力 0 件）であり、`"1"` のときだけ確定差分の同期 console 出力を
試行する。

```sh
pnpm exec wrangler deploy --var OPERATION_HISTORY_ENABLED:1 --var ACCESS_REQUIRED:1 \
  --var TEAM_DOMAIN:<team domain> --var POLICY_AUD:<aud>
```

> **この ON は次の main push で失われる。** CI の deploy コマンドは `ACCESS_REQUIRED` / `TEAM_DOMAIN` /
> `POLICY_AUD` だけを `--var` で渡すため、素の CI デプロイは `OPERATION_HISTORY_ENABLED` を既定
> `"0"` へ戻す。恒久的に ON にするなら CI の command へ `--var OPERATION_HISTORY_ENABLED:1` を足す
> （リポジトリ変更ゆえ**ユーザー判断**。既存の `ACCESS_REQUIRED` と同じ footgun 対策の形）。

- [ ] ON にした手段（deploy 時 override か CI か）と、次回 CI デプロイでの扱いを記録すること: 
- [ ] flag の ON / OFF は Timer 本体の結果を変えない（要件 1.5）。この不変は
      `tests/operation-history/store-timer-observation-fault.integration.test.ts` が O7 の trace 比較で持つ。

### 4-4. 実 Timer 操作で第一経路を貫く

対象店舗で Timer を一件開始し、茹で上がりまで待ち、完了させる（boil-started → boiled → completed）。

| # | 確認 | 期待 | 観測 |
| --- | --- | --- | --- |
| ① | Producer の出力 | `pnpm exec wrangler tail yude-men-timer` に canonical 一行が現れる（接頭辞なし・一引数・一行） | |
| ② | Timer 本体 | 表示・WS snapshot・Alarm 発火が観測 OFF と同じ | |
| ③ | Queue | backlog が増えて 0 へ落ちる | |
| ④ | R2 | 対応 object が `raw/` 配下に現れ、本体が①の行と byte 一致 | |
| ⑤ | Snowflake | ingest 手順 §4 の view に現れる（`firstObservedAt` と `firstSnowflakeAt` が並ぶ） | |
| ⑥ | 到達 SLO | 15 分以内到達として数えられる（slo 手順 §3） | |

### 4-5. 想定 envelope だけが進むこと（段 2 からの引き渡し）

同じ Producer script は Operation Record 以外の構造化 console 出力も持つ（`worker.ts` の
`posIngress` 行、`OBSERVE_DEBUG="1"` のときの計装 entry）。これらは script 条件を満たすため codec へ到達し、
**Queue へは進まず**、観測側に位置と分類だけが残る。

| # | 入力 | 期待 | 観測 |
| --- | --- | --- | --- |
| ① | 実 Timer 操作の canonical 一行 | Queue へ進む（4-4 ③） | |
| ② | `posIngress` 行（POS 取込を一度通す。または一時的に `OBSERVE_DEBUG:1` で計装 entry を出す） | Queue へ**進まない**。Tail Worker のログに `{"observation":"codec-failure","lineNumber":<1 始まり>,"failure":"<分類>"}` が残る。分類は行の内容で決まり、既知の必須属性を欠く行は `missing-required-attribute` になる | |
| ③ | ②に伴う Producer 側の変化 | 無い（ack も再出力要求も返らない。第 5 章） | |

- [ ] `OBSERVE_DEBUG` を一時的に ON にした場合、**戻し忘れないこと**（4-3 と同じ override の規律）。

### 4-6. Tail を利用できない環境（Logpush → R2 縮退）

**現時点の構成対象は 0 件である。** タスク 1.2 / 1.3 の確認結果は「対象環境はいずれも Tail Workers を利用
できる」であり、Logpush job と R2 destination は作らない（design「環境別搬送の確定結果」）。要件 4.7 / 4.8 の
前件「Tail_Worker を利用できない環境である」は成立しない。

将来 Tail を利用できない環境が現れた場合に限り、次の順で行う。

1. タスク 1.3 の確認をやり直す（対象環境、Workers logs dataset、R2 destination の利用可否、観測不能期間の
   欠落許容）。**account plan 照会と credential を要するユーザー実行**である。
2. 確認済みの Logpush job を Cloudflare account 設定として作る。**Producer 設定の SSOT（root
   `wrangler.jsonc`）へ Queue／R2 binding と再出力入口を置かない。**
3. 段 1 の R2 以降はそのまま使う。

**Logpush は Tail と同等の保証を持たない。** 観測できたログだけを best-effort で R2 へ送る縮退経路であり、
観測できなかった期間は欠落のまま残す。backfill job、Producer への再出力要求、DO 再起動はいずれも 0 件で
ある（要件 4.8）。両経路に共通する不変点の検査は
`tests/operation-history/unobserved-telemetry.integration.test.ts` と
`tests/operation-history/no-backfill.static.test.ts` が持つ。

### 4-7. 段 3 の停止条件と切戻し

**切戻しは安い。** これが本設計の要点である（要件 4.8）。

| 対象 | 切戻し | 要らないもの |
| --- | --- | --- |
| attachment | root `wrangler.jsonc` の 3 行を**再びコメント化**して deploy する | Timer state migration、backfill、Producer 再出力、DO 再起動 |
| Producer の出力 | `OPERATION_HISTORY_ENABLED` を `"0"` に戻す（既定値ゆえ、素の deploy で戻る） | 同上 |
| Logpush（将来） | job を停止する | 同上 |

- [ ] attachment を外した後も Timer 操作の結果が変わらないこと（要件 1.5）: 
- [ ] 停止期間の telemetry を**後から埋めないこと**。欠落は欠落のまま残す（要件 4.8）。停止期間は記録する: 

停止条件:

- 4-4 ②で Timer 本体の挙動が変わって見える → **即座に 4-7 の切戻しを行い、停止する。** 要件 1.5 の未達で
  あり、rollout を続けない。
- 4-4 ①で canonical 一行に接頭辞・追加 object・複数行が混ざる → 停止する（要件 4.9 の未達）。
- 4-5 ②で Operation Record 以外の行が Queue へ進む → 停止する（要件 4.3 / 4.4 の未達）。

---

## 5. 横断確認 — Producer 逆呼出しゼロ（タスク 15.5）

### 5-0. 何を観測するか

観測側から Producer へ戻る経路が無いことは、**下流を壊した状態で Producer 側の増分が 0 であること**として
見る。`StoreTimerDO` の invocation が 0 件であれば、その窓では construct、wake、rehydrate、storage read、
Alarm 予定のいずれも観測に由来して増えていない。

| 観測点 | 手段 |
| --- | --- |
| DO の invocation・Alarm・storage | dashboard の **Durable Objects** → 対象 namespace → **Metrics**（`observability.enabled: true` ゆえ **Logs** も見える） |
| 同（programmatic） | GraphQL Analytics API の `durableObjectsInvocationsAdaptiveGroups`・`durableObjectsPeriodicGroups`・`durableObjectsStorageGroups`・`durableObjectsSubrequestsAdaptiveGroups`（フィールド集合は introspection で確認する） |
| Producer の実行内容 | `pnpm exec wrangler tail yude-men-timer` と Workers Logs |
| 下流の滞留 | `pnpm exec wrangler queues info operation-records`、DLQ、Snowflake の `OPERATION_PENDING_ARRIVAL` |

### 5-1. 静止窓で baseline を採る

Timer 操作が発生しない窓（閉店後など）を選ぶ。**現場が操作している間に測ると、Timer 由来の増分と観測由来の
増分が区別できない。**

```
- 窓の開始 / 終了 (UTC) : 
- DO invocations        : 
- Alarm 予定 / 発火     : 
- storage 指標          : 
- Producer の例外        : 
```

### 5-2. 障害を注入する

一つずつ入れ、各注入で 5-3 を観測してから戻す。

| # | 対象 | 注入 | 復旧 | 危険度 |
| --- | --- | --- | --- | --- |
| F1 | Snowpipe | pipe を一時停止（`PIPE_EXECUTION_PAUSED = TRUE`。ingest 手順 §5） | `= FALSE` | 低（下流の取込が止まるだけ） |
| F2 | Queue → Consumer | `pnpm exec wrangler queues pause-delivery operation-records` | `resume-delivery` | 低（message は queue 保持期間の間残る） |
| F3 | Tail Worker | 設定正本を**リポジトリ外へ複写**し、`queues.producers` を削って `wrangler deploy --config /tmp/tail-no-queue.jsonc` する（`sendBatch` が成立せず `tail()` が失敗する） | `pnpm exec wrangler deploy --config wrangler.telemetry-tail.jsonc` で正本から再デプロイ | 中（デプロイ済み script を一時的に置き換える。**復旧を同じ作業時間内に行う**） |

- [ ] F3 の複写を commit しないこと。`name` は同じままなので、正本からの再デプロイで元に戻る。

### 5-3. 観測（各注入で埋める）

| 確認 | 期待 | F1 | F2 | F3 |
| --- | --- | --- | --- | --- |
| `StoreTimerDO` の construct / wake | 増分 0 件 | | | |
| rehydrate（`ensureLoaded`）・storage read | 増分 0 件 | | | |
| Alarm 予定の生成 | 増分 0 件 | | | |
| Producer への ack | 0 件（ack は Consumer → Queue に閉じる。要件 4.15） | | | |
| Producer への再出力要求 | 0 件 | | | |
| Producer への HTTP / RPC / Service binding / DO stub call / WebSocket | 0 件 | | | |
| Producer の例外・応答 | 変化なし（下流障害は Producer の trace に現れない） | | | |
| Timer 操作の結果 | 変化なし（注入中に一件操作して確かめる） | | | |
| 失敗の保持先 | 下流だけ（Queue backlog、DLQ、Tail Worker のログ、Snowpipe の load history） | | | |

- [ ] 注入中に Timer を一件操作し、①表示 ②WS snapshot ③Alarm 発火が観測 OFF と同じであることを確認する: 

### 5-4. 復旧と確認

- [ ] F1〜F3 を 5-2 の「復旧」列どおりに戻したこと。
- [ ] 滞留していた message が復旧後に流れ、R2 と Snowflake へ届いたこと。**復旧は下流の再配送だけで済み、
      Producer の再出力を要しない**（要件 4.11）。
- [ ] 障害中に Producer が出力した canonical 一行のうち、どれが失われたかを記録すること。失われた分は
      **埋めない**（要件 4.8）: 

### 5-5. 判定（未実施）

```
Producer 逆呼出しゼロの判定 : [ ] 是  [ ] 否
判定日 / 判定者 : 
根拠（5-3 のどの行が是か） : 
否の場合の停止措置 : 4-7 の切戻し（attachment 再コメント化・flag "0"）
```

逆方向 capability の不在の**規範的な検査**は `tests/operation-history/no-wake.static.test.ts`（O1〜O7）・
`config-graph.static.test.ts`・`reverse-path.integration.test.ts` が持つ。本章はそれを実物の account 上で
追認する。

---

## 6. 停止／切戻しの一覧

| 段 | 切戻し操作 | 要らないもの（共通） |
| --- | --- | --- |
| 1 下流 | Consumer を削除、pipe を停止、lifecycle を戻す | Timer state migration / backfill / Producer 再出力 / DO 再起動 |
| 2 Tail fixture | fixture script を削除、Tail Worker を削除 | 同上 |
| 3 attachment | root の 3 行を再コメント化、`OPERATION_HISTORY_ENABLED` を `"0"` へ | 同上 |
| 将来 Logpush | job を停止 | 同上 |

どの段の切戻しも Timer 本体の永続状態に触らない。Operation Record は best-effort ゆえ、停止期間の欠落は
そのまま残す（要件 4.8）。

---

## 7. スコープ境界（本手順で触らないもの）

- `src/` のコード、`tests/`、`config/` の宣言的正本を変更しない。段 3 で触るのは root `wrangler.jsonc` の
  `tail_consumers` 3 行のコメントだけである。
- Snowflake の SQL 内容、品質率・SLO・保持・access の定義を本書へ写さない。正本は
  `config/operation-history-snowflake/*.sql` と `src/operation-history/`、手順は既存 6 本である。
- Producer 設定の SSOT（root `wrangler.jsonc`）へ Queue／R2 binding、Snowflake credential、下流への route を
  足さない。
- `insertFiles` の常用駆動主体を本書で決めない（Data Platform 所有・未実装）。
- 観測できなかった telemetry の総数を推定しない。完全未観測率は測定不能である（要件 5.14）。

---

## 8. 参照

- 要件: 1.8 / 1.9 / 1.10（起動原因・逆経路・live resource 0 件）、2.15（観測目的の invocation 0 件）、
  4.1〜4.4（第一経路と envelope filter）、4.5 / 4.6（保存成功後 ack と Snowpipe 取込）、4.7 / 4.8（Logpush
  縮退と backfill 0 件）、4.10 / 4.11（Producer からの下流呼出し 0 件、下流だけの再試行）、4.13〜4.15
  （一方向と ack の限定）、5.5 / 5.7（重複到達の保持と raw の非削除）、6.5〜6.8（通知と保持）、
  6.11 / 6.12（access の許可と拒否）
- 設計: `design.md` 節「Rollout order」、節「Deployment and Configuration Ownership」、節「Plan
  prerequisites」、節「環境別搬送の確定結果」、節「No-wake / No-rehydrate Proof Obligations」（O1〜O7）、
  節「Snowflake 側 integration の確定結果（タスク13.7）」の「実接続を要して未検証の範囲」
- 設定正本: root `wrangler.jsonc`、`wrangler.telemetry-tail.jsonc`、`wrangler.raw-arrival-consumer.jsonc`、
  `config/operation-history-r2/`、`config/operation-history-snowflake/`
- 実装: `src/operation-history/tail.ts`（envelope filter と `PRODUCER_SCRIPTS`）、
  `src/data-platform/tail-worker.ts`、`src/data-platform/raw-arrival-consumer.ts`（object key の文法）
- ローカル検査（本書が追認する正本）: `tests/operation-history/no-wake.static.test.ts`、
  `config-graph.static.test.ts`、`no-backfill.static.test.ts`、`reverse-path.integration.test.ts`、
  `tail-queue-r2.integration.test.ts`、`store-timer-observation-fault.integration.test.ts`、
  `unobserved-telemetry.integration.test.ts`
- 既存手順（Snowflake・保持・access の正本）: [`snowflake-ingest-procedure.md`](./snowflake-ingest-procedure.md)、
  [`snowflake-quality-procedure.md`](./snowflake-quality-procedure.md)、
  [`snowflake-disclosure-procedure.md`](./snowflake-disclosure-procedure.md)、
  [`snowflake-slo-procedure.md`](./snowflake-slo-procedure.md)、
  [`retention-procedure.md`](./retention-procedure.md)、
  [`snowflake-access-procedure.md`](./snowflake-access-procedure.md)
- 後続タスク: 16.1（生成型と対象テストの完了確認）、16.2（最終品質コマンドと本手順の結果引き渡し）
