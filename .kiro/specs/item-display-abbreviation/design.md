# Design Document

## Overview

品目の表示名を 2 つの軸で短くする。**麺量**は固定表で 1 文字に畳み（`普通` は消す）、**商品名**は辞書から札を引く。どちらも `displayName`（`src/client/components/queueDisplay.ts`）の中だけで起き、描画側は従来どおり受け取った文字列を置く。

札を作る側は client に無い。`POST /pos/records` を捌く worker が、辞書に無い商品名を見つけたら `ctx.waitUntil` の中で Workers AI を呼び、機械検査に通った候補だけを KV へ書く。**取り込みは生成を待たない**——初出の 1 杯は全名で出る。

設計の芯は 2 つある。

**札は品目と同じ便で届く。** client は辞書を持たない——受け取った品目が `shortName` を持てばそれを置き、無ければ全名へ戻す。`displayName` の引数は品目 1 つのままである。辞書を引くのはサーバ側だけで、**引くのは送信を組む時点**である（到着時刻で凍らせない）。

**永続には載せない。** `StoreSnapshot.orderItems` と `ServerMessage` の品目は同じ `OrderItem` を共有するので、あの型に足せば v14 になり engine が表示専用の項目を持つ。ゆえに**ワイヤ側だけ**に `shortName` を持たせる。

**書く側は一意性を追わない。** 別々の isolate が同じ札を作りうることを受け入れる（requirements 判断 7）。ゆえに読み取り→検査→書き込みを不可分にする機構——単一の書き手、強整合のストレージ、Queue による直列化——をどれも建てない。検査は候補 1 件と元の名前だけを見る局所的な述語であり、辞書を引数に取らない。

### 先行 spec との関係

- `slot-suggested-start`（判断 8）：「設定に名前表は設けない」はそのまま。辞書は名前の**出所**ではなく、申告された名前を**キーに引く被せ物**である。`StoreConfig.menuItems` には何も足さない。同 spec 判断 14（ラベルは折り返す・行数を固定しない）も変えない——札は省略記号ではない。
- `pending-order-list-left-rail`（AC 3.5）：レールの `truncate` は残る。8 字の札でもレールの約 6 字には収まらない。本 spec はレールの幅配分に触れない。
- `pos-order-ingress`：取り込みの受理規則・素通し原則を変えない。生成の失敗は取り込みの失敗にならない。
- `per-store-provisioning`（要件 6.1 / 6.2）：`StoreTimerDO` の自立性の不変を保つ。当該 DO は KV binding も AI binding も持たない——辞書に触れるのは worker だけである。
- `operation-history-log`：記録内容を変えない。札は Operation Record に現れない。

## Architecture

```
── 読む側（純粋・client）────────────────────────────────────────
src/display/short-name.ts        SHORT_NAME_MAX_LENGTH / isSubsequence
                                 toShortNameCandidate（応答→候補） / toShortName（候補→正規化後の札）
client/components/queueDisplay.ts
        SIZE_LABEL                麺量名 → 表示（中盛/大盛/半玉 はそのまま・普通 は空）
        displayName(order)        ← 語を組む唯一の場所。`order.shortName ?? 全名`
                │
        受け取った品目がそのまま持つ ← 辞書も prop も無い（client は札を取りに行かない）

── 書く側（別 Worker：yude-men-short-names）──────────────────────
root worker.ts  POST /pos/records
        └─ waitUntil( SHORT_NAMES_WORKER.fetch(/display/observed, {names}) )  ← 応答も失敗も見ない
                │
        src/display/worker.ts     202 を即返し、自分の waitUntil で走らせる
        src/display/detect.ts     メモリの既知集合 → 単発 get → 生成（締切の配分）
        src/display/generate.ts   8字以下なら AI 無しで plain / 9字以上は AI + budget + 1 回再試行
        src/display/dictionary.ts KV の読み書き（名前 1 件 = 1 キー・metadata に札）
        ↑ AI binding と KV binding を持つのはこの Worker だけ（ShortNamesEnv）
                │
        生成が通ったら STORE_TIMER_DO.applyShortNames(entries) で押し込む
                │      （cross-script binding・deliverPlan と同じ形。DO は pull しない）
StoreTimerDO    札を別キーへ永続し（休眠で失わない）、**送信を組む時点で**品目へ被せる
                └→ ServerMessage の品目に shortName（永続の OrderItem には現れない）

（触らない）engine / OrderItem / 永続 v13 / digest / registry / 種別集合
```

**なぜ Worker を分けるのか。** `StoreTimerDO` は root の生成 Env をそのまま受ける
（`store-timer-do.ts:345` の `class StoreTimerDO extends DurableObject<Env>`）。root の `wrangler.jsonc` に
`ai` / `kv_namespaces` を書けば **DO の env にも現れる**。Workers に per-DO の binding スコープは無いので、
能力を分けるには Worker を分けるしかない。Operation History が「root は KV/R2/D1 を持たない」を静的検査で
守っているのも同じ構造の話である。

**保証の範囲を正確に言う。** 閉じているのは「DO が **AI・KV の直接 binding** を持たない」ことである。
root の `SHORT_NAMES_WORKER`（service binding）は DO からも見えるので、「札の機能へ一切到達できない」ことは
**保証していない**。前者は生成 Env 型が閉じ、後者は `store-timer-do.ts` が参照しないという静的検査で見る
（`SOLVER` と同じ扱い）。

