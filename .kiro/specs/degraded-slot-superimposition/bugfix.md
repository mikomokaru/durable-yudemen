# Bugfix Requirements Document

## Introduction

degraded（縮退）中に、down 前から在った server-confirmed タイマーが endTime 到達でクライアント側にローカル発火する。しかし発火は `processedIds` への記録にとどまり、`view.timers` からは除去されない。その茹で上がった（boiled）スロットに対しユーザーが同じスロットへ local provisional タイマーを start すると、1 スロットに `origin="server"`（boiled）と `origin="local"`（provisional）の 2 本が**重ね合わせ**になる。`slotDisplay` は 1 スロットにつき最早 endTime の 1 本しか描画しないため、片方が隠れる。

その後サーバを再起動して再接続（down→up）すると、最初の全量 snapshot が `Reconcile` として畳まれる。write-back は既存スコープ外のため、ローカルで消化したはずの古い server タイマーはサーバ側にまだ残っており snapshot で**復活**する（`reconcileServerConfirmed` の server 集合全置換で戻る）。`processedIds` は保持 id 集合に入るためローカル再発火は抑止される（ここは仕様どおり）。復活した server タイマーがサーバ側で消える（茹で上がり/消し込み）と、隠れていた local provisional が表示へ再出現し、ユーザーには「ローカルのタイマーが復活した」ように見える。

破られている不変条件は「**1 スロット ≤ 1 タイマー**」であり、これが degraded の boiled 経路で崩れる（重ね合わせ）。write-back 不在（既存スコープ外）と組み合わさることで、上記の「復活して見える」症状に至る。

本ドキュメントは記録専用である。バグ条件と文脈を後から再開できるよう正確に捕捉することだけを目的とし、設計・タスク・実装には進まない。

### バグ条件 C(X)（bug condition methodology）

バグの本質は「1 スロットが `origin="server"` と `origin="local"` の 2 本に同時占有される `ClientView` 状態が到達可能である」ことにある。`ClientView.timers` 上で表現する。

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type ClientView
  OUTPUT: boolean

  // ある slotId が、origin="server" の Timer と origin="local" の Timer の
  // 双方に同時に含まれている（重ね合わせ）
  RETURN EXISTS slotId, s, l WHERE
      s IN X.timers AND s.origin = "server" AND slotId IN s.slotIds
      AND l IN X.timers AND l.origin = "local" AND slotId IN l.slotIds
