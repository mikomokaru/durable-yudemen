// src/worker-env.d.ts — 生成 Env（wrangler types）への secret 宣言マージ。
//
// 対象は worker が実際に使う 2 つの secret（ADMIN_TOKEN / ORDER_INGRESS_TOKEN）。いずれも Cloudflare の
// secret であり、wrangler.jsonc の vars には置かない（秘密を構成に晒さない）。
// `wrangler types` は .dev.vars を読める環境でのみ secret を生成 Env に含めるため、.dev.vars を持たない CI では
// 生成 Env から ADMIN_TOKEN が欠落する。すると worker.ts が isAdminAuthorized(request, env) で env(=Env) を
// AdminAuthEnv（ADMIN_TOKEN? のみを持つ弱い型）へ渡す箇所が、共通プロパティ皆無の weak type 検出（TS2559）で
// 落ちる（ローカルは .dev.vars 由来で ADMIN_TOKEN を含むため通り、環境差でCIだけ失敗していた）。
// ORDER_INGRESS_TOKEN（Order_Ingress の Bearer トークン・ADMIN_TOKEN とは別の鍵）も同じ経路で同じ事故を起こす
// （isOrderIngressAuthorized(request, env) が OrderIngressAuthEnv へ渡る箇所で TS2559）。ゆえに同じ対処を並べる。
//
// worker が実際に使う secret を生成 Env（global interface）へ宣言マージし、環境差に依らず型を安定させる。
// 生成側は global `interface Env extends __BaseEnv_Env {}` と `namespace Cloudflare { interface Env … }` の
// 二面を持つ（後者は @cloudflare/vitest-pool-workers の `env`（Cloudflare.Env）の型）。worker.fetch(request, env) の
// ように両者を突き合わせる箇所があるため、両方へ同型で宣言マージする。型は生成側 base と同一の string ゆえ、
// .dev.vars 有無（ローカル/CI）のいずれでも矛盾しない。import/export を持たない global .d.ts として書く。
interface Env {
  ADMIN_TOKEN: string;
  ORDER_INGRESS_TOKEN: string;
}

declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN: string;
    ORDER_INGRESS_TOKEN: string;
  }
}
