import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { doctor, formatDoctorReport } from "../dist/doctor.js";

const token = `sfa_${"d".repeat(43)}`;
const exec = promisify(execFile);
const allowed = { allowed: true, reason: null };
const denied = (reason) => ({ allowed: false, reason });
const response = (interactive = false) => ({
  version: 1,
  authenticated: true,
  capabilities: {
    staticHtml: interactive ? denied("upload_scope_required") : allowed,
    interactiveHtml: interactive ? allowed : denied("interactive_scope_required"),
    fileUploads: interactive ? denied("upload_scope_required") : allowed,
    guides: interactive ? denied("upload_scope_required") : allowed,
  },
});

test("doctor validates the token through a bounded GET and reports permissions", async () => {
  const report = await doctor({
    token,
    interactive: true,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://schaffa.dev/api/capabilities");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.body, undefined);
      return Response.json(response(true));
    },
  });
  assert.equal(report.ready, true);
  assert.deepEqual(report.token, { found: true, source: "--token", status: "valid" });
  assert.match(formatDoctorReport(report), /Interactive HTML: allowed/);
  assert.ok(!JSON.stringify(report).includes(token));
  const upload = await doctor({
    token,
    interactive: true,
    fetch: async () => Response.json(response()),
  });
  assert.equal(upload.ready, false);
  assert.equal(upload.token.status, "valid");
  assert.match(formatDoctorReport(upload), /Use an Interactive token/);
});

test("doctor distinguishes rejection, unsupported servers, and failed checks without leaking responses", async () => {
  for (const [status, error, tokenStatus] of [
    [401, "invalid_token", "invalid"],
    [404, "unsupported_server", "unverified"],
    [403, "server_error", "unverified"],
    [500, "server_error", "unverified"],
  ]) {
    const report = await doctor({ token, fetch: async () => new Response(token, { status }) });
    assert.equal(report.error, error);
    assert.equal(report.token.status, tokenStatus);
    assert.equal(report.ready, false);
    assert.equal(report.capabilities, null);
    assert.ok(!JSON.stringify(report).includes(token));
  }
  for (const data of [
    {},
    { ...response(), authenticated: false },
    { ...response(), capabilities: { ...response().capabilities, interactiveHtml: denied(token) } },
  ]) {
    const report = await doctor({ token, fetch: async () => Response.json(data) });
    assert.equal(report.error, "invalid_response");
    assert.equal(report.token.status, "unverified");
    assert.ok(!JSON.stringify(report).includes(token));
  }
  const report = await doctor({
    token,
    fetch: async () => {
      throw new Error(token);
    },
  });
  assert.equal(report.error, "check_failed");
  assert.ok(!JSON.stringify(report).includes(token));
  const extra = await doctor({
    token,
    fetch: async () =>
      Response.json({
        ...response(),
        secret: token,
        capabilities: { ...response().capabilities, staticHtml: { ...allowed, secret: token } },
      }),
  });
  assert.equal(extra.ready, true);
  assert.ok(!JSON.stringify(extra).includes(token));
});

test("doctor rejects malformed tokens and unsafe server origins before making a request", async () => {
  const fetch = async () => {
    throw new Error("unexpected request");
  };
  assert.equal((await doctor({ token: "bad", fetch })).error, "invalid_token");
  assert.equal((await doctor({ token: `${token}\nprivate`, fetch })).error, "token_lookup_failed");
  assert.equal((await doctor({ token, "ignore-token": true, fetch })).error, "token_lookup_failed");
  for (const baseUrl of [
    "invalid",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?secret=value",
  ]) {
    const report = await doctor({ token, baseUrl, fetch });
    assert.equal(report.error, "invalid_server");
    assert.equal(report.server, null);
  }
});

test("CLI doctor uses real token lookup, JSON, text, exit codes, and anonymous checks", {}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-doctor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home");
  await mkdir(home);
  const tokenFile = path.join(directory, ".env.local");
  await writeFile(tokenFile, `SCHAFFA_TOKEN=${token}\n`);
  let body = response();
  let status = 200;
  const requests = [];
  const server = createServer((request, reply) => {
    requests.push({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization,
    });
    reply.writeHead(status, { "content-type": "application/json" });
    reply.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    SCHAFFA_URL: `http://127.0.0.1:${server.address().port}`,
  };
  const run = async (args = [], extraEnv = {}) => {
    try {
      return {
        ...(await exec(process.execPath, [path.resolve("dist/cli.js"), "doctor", ...args], {
          cwd: directory,
          env: { ...env, ...extraEnv },
        })),
        code: 0,
      };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return error;
    }
  };
  let result = await run(["--json"]);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).token.source, await realpath(tokenFile));
  result = await run(["--interactive", "--json"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).token.status, "valid");
  body = response(true);
  result = await run(["--interactive"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Interactive HTML: allowed/);
  assert.ok(!result.stdout.includes(token));
  result = await run(["--json"], { SCHAFFA_TOKEN: token });
  assert.equal(JSON.parse(result.stdout).token.source, "SCHAFFA_TOKEN");
  status = 401;
  result = await run(["--json"]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).token.status, "invalid");
  status = 200;
  body = {
    version: 1,
    authenticated: false,
    capabilities: {
      staticHtml: allowed,
      interactiveHtml: denied("token_required"),
      fileUploads: denied("token_required"),
      guides: denied("token_required"),
    },
  };
  result = await run(["--ignore-token", "--json"], { SCHAFFA_TOKEN: token });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).token.status, "missing");
  assert.equal(requests.at(-1).auth, undefined);
  await rm(tokenFile);
  result = await run(["--json"]);
  assert.equal(JSON.parse(result.stdout).capabilities.staticHtml.allowed, true);
  assert.equal(JSON.parse(result.stdout).token.found, false);
  assert.ok(
    requests.every((request) => request.method === "GET" && request.url === "/api/capabilities"),
  );
  await writeFile(tokenFile, `SCHAFFA_TOKEN=${token}\n`);
  const requestCount = requests.length;
  const redirectServer = createServer((_request, reply) => {
    reply.writeHead(302, { location: env.SCHAFFA_URL });
    reply.end();
  });
  await new Promise((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => redirectServer.close(resolve)));
  result = await run(["--json"], {
    SCHAFFA_URL: `http://127.0.0.1:${redirectServer.address().port}`,
  });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).token.status, "unverified");
  assert.equal(requests.length, requestCount);
});