原則は 3 つ。

1. **語を組む場所は増やさない。** `displayName` は引数が 1 つ増えるだけで、札と麺量の規則はその中に閉じる。描画側 4 箇所は文字列を受け取って置くという既存の規律（`queueDisplay.ts:177`）のままである。
2. **検査は局所的である。** `toShortName(candidate, name)` は辞書を見ない。見れば「辞書全体に対する判定」になり、一意性を追わないと決めた判断 7 と矛盾する形（検査は通るのに保証はない）が生まれる。
3. **失敗はすべて「全名」へ落ちる。** AI 不達・検査落ち・期限切れ・KV 失敗・`GET` 失敗・オフライン——経路は違っても着地点は一つで、そこは現状の表示そのものである。新しい壊れ方を作らない。

## Data Models

```ts
// src/display/short-name.ts（純粋・cloudflare:workers に触れない）

/** 札の上限。コードポイントで数える（表示幅ではない・requirements 判断 4）。 */
export const SHORT_NAME_MAX_LENGTH = 8;

/** 辞書のエントリ。「無い」（まだ考えていない）と `plain`（考えた結果、略さない）は別の事実。 */
export type ShortNameEntry =
  | { readonly kind: "short"; readonly label: string }
  | { readonly kind: "plain" };

/** client が引く形。`short` だけを名前 → 札で持つ。`plain` は載らない（判断 16）。 */
export type ShortNames = ReadonlyMap<string, string>;
```

KV の 1 件はこう置く。値は配信に載らない（Requirement 6 AC4）。

```
key       : NFKC 正規化後の Declared_Name      （最長 11 字 ≈ 33 B・上限 512 B）
metadata  : { k: "s", l: "特味噌ネギ" } | { k: "p" }   （上限 1024 B）
value     : {                                   ← 監査の記録。誰も配信しない
              declaredName: "特味噌ネギラーメン",     ← 正規化前の申告値そのまま
              decidedAt: 1789...,
              model: "@cf/zai-org/glm-5.3-flash",
              attempts: [{ candidate: "特味噌ネギラ", rejected: "failed-check" }, ...]
            }
```

metadata を短い鍵（`k` / `l`）にするのは 1024 B の上限に対する保険で、`list()` 1 回で全件の札を運ぶのがこの設計の要だからである（観測事実 18）。

## Components and Interfaces

### Component 1: 表示の語（`queueDisplay.ts`）

```ts
const SIZE_LABEL: ReadonlyMap<string, string> = new Map([
  ["普通", ""], ["中盛", "中"], ["大盛", "大"], ["半玉", "半"],
]);

export function displayName(order: WireOrderItem): string {
  const declared = (order.itemName ?? order.noodleType).normalize("NFKC");
  // 札はサーバが被せたものをそのまま使う。client は辞書を持たない（Requirement 1 AC9）。
  const head = order.shortName ?? declared;
  const size = order.sizeName?.normalize("NFKC");
  if (size === undefined) return head;
  const label = SIZE_LABEL.get(size);
  // 表に在れば区切り無しで連結（`普通` は空文字ゆえ何も付かない）。無ければ従来どおり空白区切り。
  return label === undefined ? `${head} ${size}` : `${head}${label}`;
}
```

`SIZE_LABEL` に `普通 → ""` を置くのは、「表に在る」と「表示する」を分けるためである。`普通` を表から外すと未知の麺量と同じ扱い（空白区切りで全名）に落ち、Requirement 1 AC6 と AC7 が衝突する。

**引数は品目 1 つだけである。** 辞書も resolver も prop も受けない——札はサーバが品目へ被せて送るので、client 側に引く対象が無い。旧設計（client が辞書を取って 4 箇所へ配る）を撤回した理由は requirements 判断 20 に書いた。

`order.shortName` は**ワイヤ側の項目**である（`WireOrderItem`）。`OrderItem`（永続・engine）には現れない——足せば `StoreSnapshot` と同じ型ゆえ v14 になる（観測事実 22）。

### Component 2: 復号と検査（`src/display/short-name.ts`）

**どちらも真偽値ではなく値を返す関門にする。** この repo の既存の作法（`toDeclaredName` / `toGridPoint` / `toMenuItem`）に揃える。値を返す形にするのは、**検査した文字列がそのまま次段へ渡る**ためで、「検査した値と保存した値が違う」余地が構造的に消える。

```ts
/** 応答から候補の生文字列を取り出す。取り出せなければ null（`content` が null・refusal・JSON 不正を含む）。 */
export function toShortNameCandidate(response: unknown): string | null;

/** 候補を NFKC 正規化し、3 条件を検査して**正規化後の札**を返す。落ちれば null。 */
export function toShortName(candidate: string, name: string): string | null {
  const label = candidate.normalize("NFKC");
  const length = [...label].length;
  if (length === 0 || length > SHORT_NAME_MAX_LENGTH) return null;
  if (!usesOnlyCharactersOf(label, name.normalize("NFKC"))) return null;
  return label;
}
```

