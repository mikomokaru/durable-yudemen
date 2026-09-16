import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
// Only a new file is permitted. Never prints the secret or changes an existing one.
const path = "experiments/cpsat-workers/fixtures/local/search-secrets.json";
await writeFile(
  path,
  JSON.stringify({ SEARCH_AUTH_TOKEN: randomBytes(32).toString("hex") }) + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log("Created private search credential; value not displayed");
