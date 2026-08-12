# Implementation Plan: 操作履歴ログ（operation-history-log）

## Overview

本計画は `requirements.md` と `design.md` を正本とし、確定した Timer 操作を best-effort telemetry として観測する機能を、Timer 本体へ干渉せず段階的に実装・検証するための TypeScript / Cloudflare Workers 計画である。実装順は、公開命名と環境別搬送計画の確認、純粋な Operation Record／codec／分析計算、Producer と Data Platform の独立実装、統合・運用、最終検証とする。

最優先の不変点は次のとおり。

- Operation Record は Timer 状態の正本、完全履歴、復旧元ではなく、Persist 成功済みの確定差分を通常完了後に同期 console 出力試行する best-effort telemetry である。
- Atomic Commit、Authority History、Durable Outbox、`Record_Seq`、`seq`、`nextSeq`、観測専用 Alarm、統合 Alarm、StoreTimerDO 内の Queue 待ち・配送再試行・履歴永続化を導入しない。
- 観測目的の construct、wake、rehydrate、Reconcile、Persist を起こさず、既存 Effect 列 `Persist → Set/Clear Alarm → Broadcast` と Effect 集合を変更しない。
- `TimerFact`、engine `Timer`、`TimerState`、`ActiveTimersSnapshot`、Effect に観測属性を追加せず、実効 `endTime` は既存 `toWireTimer` の射影を唯一の正本として再利用する。
- Producer の外向き作用は、一 record につき一引数の同期 `console.log(canonicalLine)` 一回だけとする。観測由来の Promise、`await`、`waitUntil`、再試行、timer、interval、connection、Alarm、storage、outbox を持たない。
- Tail Worker、Queue、Consumer、R2、Snowpipe、Snowflake、Logpush は StoreTimerDO 外の Data Platform に閉じ、Producer または StoreTimerDO への逆方向経路を構成しない。
- `src/observe` の debug harness と型、flag、出力関数を共用しない。

採用ツールは pnpm v11、TypeScript strict、Vitest v4、Cloudflare Workers pool、fast-check v4、Wrangler v4、oxlint とする。Correctness Properties 1〜11 は省略不可であり、それぞれ独立した単一 property テストとして fast-check v4 の `numRuns: 100` 以上で実行する。

> **命名ゲート:** 本計画中の `OperationObservation`、`OperationRecord`、`recordsFromCommittedDiff`、`printCanonicalOperationLine`、`parseOperationLines`、`tryWriteOperationLines`、`operationLinesFromTailEvents`、観測 ON/OFF 設定名、Worker／binding／Queue 名はすべて暫定候補である。タスク 1 で概念境界と共にユーザー確認し、確定するまでタスク 2 以降を開始しない。

## Tasks

- [x] 1. 最初のチェックポイント — 公開命名と環境別搬送方針を確定する
  - [x] 1.1 公開シンボル候補と設定・資源名を概念境界と共にユーザー確認する
    - 暫定候補 `OperationObservation`（store、event kind、before／after、Event Time の readonly 観測入力）、`OperationRecord`（kind ごとの閉じた既知属性を持つ判別共用体）、`recordsFromCommittedDiff`（確定 before／after から record 列を得る純粋導出）を提示する。
    - 暫定候補 `printCanonicalOperationLine`（known-only canonical printer）、`parseOperationLines`（未知属性許容の行別 parser）、`tryWriteOperationLines`（record ごとの局所 catch を持つ同期 console 終端）、`operationLinesFromTailEvents`（Tail envelope filter）を提示する。
    - 観測 ON/OFF 設定名、Producer script、Tail Worker、Consumer Worker、Queue producer／consumer binding、R2 binding、Queue の各候補名を、Producer と Data Platform の所有境界と共に提示する。
    - 禁止された汎用語を新しい名前に使わず、確定した名前を後続タスクへ一貫して反映する。
    - _Requirements: 1.1, 1.3, 2.16, 3.1, 4.1, 4.9, 4.10, 4.13_

  - [x] 1.2 dev／stage／prod ごとの Tail Worker 利用プランをユーザー確認する
    - 各環境について Workers plan、Tail Worker 作成権限、対象 Producer への attachment 可否、利用する Producer script を確認し、第一経路を採用できる環境を確定する。
    - _Requirements: 4.1, 4.2, 4.12_

  - [x] 1.3 Tail Worker を利用できない環境の Logpush → R2 縮退可否をユーザー確認する
    - 各対象環境で Workers logs dataset と R2 destination の可用性を確認し、観測できたログだけを搬送する縮退を許容するか確認する。
    - backfill、Producer 再出力、DO 再起動を行わず、観測不能期間の欠落を許容する方針を明示する。
    - _Requirements: 4.7, 4.8, 4.12, 4.13, 4.14_

  - [x] 1.4 命名と環境別方針の承認を実装開始ゲートとして記録する
    - 1.1〜1.3 のユーザー承認が揃うまでタスク 2 以降を開始しない。未確定名をコード、設定、テスト fixture、運用手順へ固定しない。
    - _Requirements: 1.3, 4.1, 4.7, 4.12, 4.13_

