// tests/client/decideView.property.test.ts — offline-degradation の Property 1 / 2 / 7 / 10（タスク 2.2 / 2.5 / 2.9 / 15.2）。
//
// 検証対象は client の純粋層 `mode` と `decideView` のみ。時刻・受信時刻・生成 id はすべてイベントが引数として
// 運ぶため、`Date.now()` のスタブも `vi.useFakeTimers()` もここには現れない（要件4.3 / 13.4）。純粋層テストで
// 実時計のモックが要るなら、それは時刻が暗黙時計へ漏れている兆候であって、境界の引き方を疑うサインである。
//
// 純粋性そのもの（`Date` / `crypto` / `WebSocket` / `document` / `window` / `setInterval` / `setTimeout` /
// `localStorage` を参照しないこと）は `tests/offline-degradation.static.test.ts` がソース検査で主張済み。
// ここでは再実装せず、残余である**決定性**を扱う（同じ判断を二箇所で定義しない）。
//
// 生成器は `tests/client/generators.ts` の公開分をそのまま使う。受信時刻だけは公開されていないため本ファイル内
// にローカルで置く。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMPTY_VIEW,
  decideView,
  mode,
  type ClientEvent,
  type ClientView,
  type Mode,
  type UnreachableReason,
} from "../../src/client/connection";
import { clockOffset } from "../../src/client/clock";
import { genClientView, genEvent, genEventStream, genServerMessage, genUnreachableReason } from "./generators";

const NUM_RUNS = 200;

/** 受信時刻のエポックミリ秒（`genServerMessage` の serverTime と同じ域から引き、offset が正負両方になる組を踏む）。 */
const genReceivedAt: fc.Arbitrary<number> = fc.integer({ min: 0, max: 10_000_000 });

/** `Server` 以外の全イベント種別。Property 7 の凍結側を網羅したことを試行から確かめるための照合先。 */
const FROZEN_KINDS: readonly ClientEvent["kind"][] = [
  "Reconcile",
  "LocalStart",
  "LocalCancel",
  "LocalComplete",
  "Connectivity",
  "Classify",
  "LocalDone",
  "Tick",
];

/**
 * ビューを比較可能な形へ正規化する。`processedIds`（集合）と `lastResults`（写像）は順序を意味に含まないので
 * 整列した配列・エントリ列へ写す。
 *
 * 参照同一に依らない比較にするため。`Tick` は参照同一のビューを返すが他の分岐は新しいオブジェクトを返し、
 * 集合・写像も新しいインスタンスになる。内容の差を確実に見るには、比較の土台を素の構造へ落としておく。
 */
