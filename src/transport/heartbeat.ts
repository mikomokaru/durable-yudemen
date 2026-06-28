// transport/heartbeat.ts — 到達性検出の心拍フレーム（client と shell が共有する単一の確定値）。
//
// client（Connectivity_Watch）が送る ping 要求文字列と、shell（StoreTimerDO.fetch の
// setWebSocketAutoResponse）が登録する auto-response の request / response は、同一の確定値で
// なければならない。両者が同じ定数をここから取り込むことで二重定義を根絶し、「同じ概念は
// ただ一箇所で定義する」規律を守る（要件1.1）。
//
// これは素の文字列フレームであり、ワイヤ形式（messages.ts の ClientMessage / ServerMessage）には
// 一切手を加えない。型ではなく定数ゆえ、ワイヤ型不変の制約（要件12.2）に抵触しない。

/** auto-response の ping 要求文字列。client が送り、ランタイムがこれに対し pong を直接返す。 */
export const PING_REQUEST = "ping";

/** auto-response の pong 応答文字列。ランタイムが直接返し、webSocketMessage を起動しない。 */
export const PONG_RESPONSE = "pong";