- [x] 2. 純粋層 — Operation Record と確定差分導出を実装する
  - [x] 2.1 kind ごとに閉じた Operation Record 判別共用体を実装する
    - 共通既知属性を `storeId`、`timerId`、`operationKind`、`eventTime`、非空 `slotIds`、`noodleType`、`firmness` に限定し、`boil-started`、`boiled`、`adjusted`、`completed`、`cancelled` ごとの許可属性を型で閉じる。
    - timestamp は 0 より大きい整数 epoch millisecond とし、自然人属性、導出値、`Record_Seq`、`seq`、`nextSeq` を含めない。
    - `TimerFact`、engine `Timer`、`TimerState`、`ActiveTimersSnapshot`、Effect の既存フィールド集合を変更せず、観測契約を Producer／Data Platform の audience に限定する。
    - _Requirements: 1.3, 1.7, 2.16, 2.17, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 2.2 確定 before／after 差分から Operation Record を導出する純粋関数を実装する
    - Start の追加は after facts から `boil-started`、Complete／Cancel の除去は before facts から `completed`／`cancelled`、Adjust の firmness または実効 `endTime` 変更は after facts から `adjusted` を一差分一件で導出する。
    - running → boiled は AlarmFired と既存理由の Reconcile のいずれも after facts から `boiled` を一差分一件で導出し、Reconcile が当該差分を Persist しない場合は 0 件とする。
    - 拒否、no-op、Persist 不在、Persist 失敗、本体例外は呼出し境界で導出対象外にし、観測側で時刻を読み直さず、その `decide` に一回だけ渡した `now` を全 record の Event Time に使う。
    - 入力を readonly とし、platform API、storage、console、env、`ctx`、Working Copy setter へ到達できない純粋関数にする。
    - _Requirements: 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.11, 2.12, 2.13, 2.15_

  - [x] 2.3 既存 `toWireTimer` と実効 `endTime` の SSOT を再利用する
    - engine Timer から Timer 事実を得る際は既存 `toWireTimer` を通し、`endTime + adjustment` 相当の計算を観測側へ複製しない。
    - `boiledAt` は確定差分に必要な既存値だけを読み、観測属性を Timer モデルへ追加しないことを型・静的検査で固定する。
    - _Requirements: 1.6, 1.7, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.16_

  - [x] 2.4 差分導出の example／edge テストを実装する
    - Start、Adjust、Complete、Cancel、AlarmFired、Reconcile、複数同時 boiled、拒否、no-op の代表例で、取得元、件数、順序、Event Time を確認する。
    - Reconcile は running → boiled だけを出力対象とし、観測目的で Reconcile または Persist を起動する経路がないことを確認する。
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.11, 2.12, 2.13, 2.15_

- [x] 3. 純粋層 — Operation History Codec を実装する
  - [x] 3.1 known-only canonical printer を実装する
    - 入力 object を直接直列化せず、許可された既知属性だけを `storeId`、`timerId`、`operationKind`、`eventTime`、`slotIds`、`noodleType`、`firmness`、`startTime`、`endTime`、`boiledAt` の固定順で新しい object へ写す。
    - 標準 `JSON.stringify` と同じ escape と整数表記を使い、BOM、埋め込み改行、余分な空白を含めず、一 record 一行、複数 record は LF 一個で連結して record と `slotIds` の相対順を保つ。
    - 未知属性、自然人属性、`Record_Seq`、`seq`、`nextSeq`、その他の導出値を出力しない。
    - _Requirements: 2.16, 2.17, 3.2, 3.8, 3.9, 3.10, 3.11_

  - [x] 3.2 未知属性を許容し既知属性重複を検出する行 parser を実装する
    - JSON object の member 出現回数を保持できる解析で既知属性の重複を検出し、未知属性は値を既知契約へ混ぜず無視する。
    - kind 別の必須属性、許可属性、型制約、値制約を検証し、結果を record または失敗の判別共用体にする。
    - _Requirements: 3.12, 3.13, 3.14_

  - [x] 3.3 parser の失敗優先順位、行単位継続、failure classification を実装する
    - 一行に複数問題がある場合、不正 JSON → 既知属性重複 → 必須属性欠落 → Operation Kind 不許可属性 → 既知属性型違反 → 既知属性値違反の最初の種別だけを返す。
    - 1 始まりの行番号と解析失敗種別を保持し、不正行の後続を含む全行を入力順で処理する。
    - _Requirements: 3.15, 3.16, 3.17_

  - [x] 3.4 codec の example／edge テストを実装する
    - 全 kind の golden bytes、Unicode、quote、backslash、制御文字、複数 `slotIds`、正整数 timestamp 境界を確認する。
    - 未知属性、既知属性重複、未知属性重複、empty line、BOM、CRLF、埋め込み改行、末尾 LF、複合失敗の優先順位、妥当／不正混在時の継続を固定する。
    - _Requirements: 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15, 3.16, 3.17, 3.18, 3.19_

