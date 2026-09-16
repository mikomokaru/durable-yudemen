# 同時刻の群が隠れていた——実装が仕様より広く隠していた（2026-09-15）

## 1. 症状

現場の観察（`yamaokaya-1108`）。

> 2 杯を同じ時刻に茹で始める提案が出ていると思われる局面で、UI 上は一つめがまず表示され、
> 次に同時ゆで対象であるもう一つが表示される

**CP-SAT 版でのみ起こる**（ユーザー指摘）。

## 2. 仕様は同時刻の群を隠していない

`lift-group-display` 判断 7：

> **次の群**は「現在の群の最初の 1 本が始まった」かつ「自身の 60 秒前が来た」で現れる

判断 19（Visible_Groups）：

> Gk が表示可能なのは、k = 1 であるか、G1 … G(k−1) の**すべてが** Group_Started であるとき

**「次の群」は時間的に後の群である。** 同時に始められる群を隠すとは書かれていない。

## 3. 実装は並び順で打ち切っていた

```ts
for (const group of groups) {
  visible.push(group);
  if (!group.started) break;      // ← 開始時刻を見ずに打ち切る
}
```

群は「最も早い startAt」の昇順に並ぶが、**同じ時刻の群も後ろに並ぶ**。ゆえに先頭が started で
なければ、**同時刻の群まで隠れた**。仕様より広く隠す実装の誤りである。

## 4. なぜ CP-SAT でだけ表面化したか

`started` の判定は `anchor !== null && anchor > now`。

**CP-SAT は `Placement.anchor` を常に `null` で出す**（`src/cpsat/plan.ts`）。ゆえにどの群も
`started` にならず、**連鎖が最初の群で永久に止まる**。

TS 側は走行中の仲間へ合流した配置に `joinTarget` が錨を付けるので、1 本始まれば次が解禁されて
いた。**同じ規則が、計画器によってまったく違う振る舞いになる。**

**この形は本日 3 回目である。**

| # | 同じ規則が計画器で別物になった件 |
|---:|---|
| 1 | lead の窓の内側で上がる走行中——`end` の定義域が逆転（`cpsat-lead-window-defects-20260914.md`） |
| 2 | 貪欲 hint が `unavailableSlots` を見ない——`status=UNKNOWN`（本日修正） |
| 3 | **本件**——`anchor` を出さないので連鎖が止まる |

いずれも「engine 側は前提を満たしているが、CP-SAT はその前提を作らない」という構図である。

## 5. 直し

連鎖は**止まった群より後の開始時刻**にだけ効かせる。同じ時刻の群は出す。

```ts
let blockedAt: number | null = null;
for (const group of groups) {
  const startAt = group.items[0].recommendation.startAt;
  if (blockedAt !== null && startAt > blockedAt) break;
  visible.push(group);
  if (!group.started && blockedAt === null) blockedAt = startAt;
}
```

**腕の本数では縛らない。** 「腕が 2 本なら 2 つまで」を隠す根拠に採らなかった——**腕を意識するのは
上げるとき**であって、投入の本数を縛るものではない（ユーザー判断）。濃く（押せる）出すのを先頭
`arms` 本に絞る規則（判断 21）はそのままで、変えたのは**見える範囲**だけである。

## 6. 波及——既存試験 6 件

**変更費用（`changeCost`）が同じ述語を読む。** 「表示が濃く出す品目と計画が守る品目が食い違わない
よう domain に一つだけ置く」という規律のため、`headsOf` は表示と費用の両方から呼ばれる。

| 試験 | 変更 | 理由 |
|---|---|---|
| `stability.example` (c-1) | まとまりを割る費用が **L + 2L → L** | 割っても「次に押せる品目が減る」がなくなった |
| `liftGroups.example` 卓なし 2 群 | 見える群が **1 → 2** | 同じ serveAt の 2 群が両方見える |
| `liftGroups.crosslayer` 発火 | 見える群 **1 → 2**・釜のカードは B のみ | **群として見えることと釜に出ることは別**——C の釜には boiled の A が残り、全釜 idle（判断 15）を満たさない |
| `liftGroups.crosslayer` Complete | 釜のカードに C も出る | 釜が空いた |

全数 2,178 通過。

## 7. 残る根——**CP-SAT が `anchor` を出さない**

本修正は**表示の側だけ**である。`anchor` は他の 3 箇所でも読まれる。

| 読み手 | いま何が起きているか |
|---|---|
| `keepsAnchor`（ゲート (e)） | 錨の主張が無い側で判定される。**1108 で `anchor` 棄却を観測している**（2026-09-14） |
| 群の所属（`recommend`） | 合流した配置が別の群になる |
| 変更費用 (c-1) | まとまりの分割が正しく数えられない |

**CP-SAT 側で「どの配置が走行中の仲間への合流か」を定義する作業**が要る。本記録の修正とは
独立に計画する。
