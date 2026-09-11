import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareEngine, verifiedEngine } from "../scripts/opengrep/engine.ts";

// biome-ignore lint/style/noDoneCallback: t is node:test's TestContext, not a completion callback.
test("untrusted cached engine is never accepted; failed downloads have a bounded retry count", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "opengrep-download-test-"));
  const path = join(root, "opengrep");
  writeFileSync(path, "invalid cached binary");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    // First a transport failure, then a successful HTTP response with corrupt bytes.
    if (requests === 1) throw new Error("network unavailable");
    return new Response("corrupt download", { status: 200 });
  });
  try {
    assert.equal(verifiedEngine(path), false);
    await assert.rejects(prepareEngine(path), /three attempts/);
    assert.equal(requests, 3);
    assert.equal(readFileSync(path, "utf8"), "invalid cached binary");
    assert.equal(verifiedEngine(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