- [x] 4. 純粋層 — 相関、重複、品質、SLO の計算を実装する
  - [x] 4.1 一次相関候補と補助 metadata の境界を実装する
    - `(storeId, timerId, operationKind, eventTime)` で一次候補を作り、`slotIds`、`noodleType`、`firmness` と kind 別時刻の整合を検証する。
    - canonical hash と Cloudflare trace metadata は曖昧性解消の観測側補助情報だけに使い、Operation Record identity、連番、Timer 永続 identity にしない。
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 4.2 raw arrival を保持した重複収束と品質状態を実装する
    - 同一 record の到達 `n >= 1` 件を raw のまま保持し、分析用一件、到達総数 `n`、重複数 `n - 1` へ収束させる。
    - 欠落、孤児、競合、重複を別状態で保持し、品質判定の前後で根拠となる raw arrival を削除しない。
    - _Requirements: 5.5, 5.6, 5.7_

  - [x] 4.3 品質率、信頼判定、best-effort 表示を実装する
    - lifecycle 内欠落率、重複率、孤児率、競合率を Requirements 5.9〜5.12 の分子・分母どおり計算し、分母 0 は数値 0 ではなく算出不能にする。
    - 全対象率が算出可能かつ閾値以下の場合だけ信頼済み分析へ含め、除外時は対象率と理由を表示する。
    - 分析値に対象 Store Id、期間、Observed telemetry に基づく best-effort 推定である旨を付け、console log 自体の完全未観測率は lifecycle 内欠落率と分けて測定不能と表示する。
    - _Requirements: 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 5.15_

  - [x] 4.4 UTC 月次 99%／15 分 SLO と 30／60 分通知判定を実装する
    - 重複除外後の Observed telemetry を `firstObservedAt` の UTC 暦月へ一度だけ所属させ、`firstSnowflakeAt` まで 15 分以内の件数と母集団から到達率を算出する。
    - 母集団 0 の月は率を作らず判定対象外とし、SLO 表示に母集団数、15 分以内件数、率または対象外、Timer 操作成功を保証しない旨を含める。
    - Snowflake 未到達の最古 record が 30 分帯へ入る遷移と 60 分以上へ入る遷移を判定し、各連続状態につき一回、5 分以内に必要な相関属性を含む通知を出すための結果を返す。
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.13_

  - [x] 4.5 相関・品質・SLO の example／境界テストを実装する
    - raw 重複の順列、欠落、孤児、競合、分母 0、閾値ちょうど、UTC 月境界、15 分ちょうどと前後、30／60 分遷移、一連続状態一回を確認する。
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 5.15, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.13_

- [ ] 5. 純粋層 — Tail envelope filtering を実装する
  - [x] 5.1 Tail event から Queue 候補を抽出する純粋 filter を実装する
    - タスク 1 で確定した想定 Producer script、log level `log`、console 引数が一要素かつ string、文字列が一行かつ canonical Operation Record として妥当、という全条件を順に適用する。
    - `src/observe` の debug JSON、未知の console 出力、複数引数、非 string、複数行、不正行を Queue 候補へ含めない。
    - _Requirements: 4.3, 4.4_

  - [x] 5.2 不正候補の位置と失敗種別を観測側結果へ残す
    - Tail event 内の候補位置を 1 始まりで保持し、codec の解析失敗種別と関連付ける。Producer または StoreTimerDO へ診断を返さない。
    - _Requirements: 4.4, 4.13, 4.14_

  - [x] 5.3 Tail envelope filter の example テストを実装する
    - script、level、引数数、引数型、一行性、canonical 妥当性の各不一致と複合ケースを確認し、妥当候補の入力順、不正候補の 1 始まり位置、Queue 0 件を検証する。
    - _Requirements: 4.3, 4.4_

- [x] 6. fast-check v4 で Correctness Properties 1〜11を実装する
  - [x] 6.1 確定差分と record の一対一対応を単一 property テストで検証する
    - **Property 1: 確定差分と record の一対一対応**
    - 有効な before／after TimerState、event kind、正の Event Time を生成し、fast-check v4 の一つの `fc.property` を `numRuns: 100` 以上で実行する。
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.11, 2.12, 2.13**
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.11, 2.12, 2.13_

  - [x] 6.2 Operation Record schema の閉包を単一 property テストで検証する
    - **Property 2: Operation Record schema の閉包**
    - Property 1 が生成し得る record の kind 別属性集合、値制約、禁止属性不在を、fast-check v4 の一つの `fc.property` で `numRuns: 100` 以上検証する。
    - **Validates: Requirements 2.16, 2.17, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
    - _Requirements: 2.16, 2.17, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 6.3 Canonical printer の一意性を単一 property テストで検証する
    - **Property 3: Canonical printer の一意性**
    - 有効な record 列と文字列境界を生成し、既知属性順、標準 JSON 表記、空白／BOM／改行不在、LF 連結、順序保存を、fast-check v4 の一つの `fc.property` で `numRuns: 100` 以上検証する。
    - **Validates: Requirements 3.8, 3.9, 3.10, 3.11**
    - _Requirements: 3.8, 3.9, 3.10, 3.11_

  - [x] 6.4 未知属性に対する既知意味の不変性を単一 property テストで検証する
    - **Property 4: 未知属性に対する既知意味の不変性**
    - 既知名と衝突しない任意の未知属性を生成し、追加前後の既知値と `slotIds` 順が一致することを、fast-check v4 の一つの `fc.property` で `numRuns: 100` 以上検証する。
    - **Validates: Requirements 3.12**
    - _Requirements: 3.12_

  - [x] 6.5 行 parser の失敗分類と継続性を単一 property テストで検証する
    - **Property 5: 行 parser の失敗分類と継続性**
    - 妥当行と六種の失敗を混ぜた行列を生成し、一行一結果、入力順、1 始まり行番号、優先分類、後続継続を、fast-check v4 の一つの `fc.property` で `numRuns: 100` 以上検証する。
    - **Validates: Requirements 3.13, 3.14, 3.15, 3.16, 3.17**
    - _Requirements: 3.13, 3.14, 3.15, 3.16, 3.17_

  - [x] 6.6 Codec round-trip を単一 property テストで検証する
    - **Property 6: Codec round-trip**
    - 有効 record の `parse(print(record))` と canonical line の `print(parse(line))` を同じ property 内で検証し、fast-check v4 の一つの `fc.property` を `numRuns: 100` 以上実行する。
    - **Validates: Requirements 3.18, 3.19**
    - _Requirements: 3.18, 3.19_

  - [x] 6.7 相関候補の閉じた構成を単一 property テストで検証する
    - **Property 7: 相関候補の閉じた構成**
    - record 集合と補助 metadata を生成し、一次 key の一致、Timer 事実の整合、hash／trace による identity 不変を、fast-check v4 の一つの `fc.property` で `numRuns: 100` 以上検証する。
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 6.8 重複収束と品質状態を単一 property テストで検証する
    - **Property 8: 重複収束と品質状態**
    - raw arrival multiset を生成し、分析用一件、到達数 `n`、重複数 `n - 1`、品質状態の分離、raw 不変を、fast-check v4 の一つの `fc.property` で `numRuns: 100` 以上検証する。
    - **Validates: Requirements 5.5, 5.6, 5.7**
    - _Requirements: 5.5, 5.6, 5.7_

  - [x] 6.9 品質率と信頼判定を単一 property テストで検証する
    - **Property 9: 品質率と信頼判定**
    - 非負集計、分母 0、品質閾値を生成し、四率の定義、算出不能、信頼済み分析の包含条件を、fast-check v4 の一つの `fc.property` で `numRuns: 100` 以上検証する。
    - **Validates: Requirements 5.9, 5.10, 5.11, 5.12, 5.13, 5.15**
    - _Requirements: 5.9, 5.10, 5.11, 5.12, 5.13, 5.15_

  - [x] 6.10 UTC 月次到達 SLO を単一 property テストで検証する
    - **Property 10: UTC月次到達 SLO**
    - Observed telemetry 到達列、UTC 月境界、15 分境界、空月を生成し、重複除外、月所属、率、対象外を、fast-check v4 の一つの `fc.property` で `numRuns: 100` 以上検証する。
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 6.11 Tail envelope filtering を単一 property テストで検証する
    - **Property 11: Tail envelope filtering**
    - script、level、引数数、引数型、一行妥当性の組合せを生成し、全条件を満たす候補だけが入力順で Queue 候補になることを、fast-check v4 の一つの `fc.property` で `numRuns: 100` 以上検証する。
    - **Validates: Requirements 4.3, 4.4**
    - _Requirements: 4.3, 4.4_

