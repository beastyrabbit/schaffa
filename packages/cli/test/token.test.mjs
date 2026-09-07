import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveToken } from "../dist/token.js";

const exec = promisify(execFile);
const fixtureToken = `sfa_${"t".repeat(43)}`;

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-token-test-"));
  test.after(() => rm(directory, { recursive: true, force: true }));
  const context = {
    cwd: path.join(directory, "project"),
    home: path.join(directory, "home"),
    environment: { XDG_CONFIG_HOME: path.join(directory, "config") },
  };
  await mkdir(context.cwd);
  const put = async (file, content) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  return { context, put };
}

test("discovers common token files in documented precedence order", async () => {
  const { context, put } = await setup();
  const candidates = [
    [path.join(context.cwd, ".env.local"), `export SCHAFFA_TOKEN='${fixtureToken}' # local\n`],
    [path.join(context.cwd, ".env"), `OTHER=value\r\nSCHAFFA_TOKEN="${fixtureToken}"\r\n`],
    ...[
      path.join(context.cwd, ".schaffa"),
      path.join(context.environment.XDG_CONFIG_HOME, "schaffa"),
      path.join(context.home, ".schaffa"),
    ].flatMap((directory) => [
      [path.join(directory, "token"), ` ${fixtureToken}\n`],
      [path.join(directory, "config.json"), JSON.stringify({ token: fixtureToken })],
      [path.join(directory, ".env"), `SCHAFFA_TOKEN=${fixtureToken}\n`],
    ]),
  ];
  for (const [index, [file, content]] of [...candidates.entries()].reverse()) {
    await put(file, content.replaceAll(fixtureToken, `${fixtureToken}${index}`));
  }
  for (const [index, [file]] of candidates.entries()) {
    assert.equal(resolveToken({}, context), `${fixtureToken}${index}`);
    await rm(file);
  }
  assert.equal(resolveToken({}, context), undefined);
});

test("supports default config location, JSON environment key, and empty fallback", async () => {
  const { context, put } = await setup();
  context.environment = {};
  await put(path.join(context.cwd, ".env.local"), "SCHAFFA_TOKEN=\n");
  await put(path.join(context.cwd, ".env"), "UNRELATED=value\n");
  await put(
    path.join(context.home, ".config/schaffa/config.json"),
    JSON.stringify({ SCHAFFA_TOKEN: fixtureToken }),
  );
  assert.equal(resolveToken({}, context), fixtureToken);
});

test("explicit and environment tokens take precedence; ignore skips even broken files", async () => {
  const { context, put } = await setup();
  await put(path.join(context.cwd, ".schaffa/config.json"), "{private invalid content");
  context.environment.SCHAFFA_TOKEN = fixtureToken;
  assert.equal(resolveToken({ token: "explicit" }, context), "explicit");
  assert.equal(resolveToken({}, context), fixtureToken);
  assert.equal(resolveToken({ "ignore-token": true }, context), undefined);
  assert.throws(
    () => resolveToken({ token: "explicit", "ignore-token": true }, context),
    /cannot be used together/,
  );
  delete context.environment.SCHAFFA_TOKEN;
  assert.throws(
    () => resolveToken({}, context),
    (error) => {
      assert.match(error.message, /Invalid JSON/);
      assert.doesNotMatch(error.message, /private invalid content/);
      return true;
    },
  );
});

test("CLI sends discovered tokens and omits authorization with --ignore-token", async () => {
  const { context, put } = await setup();
  await put(path.join(context.cwd, ".env"), `SCHAFFA_TOKEN=${fixtureToken}\n`);
  await put(path.join(context.cwd, "page.html"), "<h1>Token lookup test</h1>");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    request.resume();
    response.writeHead(201, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ publicUrl: "http://localhost/p/test", slug: "test", editRevision: 1 }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    PATH: process.env.PATH,
    HOME: context.home,
    USERPROFILE: context.home,
    XDG_CONFIG_HOME: context.environment.XDG_CONFIG_HOME,
    SCHAFFA_URL: `http://127.0.0.1:${server.address().port}`,
  };
  const run = (args, extraEnv = {}) =>
    exec(process.execPath, [path.resolve("dist/cli.js"), ...args], {
      cwd: context.cwd,
      env: { ...env, ...extraEnv },
    });
  const authenticated = await run(["upload", "page.html"]);
  assert.equal(authenticated.stdout.trim(), "http://localhost/p/test");
  const anonymous = await run(["upload", "page.html", "--ignore-token"], {
    SCHAFFA_TOKEN: fixtureToken,
  });
  assert.equal(anonymous.stdout.trim(), "http://localhost/p/test");
  await run(["guide", "start", "--title", "Test guide"]);
  assert.deepEqual(requests, [
    { url: "/api/pages", authorization: `Bearer ${fixtureToken}` },
    { url: "/api/pages", authorization: undefined },
    { url: "/api/guides", authorization: `Bearer ${fixtureToken}` },
  ]);
  for (const args of [
    ["publish", "deck.md", "--kind", "presentation"],
    ["record", "--title", "Test", "--browser", "https://example.com"],
    ["guide", "record", "--title", "Test", "--url", "https://example.com"],
    ["guide", "start", "--title", "Test"],
    ["upload", "page.html", "--interactive"],
  ]) {
    await assert.rejects(run([...args, "--ignore-token"]), /SCHAFFA_TOKEN is required/);
  }
  assert.equal(requests.length, 3);
  assert.doesNotMatch(
    authenticated.stdout + authenticated.stderr + anonymous.stdout + anonymous.stderr,
    new RegExp(fixtureToken),
  );
});

test("malformed discovered tokens fail without exposing credentials in stderr", async () => {
  const { context, put } = await setup();
  const malformed = `${fixtureToken}\ncomment`;
  const candidates = [
    [path.join(context.cwd, ".schaffa/token"), malformed],
    [path.join(context.cwd, ".schaffa/config.json"), JSON.stringify({ token: malformed })],
    [path.join(context.cwd, ".env"), `SCHAFFA_TOKEN="${malformed}"\n`],
  ];
  for (const [file, content] of candidates) {
    await put(file, content);
    await assert.rejects(
      exec(process.execPath, [path.resolve("dist/cli.js"), "guide", "start", "--title", "Test"], {
        cwd: context.cwd,
        env: { PATH: process.env.PATH, HOME: context.home, USERPROFILE: context.home },
      }),
      (error) => {
        assert.match(error.stderr, /SCHAFFA_TOKEN must contain only printable ASCII/);
        assert.ok(!error.stderr.includes(fixtureToken));
        return true;
      },
    );
    await rm(file);
  }
  for (const token of [malformed, `${fixtureToken}\u0000`, `${fixtureToken}é`]) {
    assert.throws(() => resolveToken({ token }, context), /printable ASCII/);
    assert.throws(
      () => resolveToken({}, { ...context, environment: { SCHAFFA_TOKEN: token } }),
      /printable ASCII/,
    );
  }
});