**`toShortName` が返した文字列だけを保存し、配信する。** 真偽値を返す形（`isValidShortName`）では、候補 `特味噌ﾈｷﾞﾗｰﾒ` が「正規化すれば 8 字・正規化すれば部分列」で検査を通り、**生のまま保存されうる**——生は 9 コードポイントで `特味噌ネギラーメン` の部分列でもない。検査した性質が表示値に成立しない。値を返す関門はこの経路を作らない。

検査は 3 条件だけで、辞書を引数に取らない（原則 2）。文字種の検査は持たない——「元名の文字だけで組む」が「元名に無い文字は使えない」を構造的に与える（Requirement 5 AC5）。

**並び替えを許す**（2026-09-15・判断 33）。`Aセット` を `A味噌` と略す形を指示が求めており、順序を固定したままでは機械検査が弾いて該当 15 件がすべて `plain` へ落ちる。守っている芯は「元名に無い文字を使わせない」ことで、順序はその芯ではない。実測でこの芯が働いた例がある——`塩ネギチャーシュー` に対する `塩葱?` は、元名に無い `葱` と `?` を使ったため関門が捕らえ、`plain` になった。

長さは `[...label].length`（コードポイント）で数える。`label.length` は UTF-16 の符号単位で、絵文字や異体字が来たときに 1 文字を 2 と数える。

`usesOnlyCharactersOf` は文字の出現回数を数えるだけでよい。入力は最長 11 字である。

### Component 3: 辞書の読み書き（`src/display/dictionary.ts`）

- `readShortNames(kv): Promise<Map<string, ShortNameEntry>>` — `list()` を回し、`list_complete` が偽なら `cursor` で続きを読む。値は読まない（metadata だけで足りる）
- `readShortName(kv, key): Promise<ShortNameEntry | null>` — `getWithMetadata` で 1 件
- `writeShortName(kv, key, entry, record): Promise<void>` — metadata に判別と札、value に監査の記録

**上書きを防がない。** `put` はそのまま後勝ちで、判断 12 が許容する範囲である。

### Component 4: 生成（`src/display/generate.ts`）

```
generateShortName(deps, key, declaredName, budgetMs):
  1. [...key].length <= 8               → write(plain) して終わり（AI を呼ばない）
  2. callModel → toShortNameCandidate → toShortName  → 通れば write(short, 正規化後の札)
  3. いずれかが null／例外／JSON Mode エラー → 残り budget があれば 1 回だけ再試行
  4. 通らない／budget 到達                → write(plain)
```

`deps` は `{ ai, kv, model, now }` を受け取る形にして、テストが実 AI を呼ばずに全分岐を踏めるようにする。`budgetMs` を引数で受けるのは、リクエスト共通の締切から割り当てられるためである（Component 5）。`key` は AI へ渡す正規化後の名前で、`declaredName` は監査の記録へ残す生の申告値である——2 つを受けるのは、正規化がこの関数より手前で起きているためで、ここで戻すことはできない。

期限は 3 段で持つ。

| 定数 | 値 | 根拠 |
| --- | --- | --- |
| `SHORT_NAME_CALL_TIMEOUT_MS` | 11,000 | 1 回の `AI.run` の待機。`AbortSignal.timeout` で切る |
| `SHORT_NAME_DEADLINE_MS` | 24,000 | 1 件あたりの上限。呼び出し 2 回分（22 秒）＋ 書き込みの余裕 |
| `SHORT_NAME_REQUEST_DEADLINE_MS` | 24,000 | **1 リクエストの全 Generation が共有する締切**（30 秒に対して 6 秒を残す） |
| `SHORT_NAME_MAX_PER_REQUEST` | 1 | 1 リクエストが着手する初出の上限 |

**値は実測から引いた**（2026-09-15・実データ 24 件）。所要は最小 858ms・中央 1,399ms だが**裾が 26,569ms まで伸びる**。当初の 3,500ms では 6 件が中断され、訂正の経路が無い以上その商品は恒久的に全名になる。1 件 11 秒 × 2 回＋書き込みを `waitUntil` の 30 秒へ収めるため、**1 リクエストで着手するのは 1 件**とした（収束は「当該商品の次の注文」に委ねる設計なので成り立つ）。

**`chat_template_kwargs: { enable_thinking: false }` を必ず渡す。** `glm-5.3-flash` は推論モデルで、既定のままだと 1 件 18,449ms・33.6 Neurons を要する（推論 1,730 文字）。切れば 3,269ms・4.8 Neurons になり、出力の質は変わらなかった。**モデルを差し替えるときはこの指定が効くかを確認し直す。**

`waitUntil` の 30 秒は**呼び出し 1 回に対して与えられ、その中の全 Promise が共有する**（観測事実 20）。1 件 8 秒という上限だけでは、初出が 5 件あるバッチで 40 秒に達して後半の保存が失われる。ゆえに 1 件の budget は `min(SHORT_NAME_DEADLINE_MS, 締切までの残り)` とする。

呼び出しの形（`glm-5.3-flash` の公開スキーマに合わせる）：

```ts
const result = await deps.ai.run(deps.model, {
  messages: [
    { role: "system", content: SHORT_NAME_PROMPT },
    { role: "user", content: `次の商品名に札を作れ。\n\n${name}` },
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "short_name",                                  // ← 必須
      schema: {                                            // ← スキーマ本体はここ
        type: "object",
        properties: { short: { type: "string" } },
        required: ["short"],
        additionalProperties: false,
      },
    },
  },
}, { signal: AbortSignal.timeout(callTimeout) });
```

