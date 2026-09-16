#!/usr/bin/env node
// 1108 を人が操作している間の行を、取りこぼさずに貯める（2026-09-13）。
//
//   node collect-1108-session.mjs OUT.jsonl [--minutes 90] [--store yamaokaya-1108]
//
// **live で見ない理由。** Workers Logs には取り込みの遅れがあり、1 応答は 1000 行で頭打ちで
// cursor を返さない（時間で刻むしかない）。見ている瞬間に操作が重なる保証も無いので、
// 重なりを持たせて定期的に引き、鍵で重複を落として貯める。
//
// 貯めるのは 3 種。採否（`cpsat.plan-decided`）・求解（`cpsat-plan-computed`）・失敗
// （`cpsat-plan-failed`）。**走行中の本数は求解の行にしか無い**ので、人が押したかどうかは
// そこから読む。
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [output, ...flags] = process.argv.slice(2);
if (!output)
  throw new Error("Usage: collect-1108-session.mjs OUT.jsonl [--minutes N] [--store ID]");
const flag = (name, fallback) => {
  const index = flags.indexOf(`--${name}`);
  return index < 0 ? fallback : flags[index + 1];
};
const MINUTES = Number(flag("minutes", 90));
const STORE = String(flag("store", "yamaokaya-1108"));
const ACCOUNT = "305d89a643ac689b4204454c5493cbde";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) throw new Error("CLOUDFLARE_API_TOKEN が要る");

const KINDS = new Set(["cpsat.plan-decided", "cpsat-plan-computed", "cpsat-plan-failed"]);
const SERVICES = ["yude-men-timer", "yude-men-cpsat-planner-dev"];
/** 重複の鍵。同じ行を何度引いても 1 度しか書かない。 */
const seen = new Set();
try {
  for (const line of (await readFile(resolve(output), "utf8")).split("\n"))
    if (line.trim()) seen.add(JSON.parse(line).key);
} catch {
  /* 初回は無い */
}

async function query(service, from, to) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        queryId: "session",
        view: "events",
        limit: 1000,
        timeframe: { from, to },
        parameters: {
          filters: [
            { key: "$metadata.service", operation: "eq", type: "string", value: service },
            { key: "$metadata.type", operation: "eq", type: "string", value: "cf-worker" },
          ],
        },
      }),
    },
  );
  if (!response.ok) return { rows: [], capped: false, error: response.status };
  const body = await response.json();
  const events = body?.result?.events?.events ?? [];
  return { rows: events, capped: events.length >= 1000, error: null };
}

const started = Date.now();
let polls = 0;
let written = 0;
let capped = 0;
// **重なりを持たせて引く。** 取り込みの遅れで、直前の窓に後から行が現れる。
const OVERLAP_MS = 5 * 60_000;
const INTERVAL_MS = 60_000;

while (Date.now() - started < MINUTES * 60_000) {
  const to = Date.now();
  const from = to - OVERLAP_MS;
  const batch = [];
  for (const service of SERVICES) {
    // oxlint-disable-next-line no-await-in-loop
    const { rows, capped: hit, error } = await query(service, from, to);
    if (error !== null) continue;
    if (hit) capped += 1;
    for (const event of rows) {
      const source = event.source;
      if (!source || !KINDS.has(source.kind)) continue;
      // 求解の行は storeId を持つ。採否の行も持つ。どちらも対象店舗だけ残す。
      if (source.storeId !== STORE) continue;
      const key = `${source.kind}|${source.requestId ?? ""}|${event.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      batch.push(JSON.stringify({ key, at: event.timestamp, ...source }));
    }
  }
  if (batch.length > 0) {
    // oxlint-disable-next-line no-await-in-loop
    await appendFile(resolve(output), `${batch.join("\n")}\n`);
    written += batch.length;
  }
  polls += 1;
  process.stdout.write(`poll ${polls}: +${batch.length}（累計 ${written}）\n`);
  // oxlint-disable-next-line no-await-in-loop
  await new Promise((done) => setTimeout(done, INTERVAL_MS));
}
console.log(`終了：${polls} 回・${written} 行・窓が 1000 行に達した回 ${capped}`);