- [x] 7. チェックポイント — 純粋層と全11 property を検証する
  - [x] 7.1 純粋層の example、edge、Property 1〜11を実行し結果を確認する
    - 全 property が省略されず、それぞれ単一 property テストかつ `numRuns: 100` 以上であること、platform 作用を mock で純粋 property に見せていないことを確認する。
    - 問題があれば Producer／Data Platform 統合へ進む前にユーザーへ確認する。
    - _Requirements: 1.6, 2.1, 2.16, 3.1, 3.8, 3.12, 3.13, 3.18, 4.3, 5.1, 5.5, 5.9, 6.1_

- [x] 8. Producer 側 — StoreTimerDO へ同期 best-effort console 終端を最小統合する
  - [x] 8.1 record ごとに独立した同期 console 出力試行を実装する
    - 純粋導出 → canonical printer → 一引数 `console.log(canonicalLine)` のみを実行し、各 record の構築、printer、console を record ごとの局所 `try/catch` で隔離する。
    - 一件の失敗後も後続 record は各一回だけ試行し、失敗 record を再試行しない。戻り値、Promise、`await`、`waitUntil`、timer、interval、connection、Alarm、storage、outbox、Queue 能力を追加しない。
    - 観測 ON/OFF はタスク 1 で確定した設定だけで判定し、OFF 時は record 構築前に同期 return する。観測失敗を別 console 行へ出さない。
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.10, 2.14, 4.9_

  - [x] 8.2 既存入口の通常完了経路へ観測を差し込む
    - 状態変化を Persist し得る既存 WebSocket message、既存 Alarm、既存理由の constructor Reconcile で、`decide` 前の確定済み before、既存の一回採取済み `now`、`runEffects` 正常復帰後の after を渡す。
    - Effect 列に Persist があり、その Persist 成功後に Working Copy 更新、既存 Set/Clear Alarm、Broadcast、応答その他の既存作用が通常完了した場合だけ、既存 return 直前に同期出力を試行する。
    - 観測を Effect、`applySideEffect`、`finally` に入れず、既存 Effect 列 `Persist → Set/Clear Alarm → Broadcast`、既存 Alarm の待機規律、WebSocket 応答、既存例外を変えない。
    - rejection、no-op、Persist 不在、Persist 失敗、Persist 後の既存作用例外では出力 0 件とし、既存例外を捕捉・変換しない。
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 2.1, 2.9, 2.10, 2.11, 2.12, 2.14, 2.15_

  - [x] 8.3 constructor Reconcile の観測境界を最小統合する
    - 既存理由で constructor が既に起動し、独自に一回採取した `now` で Reconcile を実行した場合だけ、running → boiled を含む Persist 成功差分を同じ `blockConcurrencyWhile` 内の通常完了後に出力試行する。
    - 差分なし、Alarm 張り直しだけ、Persist 失敗、既存作用例外では 0 件とし、観測から constructor、rehydrate、Reconcile、Persist を起動しない。
    - 後続 fetch／WebSocket message は別に採取した `now` を使い、Reconcile の Event Time と共有しない。
    - _Requirements: 2.7, 2.8, 2.10, 2.13, 2.15_

  - [x] 8.4 Workers pool で観測 ON/OFF と fault injection の統合テストを実装する
    - 同じ初期 snapshot、既存イベント列、`decide` 時刻列に対し、OFF、成功、record 構築 throw、printer throw、console throw を比較する。
    - Start、Adjust、Complete、Cancel、AlarmFired、Reconcile を含め、TimerState、Persist payload／成否／順序、Working Copy、Set/Clear Alarm、Broadcast 内容／宛先／順序、Snapshot、応答、正常 return、既存例外が一致することを確認する。
    - 観測失敗が Timer 操作結果へ伝播せず、各 record の試行が局所化され、再試行と追加作用が 0 件であることを確認する。
    - _Requirements: 1.2, 1.4, 1.5, 1.6, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.11, 2.12, 2.13, 2.14_

  - [x] 8.5 Workers pool で既存例外と Reconcile の統合テストを実装する
    - Persist 失敗、Set/Clear Alarm の同期 throw、Broadcast stringify／send throw、Alarm Persist 失敗時の既存 retry／rearm 分岐で console 0 件かつ同じ既存例外を確認する。
    - Reconcile の複数 running → boiled は一差分一行、差分なしは 0 行、後続 message とは別 Event Time であることを確認する。
    - _Requirements: 1.5, 2.7, 2.8, 2.9, 2.10, 2.11, 2.13, 2.14_

  - [x] 8.6 既存 Timer モデルと Effect の不変性を検証する
    - `TimerFact`、engine `Timer`、`TimerState`、`ActiveTimersSnapshot` のフィールド集合、Effect の判別共用体、Persist payload に観測属性がないことを型・snapshot・静的検査で確認する。
    - `Record_Seq`、`seq`、`nextSeq` が Operation Record または console 行へ出ないことを確認する。
    - _Requirements: 1.3, 1.7, 2.16, 3.2_

