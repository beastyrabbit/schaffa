import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { installClamGateFixture } from "./clamgate-fixture.js";

test("the production Shoo verifier validates offline signed claims against loopback JWKS", {}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-shoo-test-"));
  const restoreScanner = await installClamGateFixture(directory);
  t.after(async () => {
    restoreScanner();
    await rm(directory, { recursive: true, force: true });
  });
  const keys = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "ES256", use: "sig" };
  const server = createServer((_request, reply) => {
    reply.setHeader("content-type", "application/json");
    reply.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.SHOO_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SHOO_ISSUER = process.env.SHOO_BASE_URL;
  process.env.SCHAFFA_BASE_URL = "https://fixture.example";
  const { verifyShooToken } = await import("../src/shoo-auth.js");
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: process.env.SHOO_BASE_URL,
    aud: "origin:https://fixture.example",
    iat: now,
    exp: now + 60,
    pairwise_sub: "fixture-user",
  };
  const sign = (payload: Record<string, unknown>) =>
    new SignJWT(payload).setProtectedHeader({ alg: "ES256", kid: "fixture" }).sign(keys.privateKey);
  assert.equal((await verifyShooToken(await sign(claims))).subject, "fixture-user");
  for (const change of [
    { exp: undefined },
    { exp: now - 1 },
    { iat: undefined },
    { aud: "origin:https://other.example" },
    { iss: "https://other.example" },
    { pairwise_sub: "" },
    { pairwise_sub: " " },
  ]) {
    await assert.rejects(verifyShooToken(await sign({ ...claims, ...change })));
  }
  const other = await generateKeyPair("ES256");
  await assert.rejects(
    verifyShooToken(
      await new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: "fixture" })
        .sign(other.privateKey),
    ),
  );
});