`json_schema` は **`name` が必須で、スキーマ本体は `schema` に入る**（`sync-input.json` の `required: ["name"]`）。JSON Mode ページが載せているフラットな形はこのモデルの入力スキーマに合わず、拒否される。`strict` も受け付けるが、Workers AI での意味がドキュメントに無いため置かない——形の保証は後段の関門が担う。

**応答は OpenAI 形である。** `sync-output.json` は `choices[]` を持ち、`choices[].message.content` は `string | null`、隣に `refusal: string | null` がある。`{ response: ... }` ではない。`toShortNameCandidate` がこの形を一度だけ読む：

```
response.choices[0].message.content が文字列でない（null・refusal・欠落）  → null
JSON.parse に失敗                                                        → null
parse 結果がオブジェクトでない／`short` が文字列でない                     → null
それ以外                                                                 → その生文字列
```

**復号の関門はここ一箇所**で、`generate.ts` は `toShortNameCandidate` → `toShortName` の 2 段を通した結果しか触らない。`JSON Mode couldn't be met` は例外として上がるので、`null` と同じ扱い（検査落ち）へ畳む（判断 23）。

`SHORT_NAME_PROMPT` は固定文字列としてこのモジュールに置く。**既存の札の一覧は user メッセージで渡す**（2026-09-15 改訂・判断 30）——在メモリの辞書が既に札を持っているので追加の I/O は要らず、実測では衝突する札を渡した 4 ケースすべてが別の札を返した。一意性の保証にはならない（判断 7）が、起きにくくはなる。

```
あなたはラーメン店の厨房で使う画面の表示名を作る。

麺を茹でる担当者が、釜に入っている丼がどの注文のものかを見分けるための「札」を作る。
札は狭い画面に並ぶため短くなければならない。

規則:
1. 元の商品名から文字を削って作る。文字を足さない。並び順を変えない。
2. 8文字以内。規則3〜5を守れる範囲で、できるだけ短くする。
3. 味の系統（醤油・味噌・特味噌・辛味噌・塩）の違いが札だけで分かること。
   「特味噌」と「辛味噌」と「味噌」は別物であり、区別が消えてはならない。
4. 具の違い（ネギ・チャーシュー・ネギチャー）が札だけで分かること。
5. セットの種別（A・B・C）を落とさない。お子様向けの区別も落とさない。

出力は JSON のみ。説明を書かない。
```

規則 3〜5 が Distinguishing_Characters（判断 21）で、**機械検査は持たない**。規則 1 だけが検査され、2 は検査と指示の両方に現れる。

### Component 5: 初出の検出（`src/display/detect.ts` と `worker.ts`）

**生成の要否と、観測店舗への配信は別の問いである。** 既知の名前でも**押し込みの積荷には載せる**——店舗 A で生成済みの商品を店舗 B が初めて観測したとき、生成を飛ばすだけでは B に札が永久に届かない。ゆえにループは「生成するか」と「押すか」を分けて判断する。

判断は 3 段で、段ごとに費用が上がる。

1. **メモリの辞書**（module scope の `Map<Dictionary_Key, ShortNameEntry>`）。**鍵だけの Set では足りない**——押し込む札そのものを取り出せないからである
2. 辞書に無ければ **`readShortName` を 1 回**。他の isolate が既に書いていればここで分かる
3. それでも無ければ **生成**。`generateShortName` は**確定したエントリを返す**（void ではない）——押し込みの積荷へ載せるため

isolate の初回だけ `readShortNames` で集合を満たす。この読み込みも `waitUntil` の中で起きるので、`POST /pos/records` の応答時間には現れない。

**1 リクエストに複数の初出が含まれる。** Arrival_Batch は複数 Record・複数品目を運ぶので、新メニュー投入の朝には初出が一度に何件も届く。ゆえに検出は 1 件の手続きではなく、**バッチ全体に対する 1 本のループ**である。

```
detectFirstAppearance(deps, payload):
  deadline = deps.now() + SHORT_NAME_REQUEST_DEADLINE_MS       ← 締切はここで確定（readShortNames も内側）

  pending = Map<Dictionary_Key, Declared_Name>                 ← 重複除去は鍵で、値は生の申告名
  for record of payload, item of 親品目:
     key = NFKC(item.item_name)
     if (!pending.has(key)) pending.set(key, item.item_name)   ← 同じ鍵の複数表記は先頭が勝つ

  if (known === null) known = await readShortNames(deps.kv)           ← isolate 初回のみ・締切の内側

  payload = Map<Dictionary_Key, 札>                            ← 押し込みの積荷（short だけ）

  // 第 1 巡：**在メモリで判る分を先に集める。** I/O を伴わないので、生成の上限にも締切にも掛からない。
  unknown = []
  for [key, declaredName] of pending:
     entry = cache.get(key)
     if (entry === undefined) unknown.push([key, declaredName])
     else if (entry.kind === "short") payload.set(key, entry.label)

  // 第 2 巡：**知らない分だけを、上限と締切の下で解く。** ここで break しても第 1 巡の収穫は残る。
  started = 0
  for [key, declaredName] of unknown:                          ← 直列
     if (started >= SHORT_NAME_MAX_PER_REQUEST) break
     if (budgetOf(deps, deadline) === null) break              ← 読み取りに入る前
     entry = await readShortName(deps.kv, key)
     if (entry === null):
        budget = budgetOf(deps, deadline)                      ← 読み取りの後に引き直す
        if (budget === null) break
        started += 1
        entry = await generateShortName(deps, key, declaredName, budget)  ← 確定を返す
     cache.set(key, entry)                                     ← 保存が成った後だけ
     if (entry.kind === "short") payload.set(key, entry.label)

  if (payload.size > 0) await push(deps, storeId, payload)     ← 観測した店舗へ

budgetOf(deps, deadline):
  remaining = deadline - deps.now()
  if (remaining < SHORT_NAME_MIN_BUDGET_MS) return null        ← 着手しない
  return Math.min(SHORT_NAME_DEADLINE_MS, remaining)
```