- [x] 9. No-wake／No-rehydrate の O1〜O7 を検証する
  - [x] 9.1 O1〜O3 の Producer capability・起動原因・永続読書きゼロを静的検証する
    - Producer 観測 module の import graph と引数に `cloudflare:workers`、`ctx`、env binding、storage、Alarm、Queue、R2、WebSocket、HTTP client、DO namespace、下流 client がないことを確認する。
    - 観測用 fetch route、WebSocket frame、Alarm、scheduled event、Queue callback、RPC、Worker 間 binding、storage key、read／write／list／transaction が追加されていないことを確認する。
    - _Requirements: 1.3, 1.8, 1.9, 2.15_

  - [x] 9.2 O4〜O6 の逆方向到達不能・live resource ゼロ・Reconcile 因果を静的検証する
    - Tail／Consumer から Producer への URL、Service Binding、DO stub、RPC、WebSocket、Alarm、scheduled callback がなく、Queue ack が Consumer → Queue に閉じることを確認する。
    - Producer 終端が Promise、`waitUntil`、timer、interval、subscription、connection、Alarm、保持 closure、mutable state を作らないことを確認する。
    - boiled 出力から constructor、rehydrate、Reconcile へ戻る edge がなく、既存 constructor の Persist 成功差分だけを観測することを確認する。
    - _Requirements: 1.8, 1.9, 1.10, 2.7, 2.8, 2.15, 4.13, 4.14, 4.15_

  - [x] 9.3 O7 の比較 trace と runtime counter を Workers pool で検証する
    - 観測 OFF／成功／三種の fault injection で、decide outcome、次 TimerState、Effect 列、Persist、Working Copy、Alarm、Broadcast、Snapshot、応答、既存例外の trace を比較する。
    - 観測由来の construct、wake、rehydrate、storage read、Alarm 予定が全て 0 差分であり、invocation 終了時の観測由来 live resource が 0 件であることを確認する。
    - プラットフォームによる非決定的な instance 廃棄時点だけは比較対象外とし、それ以外の追加起動原因がないことを O1〜O6 と合わせて確認する。
    - _Requirements: 1.5, 1.8, 1.9, 1.10, 1.11_

  - [x] 9.4 hibernation debug harness との非共有を静的検証する
    - Producer 観測 module が `src/observe` の型、flag、出力関数を import せず、Operation History 固有の純粋層と同期終端だけに依存することを確認する。
    - _Requirements: 1.3, 1.8, 1.10_

- [x] 10. Data Platform 側 — Tail Worker → Queue → Consumer → R2 を実装する
  - [x] 10.1 Tail Worker で完了済み Producer execution の envelope を受ける
    - タスク 1 で確定した Producer script の完了後に別 Worker execution として起動し、純粋 envelope filter と codec を呼び出す。
    - 全条件を満たす canonical 一行から得た Operation Record と観測側 metadata だけを Queue へ送り、不正行は送らず 1 始まり位置と failure classification を観測側へ保持する。
    - Tail Worker 自身の失敗、Queue 送信、非同期処理、再試行を Data Platform 内に閉じ、Producer の invocation、戻り値、例外、状態へ接続しない。
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.11, 4.13, 4.14_

  - [x] 10.2 Queue Consumer で raw arrival を R2 へ保存する
    - Queue message の canonical line、`firstObservedAt`、到着時刻、producer script、必要な trace metadata／canonical hash を Operation Record 本体と分離して raw object に保存する。
    - R2 put 成功後だけ Queue へ ack し、put 失敗時は ack 0 件として Queue の再配送方針へ委ねる。ack を Producer または StoreTimerDO へ返さない。
    - 重複配送でも raw arrival を削除・上書きせず保持できる object key／書込規律にする。
    - _Requirements: 4.5, 4.11, 4.12, 4.13, 4.15, 5.3, 5.4, 5.5, 5.7, 6.1_

  - [x] 10.3 Tail／Queue／R2 の integration テストを実装する
    - 完了済み Producer tail fixture から想定 script、`log`、一引数 string、妥当な一行だけが Queue へ送られることを確認する。
    - 不正行は Queue 0 件で、1 始まり位置と失敗種別が残ること、Queue send failure が Producer trace に現れないことを確認する。
    - R2 put 成功後だけ ack、失敗時 ack 0 件、重複 delivery でも raw arrival が全件残ることを確認する。
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.11, 4.13, 4.14, 4.15, 5.5, 5.7_

  - [x] 10.4 Tail／Consumer から Producer への逆方向経路がないことを検証する
    - 全 fixture と call trace で Producer URL、Service Binding、DO namespace／stub、RPC、HTTP、WebSocket、scheduled event、Alarm、ack、再出力要求が 0 件であることを確認する。
    - _Requirements: 1.9, 4.10, 4.13, 4.14, 4.15_

