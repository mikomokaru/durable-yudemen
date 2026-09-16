import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { connectSolver } from "../tuning/cloud-client.mjs";

const wrangler = process.env.CPSAT_WRANGLER;
assert(wrangler, "Set CPSAT_WRANGLER to the Wrangler 4.130.0 executable");
const directory = process.argv[2];
const output = process.argv[3];
assert(directory && output);
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(8793, "127.0.0.1", () => probe.close(resolve));
});
const secret = JSON.parse(
  await readFile("experiments/cpsat-workers/fixtures/local/search-secrets.json", "utf8"),
).SEARCH_AUTH_TOKEN;
assert(/^[a-f0-9]{64}$/.test(secret));
const vars = "experiments/cpsat-workers/search-worker/.dev.vars";
const contents = `SEARCH_AUTH_TOKEN=${secret}\n`;
try {
  await writeFile(vars, contents, { mode: 0o600, flag: "wx" });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  assert((await readFile(vars, "utf8")) === contents, "Local search secret differs");
}
const server = spawn(
  wrangler,
  [
    "dev",
    "--config",
    "experiments/cpsat-workers/search-worker/wrangler.jsonc",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8793",
    "--log-level",
    "error",
    "--show-interactive-dev-session=false",
  ],
  { detached: true, stdio: ["ignore", "ignore", "pipe"] },
);
server.stderr.on("data", () => {});
try {
  let connected = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(server.exitCode === null, "Local Worker exited early");
    try {
      await connectSolver({ local: true });
      connected = true;
      break;
    } catch {
      await delay(200);
    }
  }
  assert(connected, "Local Worker did not become ready");
  const test = spawn(
    "node",
    [
      "experiments/cpsat-workers/tuning/check-cloud.mjs",
      directory,
      output,
      "--local",
      ...process.argv.slice(4),
    ],
    { stdio: "inherit" },
  );
  await new Promise((resolve, reject) => {
    test.once("error", reject);
    test.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Local check exit ${code}`)),
    );
  });
} finally {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-server.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH")
        console.error("Could not stop the owned local Worker process group");
    }
    if (signal === "SIGTERM") await delay(500);
  }
}
