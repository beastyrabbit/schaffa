import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { smokeDeploy } from "../scripts/ci-smoke-deploy.mjs";

const landing = '<!doctype html><header><a class="wordmark" href="/">Schaffa</a></header>';

function capabilities(serverVersion) {
  return {
    version: 1,
    ...(serverVersion === undefined ? {} : { serverVersion }),
    authenticated: false,
    capabilities: { staticHtml: { allowed: true, reason: null } },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// Serves each queued capabilities response once, then keeps the last one so the
// final endpoint check sees the deployed release. The landing page is fixed.
function site(capabilityResponses, { landingResponse = () => new Response(landing) } = {}) {
  const requests = [];
  const logs = [];
  let clock = 0;
  let last;
  const run = (options = {}) =>
    smokeDeploy({
      baseUrl: "https://schaffa.example",
      expectedVersion: "0.16.0",
      fetch: async (url, init) => {
        assert.equal(init.redirect, "manual");
        const { pathname } = new URL(url);
        requests.push(pathname);
        if (pathname === "/") return landingResponse();
        last = capabilityResponses.shift() || last;
        if (!last) throw new Error("unexpected request");
        return last();
      },
      timeoutMs: 60_000,
      intervalMs: 15_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: (line) => logs.push(line),
      ...options,
    });
  return { run, requests, logs };
}

test("an old release is polled until the expected release is live and healthy", async () => {
  const { run, requests, logs } = site([
    () => json(capabilities()),
    () => json(capabilities("0.15.0")),
    () => json({ message: "Bad gateway" }, 502),
    () => {
      throw new TypeError("fetch failed");
    },
    () => json(capabilities("0.16.0")),
  ]);
  await run();
  assert.deepEqual(requests, Array(5).fill("/api/capabilities").concat(["/", "/api/capabilities"]));
  assert.match(logs[0], /without serverVersion/);
  assert.match(logs[1], /now 0\.15\.0/);
  assert.match(logs[2], /HTTP 502/);
  assert.match(logs[3], /fetch failed/);
  assert.match(logs.at(-1), /0\.16\.0 is live and healthy/);
});

test("a newer release is reported as superseded, not as success", async () => {
  for (const newer of ["0.16.1", "0.17.0", "1.0.0"]) {
    await assert.rejects(site([() => json(capabilities(newer))]).run(), /superseded.*runs/);
  }
  // A prerelease of the expected version is older, not newer.
  const { run } = site([
    () => json(capabilities("0.16.0-rc.1")),
    () => json(capabilities("0.16.0")),
  ]);
  await run();
});

test("version comparison accepts build metadata and preserves large core numbers", async () => {
  await site([
    () => json(capabilities("0.15.0+build.1")),
    () => json(capabilities("0.16.0")),
  ]).run();
  await assert.rejects(
    site([() => json(capabilities("9007199254740993.0.0"))]).run({
      expectedVersion: "9007199254740992.0.0",
    }),
    /superseded/,
  );
});

test("malformed 200 responses fail immediately", async () => {
  for (const [response, expected] of [
    [() => new Response("<html>login</html>"), /non-JSON/],
    [() => json({ ok: true }), /unexpected body/],
    [() => json(capabilities("latest")), /malformed serverVersion "latest"/],
    [() => json(capabilities(16)), /malformed serverVersion 16/],
    ...["00.16.0", "0.16.0-rc..1", "0.16.0-01", "0.16.0\n"].map((version) => [
      () => json(capabilities(version)),
      /malformed serverVersion/,
    ]),
  ]) {
    const { run, requests } = site([response]);
    await assert.rejects(run(), expected);
    assert.equal(requests.length, 1);
  }
});

test("a deployment that never reaches the expected release times out loudly", async () => {
  const { run, requests } = site([() => json(capabilities("0.15.0"))]);
  await assert.rejects(run(), /Timed out .*0\.16\.0 .*last seen: 0\.15\.0/);
  assert.equal(requests.length, 5);
  const unreachable = site([() => json({}, 503)]);
  await assert.rejects(unreachable.run(), /Timed out .*last seen: HTTP 503/);
});

test("the expected release still fails when its public endpoints are unhealthy", async () => {
  const live = () => json(capabilities("0.16.0"));
  await assert.rejects(
    site([live], { landingResponse: () => new Response("down", { status: 500 }) }).run(),
    /Landing page returned HTTP 500/,
  );
  await assert.rejects(
    site([live], { landingResponse: () => new Response(null, { status: 302 }) }).run(),
    /Landing page returned HTTP 302/,
  );
  await assert.rejects(
    site([live], { landingResponse: () => new Response("<html>Pangolin</html>") }).run(),
    /missing the Schaffa wordmark/,
  );
  await assert.rejects(
    site([live, () => json(capabilities("0.16.0"), 500)]).run(),
    /Capabilities returned HTTP 500/,
  );
  await assert.rejects(
    site([live, () => json({ ...capabilities("0.16.0"), authenticated: true })]).run(),
    /unexpected body/,
  );
});

test("only stable release tags can be smoke tested", async () => {
  for (const expectedVersion of ["0.16.0-rc.1", "latest", "00.16.0"]) {
    await assert.rejects(site([]).run({ expectedVersion }), /not a stable release version/);
  }
  const script = fileURLToPath(new URL("../scripts/ci-smoke-deploy.mjs", import.meta.url));
  await assert.rejects(
    promisify(execFile)(process.execPath, [script], {
      env: { PATH: process.env.PATH, SMOKE_BASE_URL: "http://127.0.0.1:9" },
    }),
    /RELEASE_REF_NAME must be a v\* release tag/,
  );
});

test("version parsing rejects empty prerelease and build identifiers", async () => {
  for (const version of [
    "0.16.0-",
    "0.16.0-.rc",
    "0.16.0-rc.",
    "0.16.0+",
    "0.16.0+.build",
    "0.16.0+build.",
    "0.16.0+build..1",
    "0.16.0-rc.1+build..1",
  ]) {
    const { run, requests } = site([() => json(capabilities(version))]);
    await assert.rejects(run(), /malformed serverVersion/);
    assert.equal(requests.length, 1);
    await assert.rejects(
      site([]).run({ expectedVersion: version }),
      /not a stable release version/,
    );
  }
});

test("version parsing accepts zero and alphanumeric prereleases and numeric build identifiers", async () => {
  const version = "0.16.0+01.build-1";
  const { run } = site([
    () => json(capabilities("0.16.0-0")),
    () => json(capabilities("0.16.0-01a")),
    () => json(capabilities("0.16.0-rc-1.0+01.build")),
    () => json(capabilities(version)),
  ]);
  await run({ expectedVersion: version });
});