**残り時間を読む規則は `budgetOf` の 1 箇所に置き、`await` をまたぐたびに呼び直す。** ループの先頭で 1 回引くだけでは足りない——`readShortNames` と `readShortName` はどちらもネットワークを待つので、引いた時点の残り時間は生成を始める時点の残り時間ではない。残り 2 秒のときに `readShortName` が 3 秒かかれば、締切を過ぎているのに 2 秒の budget で生成が始まる。締切は「いつ測っても同じ絶対時刻」として持ち、残りはそのつど引く。

**重複除去は Dictionary_Key で行い、値として生の Declared_Name を持つ。** `Set<Dictionary_Key>` に畳むと `旨辛ｽﾀﾐﾅﾗｰﾒﾝ` がこの段で `旨辛スタミナラーメン` になり、監査の記録（Requirement 6 AC3）に残すべき元の表記を復元できない。同じ鍵に複数の表記が混ざる場合は先頭を採る——どれを採っても記録の用途（「何が届いてこの札になったか」）は果たせる。`generateShortName` は鍵（AI へ渡す正規化後の名前）と申告名（記録に残す生の値）の両方を受け取る。

| 定数 | 値 | 役割 |
| --- | --- | --- |
| `SHORT_NAME_MAX_PER_REQUEST` | 4 | 1 リクエストが着手する初出の上限。最悪ケースを締切に依らず読めるようにする |
| `SHORT_NAME_MIN_BUDGET_MS` | 1,000 | これを下回る残り時間では新しい Generation を**始めない** |

**直列にするのは締切の勘定を単純に保つためである。** 並行にすれば同じ締切の中でより多く捌けるが、残り時間の割り当てと再試行の budget が絡んで読みにくくなり、新メニューの朝に AI 呼び出しのバーストを作る。直列なら、締切に対して「今どこまで来たか」を `budgetOf` の 1 箇所で読めばよく、着手の可否と budget が同じ 1 本の式から出る。**残り時間を引く回数が減るわけではない**——`await` のたびに引き直す規則（上記）は直列でも変わらない。

**着手できなかった名前は放置してよい。** エントリが残らないので、**その商品が再び注文されたとき**に改めて初出と判定され、そのときの締切で着手される。拾い直しの契機は「当該商品の次の注文」であって、他の商品の注文が続くだけでは起きない——検出はバッチに現れた名前しか見ないからである。

**どれだけの到着で埋まるかは、この設計からは決まらない。** 1 リクエストで着手できるのは最大 4 件で、しかも締切の残り次第ではそこまで届かない。埋まる速さは各商品が再び注文される頻度に依存し、注文の出方は本 spec の制御下にない。言えるのは 2 つだけである——**着手しなかった名前は何も壊さない**（エントリが無いので表示は全名で、これはフォールバックが正しく効いている状態である）、そして**当該商品が再び届けば、そのときの件数・時間の制限のもとで改めて着手される**。

module scope の可変状態を置くのは、**失われても余分な KV 読みが増えるだけ**だからである。辞書へ入れるのは書き込みが成功した後に限り、「書けていないのに既知」という状態を作らない。他の isolate の書き込みが伝わらない間は段 2 が拾う。

**生成の上限と締切は、配信対象の収集を止めない。** 1 巡目で在メモリの札を集め切ってから 2 巡目で知らない分を解くのは、そのためである。1 巡にまとめて `break` すると「初出 4 件 → 未登録 1 件 → 既知の商品」の順で最後の既知の札が積まれず、AC 7.11（既知も積む）と矛盾する。**途中の読み取り・生成が失敗しても、そこまでに集めた札は押す。**

**押し込みの失敗は握り潰し、次の観測に委ねる。** 積荷は「このバッチで観測した名前のうち札を持つもの」なので、同じ商品が次に注文されれば同じ札がまた積まれる。押し込み専用の再送機構は持たない——持てば、辞書と DO の同期という第二の状態が生まれる。

`/s/{storeId}/orders`（Order_Ingress）は触らない。あの経路は worker がボディを解釈せず転送する形で、読ませれば worker が薄いという既存の規律が崩れる（requirements 判断 19）。

### Component 6: 押し込み（札の Worker → `StoreTimerDO`）

生成が `short` で確定したら、**その名前を観測した店舗の DO へ押し込む**。押し込むのは `{ 名前: 札 }` だけで、`plain` も生成の記録も載せない（受け手にとって `plain` と「辞書に無い」は同じ挙動である）。

