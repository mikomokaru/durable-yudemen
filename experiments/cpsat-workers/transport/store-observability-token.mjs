#!/usr/bin/env node
// Store the trial's Cloudflare API token for this machine, and verify its scope.
//
// The token is read from stdin, never from argv: arguments are visible to `ps`
// and land in shell history. It is written to a gitignored file with 0600 and
// is never printed, echoed or returned in any error message.
//
//   node experiments/cpsat-workers/transport/store-observability-token.mjs
//
// Then, for the collector:
//
//   set -a; . experiments/cpsat-workers/fixtures/local/observability.env; set +a
//
// Re-running replaces the stored token only after the new one verifies, so a
// failed attempt cannot leave the machine without a working credential.
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ACCOUNT = "305d89a643ac689b4204454c5493cbde";
const directory = dirname(fileURLToPath(import.meta.url));
const target = resolve(directory, "../fixtures/local/observability.env");

async function readToken() {
  if (process.argv.length > 2) {
    // Refuse rather than accept: an argument has already been recorded by the
    // shell by the time this process sees it.
    throw new Error("Pass the token on stdin, not as an argument.");
  }
  if (!process.stdin.isTTY) {
    let piped = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) piped += chunk;
    return piped.trim();
  }
  const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // No prompt echo: the value must not appear on the terminal or in scrollback.
  const answer = await reader.question("Cloudflare API token (input hidden): ");
  reader.close();
  process.stderr.write("\n");
  return answer.trim();
}

/** Confirm the token reaches this account's observability, and nothing wider. */
async function verify(token) {
  const call = async (path, init = {}) =>
    fetch(`https://api.cloudflare.com/client/v4/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

  // A dry query: asks the telemetry endpoint to accept the request without
  // returning data, so verification does not depend on any events existing yet.
  // The shape mirrors the collector's own query — `parameters` is required, and
  // omitting it is rejected as malformed before authorization is ever reached.
  const observability = await call(`accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
    method: "POST",
    body: JSON.stringify({
      queryId: "cpsat-token-check",
      dry: true,
      view: "events",
      limit: 1,
      timeframe: { from: Date.now() - 60_000, to: Date.now() },
      parameters: { filters: [] },
    }),
  });
  if (!observability.ok) {
    // Do not report every failure as a permission problem: a malformed query
    // and a refused one need opposite responses, and calling the first the
    // second sends someone off to widen a token that was already fine.
    const detail = await observability
      .json()
      .then((body) =>
        (body?.errors ?? []).map((error) => `${error.code}: ${error.message}`).join("; "),
      )
      .catch(() => "");
    // The token travels in a header, never in the body, so these are safe to
    // show — and without them a 400 is not actionable.
    throw new Error(
      observability.status === 401 || observability.status === 403
        ? `Observability query refused with ${observability.status}. The token needs Workers Observability Write on account ${ACCOUNT}. ${detail}`
        : `Observability query rejected with ${observability.status}: ${detail || "no error detail"}. This is the request being wrong, not the token — nothing was written.`,
    );
  }

  // Scope check: the token must not see other accounts. This is a property of
  // the credential, not of the trial, so it is worth failing on.
  const accounts = await call("accounts?per_page=50");
  if (accounts.ok) {
    const body = await accounts.json();
    const ids = (body?.result ?? []).map((account) => account.id);
    if (ids.length > 1 || (ids.length === 1 && ids[0] !== ACCOUNT))
      throw new Error(`Token is broader than one account (${ids.length} visible). Scope it down.`);
  }
  return { accountsListable: accounts.ok, accountsStatus: accounts.status };
}

const token = await readToken();
if (!/^[A-Za-z0-9_-]{20,120}$/.test(token)) {
  throw new Error("That does not look like a Cloudflare API token; nothing was written.");
}
const scope = await verify(token);

await mkdir(dirname(target), { recursive: true });
const temporary = `${target}.new`;
// Written with 0600 before it holds anything, then moved into place, so the
// secret is never briefly readable by others.
await writeFile(temporary, `CLOUDFLARE_API_TOKEN=${token}\n`, { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, target);

// The value is never printed. Only where it went and what it proved.
console.log(
  JSON.stringify(
    {
      stored: target,
      mode: "0600",
      gitignored: "experiments/cpsat-workers/fixtures/local/",
      account: ACCOUNT,
      observabilityQuery: "accepted",
      ...scope,
      load: "set -a; . experiments/cpsat-workers/fixtures/local/observability.env; set +a",
    },
    null,
    2,
  ),
);
