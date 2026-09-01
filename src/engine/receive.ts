// engine/receive.ts — 取り込み経路が受けた 1 店舗分の受領を、ただ 1 つの状態遷移へ畳む純粋変換。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// **order.ts へ置かない。** あちらの冒頭が語る同居の理由は「どちらも Timer に触れず Pending_Order 集合だけを
// 動かす、集合操作の上に一枚被せるだけの薄さ」であり、かつ「拒否経路を持たない」ことがその規律である。
// 受領は集合と重複判定の材料（lastSequenceByTerminal）の 2 つを同時に動かし、状態を見て読み飛ばす分岐を
// 持つ。同居させれば order.ts の冒頭が嘘になる。遷移ごとに 1 ファイル（start / cancel / complete / adjust /
// fire / order / plan）という既存の形にそのまま乗る（plan.ts が同じ判断でここに並んでいる）。
//
// **settle を通すのは最後の 1 回だけである。** ループの中で settle を呼べば `Persist` が受領件数だけ生じ、
// 1 受領につき単一の `put`（pos-order-ingress AC 5.5 / 6.8）と単一遷移（Property 20）がいずれも破れる。
// ゆえに集合と判定材料を先に畳み切り、確定はただ一度に閉じる。
//
// **翻訳はここに無い。** 麺の仕様の解釈には StoreConfig が要り、engine は StoreConfig を知らない
// （AC 6.13）。ここへ届くのは翻訳済みの ReceivedOrder だけで、engine が見るのは「どの注文に、どの品目群が
// 対応し、どの端末のどの sequence_number まで進んだか」の 3 つである。

import type { TimerState } from "./state";
import { isNewerSequence } from "./state";
import type { Event } from "./event";
import type { Outcome } from "./effect";
import { removeOrder, upsertOrder } from "./pending";
import { settle } from "./settle";
import type { SettleParams } from "./settle";
import { isNonEmpty } from "../domain/timer";

/** RecordsReceived イベントの本体。arriveRecords はこの形だけを受け取る（event.ts の唯一の出所を再利用）。 */
type RecordsReceivedEvent = Extract<Event, { type: "RecordsReceived" }>;

/**
 * 受領の状態遷移（AC 5.5 / 6.8 / 6.10〜6.13 / 10.1 / 10.2）。到着順に畳み、単一の `Persist` で確定する。
 *
 * **重複の判定を engine の内側で行う**（AC 6.10）。判定材料が engine 状態に属し、状態を見て決めるのが
 * engine の役目である。shell が判定すれば状態の読み出しが 2 箇所に生じる。新旧の判定は `isNewerSequence`
 * ただ一つを通す——桁数を揃えた文字列比較の規則が二箇所に分かれれば、繰り上がりの瞬間に片方だけが誤る。
 *
 * 判定材料は**畳んだ途中の値**と突き合わせる。同一受領に同一端末の複数 Record が含まれるとき、材料は到着順に
 * 進む（最後の seq が残る）——遷移前の値と比べれば、同じ受領の中の後着がすべて「新しい」と見えてしまう。
 *
 * 集合の動かし方は 3 通り（AC 6.7 / 6.11 / 6.12）。品目が非空なら `upsertOrder` で置換、空かつ既存ありなら
 * `removeOrder` で除去、空かつ既存なしなら集合を変えない。いずれの場合も判定材料は進む——進めなければ
 * 同じ注文が再送のたびに翻訳をやり直される。
 *
 * `mayRequestPlan` は真——受領は計画の入力が変わる契機そのものである（`arriveOrder` と同じ扱い）。
 */
export function arriveRecords(
  state: TimerState,
  args: RecordsReceivedEvent,
  params: SettleParams,
): Outcome {
  // 判定材料の写しは 1 つだけ作り、その中で畳む。ループの中で写し直せば受領件数だけオブジェクトが生まれる。
  // 局所の可変で純粋性は損なわれない——この写しはここから外へ出るまで誰も触れない。
  const lastSequenceByTerminal: Record<string, string> = { ...state.lastSequenceByTerminal };
  let pendingOrders = state.pendingOrders;

  for (const received of args.received) {
    if (!isNewerSequence(received.sequenceNumber, lastSequenceByTerminal[received.terminalId]))
      continue;
    lastSequenceByTerminal[received.terminalId] = received.sequenceNumber;
    // 生きた Timer の集合を渡すのは `arriveOrder` と同じ理由——開始済み品目が後着の置換で待ち行列へ
    // 復活すれば二重調理になる（意味論の正本は pending.ts の upsertOrder）。
    //
    // 非空の側で `externalOrderId` を渡さないのは、置換の鍵を二箇所に書かないためである。`upsertOrder` は
    // 到着に現れた externalOrderId の群を置換する規則を既に持っており、ここで先に除いてから足せば
    // 「何が置換されるか」の規則が engine の 2 箇所に生まれる。受領単位の externalOrderId が要るのは、
    // 品目が 1 つも無く群から鍵を引けない除去の側だけである。
    pendingOrders = isNonEmpty(received.items)
      ? upsertOrder(pendingOrders, state.timers, received.items)
      : removeOrder(pendingOrders, received.externalOrderId);
  }

  // 判定材料と集合を同じ `moved` に載せ、同一の `Persist` で確定させる（Property 14）。別の書き込みにすれば
  // 「判定材料だけ進んで注文が無い」欠落が生じ、その注文は再送でも重複として弾かれて永久に失われる。
  return settle(state, { ...state, pendingOrders, lastSequenceByTerminal }, params, args.now, true);
}
