# Implementation Plan: 音声キュー（audio-cues）

## Overview

本計画は `design.md` の二層骨格（**純粋判定 `src/client/audioCue.ts` → 端の作用フック `src/client/components/useAudioCues.ts` → 既存 UI への配線**）を、依存順にインクリメンタルに組み立てる一連のコーディングタスクへ落とす。`engine` / `domain` / `shell` には一切触れず、変更は `src/client/` に閉じる（要件1.4 / 7.10・設計骨格4）。

進め方の骨格:

1. **純粋層を先に固める** — `audioCue.ts` の決定的関数群（`boiledTimerIds` / `dueDoneCue` / `advancePreAlert`）を実装し、Correctness Properties P1〜P5 を fast-check で機械検証する（property 先行）。AudioContext も時計も持たない核を、実 I/O 抜きで正しさを保証する。
2. **端の作用を載せる** — 合成トーン・ローカル永続・Audio_Session のライフサイクルを `useAudioCues` へ隔離する。`useWakeLock` の規律（可視時のみ・前面復帰のたびに取り直す・優雅な劣化）を手本にする。
3. **既存 UI へ最小配線する** — `App.tsx` でフックを呼び、`SlotBoard` 経由で `playTouchCue` を指定操作へ相乗りさせる。
4. **依存の自動確認** — Wake_Lock マウント等、コードで検証できる前提を example テストで固定する。

テストは `tooling.md` 確定スタック（**Vitest v4** ＋ **fast-check v4**）に従い `tests/client/` へ置き、`pnpm test`（= `vitest --run`）で走らせる。新規依存（howler 等）は追加しない（設計の定石は手法として最小実装で借りる）。

> 各サブタスクのうち `*` を付けたもの（property / example / integration テスト）は任意であり、MVP では省略可能。`*` の付かないコア実装タスクは必ず実装する。

## Tasks

- [x] 1. 純粋判定モジュール `src/client/audioCue.ts`
  - [x] 1.1 純粋判定関数群と公開シンボルを実装する
    - `src/client/audioCue.ts` を新規作成し、定数 `PRE_ALERT_THRESHOLD_MS`（60_000）・`DONE_CUE_INTERVAL_MS`（5_000）を定義する
    - `boiledTimerIds(displays: readonly SlotDisplay[]): ReadonlySet<string>` を実装（`kind:"boiled"` の timerId を `Set` で dedup・複数スロット駆動と複数件同時 boiled を集約）
    - `dueDoneCue(boiled, now, lastRingAt, intervalMs?): boolean` を実装（boiled 空なら常に false／非空かつ `lastRingAt === null` なら true／非空かつ `now - lastRingAt ≥ interval` のとき true。done 受信回数・件数・`processedIds` に依存しない）
    - 型 `PreAlertWatch`（`{ readonly armed; readonly alerted }`）と初期値 `EMPTY_PRE_ALERT_WATCH` を定義する
    - `advancePreAlert(prev, assigned, offset, now, thresholdMs?): { fire; next }` を実装（armed/alerted 位相遷移・出現時 ≤ 閾値は alerted 直行で失格・once-only・`assigned` に居ない timerId は次位相から脱落）
    - すべて純粋・決定的に保つ（`Date.now()` / AudioContext / WS / DOM / localStorage を参照しない。時刻・位相は引数で受ける）
    - 既存 `slotDisplay.ts`（`SlotDisplay`）・`assignment.ts`・`clock.ts`（`remainingMs`）の純粋導出を組み合わせ、boiled / remaining を二重定義しない
    - _Requirements: 2.3, 2.4, 2.5, 2.10, 3.1, 3.2, 3.4, 3.6, 3.7, 3.9_

  - [x]* 1.2 property テスト用の入力生成器を用意する
    - `tests/client/audioGenerators.ts` を新規作成し、既存 `tests/client/generators.ts` の `genClientView` / `genClientTimer` / `genUnits` を再利用して拡張する
    - 担当内外をまたぐ `slotIds`・過去/現在/未来に広がる `endTime`・`offset`（負/0/正）・`endTime == correctedNow`（remaining = 0）と `remaining == 閾値`（60s）の境界・同一 timerId の重複出現を含める
    - 単調増加 `now` 列（開始・閾値クロス・boiled 化・done/cancel 除去を踏む `PreAlertWatch` 畳み込み用）を生成する
    - _Requirements: 2.1, 3.6, 3.7_

  - [x]* 1.3 Property 1 の property テストを書く
    - **Property 1: 純粋判定は入力 view を変更せずデータのみを決定的に返す（SSOT 非書き戻し）**
    - `tests/client/audioCue.property.test.ts` に実装。先頭に `// Feature: audio-cues, Property 1: ...` のタグコメントを付す
    - `fc.assert(fc.property(...), { numRuns: 100 })`（最低 100 反復）。入力 `ClientView`（`timers`/`offset`/`processedIds`）が不変で、二度評価が等しいことを検証
    - **Validates: Requirements 1.4, 2.3, 2.7, 3.9, 4.7, 5.4, 7.7, 7.10**

  - [x]* 1.4 Property 2 の property テストを書く
    - **Property 2: Pre_Alert は閾値クロスで各 timerId につきちょうど 1 回だけ発火する（once-only と資格）**
    - 同 `audioCue.property.test.ts` に追記。Property 2 のタグコメントを付す。`numRuns: 100`
    - 単調増加 `now` 列で `advancePreAlert` を畳み込み、閾値超で観測後に ≤ 閾値へ達した timerId だけが `fire` にちょうど 1 回現れること、出現時既に ≤ 閾値は不発、同時クロスは全件発火を検証
    - **Validates: Requirements 2.1, 2.4, 2.5, 2.8, 5.7**

  - [x]* 1.5 Property 3 の property テストを書く
    - **Property 3: Pre_Alert の発火と記録は担当 Timer に限られ、消えた Timer の記録は破棄される**
    - 同 `audioCue.property.test.ts` に追記。Property 3 のタグコメントを付す。`numRuns: 100`
    - `fire` が入力 `assigned` の timerId のみを含むこと、`assigned` に居ない timerId が次位相（armed/alerted）から脱落し記録が有界に保たれることを検証
    - **Validates: Requirements 2.2, 2.10**

  - [x]* 1.6 Property 4 の property テストを書く
    - **Property 4: Done_Cue の鳴動可否は boiled 集合の非空性と周期経過のみで決まる（件数・重複・done 回数・processedIds 非依存）**
    - 同 `audioCue.property.test.ts` に追記。Property 4 のタグコメントを付す。`numRuns: 100`
    - `dueDoneCue(boiledTimerIds(displays), now, lastRingAt)` の (a) 空→常に false (b) 非空かつ null→true (c) 非空かつ `now-lastRingAt ≥ interval` ⇔ true を検証し、boiled の濃度・重複出現に不変であることを確認
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 5.3, 5.6**

  - [x]* 1.7 Property 5 の property テストを書く
    - **Property 5: boiled 集合は担当かつ remaining ≤ 0 の Timer のみを含む（視覚正本との一致）**
    - 同 `audioCue.property.test.ts` に追記。Property 5 のタグコメントを付す。`numRuns: 100`
    - `boiledTimerIds(assignedSlotDisplays(view, units, now))` の各 timerId が担当範囲に属し remaining = 0 であること、走行中/担当外/除去済みを含まないこと、Audio_Session 状態を入力に取らないことを検証
    - **Validates: Requirements 3.5, 3.8, 7.8**

