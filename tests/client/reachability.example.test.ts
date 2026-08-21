// tests/client/reachability.example.test.ts — 作用の端 probeReachability の example テスト（V-2・タスク4）。
//
// _Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 5.4_
//
// V-1（reachability.property.test.ts）が分類の全域を踏むのに対し、ここが踏むのは**観測の構築**である
// ——fetch の結果が ProbeObservation へ正しく写るか。分類表はここで再検証しない（同じ判断を二箇所に
// 置かない）。ゆえに主張は 2 種類に絞る。
//
//   (1) **観測の構築規則**（design 判断 1）が守られていること。とくに **403 に parse を掛けない**。
//       全応答に response.json() を試みて失敗を "failed" へ畳む形が、切り出しで最も起きやすい誤りで、
//       それをやると Worker の 403（JSON 本文を持たないことがある）が "offline" へ退行する（要件2.1）。
//   (2) **fetch の与え方**が分類の成立条件を満たしていること。叩く先が `/entry/stores` に固定され
//       （要件1.4）、`redirect: "manual"`（要件1.2）と `cache: "no-store"`（要件5.4）が渡ること。
//       URL とこれらの指定は作用の端の性質であり、classifyReachability は一切知らない。
//
// fetch はグローバルを差し替えて注入する（`vi.stubGlobal("fetch", …)`。tests/worker/access-jwt.integration
// .test.ts と同じ作法）。**probeReachability のシグネチャに注入口を足さない**——注入のためだけの引数は
// Sync_Mediator（唯一の呼び出し元）が決して渡さない引数であり、公開面に嘘の自由度を生む。
//
// Opaque_Redirect は Response のコンストラクタで作れない（`type` は読み取り専用で "opaqueredirect" を
// 与える手段がない）。ゆえに観測に要る面（`type` / `status` / `json`）だけを持つ最小の代役を渡す。端が
// 実際に読む面はこの 3 つだけであり、それ以上を模す必要がない。

import { afterEach, describe, expect, it, vi } from "vitest";
import { probeReachability } from "../../src/client/connectivity";

const STORE_ID = "yamaokaya-1263";

/** 分類 fetch が叩く唯一の経路（要件1.4）。 */
const STORES_PATH = "/entry/stores";

/** 端が読む面だけを持つ応答の代役（`type` / `status` / `json`）。 */
interface ProbeReply {
  readonly type: string;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

/** fetch の呼び出し記録。第 2 引数は端が与えた指定をそのまま検査するため未加工で持つ。 */
interface FetchCall {
  readonly input: unknown;
  readonly init: Record<string, unknown> | undefined;
}

/**
 * グローバル fetch を差し替え、呼び出し記録を返す。
 *
 * reply が throw すれば fetch 自体の throw（ネットワークエラー）を模す——観測の "failed" 枝はこの経路
 * だけから生まれる。
 */
function stubFetch(reply: () => ProbeReply): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: Record<string, unknown>) => {
    calls.push({ input, init });
    // 端は Response の全面ではなく `type` / `status` / `json` のみを読む（上のコメント参照）。
    return Promise.resolve(reply() as unknown as Response);
  });
  return calls;
}

/** JSON 本文を返す応答。 */
function jsonReply(status: number, value: unknown): ProbeReply {
  return { type: "default", status, json: () => Promise.resolve(value) };
}

/** 本文が JSON でない応答（`json()` が reject する）。Worker の 403 / エラーページがこの形になる。 */
function nonJsonReply(status: number, onRead: () => void = () => {}): ProbeReply {
  return {
    type: "default",
    status,
    json: () => {
      onRead();
      return Promise.reject(new SyntaxError("Unexpected token < in JSON"));
    },
  };
}

const STORE_LIST = [
  { storeId: STORE_ID, name: "Yamaokaya 1263" },
  { storeId: "other-1", name: "Other" },
];

describe("client/connectivity — V-2: probeReachability の観測の構築", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Opaque_Redirect（Access の 302）→ signInRequired（要件1.1 / 1.3）", async () => {
    // `redirect: "manual"` の下では 3xx はこの形で返る。status は 0、Location は読めない。
    stubFetch(() => ({
      type: "opaqueredirect",
      status: 0,
      json: () => Promise.reject(new TypeError("body is unusable")),
    }));

    await expect(probeReachability(STORE_ID)).resolves.toBe("signInRequired");
  });

  it("403 ＋ 非 JSON 本文 → signInRequired。**本文の読み取りを試みない**（要件2.1）", async () => {
    // 構築規則の固定。403 に parse を掛ければ読み取り失敗に巻き取られ "offline" へ退行する。
    let bodyRead = 0;
    stubFetch(() =>
      nonJsonReply(403, () => {
        bodyRead += 1;
      }),
    );

    await expect(probeReachability(STORE_ID)).resolves.toBe("signInRequired");
    expect(bodyRead, "403 に response.json() を掛けてはならない").toBe(0);
  });

  it("200 かつ店舗リストに storeId 在 → offline（要件2.3）", async () => {
    stubFetch(() => jsonReply(200, STORE_LIST));

    await expect(probeReachability(STORE_ID)).resolves.toBe("offline");
  });

  it("200 かつ店舗リストに storeId 不在 → noAccess（要件2.4）", async () => {
    stubFetch(() => jsonReply(200, [STORE_LIST[1]]));

    await expect(probeReachability(STORE_ID)).resolves.toBe("noAccess");
  });

  it("200 だが本文の読み取りが失敗 → offline。**failed へ畳まず noAccess へも落ちない**", async () => {
    // 読み取り失敗は `{ parsed: false }` に留まる（構築規則 3）。空配列と同一視しないため noAccess にならない。
    stubFetch(() => nonJsonReply(200));

    await expect(probeReachability(STORE_ID)).resolves.toBe("offline");
  });

  it("200 だが本文が配列でない → offline（店舗リストではないため分類不能・要件3.3）", async () => {
    stubFetch(() => jsonReply(200, { stores: [STORE_ID] }));

    await expect(probeReachability(STORE_ID)).resolves.toBe("offline");
  });

  it("404 → offline（分類不能。本文の読み取りも試みない）", async () => {
    let bodyRead = 0;
    stubFetch(() =>
      nonJsonReply(404, () => {
        bodyRead += 1;
      }),
    );

    await expect(probeReachability(STORE_ID)).resolves.toBe("offline");
    expect(bodyRead, "200 以外に response.json() を掛けてはならない").toBe(0);
  });

  it("fetch 自体の throw（ネットワークエラー）→ offline", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Load failed")));

    await expect(probeReachability(STORE_ID)).resolves.toBe("offline");
  });

  it("叩く先は /entry/stores のみ。redirect: manual と cache: no-store を渡す（要件1.2 / 1.4 / 5.4）", async () => {
    const calls = stubFetch(() => jsonReply(200, STORE_LIST));

    await probeReachability(STORE_ID);

    // 分類のために追加のエンドポイントを新設しない（要件1.4）。1 回だけ、この 1 本を叩く。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(STORES_PATH);

    const init = calls[0]?.init;
    // リダイレクトを追跡させない。追えば CORS で潰れ 302 という事実が失われる（要件1.2）。
    expect(init?.redirect).toBe("manual");
    // ブラウザの HTTP キャッシュは SW の戦略とは別の層。塞ぐ層は 2 つある（要件5.4）。
    expect(init?.cache).toBe("no-store");
    expect(init?.headers).toEqual({ Accept: "application/json" });
  });
});