- [ ] 11. Producer と Data Platform の設定境界を実装・検証する
  - [x] 11.1 実装時点の Wrangler v4 schema と公式資料で設定キーを確認する
    - リポジトリに導入済み Wrangler v4 の schema と Cloudflare 公式 Wrangler configuration／Tail Workers／Queues／R2 資料を照合し、`tail_consumers`、Queue producer／consumer、R2 binding の正しいキーと配置を確認してから設定する。
    - タスク 1 で確定した Worker、binding、Queue 名を使い、未確認の設定キーを推測で追加しない。
    - _Requirements: 4.1, 4.3, 4.5, 4.12, 4.13_

  - [x] 11.2 Producer root `wrangler.jsonc` には Tail attachment だけを追加する
    - Producer 設定の SSOT である root `wrangler.jsonc` に、実在する Tail Worker を指す `tail_consumers` attachment だけを追加する。
    - Queue producer／consumer、R2、観測用 DO、storage、Alarm、Consumer への binding を root へ追加せず、StoreTimerDO の env から下流へ到達不能にする。
    - root 変更後は `pnpm cf-typegen` を実行し、生成 `Env` 型に Queue／R2 能力が増えていないことを確認する。
    - _Requirements: 1.3, 1.7, 1.9, 4.9, 4.10, 4.13, 4.14_

  - [~] 11.3 Tail Worker と Consumer の設定を Data Platform 側へ分離する
    - Tail Worker に Queue producer binding、Consumer に Queue consumer と R2 binding を置き、再配送／dead-letter 方針を Data Platform 側の設定正本へ置く。
    - Tail／Consumer に `STORE_TIMER_DO`、Producer URL、Service Binding、DO namespace／stub、Producer を起動できる route や権限を付けない。
    - _Requirements: 1.9, 4.1, 4.5, 4.11, 4.12, 4.13, 4.14, 4.15_

  - [~] 11.4 設定 graph の static test を実装する
    - root には Tail attachment だけ、Tail には Queue producer だけ、Consumer には Queue consumer／R2 だけがあり、Producer への逆 edge がないことを machine-readable graph と設定 snapshot で検証する。
    - Producer 観測 module に platform／downstream capability がなく、観測専用 Alarm、Queue callback、scheduled route、storage key がないことも合わせて確認する。
    - _Requirements: 1.3, 1.8, 1.9, 2.15, 4.10, 4.13, 4.14, 4.15_

- [ ] 12. Tail 不可環境の Logpush → R2 縮退を構成・検証する
  - [~] 12.1 確認済み環境だけに Logpush → R2 を構成する
    - タスク 1.3 で承認された環境の対象 Workers logs dataset と R2 destination を使い、観測できた structured console log だけを R2、Snowpipe、Snowflake へ搬送する。
    - Producer root に Queue／R2 binding や再出力入口を追加せず、Data Platform 所有の account 設定として分離する。
    - _Requirements: 4.7, 4.12, 4.13, 4.14_

  - [~] 12.2 縮退経路に backfill／再出力／DO 再起動がないことを検証する
    - Tail unavailable または structured console log 未観測の期間について、backfill job、Producer 再出力要求、outbox、DO 再起動、観測目的の rehydrate／Reconcile／Persist が存在しないことを設定 graph と運用手順で確認する。
    - _Requirements: 1.8, 1.9, 2.15, 4.8, 4.13, 4.14_

  - [~] 12.3 Logpush 縮退の smoke fixture と欠落表示を検証する
    - 観測できた canonical line が R2 へ到達する fixture と、観測不能分を補完せず完全未観測率を測定不能と表示する運用結果を確認する。
    - _Requirements: 4.7, 4.8, 5.8, 5.14_