function canonical(view: ClientView) {
  return {
    ...view,
    processedIds: [...view.processedIds].sort(),
    lastResults: [...view.lastResults.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/** ビューにイベント列を順に畳み込む（決定性の主張は同一列に対する二度の畳み込みを比べる）。 */
function fold(view: ClientView, events: readonly ClientEvent[]): ClientView {
  return events.reduce((acc, event) => decideView(acc, event), view);
}

/** ビューと、そのビューに対して意味のある入力空間から引いたイベントの組。 */
const genViewAndEvent: fc.Arbitrary<{ view: ClientView; event: ClientEvent }> = genClientView.chain((view) =>
  genEvent(view).map((event) => ({ view, event })),
);

describe("client/connection 純粋層 — offline-degradation Property 1 / 2 / 7 / 10", () => {
  // Feature: offline-degradation, Property 1: Mode は Connectivity から全域的・決定的に導出される
  // 任意の ClientView について、mode(view) は view.connectivity === "up" のとき必ず "live"、"down" のとき必ず
  // "degraded" を返し（全域的）、同一ビューに対し常に同一の Mode を返す（決定的）。ClientView は mode を独立
  // フィールドとして持たず、Mode は参照のたびに Connectivity からのみ導出される。
  // **Validates: Requirements 3.1, 3.2, 3.3**
  it("Property 1: Mode は Connectivity から全域的・決定的に導出される", () => {
    // Mode を状態に昇格させていないこと。フィールドが無ければ二つの真実の源は生まれ得ない（要件3.3）。
    expect(Object.keys(EMPTY_VIEW)).not.toContain("mode");

    const observedModes = new Set<Mode>();
    fc.assert(
      fc.property(genClientView, (view) => {
        const derived = mode(view);
        observedModes.add(derived);
        // 決定性 — 同一ビューに対し常に同一。
        expect(mode(view)).toBe(derived);
        // 全域性 — Connectivity だけが Mode を決め、他の一切のフィールドは結果に影響しない。
        expect(mode({ ...view, connectivity: "up" })).toBe("live");
        expect(mode({ ...view, connectivity: "down" })).toBe("degraded");
      }),
      { numRuns: NUM_RUNS },
    );
    // 二値の両方を実際に踏んだこと。片側だけの観測では「常に live」の実装でも緑になる。
    expect([...observedModes].sort()).toEqual(["degraded", "live"]);
  });

  // Feature: offline-degradation, Property 2: Client_Decide は決定的かつ純粋（時刻を引数に取り暗黙時計に漏れない）
  // 任意の ClientView と任意のタグ付きイベントについて、decideView(view, event) を二度評価すると結果ビューは
  // 完全に等しい。したがって任意のイベント列を畳み込んだ後のビューも、同じ列に対して常に同一である。
  // **Validates: Requirements 4.1, 4.2, 4.3**
  it("Property 2: decideView は決定的（二度評価の一致・列畳み込みの一致）", () => {
    const observedKinds = new Set<ClientEvent["kind"]>();

    fc.assert(
      fc.property(genViewAndEvent, ({ view, event }) => {
        observedKinds.add(event.kind);
        expect(canonical(decideView(view, event))).toEqual(canonical(decideView(view, event)));
      }),
      { numRuns: NUM_RUNS },
    );

    fc.assert(
      fc.property(
        genClientView.chain((view) => genEventStream(view).map((events) => ({ view, events }))),
        ({ view, events }) => {
          for (const event of events) observedKinds.add(event.kind);
          expect(canonical(fold(view, events))).toEqual(canonical(fold(view, events)));
        },
      ),
      { numRuns: NUM_RUNS },
    );

    // Tick と Classify の分岐は本テスト以前に一度も実行されていない。決定性の主張がそれらを実際に通ったことを
    // 確かめる（9 系統すべての出現は tests/client/generators.smoke.test.ts が見張っている）。
    expect(observedKinds.has("Tick")).toBe(true);
    expect(observedKinds.has("Classify")).toBe(true);
  });

  // Feature: offline-degradation, Property 7: クロックオフセットを更新するのは `Server` 受信だけで、他のすべての
  // イベントは凍結する
  // 任意の ClientView と、Server 以外のすべての ClientEvent（Reconcile / LocalStart / LocalCancel /
  // LocalComplete / Connectivity / Classify / LocalDone / Tick）について、decideView の結果ビューの offset は
  // 元ビューの offset と等しい。offset を書き換える分岐は Server ただ一つで、そこでは
  // clockOffset(message.serverTime, receivedAt) により再確立される。Reconcile は全量スナップショットを運ぶが
  // serverTime を運ばないため offset を変えない。
  // **Validates: Requirements 5.2**
  it("Property 7: offset を更新するのは Server 受信だけで、他のすべてのイベントは凍結する", () => {
    const observedFrozenKinds = new Set<ClientEvent["kind"]>();
    fc.assert(
      fc.property(
        genClientView.chain((view) =>
          genEvent(view)
            .filter((event): event is Exclude<ClientEvent, { kind: "Server" }> => event.kind !== "Server")
            .map((event) => ({ view, event })),
        ),
        ({ view, event }) => {
          observedFrozenKinds.add(event.kind);
          expect(decideView(view, event).offset).toBe(view.offset);
        },
      ),
      { numRuns: NUM_RUNS },
    );

    // 対の主張 — 凍結側だけを見ると「offset を誰も触らない」実装でも緑になる。書き換える唯一の分岐が実際に
    // 書き換えることを、同じ property の中で押さえる。期待値は既存の clockOffset に委ね、式を書き直さない。
    let observedUpdate = false;
    fc.assert(
      fc.property(genClientView, genServerMessage, genReceivedAt, (view, message, receivedAt) => {
        const result = decideView(view, { kind: "Server", message, receivedAt });
        expect(result.offset).toBe(clockOffset(message.serverTime, receivedAt));
        if (result.offset !== view.offset) observedUpdate = true;
      }),
      { numRuns: NUM_RUNS },
    );
    expect(observedUpdate).toBe(true);

    // 凍結側 8 種すべてを実際に踏んだこと。踏み損ねた種類が在れば落ちる（空虚な緑を作らない）。
    expect([...observedFrozenKinds].sort()).toEqual([...FROZEN_KINDS].sort());
  });

  // Feature: offline-degradation, Property 10: Classify は到達不能理由だけを畳み、up の Connectivity はそれを
  // offline へ戻す
  // 任意の ClientView と任意の UnreachableReason について、decideView(view, { kind: "Classify", reason }) の
  // 結果ビューは unreachableReason === reason を満たし、かつ他の全フィールドは元ビューと同一である。さらに、
  // 任意の ClientView について decideView(view, { kind: "Connectivity", status: "up" }) の結果ビューは
  // unreachableReason === "offline" を満たす（down 時にのみ意味を持つ規律を構造で担保）。
  // **Validates: Requirements 15.7, 15.8, 15.12**
  it("Property 10: Classify は到達不能理由だけを畳み、up の Connectivity はそれを offline へ戻す", () => {
    const observedViewReasons = new Set<UnreachableReason>();
    let observedReasonChange = false;

    fc.assert(
      fc.property(genClientView, genUnreachableReason, (view, reason) => {
        observedViewReasons.add(view.unreachableReason);
        if (view.unreachableReason !== reason) observedReasonChange = true;

        const classified = decideView(view, { kind: "Classify", reason });
        expect(classified.unreachableReason).toBe(reason);
        // 他フィールドの不変は「元ビューの reason だけを差し替えたもの」との丸ごと比較で主張する。個別の
        // フィールド列挙にしないのは、ClientView が育ったときに取り残される主張を作らないため。
        expect(canonical(classified)).toEqual(canonical({ ...view, unreachableReason: reason }));

        // up 復帰は到達不能理由を既定へ戻す（要件15.12）。
        expect(decideView(view, { kind: "Connectivity", status: "up" }).unreachableReason).toBe("offline");
        // down では変えない。up 側だけの主張では「常に offline へ潰す」実装でも緑になる。
        expect(decideView(view, { kind: "Connectivity", status: "down" }).unreachableReason).toBe(
          view.unreachableReason,
        );
      }),
      { numRuns: NUM_RUNS },
    );

    // 3 値すべてを起点として踏んだこと。offline のみを起点にしていたら up 復帰の主張は空虚になる。
    expect([...observedViewReasons].sort()).toEqual(["noAccess", "offline", "signInRequired"]);
    // Classify が実際に値を変える試行が在ったこと（恒等な畳み込みだけを見ていない）。
    expect(observedReasonChange).toBe(true);
  });
});
