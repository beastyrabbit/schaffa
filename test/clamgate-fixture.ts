import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CompactSign } from "jose";

export const scannerState: { mode: "ok" | "infected" | "unavailable" | "error" | "stall" } = {
  mode: "ok",
};
const stalledScans = new Set<() => void>();

export function releaseStalledScans(): void {
  for (const release of stalledScans) release();
  stalledScans.clear();
}

export async function waitForStalledScanner(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (stalledScans.size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Scanner request did not reach the stalled fixture.");
}

export async function installClamGateFixture(directory: string): Promise<() => void> {
  const pair = generateKeyPairSync("ed25519");
  const keyFile = path.join(directory, "clamgate-public.pem");
  await writeFile(keyFile, pair.publicKey.export({ type: "spki", format: "pem" }));
  const origin = "https://clamgate.fixture.test";
  process.env.CLAMGATE_BASE_URL = origin;
  process.env.CLAMGATE_PUBLIC_KEY_FILE = keyFile;
  process.env.CLAMGATE_PUBLIC_KEY_ID = "fixture";
  process.env.CLAMGATE_APPLICATION_TOKEN = "";
  process.env.CLAMGATE_TIMEOUT_MS = "5000";
  const jobs = new Map<
    string,
    { sha256: string; size: number; nonce: string; accessKey: string }
  >();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) return originalFetch(input, init);
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    if (init?.method === "POST") {
      if (scannerState.mode === "unavailable") return new Response(null, { status: 503 });
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        size += chunk.length;
      }
      const id = randomUUID();
      const accessKey = randomBytes(32).toString("base64url");
      const nonce = headers.get("X-Scan-Nonce") || "";
      assert.match(nonce, /^[A-Za-z0-9_-]{22,128}$/);
      jobs.set(id, { sha256: hash.digest("hex"), size, nonce, accessKey });
      return Response.json({ id, accessKey }, { status: 202 });
    }
    const id = url.pathname.split("/").at(-1) || "";
    const job = jobs.get(id);
    assert.ok(job);
    assert.equal(headers.get("Authorization"), `Bearer ${job.accessKey}`);
    if (init?.method === "DELETE") {
      jobs.delete(id);
      return Response.json({ accepted: true });
    }
    if (scannerState.mode === "stall") {
      await new Promise<void>((resolve, reject) => {
        const release = () => {
          init?.signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          stalledScans.delete(release);
          reject(new Error("Fixture scan cancelled"));
        };
        stalledScans.add(release);
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) abort();
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const outcome =
      scannerState.mode === "infected"
        ? "infected"
        : scannerState.mode === "error"
          ? "rejected"
          : "clean";
    const result = await new CompactSign(
      Buffer.from(
        JSON.stringify({
          iss: "urn:clamgate:virus",
          jobId: id,
          nonce: job.nonce,
          sha256: job.sha256,
          size: job.size,
          outcome,
          iat: now,
          exp: now + 3600,
          policy: "clamgate-v1",
          engine: "fixture",
          signatureVersion: "fixture",
          signatureDate: new Date().toISOString(),
        }),
      ),
    )
      .setProtectedHeader({ alg: "EdDSA", typ: "clamgate-result+jws", kid: "fixture" })
      .sign(pair.privateKey);
    return Response.json({ id, state: outcome, result });
  };
  return () => {
    globalThis.fetch = originalFetch;
    releaseStalledScans();
  };
}