- [ ] 13. Snowpipe／Snowflake の raw、品質、SLO、保持、アクセス制御を実装する
  - [~] 13.1 R2 raw arrival を Snowpipe で Snowflake へ取り込む
    - canonical Operation Record と観測側 metadata を分離したまま取り込み、`firstObservedAt` と `firstSnowflakeAt` を関連付ける。
    - raw arrival、重複収束後 record、相関結果、品質判定を別の責務として保持し、重複、欠落、孤児、競合の根拠 record を削除しない。
    - _Requirements: 4.6, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1_

  - [~] 13.2 相関、重複収束、欠落／孤児／競合／重複、品質率を Snowflake へ配線する
    - 純粋計算の定義を SQL／view 側で再解釈して別の定義を作らず、一次相関 key、Timer 事実整合、補助 metadata、raw 到達数、重複数を設計どおり反映する。
    - lifecycle 内欠落率、重複率、孤児率、競合率と分母 0 の算出不能を保持し、閾値超過または算出不能の店舗／期間を信頼済み分析から除外する。
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.9, 5.10, 5.11, 5.12, 5.13, 5.15_

  - [~] 13.3 best-effort 分析表示と完全未観測率の表示を実装する
    - 生産能力指標に Store Id、期間、Observed telemetry に基づく best-effort 推定である旨を付ける。
    - lifecycle 内欠落率と console log 自体の完全未観測率を分け、後者は Producer telemetry 総数を観測できないため測定不能と表示する。
    - _Requirements: 5.8, 5.14, 5.15_

  - [~] 13.4 月次 99%／15 分 SLO と 30／60 分通知を運用経路へ配線する
    - UTC 暦月ごとに重複除外後の母集団、15 分以内到達数、率または対象外を表示し、母集団が一件以上なら 99% 以上を判定基準にする。
    - 未到達最古 record が 30 分帯へ遷移したら警告、60 分以上へ遷移したら重大通知を各連続状態一回、遷移から 5 分以内に発し、Store Id、Timer Id、Operation Kind、Event Time を含める。
    - SLO が Timer 操作成功を保証しない旨を併記する。
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.13_

  - [~] 13.5 R2 90 日と Snowflake 25 UTC 暦月の保持を構成する
    - R2 は保存成功から 90 日で削除開始し 24 時間以内に完了、Snowflake は初回到達月を第 1 月とする 25 UTC 暦月終了後に削除開始し 24 時間以内に完了する。
    - 各期限前は保持期限を理由とする削除を 0 件にし、品質根拠 raw も期限までは保持する。
    - _Requirements: 6.7, 6.8, 6.9_

  - [~] 13.6 機密業務データのアクセス制御を実装する
    - Operation Record を個人情報ではない機密業務データとして分類し、record、品質指標、分析結果を承認済み分析担当者だけが読める role／policy にする。
    - 未承認主体を拒否し、拒否後も Operation Record、品質指標、分析結果、アクセス承認状態が変わらないようにする。
    - _Requirements: 6.10, 6.11, 6.12_

  - [~] 13.7 Snowpipe／Snowflake／運用 integration テストを実装する
    - R2 fixture の取込、初回時刻関連付け、重複 raw 保持、四品質状態、四品質率、分母 0、信頼除外、best-effort 表示、完全未観測率の測定不能を確認する。
    - 15 分境界、空月、30／60 分通知、R2 90 日、Snowflake 25 UTC 暦月、24 時間削除境界を clock-controlled test で確認する。
    - 承認済み／未承認アクセスと拒否後不変を確認する。
    - _Requirements: 4.6, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 5.15, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13_

- [ ] 14. チェックポイント — Producer と Data Platform の統合境界を確認する
  - [~] 14.1 Producer／Tail／Queue／R2／Snowflake の検証結果をレビューする
    - Producer の console 一点以外に StoreTimerDO 外向き作用がなく、Data Platform の待機、再試行、失敗保持、再配送が StoreTimerDO 実行外だけにあることを確認する。
    - O1〜O7、設定 graph、fault injection、Tail fixture、R2 ack、raw 重複保持、品質／SLO／保持／アクセスの検証が揃うまで rollout へ進まない。
    - _Requirements: 1.1, 1.2, 1.3, 1.8, 1.9, 1.10, 4.1, 4.5, 4.10, 4.11, 4.13, 4.14, 4.15_

- [ ] 15. Config／deployment smoke と段階 rollout を実施する
  - [~] 15.1 local config smoke を実装・実行する
    - root `tail_consumers` が確定した実在 Tail Worker 名を指し、Tail の Queue producer、Consumer の Queue consumer／R2、R2 lifecycle、Snowpipe stage、通知、access role の参照整合を検査する。
    - Producer root に Queue／R2 がなく、Tail／Consumer に `STORE_TIMER_DO`、Producer URL、Service Binding、DO stub がなく、Producer 逆呼出し edge が 0 件であることを確認する。
    - _Requirements: 1.3, 1.9, 4.1, 4.5, 4.10, 4.12, 4.13, 4.14, 4.15, 6.7, 6.8, 6.11_

  - [~] 15.2 ユーザー実行の下流 smoke 手順を整備する
    - 認証情報を要する実デプロイとは分けて、ユーザーが R2 → Queue／Consumer → Snowpipe → Snowflake → 保持／通知／access の順に疎通確認する手順、期待結果、停止／切戻し条件を記述する。
    - R2 保存成功前 ack 0 件、重複 raw 保持、Producer／StoreTimerDO 呼出し 0 件を確認項目に含める。
    - _Requirements: 4.5, 4.6, 4.10, 4.11, 4.13, 4.14, 4.15, 5.5, 5.7, 6.5, 6.6, 6.7, 6.8, 6.11, 6.12_

  - [~] 15.3 ユーザー実行の Tail fixture smoke 手順を整備する
    - 下流疎通後に Tail Worker を fixture で検証し、想定 envelope だけが Queue へ進み、不正行の位置／分類が残り、Producer 逆呼出しがないことを確認する手順を記述する。
    - _Requirements: 4.2, 4.3, 4.4, 4.13, 4.14_

  - [~] 15.4 環境別の最終 attachment／Logpush 有効化手順を整備する
    - Tail 利用可能環境は下流と Tail fixture 成功後に Producer `tail_consumers` attachment を有効化し、利用不可環境は確認済み Logpush → R2 を有効化する。
    - 順序を「下流 → Tail fixture → Producer attachment または Logpush」に固定し、実デプロイ、account plan 確認、credential を要する操作はユーザー実行と明記する。
    - attachment 無効化または Logpush 停止に Timer state migration、backfill、Producer 再出力、DO 再起動が不要であることを切戻し条件にする。
    - _Requirements: 1.8, 1.9, 2.15, 4.1, 4.7, 4.8, 4.13, 4.14_

  - [~] 15.5 ユーザー実行 smoke で Producer 逆呼出しゼロを確認する
    - Tail／Consumer／Snowpipe 障害を発生させても StoreTimerDO の construct、wake、rehydrate、storage read、Alarm 予定が増えず、Producer へ ack、再出力要求、HTTP、RPC、stub call がないことを確認する観測手順を記述する。
    - _Requirements: 1.8, 1.9, 1.10, 4.10, 4.11, 4.13, 4.14, 4.15_

