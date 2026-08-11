import { parseArgs } from "node:util";
import { createToken } from "../src/auth.js";
import { closeDb, db, type TokenScope } from "../src/db.js";

const { values } = parseArgs({
  options: {
    name: { type: "string", short: "n" },
    scopes: { type: "string", short: "s", default: "upload" },
  },
});

if (!values.name) {
  console.error("Usage: pnpm token --name <client-name> [--scopes upload,admin]");
  process.exitCode = 1;
} else {
  const scopes = values.scopes?.split(",").map((scope) => scope.trim()) as TokenScope[];
  try {
    db();
    const created = createToken(values.name, scopes);
    console.log(`Token ID: ${created.id}`);
    console.log(`Token: ${created.token}`);
    console.log("Store this value now; Mumpitz does not persist the plaintext token.");
  } finally {
    closeDb();
  }
}