- [x] 2. Checkpoint - 純粋層のテストを通す
  - すべてのテストが通ることを確認し、疑問があればユーザーに問い合わせる。

- [x] 3. 端の作用フック `src/client/components/useAudioCues.ts`
  - [x] 3.2 3 種の合成トーンと再生終了ノードの後始末を実装する
    - `src/client/components/audioTone.ts` を新規作成し、単一 AudioContext 上で `OscillatorNode` + `GainNode` のエンベロープにより Touch_Cue（極短クリック）・Pre_Alert_Cue（単発予告音）・Done_Cue（反復しやすい注意音）を鳴らす関数を提供する
    - 各ノードの `onended` で `disconnect` し参照を解放、`onended` を null 化する。finished ノードへ再 `start` しない（`InvalidStateError`・メモリリーク防止）
    - 外部音源ファイル・`<audio>` 要素・アセット読み込みを持たない（音声経路は AudioContext 単一）
    - _Requirements: 1.1, 3.11_

  - [x] 3.3 Audio_Session のライフサイクルを実装する
    - `src/client/components/useAudioCues.ts` を新規作成し、`useAudioCues(view, units, options?)` と返り値 `AudioCues`（`{ playTouchCue }`）・`AudioCuesOptions`（`now?`/`tickMs?`）を定義する
    - Audio_Unlock: 初回ジェスチャ（`touchstart`/`touchend`/`click`/`keydown` を **capture フェーズ**で待受）で AudioContext を生成し無音バッファを 1 回 warm-up する
    - 無音 BufferSource の `onended` 発火で解錠成立を確認してから running 化し、確認後に解錠リスナ群を一括解除する（試みただけで running を主張しない）
    - resume: suspended/interrupted な Audio_Session を可視化・ジェスチャ起点で resume する
    - 破棄と再生成: resume 失敗（`InvalidStateError` 等）で close → 新規生成 → 次ジェスチャで再 warm-up。warm-up 失敗時も次ジェスチャで再試行する
    - sampleRate: `ctx.sampleRate` には干渉しない（正常値は OS / 出力デバイス任せでデバイスごとに異なり、特定値で弾くと無音化するため。稀な変動による歪みは best-effort として受容）
    - 非対応環境（`AudioContext`/`webkitAudioContext` 不在）は何もせず劣化する。アンマウントで AudioContext を破棄しリスナを解除する
    - 解錠状態・Audio_Session を SSOT・永続へ書き戻さない（セッション内ローカルに保持）
    - _Requirements: 4.1, 4.2, 4.5, 4.6, 4.7, 7.1, 7.2, 7.3, 7.4, 7.10_

  - [x] 3.4 評価ティックと Cue 発火の配線を実装する
    - `useAudioCues` に `tickMs`（既定 1000・≤1000 を保つ）ごとの評価ティックを追加し、毎ティックで `now` を採取し `assignedSlotDisplays → boiledTimerIds` で boiled 集合、`assignedTimers + advancePreAlert` で Pre_Alert 発火群を純粋導出する（自前状態に昇格させない）
    - Pre_Alert 再生: 解錠済みなら `fire` の各 timerId に Pre_Alert_Cue を 1 回鳴らす
    - Done_Cue 5 秒周期: `dueDoneCue` が true の周期で、冒頭に Audio_Session 状態を確認し suspended/interrupted なら resume を試みた上で Done_Cue を 1 回鳴らし `lastRingAt` を更新する。boiled が空になれば `lastRingAt` を解除する（次の非空化で 1 秒以内に最初の Done）
    - 可視復帰: `visibilitychange`（→visible）で suspended/interrupted なら resume、boiled 残存なら 1000ms 以内に Done_Cue 周期を再開、boiled 空なら鳴らさない（`useWakeLock` と同じ visibilitychange 規律）
    - Touch_Cue 再生口 `playTouchCue` を提供（未解錠・running 以外・再生失敗は no-op、直前未完了でも先頭から再トリガ）
    - 各再生は try/catch で失敗を握り潰し次周期へ繰り越す（視覚正本は不変）
    - `PreAlertWatch`・`lastRingAt` は `useRef` 等で作用ローカルに抱え、SSOT・永続へ書き戻さない
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 2.1, 2.8, 2.9, 3.1, 3.3, 3.4, 3.11, 5.1, 5.2, 5.3, 5.5, 5.6, 7.5, 7.6, 7.8, 7.9_

  - [ ]* 3.5 mock AudioContext / 擬似 visibilitychange のテストヘルパを用意する
    - `tests/client/audioMocks.ts` を新規作成し、`state`/`sampleRate`/`resume`/`close`/`createOscillator`/`createGain`/`createBuffer*` を差し替え可能な mock AudioContext、`visibilitychange` 発火ユーティリティを提供する
    - 生成された Oscillator/Gain ノードの `connect`/`disconnect`/`start`/`onended` を観測できるスパイを持たせる
    - _Requirements: 4.2, 7.4_

  - [ ]* 3.6 解錠ゲート・既定・非対応の example/unit テストを書く
    - `tests/client/useAudioCues.example.test.ts` に実装（mock AudioContext 使用）
    - 未解錠で Pre_Alert/Done が鳴らず解錠後に再生可能（1.2/4.3/4.4）、`AudioContext` 不在で throw せず no-op（4.5）を確認
    - _Requirements: 1.2, 4.3, 4.4, 4.5_

  - [ ]* 3.7 Audio_Session と周期・自己回復の integration テストを書く
    - `tests/client/useAudioCues.integration.test.ts` に実装（mock AudioContext / 擬似 visibilitychange 使用・各 1〜3 例）
    - Audio_Unlock（capture 待受 → warm-up → 無音 `onended` で running → リスナ一括解除・失敗時は次ジェスチャ再試行）(4.1/4.2/4.6)
    - Touch_Cue レイテンシ／再トリガ（即時呼び出し・連続で都度新ノード）(1.1/1.6)
    - 再生終了ノードの後始末（`onended` で disconnect・複数周期で滞留や再 start なし）(3.11)
    - Done_Cue 周期＋自己回復（5 秒周期・冒頭 state 確認 → resume → 再生・1 周期失敗でも次周期リトライ）(3.1/7.5/7.6/3.11)
    - resume 失敗 → close → 再生成 → 次ジェスチャ warm-up (7.2/7.3/7.4)、sampleRate には干渉せず 48000 等のデバイスでも解錠成立 (7.4)
    - 可視復帰（suspended なら resume・boiled 残存で再開・空なら鳴らさない・Wake_Lock 不在でも再評価）(5.1/5.2/5.3/5.9)、ティック間隔 ≤1000ms (2.9/3.3/5.5)
    - _Requirements: 1.1, 1.6, 2.9, 3.1, 3.3, 3.11, 4.1, 4.2, 4.6, 5.1, 5.2, 5.3, 5.5, 5.9, 7.2, 7.3, 7.4, 7.5, 7.6_

