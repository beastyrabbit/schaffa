import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseCliArgs } from "../dist/cli.js";
import { upload } from "../dist/client.js";

const token = `sfa_${"a".repeat(43)}`;
const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-cli-test-"));
const execFileAsync = promisify(execFile);

test.after(async () => rm(directory, { recursive: true, force: true }));

test("uploads HTML pages to the default Schaffa origin", async () => {
  const filePath = path.join(directory, "plan.html");
  await writeFile(filePath, "<h1>Plan</h1>");
  const requests = [];
  const result = await upload({
    filePath,
    token,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ publicUrl: "https://schaffa.dev/p/abc234def567", version: 1 }, 201);
    },
  });

  assert.equal(result.publicUrl, "https://schaffa.dev/p/abc234def567");
  assert.equal(requests[0].url, "https://schaffa.dev/api/pages");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].init.body.get("html").name, "plan.html");
});

test("uploads a new HTML page anonymously without an authorization header", async () => {
  const filePath = path.join(directory, "anonymous.html");
  await writeFile(filePath, "<h1>Temporary plan</h1>");
  const requests = [];
  await upload({
    filePath,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ publicUrl: "https://schaffa.dev/p/temp234abcde" }, 201);
    },
  });

  assert.equal(requests[0].url, "https://schaffa.dev/api/pages");
  assert.equal(requests[0].init.headers, undefined);
});

test("requires a token for files and page updates", async () => {
  const filePath = path.join(directory, "private.png");
  const htmlPath = path.join(directory, "update-without-token.html");
  await writeFile(filePath, Buffer.from([1, 2, 3]));
  await writeFile(htmlPath, "<h1>Update</h1>");

  await assert.rejects(upload({ filePath }), /SCHAFFA_TOKEN is required to upload files/);
  await assert.rejects(
    upload({ filePath: htmlPath, slug: "abc234def567" }),
    /SCHAFFA_TOKEN is required to update/,
  );
});

test("accepts a command-line token and gives it precedence over the environment", () => {
  const commandToken = `sfa_${"b".repeat(43)}`;
  const options = parseCliArgs(
    ["upload", "plan.html", "--token", commandToken, "--slug", "abc234def567"],
    { SCHAFFA_TOKEN: token },
  );
  assert.equal("help" in options, false);
  assert.equal(options.token, commandToken);
  assert.equal(options.slug, "abc234def567");
});

test("runs when the package binary points to the CLI through a symlink", async () => {
  const binary = path.join(directory, "schaffa");
  await symlink(path.resolve("dist/cli.js"), binary);
  const { stdout, stderr } = await execFileAsync(process.execPath, [binary, "--help"]);
  assert.match(stdout, /schaffa upload <file>/);
  assert.equal(stderr, "");
});

test("updates an HTML page when a slug is supplied", async () => {
  const filePath = path.join(directory, "update.html");
  await writeFile(filePath, "<h1>Updated</h1>");
  const requests = [];
  await upload({
    filePath,
    token,
    slug: "abc234def567",
    baseUrl: "http://schaffa.localhost:1355",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ publicUrl: "http://schaffa.localhost:1355/p/abc234def567" }, 200);
    },
  });

  assert.equal(requests[0].url, "http://schaffa.localhost:1355/api/pages/abc234def567");
  assert.equal(requests[0].init.method, "PUT");
});

test("uploads non-HTML content through the file endpoint", async () => {
  const filePath = path.join(directory, "diagram.png");
  await writeFile(filePath, Buffer.from([1, 2, 3]));
  const requests = [];
  await upload({
    filePath,
    token,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ publicUrl: "https://schaffa.dev/f/random.webp" }, 201);
    },
  });

  assert.equal(requests[0].url, "https://schaffa.dev/api/files");
  assert.equal(requests[0].init.body.get("file").type, "image/png");
});

test("reports API errors without exposing the bearer token", async () => {
  const filePath = path.join(directory, "rejected.html");
  await writeFile(filePath, "<h1>Rejected</h1>");
  await assert.rejects(
    upload({
      filePath,
      token,
      fetch: async () => jsonResponse({ message: "Upload rejected." }, 422),
    }),
    (error) => {
      assert.match(error.message, /HTTP 422.*Upload rejected/);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    },
  );
});

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