- [ ] 16. 最終チェックポイント — 全ローカル検証を完了する
  - [~] 16.1 生成型と対象テストの完了状態を確認する
    - root `wrangler.jsonc` を変更した場合は `pnpm cf-typegen` が完了し、Producer `Env` に Queue／R2／DO 逆方向能力が追加されていないことを確認する。
    - Correctness Properties 1〜11、Workers pool integration、static／config graph、Tail／Queue／R2、Snowflake／運用 integration が全て省略なく成功していることを確認する。
    - _Requirements: 1.3, 1.5, 1.7, 1.8, 1.9, 1.10, 3.18, 3.19, 4.3, 4.4, 4.5, 4.13, 4.14, 5.15, 6.13_

  - [~] 16.2 最終品質コマンドを順に実行する
    - `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` を実行し、失敗があれば原因を修正して全て成功するまで確認する。
    - 実デプロイ、plan／権限照会、credential を要する smoke は自動実行せず、タスク 15 のユーザー実行手順と結果記録を引き渡す。
    - _Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 4.1, 4.5, 4.12, 4.13, 4.14, 4.15_

## Notes

- 全チェックボックスは未完了で開始する。`*` 付き省略可能タスクは設けない。特に Correctness Properties 1〜11 は全て必須である。
- 各 property は fast-check v4 の独立した単一 property テストとし、各 `numRuns: 100` 以上で実行する。platform 作用は property 化せず、Workers pool integration、static test、config graph、deployment smoke へ分離する。
- タスク 1.4 は全後続タスクの必須ゲートである。公開シンボル、観測設定、Worker／binding／Queue 名はタスク 1 で確定するまで暫定候補であり、コードや設定へ固定しない。
- Producer と Data Platform は、一方向の structured console log 境界だけを共有する。Producer は Queue、R2、Consumer、Snowpipe、Snowflake を知らず、Data Platform は Producer または StoreTimerDO を呼び戻さない。
- Atomic Commit、Authority History、Durable Outbox、`Record_Seq`、`seq`、`nextSeq`、観測専用 Alarm、統合 Alarm、StoreTimerDO 内 Queue 待ち／配送再試行／履歴永続化は実装しない。観測目的の rehydrate、Reconcile、Persist も起動しない。
- `TimerFact`、engine `Timer`、`TimerState`、`ActiveTimersSnapshot`、Effect は不変とし、実効 `endTime` は既存 `toWireTimer` の SSOT を再利用する。
- root `wrangler.jsonc` の Producer 設定には `tail_consumers` attachment だけを置き、Queue／R2 binding を置かない。変更時は `pnpm cf-typegen` を実行する。
- 実環境への deploy、account plan／権限確認、Logpush job、Snowpipe、保持 policy、通知、access role の smoke は認証情報を要するため、ユーザー実行手順としてローカル検証と区別する。

## Task Dependency Graph

```json
{
  "gate": {
    "task": "1.4",
    "requires": ["1.1", "1.2", "1.3"],
    "blocks": ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16"]
  },
  "waves": [
    { "id": 0, "phase": "公開名・環境計画の確認", "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "phase": "純粋な record と確定差分", "tasks": ["2"] },
    { "id": 2, "phase": "純粋な codec と分析計算", "tasks": ["3", "4"] },
    { "id": 3, "phase": "純粋な Tail filter", "tasks": ["5"] },
    { "id": 4, "phase": "必須 PBT", "tasks": ["6"] },
    { "id": 5, "phase": "純粋層チェックポイント", "tasks": ["7"] },
    { "id": 6, "phase": "Producer と Data Platform の並列実装", "tasks": ["8", "10", "11"] },
    { "id": 7, "phase": "非干渉証明と縮退経路", "tasks": ["9", "12"] },
    { "id": 8, "phase": "分析・運用基盤", "tasks": ["13"] },
    { "id": 9, "phase": "統合チェックポイント", "tasks": ["14"] },
    { "id": 10, "phase": "config・deployment smoke と rollout", "tasks": ["15"] },
    { "id": 11, "phase": "最終検証", "tasks": ["16"] }
  ],
  "dependencies": {
    "2": ["1.4"],
    "3": ["2"],
    "4": ["2"],
    "5": ["3"],
    "6": ["2", "3", "4", "5"],
    "7": ["6"],
    "8": ["7"],
    "10": ["7"],
    "11": ["1.4"],
    "9": ["8", "11"],
    "12": ["11"],
    "13": ["4", "10", "12"],
    "14": ["9", "10", "11", "12", "13"],
    "15": ["14"],
    "16": ["15"]
  }
}
```