- [x] 4. Checkpoint - 端の作用のテストを通す
  - すべてのテストが通ることを確認し、疑問があればユーザーに問い合わせる。

- [x] 5. 既存 UI への配線
  - [x] 5.1 App.tsx で view 購読・フック呼び出しを追加する
    - `src/client/App.tsx` で `useSyncExternalStore(connection.subscribe, connection.getView)` により view を購読する（残り秒を状態化しない・SlotBoard と同じパターン）
    - `useWakeLock()` の隣に `const { playTouchCue } = useAudioCues(view, units)` を同列で呼ぶ
    - `playTouchCue` を `SlotBoard` へ props で渡す
    - _Requirements: 5.8_

  - [x] 5.2 SlotBoard で playTouchCue を Start押下/麺選択/Cancel/Complete/茹で加減変更に相乗りさせる
    - `src/client/components/SlotBoard.tsx` が `playTouchCue` を props で受け取り、`onStart`（Start ボタン押下＝ラジアルを開く）・麺選択確定（RadialMenu の `onSelect` 経由）・`onCancel`・`onComplete`・`onAdjust`（茹で加減変更）の配線に相乗りさせて呼ぶ
    - 指定外操作（設定ポップオーバー開閉など）からは呼ばない。`playTouchCue` は UI 本来の動作を妨げない（best-effort）
    - _Requirements: 1.1, 1.4, 1.5_

  - [x] 5.3 SlotCard へ必要な props を受け渡す
    - `src/client/components/SlotCard.tsx` は表示と操作の口に徹し、音声呼び出しの合成は SlotBoard 側で行う。props 伝播のみ必要なら最小限で受け渡す（カードは音を知らないまま保つ）
    - _Requirements: 1.5_

  - [ ]* 5.4 配線の example テストを書く
    - `tests/client/audioWiring.example.test.ts` に実装。Start押下/麺選択/Cancel/Complete/茹で加減変更が `playTouchCue` を呼び、指定外操作（設定・茹で加減メニュー開閉のみ）が呼ばないことを確認（1.5）。`playTouchCue` 失敗時も UI 操作本体が継続することを確認（1.3）
    - _Requirements: 1.3, 1.5_