```
root  POST /display/observed  { storeId, names }        ← 観測した店舗を添える
札の Worker  生成 → write(KV) → STORE_TIMER_DO.getByName(storeId).applyShortNames(entries)
```

**DO は引きに行かない。** 自立性の不変が禁じているのは pull であって push ではない——設定が `applyProjection` で、外部計画が `deliverPlan` で届くのと同じ形である（観測事実 23）。札の Worker が持つのは `script_name: "yude-men-timer"` を付けた cross-script の DO binding で、`wrangler.solver.jsonc` に前例がある（クラスの所有者は root ゆえ migrations はあちらに置かない）。

**全店への fan-out はしない。** 押し込み先は「その名前を観測した店舗」に限る。root は `/pos/records` を店舗ごとに捌いているので、観測の通知に `storeId` を添えれば足りる。各店舗は自分が実際に出す品目の札だけを持つ。

**DO は札を `StoreSnapshot` とは別のキーへ永続する。**

**当初「永続すれば v14 になる」と書いたのは誤りだった。** `StoreSnapshot` に入れれば確かに v14 だが、`projection`（設定と Roster）と同じく**別キーに置ける**——そちらは既にそうしていて、`CURRENT_SCHEMA_VERSION` にも `migrate` にも関わらない。永続しない理由を「v14 必須」に置くことはできない。

そして在メモリだけでは**成り立たない**。Durable Object は条件を満たせば**約 10 秒の無活動で休眠し、メモリを失う**（WS 接続は残る）。失った後に復元されるのは**その商品が再び観測されたとき**だけなので、直後の POS が別の商品なら前の商品の札は戻らない。閑散時ほど札が消えたままになる——「短い期間」とは保証できない。

ゆえに札は DO 側で永続する。置き場は `StoreSnapshot` の外（`projection` と同じ形の独立したキー）で、Requirement 8 AC1・AC2（`OrderItem` を変えない・v13 を保つ・`migrate` に分岐を足さない）はそのまま成り立つ。

### Component 7: ワイヤへの搭載（`StoreTimerDO` → client）

`ServerMessage` を組む時点で、品目の Declared_Name（NFKC 正規化後）に札があれば `shortName` として添える。**送信のたびに引く**ので、札ができた瞬間から既に待ち行列に在る品目にも効く（取り込み時に焼き付ける形を退けた理由・判断 25）。

**被せる処理は 1 つの関数に閉じ、通常の Broadcast と接続時の hydration の両方がそれを通る。** 二箇所で組めば「レールには札が出るのに、開き直すと全名」という食い違いが生まれる。

**接続中の画面は、押し込みだけでは更新されない。** 送信時に被せる形は「次に送るとき」しか効かず、状態が変わらない限り送信は起きない。ゆえに **`applyShortNames` は、札が実際に変わったときに限り、確定済みの現在の状態をそのまま再送する**。

**順序が意味を持つ。** `applyShortNames` は 3 段で進む。

1. 保存済みの札へ受信分を**マージ**する
2. 変わっていれば**札の別キーへ保存**する
3. **保存が成功してから**メモリへ反映し、確定済みの状態を再送する

**保存に失敗したら従来の札を維持し、未保存の札を配信しない。** 配ってから保存する形にすると、休眠を挟んだ瞬間に「画面には出ているのに DO は知らない札」が生まれる。

- 再送するのは**既に確定した状態**であり、新しい状態遷移でも `Effect` でもない。`decide` を通らない。**`storage.put` を伴わないとは、Timer の `StoreSnapshot` を書き直さないという意味である**——札そのものは別キーへ保存する（そうしなければ休眠で失われる）。SSOT の規律（Timer の確定の起点は `StoreSnapshot` の `put` の成功のみ）はそのままである
- **変わらなければ送らない。** 同じ札を押し直されるたびに再送すれば、閑散時に無意味な送信が積み上がる
- **休眠からの復帰では、保存済みの札を読み戻す。** POS の再観測を待たない（待てば閑散時ほど札が消えたままになる・観測事実 24）

```ts
// ワイヤ側だけが持つ形。`OrderItem`（永続・engine）は変わらない。
export type WireOrderItem = OrderItem & { readonly shortName?: string };
```

種別集合は変えない——増えるのは既存の `snapshot` が運ぶ品目の項目 1 つである。復号（`toOrderItemFromWire`）は `shortName` を任意の非空文字列として読み、それ以外は持たないものとして扱う（空文字を通せば「札がある」と「無い」が区別できなくなる）。

client 側は受け取って置くだけで、`ClientView` にも `localStorage` にも辞書は現れない。**取得も保持も受け渡しも無い。**

### Component 8: 触らないもの

`OrderItem`／永続 v13（`StoreSnapshot` と `migrate`）／`digest`／`StoreConfig`／`StoreProjection`／レジストリ／ワイヤの**種別集合**／Operation History。Requirement 8 がこれを受入基準として持ち、Testing Strategy の静的検査が閉じる。

**`StoreTimerDO` はこの一覧から外れた**（2026-09-15）。札の押し込みを受け（`applyShortNames`）、別キーへ永続し、送信時に品目へ被せる。閉じているのは「**辞書を pull しない・AI と KV の直接 binding を持たない**」ことであって、DO が札に一切関わらないことではない。