END FUNCTION
```

到達経路（この状態が生まれるシーケンス）:
`degraded 中に既存 server-confirmed が boiled 化（除去されず timers に残存）` → `同一スロットへ LocalStart（provisional 注入）` → `再接続 down→up で Reconcile（server-confirmed 全置換＝古い server タイマーが復活）`。

- **F**: 現行（未修正）のクライアント状態遷移／表示導出（`decideView` / `assignedSlotDisplays` / `reconcileServerConfirmed`）。
- **F'**: 修正後。1 スロット ≤ 1 タイマーが degraded の boiled 経路でも保たれる。

## Bug Analysis

### Current Behavior (Defect)

現状、degraded の boiled 経路で 1 スロットに server-confirmed と local provisional が重ね合わせになり、再接続で復活して見える。

1.1 WHEN degraded 中に down 前からの server-confirmed タイマーが endTime に到達してローカル発火する THEN the system はそれを `processedIds` に記録するのみで `view.timers` から除去せず、当該スロットを boiled 表示のまま在席させ続ける

1.2 WHEN その boiled なスロット（server-confirmed が在席）へユーザーが local provisional を start する THEN the system は同一スロットを `origin="server"` と `origin="local"` の 2 本で同時占有させ（重ね合わせ）、`slotDisplay` が最早 endTime の 1 本だけを描画するため他方を隠す

1.3 WHEN サーバ再起動後に再接続（down→up）して最初の全量 snapshot を Reconcile する THEN the system は `reconcileServerConfirmed` の server 集合全置換により、ローカルで消化したはずの古い server-confirmed タイマーをサーバ残存データから復活させる

1.4 WHEN 復活した server-confirmed タイマーがその後サーバ側で消える（茹で上がり/消し込み）THEN the system は隠れていた local provisional を表示へ再出現させ、ユーザーには「ローカルのタイマーが復活した」ように見える

### Expected Behavior (Correct)

「1 スロット ≤ 1 タイマー」を degraded の boiled 経路でも保ち、重ね合わせと「復活して見える」症状を解消する。

2.1 WHEN degraded 中に server-confirmed タイマーが endTime に到達してローカル発火する THEN the system SHALL 「1 スロット ≤ 1 タイマー」を保ち、後続の同一スロットへの start が重ね合わせを生まない状態に整える

2.2 WHEN boiled なスロット（server-confirmed が在席）へ start しようとする THEN the system SHALL 同一スロットが `origin="server"` と `origin="local"` の 2 本で同時占有される状態（`isBugCondition(X)` が真になる状態）を生成しない

2.3 WHEN サーバ再起動後に再接続して最初の全量 snapshot を Reconcile する THEN the system SHALL ローカルで既に消化済み（`processedId` 済み）の server-confirmed タイマーが表示上で「復活」して見えない扱いを与える

2.4 WHEN 復活した／隠れていたタイマーがサーバ側の変化で消える THEN the system SHALL 隠れていた別起源タイマーが不意に再出現する挙動を起こさない

### Unchanged Behavior (Regression Prevention)

重ね合わせが起きない正常経路の挙動は不変に保つ。

3.1 WHEN degraded 中に空きスロット（server-confirmed も provisional も不在）へ local provisional を start する THEN the system SHALL CONTINUE TO 単一の provisional タイマーを注入し、当該スロットの直前結果（残滓）を解除する（現行 `decideLocalStart` の挙動）

3.2 WHEN Provisional_Timer（`origin="local"`）を cancel / complete する THEN the system SHALL CONTINUE TO それをローカルで除去する（`origin="server"` 記録経路を発動させない）

3.3 WHEN 再接続 Reconcile を適用する THEN the system SHALL CONTINUE TO server-confirmed を全置換しつつ Provisional_Timer（`origin="local"`）を保持し、消えた Timer の残滓記録・`processedIds` の刈り取り（保持 id 集合への限定）を現行どおり行う

3.4 WHEN live（非 degraded）で通常のタイマー start / cancel / complete / adjust を行う THEN the system SHALL CONTINUE TO 現行どおりサーバへ送信し、重ね合わせを生じない

3.5 WHEN 単一スロットに 1 本だけタイマーが在席する（重ね合わせでない）通常表示 THEN the system SHALL CONTINUE TO running / boiled / idle / unreceived の導出を現行 `assignedSlotDisplays` のまま行う

3.6 WHEN engine 契約（`src/engine`, `src/domain`）に関わる挙動 THEN the system SHALL CONTINUE TO それらを不変に保つ（変更は `src/client` 内に閉じる）

---

## Reference Notes（記録専用・後続の設計フェーズ向け・本ドキュメントでは判断しない）

以下は再開のための文脈記録であり、設計判断は行わない。設計・タスクは別フェーズで扱う。

### Affected Components（調査済み）

- `src/client/connection.ts` — `decideView`（`LocalDone` は `processedIds` 記録のみで `timers` 非除去）、`decideLocalStart`（占有スロットの既存タイマーを除去せず provisional を追加）、`reconcileServerConfirmed`（server 集合全置換で残存 server タイマーが復活）、`dueLocalTimers` / `fireDue`（ローカル発火経路）。
- `src/client/components/slotDisplay.ts` — `assignedSlotDisplays`（1 スロットにつき最早 endTime の 1 本のみ描画＝重ね合わせの片方を隠す）。
- `src/client/assignment.ts` — `assignedTimers` / `slotOf` / `slotsOfUnits`（スロット射影。any-overlap）。

### Candidate Fix Directions（options のみ・未実装）

- (A) `LocalStart` 時に、対象スロットを占有する既存タイマー（特に boiled）を先にローカル除去（暗黙 complete）してから注入し、重ね合わせを防ぐ。
- (B) boiled の server-confirmed が残るスロットでは complete を経ないと start させない UI ゲート。
- (C) 再接続 Reconcile で「ローカル処理済み（`processedId` 済み）かつ復活した server タイマー」の表示上の扱いを明確化する。

### Scope Notes

- engine 契約（`src/engine`, `src/domain`）は不変。変更は `src/client` 内に閉じる想定。
- write-back / クロスデバイス二重投入は既存 `offline-degradation` スペックでスコープ外。
- 関連スペック: `.kiro/specs/offline-degradation/`（`design.md` の Provisional_Timer・Reconcile・決定 B、要件 6/7/8/9/11）、`.kiro/specs/snapshot-broadcast/`（`reconcileServerConfirmed` の残滓/刈り取り規律）。
