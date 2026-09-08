// engine/timer.ts — 不正状態を構築不能にする Timer 型と smart constructor。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import type { EpochMillis, SlotId, NoodleType, TimerId } from "./types";
import type { TimerFact, NonEmptyArray } from "../domain/timer";
import type { Firmness } from "../domain/firmness";

/**
 * Sequenced — engine だけが持つ登録順の事実（ワイヤには出ない）。
 *
 * seq は同一 endTime のときのタイブレークに用いる全順序の根拠（要件3.2）。engine の
 * earliestEndTime / byEndTimeThenSeq だけが読み、shell もクライアントも参照しない。
 * engine 専用の基底ゆえ定義も engine に置く（共有契約 domain には置かない・audience に従う）。
 */
export interface Sequenced {
  /** 登録順。同一 endTime のタイブレーク（要件3.2 / 2系）。 */
  readonly seq: number;
}

/**
 * Boilable — engine だけが持つ「発火を記録した事実」（ワイヤには出ない）。
 *
 * boiledAt は Alarm 発火で running → boiled へ遷移した時刻。null は走行中（running）を表す。
 * boiled な Timer は除去されず、ユーザーの明示完了（Complete）まで残る。Alarm の張り直しは
 * running（boiledAt === null）の最早だけを対象にし、過去時刻 Alarm の無限再発火を構造的に断つ。
 * クライアントは boiled を endTime ≤ now から導出するため、この事実はワイヤに乗せず engine 内部に閉じる
 * （timer-model.md: 片側専用の関心事は共有契約 domain に混ぜない）。
 */
export interface Boilable {
  /** 発火時刻。null は running（未発火）。非 null は boiled（明示完了待ち）。 */
  readonly boiledAt: EpochMillis | null;
}

/**
 * Adjusted — engine だけが持つ「同期のための符号付き調整」（ワイヤには出ない）。
 *
 * adjustment はオリジナル endTime に対するミリ秒オフセット（初期値 0・負=早める / 正=遅らせる）。
 * 近接した複数の茹で上がりを共通時刻へそろえる Boil_Sync（synchronize）が、この値を全体置換で書き込む。
 * 実効茹で上がり時刻 Adjusted_Boil_Time = endTime + adjustment は射影（project.ts）でのみ現れ、
 * オリジナル endTime（不変アンカー）自体は書き換えない。|adjustment| ≤ h_i を synchronize が保証する。
 * seq / boiledAt と同じく engine 専用の関心事ゆえ domain には置かない（共有契約 TimerFact を god type にしない）。
 */
export interface Adjusted {
  /** オリジナル endTime に対する符号付きミリ秒オフセット。初期値 0。 */
  readonly adjustment: number;
}

/**
 * Ordered — 「どの注文品目から始まったか」の事実。参照の鍵は共有契約（`TimerFact.orderItem`）に出し、卓は engine 専用。
 *
 * orderItem は POS 由来の注文品目への参照（externalOrderId と、その注文内の itemIndex）と、その品目が
 * 由来する卓（tableId・卓を持たない品目は null）。null はアドホック麺茹で＝POS を経ない開始。
 * 生成時に一度書いて不変、Timer が消えれば関係も消える（order-lifecycle 判断 2）。
 * 用途は二つ。(1) 品目の状態の導出——自分を指す生きた Timer（running / boiled）が在る品目は cooking であり
 * （`itemStatusOf`）、開始の照合・後着の置換・計画対象から自然に外れて二重調理を防ぐ（要件1.8・order-lifecycle 判断 1）。
 * 釜側（カード・番号）は `orderItemOf(timer, items)` で品目を引く（判断 9）。
 * (2) 卓の同定——同じ卓の走行中 Timer を計画の群の成員に留め、群の 1 本目を入れた後も残りが 1 本目へ揃う
 * （lift-group-planning・ADR-0003）。
 * tableId を Timer の直下ではなく orderItem の内側に置くのは、(orderItem = null, tableId 非 null) という
 * 「POS を経ないのに卓を知る Timer」を型として構築不能にするためである。
 * 後着で品目の卓が移っても走行中 Timer の tableId は追随しない（order-lifecycle 判断 7）——その Timer は既に旧卓の
 * 群として茹でている事実であり（`OrderItem` は最新の注文情報、`Timer` は調理を開始した時点の情報）、カードは参照先の
 * 品目から新しい卓を、計画の `tableMembers` はここに残る旧卓を読む。
 * tableId は共有契約 domain には出さない（timer-model.md: 片側専用の関心事は共有契約に混ぜない。混ぜれば TimerFact が
 * god type に転じる）。
 */
export interface Ordered {
  /** 由来する注文品目への参照と卓。null はアドホック麺茹で（POS を経ない開始）。 */
  readonly orderItem: {
    readonly externalOrderId: string;
    readonly itemIndex: number;
    /** 由来する卓。null は卓を持たない品目。 */
    readonly tableId: string | null;
  } | null;
}

/**
 * Timer — アクティブな茹でタイマー一件。事実の芯（ブランド化）＋ engine 専用の連番・発火事実・調整・注文紐づけ。
 *
 * 共有契約の芯 TimerFact（domain/timer.ts）をブランド型で具体化し、engine 専用の Sequenced /
 * Boilable / Adjusted / Ordered を多重継承で合成する。endTime を持たない Timer や slotId を持たない Timer は型として
 * 存在しえない（ブランド型と smart constructor が担保）。
 * 残り秒は状態として持たない。保持するのは絶対終了時刻 endTime という「事実」だけ。
 *
 * `orderItem` は共有契約の参照（鍵）を engine 専用の卓で具体化する（Ordered）。TimerFact の側の `orderItem` を
 * `Omit` で外して Ordered の形に差し替える——engine の Timer は wire の参照より広い（tableId を持つ）ので、
 * wire へは `toWireTimer` が鍵だけを写す。
 */
export interface Timer
  extends
    Omit<TimerFact<TimerId, SlotId, NoodleType, EpochMillis>, "orderItem">,
    Sequenced,
    Boilable,
    Adjusted,
    Ordered {}

/**
 * Timer を構築できる唯一の経路。検証に通った入力（ブランド型）からのみ Timer が生まれる。
 *
 * 入力はすべてブランド型なので、ここに到達する時点で各値は検証済みであることが型で保証される。
 * 構築の一点に生成を集約し、構築後は常に正当であることを型が担保する。
 * boiledAt は省略時 null（走行中で生まれる）。発火時に fireDueTimers が非 null へ写す。
 * adjustment は省略時 0（未調整で生まれる）。synchronize が全体置換で書き換える。
 * orderItem は省略時 null（アドホック麺茹でで生まれる）。注文由来の開始のみ非 null を渡す。
 */
export function createTimer(input: {
  id: TimerId;
  slotIds: NonEmptyArray<SlotId>;
  noodleType: NoodleType;
  firmness: Firmness;
  startTime: EpochMillis;
  endTime: EpochMillis;
  seq: number;
  boiledAt?: EpochMillis | null;
  adjustment?: number;
  orderItem?: Ordered["orderItem"];
}): Timer {
  return {
    id: input.id,
    slotIds: input.slotIds,
    noodleType: input.noodleType,
    firmness: input.firmness,
    startTime: input.startTime,
    endTime: input.endTime,
    seq: input.seq,
    boiledAt: input.boiledAt ?? null,
    adjustment: input.adjustment ?? 0,
    orderItem: input.orderItem ?? null,
  };
}