## Error Handling

| 起きること | 扱い | 表示 |
| --- | --- | --- |
| AI が例外・不達 | 残り budget があれば 1 回再試行 → なお駄目なら `plain` | 全名 |
| `JSON Mode couldn't be met` | 同上（検査落ちと同じ扱い・判断 23） | 全名 |
| `message.content` が `null`／`refusal` が付く | `toShortNameCandidate` が `null` を返す → 検査落ちと同じ | 全名 |
| `content` が JSON として壊れている | 同上 | 全名 |
| 検査に落ちる | 同上 | 全名 |
| 1 件の budget 到達 | 待機を打ち切り `plain` を保存 | 全名 |
| リクエスト共通の締切に届かず着手できない | 何も書かない。**当該商品の**次の到着で再び初出になる | 全名 |
| 1 リクエストの初出が 5 件以上 | 先頭 4 件だけ着手し、残りは当該商品の次の到着へ送る | 残りは全名 |
| KV の書き込みが失敗 | 記録のみ。エントリは残らず、次の出現で再び初出になる | 全名 |
| `waitUntil` がキャンセルされる | 同上（期限が 8 秒なので通常は起きない） | 全名 |
| DO が hibernate から復帰した | 保存済みの札を読み戻す（POS の再観測を待たない） | 札つき |
| 押し込みが届いていない（その名前の札がまだ無い） | 札を持たないまま送る | 全名 |
| 札の保存に失敗した | 従来の札を維持し、未保存の札を配信しない。再送もしない | 直前の状態のまま |
| 押し込みが失敗する | 記録のみ。辞書には在るので次の観測で押し直される | 全名 |
| 同じ名前が同時に生成される | 後勝ち。どちらも検査を通った札である | いずれかの札 |
| 異なる商品が同じ札になる | 許容する（判断 7）。検査しない | 同じ札 |

**すべての行の着地点が「全名」か「正当な札」である。** 新しい壊れ方は無く、最悪でも現状の表示に戻る。

## Testing Strategy

**純粋層（PBT）**

- `toShortName`：**返り値が非 null なら、その返り値そのものが**元名の部分列であり、コードポイント長 8 以下であり、非空である（生の候補についてではなく**返り値について**成り立つことを検査する——これが Component 2 の要点である）。生成器は「元名から無作為に文字を抜いた列」（通る側）と「文字を足した／並べ替えた列」（落ちる側）に加え、**半角カナ・全角の揺れを混ぜる**（`特味噌ﾈｷﾞﾗｰﾒ` のような、正規化してはじめて通る候補を必ず踏む）
- `isSubsequence`：部分列であることと、`name` から `candidate` を消し込めることが一致する
- `toShortNameCandidate`：`choices[0].message.content` が文字列でない・JSON が壊れている・`short` が文字列でないの各場合に `null` を返す
- `displayName`：辞書が空のときの出力が、本 spec 以前の出力と麺量の扱いを除いて一致する

**例テスト（実データの名前を使う）**

`特味噌ネギラーメン` / `特味噌ラーメンAセット` / `新プレ塩` / `旨辛ｽﾀﾐﾅﾗｰﾒﾝ`（NFKC で `旨辛スタミナラーメン` になること）/ 麺量 4 種（`普通` が消えること・`中` が区切り無しで付くこと）/ 未知の麺量が空白区切りで残ること。架空の名前（`プレ塩`・`ﾈｷﾞ丼`）は新しいテストに使わない。

**生成と検出（AI を呼ばない）**

`deps` を差し替え、`generateShortName` は 8 字以下で AI を呼ばないこと・検査落ちで 1 回だけ再試行すること・budget 到達で `plain` を書くこと・KV 失敗でエントリが残らないこと・**保存された札が正規化後の文字列であること**を踏む。

`detectFirstAppearance` は締切の勘定を踏む——同一バッチ内の同名が 1 回しか生成されないこと・`SHORT_NAME_MAX_PER_REQUEST` を超える初出が次へ送られること・残り時間が `SHORT_NAME_MIN_BUDGET_MS` を切ったら**着手しない**こと・各 Generation へ渡る budget が `min(1 件の上限, 残り)` であること。`now` を注入して時間の分岐を決定的に回す（実時間を待たない）。

**静的検査**

`StoreTimerDO` が AI binding・KV binding へ到達できないこと（Requirement 8 AC5）。同種の不変を閉じる既存の検査が 2 本あるので、その作法に揃える——`tests/operation-history/config-graph.static.test.ts` は Wrangler 設定を capability graph へ写して edge 集合を固定し、`tests/operation-history/no-wake.static.test.ts` は AST で capability の形を見る。本 spec は「`store-timer-do.ts` が `SHORT_NAMES` / `AI` を参照しない」という後者の形で足りる。

## naming ゲート（2026-09-15 承認済み）

