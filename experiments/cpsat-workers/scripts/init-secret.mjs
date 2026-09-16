import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../.dev.vars", import.meta.url));
try {
  await writeFile(path, `POC_AUTH_TOKEN=${randomBytes(32).toString("hex")}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Created private local credential file: ${path}`);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const existing = await readFile(path, "utf8");
  if (!/^POC_AUTH_TOKEN=[a-f0-9]{64}$/m.test(existing)) {
    throw new Error("Existing .dev.vars has no valid PoC token; refusing to overwrite");
  }
  console.log("Existing PoC credential retained (value not displayed)");
}