- [x] 6. 前面維持の依存を確認する
  - [x]* 6.1 Wake_Lock マウントの example テストを書く
    - `tests/client/audioWakeLock.example.test.ts` に実装。`App` が `useWakeLock()` をマウントしていること（音声信頼性の主戦略の前提）を自動確認する（`useWakeLock` 自体は本 spec で再実装しない）
    - _Requirements: 5.8_

- [x] 7. Final checkpoint - すべてのテストを通す
  - すべてのテストが通ることを確認し、疑問があればユーザーに問い合わせる。

## Notes

- `*` 付きサブタスク（property / example / integration テスト）は任意であり、高速な MVP では省略可。`*` の付かないコア実装タスクは必ず実装する。
- 各タスクは要件・設計の該当箇所を参照する（トレーサビリティ）。property テストは Correctness Properties P1〜P5 を、最低 100 反復・各 1 本・タグコメント付きで検証する。
- テストは `pnpm test`（= `vitest --run`・単発実行）で走らせる。watch は使わない。新規依存（howler 等）は追加しない。
- 変更は `src/client/` に閉じ、`engine` / `domain` / `shell` には触れない（要件1.4 / 7.10）。
- **手動確認（コーディングエージェントの範囲外・実機で別途実施）:** Silent_Switch（マナースイッチ ON で音が鳴らず boiled 表示・カウントダウンが継続・要件7.9）と iOS PWA standalone 起動での初回タップ後の Pre_Alert/Done 鳴動（要件4.x）は、Web から検知不能・実機依存のため自動テストにできない。実機（iPad）での目視確認に委ね、本タスクリストには含めない。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.2", "3.5"] },
    { "id": 1, "tasks": ["1.2", "3.3"] },
    { "id": 2, "tasks": ["1.3", "3.4"] },
    { "id": 3, "tasks": ["1.4", "3.6", "3.7", "5.1", "5.2", "5.3"] },
    { "id": 4, "tasks": ["1.5", "5.4", "6.1"] },
    { "id": 5, "tasks": ["1.6"] },
    { "id": 6, "tasks": ["1.7"] }
  ]
}
```