requirements の表に加えて、design で増えた公開シンボル。**2026-09-15 に全件承認**（`ShortNameStore` / `ShortNameRecord` / `ShortNameModel` / `ShortNameDeps` は実装中に追加し、同日に承認）。下記 3 件は確認の場で改めた——旧 `ShortNameDictionary` を `ShortNames` へ（構造の語より母語）、旧 `readAll` / `readOne` / `write` を `readShortNames` / `readShortName` / `writeShortName` へ（import 先で何を読み書きするか読める）、旧 `SYSTEM_PROMPT` を `SHORT_NAME_PROMPT` へ（他の定数と接頭辞を揃える）。

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `ShortNames` | `src/display/short-name.ts` | `short` だけの名前 → 札。押し込みの積荷であり、client には渡らない |
| `WireOrderItem` | ワイヤ側の品目 | `OrderItem` に `shortName` を足した形。永続・engine には現れない |
| `applyShortNames(entries)` | `StoreTimerDO` の RPC | 押し込みの受け口（`deliverPlan` と同じ形） |
| `usesOnlyCharactersOf(a, b)` | `src/display/short-name.ts` | a が b の文字だけで組まれている（多重集合の包含）。並び替えを許す |
| `toShortNameCandidate(response)` | `src/display/short-name.ts` | 応答から候補の生文字列を取り出す唯一の関門 |
| `SHORT_NAME_CALL_TIMEOUT_MS` | `src/display/generate.ts` | 1 回の `AI.run` の待機上限 |
| `SHORT_NAME_REQUEST_DEADLINE_MS` | `src/display/detect.ts` | 1 リクエストの全 Generation が共有する締切 |
| `SHORT_NAME_MAX_PER_REQUEST` / `SHORT_NAME_MIN_BUDGET_MS` | `src/display/detect.ts` | 1 リクエストで着手する件数の上限と、着手の下限残り時間 |
| `readShortNames` / `readShortName` / `writeShortName` | `src/display/dictionary.ts` | KV の 3 操作。上書きを防がない |
| `ShortNameStore` | `src/display/dictionary.ts` | 本モジュールが使う KV の 3 操作だけを写した型。`KVNamespace` 全体を受けない |
| `ShortNameRecord` | `src/display/dictionary.ts` | 生成の記録（生の申告名・時刻・モデル ID・落ちた候補）。`ShortNameEntry`（判断の結果）と区別する |
| `ShortNameModel` | `src/display/generate.ts` | 本モジュールが使う Workers AI の能力（`run` 1 つ）だけを写した型。`Ai` 全体を受けない |
| `ShortNameDeps` | `src/display/generate.ts` | 生成が要する 4 つ（問う先・保存先・モデル ID・時計） |
| `detectFirstAppearance(deps, cache, declaredNames)` | `src/display/detect.ts` | バッチ 1 本の検出ループ。重複除去と締切の配分を持つ。payload の形は知らず、生の申告名の列を受ける |
| `generateShortName(deps, key, declaredName, budgetMs)` | `src/display/generate.ts` | 1 件の生成。budget は呼び出し側が配る |
| `budgetOf(deps, deadline)` | `src/display/detect.ts` | 残り時間の読み方の唯一の場所。`await` をまたぐたびに呼ぶ（非公開） |
| `ShortNameCache` | `src/display/detect.ts` | isolate が持ち越す既知の鍵。`keys` が `null` は「まだ一度も読んでいない」 |
| `SHORT_NAME_PROMPT` | `src/display/generate.ts` | 生成の指示。既存の札一覧を含まない |
| `ShortNamesEnv` | `src/display/worker-configuration.d.ts` | 札の Worker の Env 型。root の `Env` と**別物**（`pnpm short-names:types` が生成） |
| `SHORT_NAMES_WORKER` | root の `services` binding | 札の Worker への唯一の到達経路。DO からも見える（`SOLVER` と同じ範囲） |
| `POST /display/observed` | 札の Worker の経路 | 届いた商品名と店舗を知らせる内部口。202 を即返す |
| `declaredItemNames(records)` | `src/ingress/declared-item-names.ts` | Arrival_Batch から親品目の申告名を到着順に拾う。正規化も重複除去もしない |

## 未決の決定

**残る未決は 1 つだけである**（2026-09-15 時点）。

1. **`ai` binding の課金経路。** `glm-5.3-flash` は有料の支払い方法が必須のモデル群に属する（観測事実 17）。対象アカウントの Workers Paid 有効化は**未確認**で、KV namespace を作れたことは利用可否を意味しない。**実 AI 検証とデプロイの前に確認する。**

### 決着済み（記録）

- **KV namespace**（2026-09-15）。`yude-men-short-names` = `94044a829d6743cb894b1b660e4a10a5`、`yude-men-short-names-preview` = `f718a3063f7f427f970d5fdc5a2b3cce`。`wrangler kv namespace list` の名前と ID を突き合わせて確認し、同名の重複が無いことも確認した。設定は `wrangler.short-names.jsonc` の `kv_namespaces[0]`。
- **`SHORT_NAME_MODEL`** = `@cf/zai-org/glm-5.3-flash`（`wrangler.short-names.jsonc` の `vars`）。入力・出力の契約は公開スキーマ（`sync-input.json` / `sync-output.json`・2026-09-14 取得）で確認済み——`json_schema` は `name` が必須で本体は `schema`、応答は `choices[].message.content`（`string | null`・隣に `refusal`）。**モデルを差し替えるなら両方を確認し直す。**
- ~~`Cache-Control` の秒数~~ — **不要になった**。client が HTTP で辞書を取らないため、配信経路ごと落ちた（判断 20・24）。
