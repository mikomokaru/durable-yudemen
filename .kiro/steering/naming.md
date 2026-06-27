# 命名規律 — 名は概念境界を表明する

命名は「何を」を構造で語る行為であり、設計判断である。名は実装の飾りではなく、概念の境界線そのものを宣言する。本コードベースの命名は、設計哲学（`design-philosophy.md`）の「真 — コードは真実を語る」「美 — コードは必然である」の直接の帰結として、以下の規律に従う。Kiro はこれをコード・型・コメント・コミット・spec ドキュメントの全てで一貫して守る。

## 凡庸な汎用語を既定で禁止する

次の汎用語は、概念境界を語らず「何を」を曖昧にするため、既定で禁止する。

- 名詞的被せ物: `Manager` / `Handler` / `Service` / `Util` / `Utils` / `Helper` / `Data` / `Info`
- 動詞的被せ物: `process` / `handle` / `manage` / `doX`

これらは「処理する何か」という同語反復にすぎず、概念の輪郭を一切示さない。名にこれらを使いたくなったとき、それは概念がまだ言語化されていない兆候である。立ち止まり、その単位が**本当は何をする概念なのか**を問い直す。

## ドメインの語彙を優先する

技術的・汎用的な被せ物より、ドメインの母語を優先する。本コードベースの語彙（例）:

- `Slot`（スロット / 釜）/ `Unit` / `Timer` / `endTime` / `seq`
- `drain`（一括ドレイン発火）/ `reconcile`（rehydrate 整合）/ `rehydrate` / `hydration`
- `Snapshot` / `Effect` / `Persist` / `Broadcast` / `decide`（唯一の状態遷移）

ドメインの語が既にある概念に、技術的な被せ物（`TimerManager`・`SnapshotService`・`AlarmHandler` 等）をかぶせない。問題がその形を要求したときに、結果としてその名になる。形（パターン名）を先に持ち込まない。

## 公開シンボルの命名は実装前にユーザー確認を要する

次の**公開シンボル**は、概念境界の表明であり設計判断であるため、**実装前にユーザーへ確認する**。

- 型 / インターフェース（`Timer` / `TimerState` / `ActiveTimersSnapshot` …）
- 公開関数（`decide` / `fireDueTimers` / `nextAlarmEffect` …）
- `Effect` の種別（`Persist` / `SetAlarm` / `Broadcast` …）
- 状態フィールド（`timers` / `nextSeq` / `endTime` …）
- メッセージ種別（`ClientMessage` / `ServerMessage` の各 `type`：`start` / `snapshot` / `done` …）

確認の際は、候補名・その名が表明する概念境界・ドメイン語彙との対応を簡潔に示し、ユーザーの判断を仰ぐ。

## 確認を要しないもの

- ローカル変数（`now` / `due` / `remaining` / ループ変数など）
- 自明な名（標準的な慣用に収まり、概念境界の判断を含まないもの）

これらは設計判断を伴わないため、確認なしで進めてよい。ただし上記の禁止汎用語はローカルでも避ける。
