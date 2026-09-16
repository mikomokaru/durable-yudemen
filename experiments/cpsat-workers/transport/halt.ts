// The stop version for both trial Workers.
//
// Deployed over `yude-men-cpsat-transport-shim-dev` or
// `yude-men-cpsat-planner-dev` to close the trial. Neither Worker has an
// earlier version to roll back to, so this is what "off" means for them.
//
// It carries no bindings, no Wasm, no fixtures and no manifest. A Worker that
// cannot reach a solver, a store or the TS planner cannot solve, forward or
// call back, whatever request arrives — the refusal does not depend on this
// file's own logic being right.
//
// 503 rather than 404: the endpoint exists and is deliberately unavailable.
// Nothing here distinguishes methods or paths, because nothing should get a
// different answer.
export default {
  fetch(): Response {
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler;
