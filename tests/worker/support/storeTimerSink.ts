// tests/worker/support/storeTimerSink.ts — 店舗 DO への転送を横取りして観測するテストハーネス。
//
// Worker が `/s/{storeId}/*` の経路で店舗 DO へ「何を渡したか」「そもそも渡したか」を確かめるテストは
// 複数の関心事にまたがる（クライアント由来 identity ヘッダの除去・不正 Upgrade の非到達）。観測の形は
// どちらも同一——転送先 namespace を差し替えて受信 Request を記録する——ゆえに、ここ 1 箇所に置いて
// テストごとに作り直さない。
//
// **DO 本体は起こさない。** 関心は Worker の転送そのものであり、DO 内部の挙動（Roster 判定・WS 収容）は
// 別のテストが担う。

/**
 * ForwardSink — Worker が店舗 DO へ転送した Request の記録先。
 *
 * `forwarded` が `null` のままであることが「DO へ引き渡していない」の観測そのものである。応答ステータス
 * だけでは到達の有無を語れない——拒否のステータスは DO 側からも返せるため、非到達は転送先で観測する。
 */
export interface ForwardSink {
  forwarded: Request | null;
}

/** 何も転送されていない状態の sink。 */
export function emptyForwardSink(): ForwardSink {
  return { forwarded: null };
}

/**
 * capturingStoreNamespace — 転送先 DO を横取りし、Worker が転送した Request を記録する namespace。
 *
 * Worker は `idFromName(storeId)` → `get(id, {locationHint})` → `stub.fetch(forwardedRequest)` の順で
 * 委譲する。ここでは DO 内部挙動を起こさず、受け取った Request を捕捉して 200 を返す。101（WS 昇格）は
 * webSocket 無しでは workerd で構成できないため、「転送された＝DO に到達した」ことを示す 200 で足りる。
 */
export function capturingStoreNamespace(sink: ForwardSink): Env["STORE_TIMER_DO"] {
  const stub = {
    fetch(request: Request): Response {
      sink.forwarded = request;
      return new Response("reached", { status: 200 });
    },
  };
  return {
    idFromName: (_name: string) => ({}) as DurableObjectId,
    get: (_id: DurableObjectId) => stub,
  } as unknown as Env["STORE_TIMER_DO"];
}
