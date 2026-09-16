import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { connectSolver } from "./cloud-client.mjs";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  const solver = await connectSolver({ versionId: process.argv[2] });
  send(solver.ready);
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const request = JSON.parse(line);
    if (request.kind === "stop") break;
    assert.equal(request.kind, "solve");
    send(await solver.solve(request.model, request.protoBase64));
  }
} catch (error) {
  send({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
