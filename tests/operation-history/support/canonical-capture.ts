// Producer が console へ渡した payload を canonical 一行へ戻す（テスト用）。
//
// 2026-09-16 に Producer は文字列ではなく**オブジェクト**を渡すようになった。搬送と会計を確かめる
// 検査の関心は「どの一行が運ばれたか」であって console の受け渡しの姿ではないので、ここで一度だけ
// 戻す。**`operationRecordPayload` は canonical と同じ並びで組む**ので、これは canonical 一行に等しい。
//
// 名乗りと検査そのものを確かめる検査は、戻さずにオブジェクトのまま Tail へ渡す
// （`tests/operation-history/tail.example.test.ts`）。

/** `console.log` の呼び出し記録から canonical 一行の列を作る。 */
export function canonicalLinesOf(calls: readonly (readonly unknown[])[]): string[] {
  return calls.map(([payload]) =>
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
}
