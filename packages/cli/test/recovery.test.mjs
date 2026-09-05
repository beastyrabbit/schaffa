import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { recordBrowserGuide } from "../dist/recorder.js";
import { appendRecordedStep, recordingUploadQueue } from "../dist/recording-upload.js";

const exec = promisify(execFile);
const token = "fixture-authentication";
const initial = {
  slug: "abc234def567",
  editRevision: 1,
  status: "recording",
  steps: [],
  publicUrl: "http://localhost/g/abc234def567",
};
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("recording uploads refresh one edit conflict and preserve corrections and retry keys", async () => {
  let current = { ...initial };
  const keys = [];
  const fetch = async (_url, init) => {
    if (!init?.method || init.method === "GET") return response(current);
    keys.push(new Headers(init.headers).get("Idempotency-Key"));
    if (String(new Headers(init.headers).get("If-Match")) !== String(current.editRevision))
      return response({ error: "edit_conflict" }, 409);
    current = {
      ...current,
      editRevision: current.editRevision + 1,
      steps: [...current.steps, { id: `step-${current.steps.length}`, title: "Captured" }],
    };
    return response(current);
  };
  const queue = recordingUploadQueue({
    guide: initial,
    stopped: () => false,
    save: async () => {},
  });
  const first = { sequence: 1, target: "first", status: "pending" };
  queue.enqueue(first, {
    token,
    title: "First",
    description: "First step",
    fetch,
    idempotencyKey: "recording-first",
  });
  await queue.drain();
  current = {
    ...current,
    editRevision: current.editRevision + 1,
    steps: [{ ...current.steps[0], title: "Human correction" }],
  };
  const second = { sequence: 2, target: "second", status: "pending" };
  queue.enqueue(second, {
    token,
    title: "Second",
    description: "Second step",
    fetch,
    idempotencyKey: "recording-second",
  });
  await queue.drain();
  assert.equal(first.status, "uploaded");
  assert.equal(second.status, "uploaded");
  assert.equal(queue.guide.steps[0].title, "Human correction");
  assert.equal(queue.guide.steps.length, 2);
  assert.deepEqual(keys, ["recording-first", "recording-second", "recording-second"]);
});

test("append retries are bounded and do not retry unrelated conflicts", async () => {
  for (const error of ["edit_conflict", "idempotency_conflict"]) {
    let posts = 0;
    await assert.rejects(
      appendRecordedStep({
        ...initial,
        token,
        title: "Step",
        description: "Text",
        fetch: async (_url, init) => {
          if (!init?.method || init.method === "GET") return response(initial);
          posts += 1;
          return response({ error }, 409);
        },
      }),
    );
    assert.equal(posts, error === "edit_conflict" ? 2 : 1);
  }
});

test("explicit manifest sync runs through the CLI without an active session", {}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-recover-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let guide = { ...initial, status: "published" };
  const server = createServer(async (request, reply) => {
    for await (const _chunk of request) {
      /* Drain the local fixture request. */
    }
    if (request.method === "POST")
      guide = {
        ...guide,
        editRevision: 2,
        steps: [{ id: "recovered", position: 1, title: "Recovered" }],
      };
    reply.setHeader("content-type", "application/json");
    reply.end(JSON.stringify(guide));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const manifest = path.join(directory, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      slug: initial.slug,
      steps: [
        {
          sequence: 1,
          target: "Continue",
          title: "Recovered",
          description: "Continue",
          status: "pending",
          screenshot: null,
        },
      ],
    }),
  );
  const result = await exec(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "guide",
      "sync",
      "--manifest",
      manifest,
      "--json",
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        SCHAFFA_TOKEN: token,
        SCHAFFA_URL: `http://127.0.0.1:${server.address().port}`,
      },
    },
  );
  assert.equal(JSON.parse(result.stdout).failedUploads, 0);
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).steps[0].status, "uploaded");
});

test("browser closure during initialization cannot miss completion", {
  timeout: 4000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-early-close-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const browser = new EventEmitter();
  browser.connected = true;
  const page = {
    isClosed: () => !browser.connected,
    exposeFunction: async () => {},
    evaluateOnNewDocument: async () => {},
    evaluate: async () => {},
    createCDPSession: async () => null,
    goto: async () => {
      browser.connected = false;
      browser.emit("disconnected");
    },
    url: () => "http://localhost/",
    title: async () => "Fixture",
    screenshot: async () => {
      throw new Error("Closed");
    },
  };
  browser.pages = async () => [page];
  const result = await recordBrowserGuide({
    guide: initial,
    token,
    url: "http://localhost/",
    browserExecutable: process.execPath,
    outputDirectory: directory,
    profileDirectory: path.join(directory, "profile"),
    launchBrowser: async () => browser,
    fetch: async () => response({ ...initial, editRevision: 2, steps: [{ id: "text" }] }),
  });
  assert.equal(result.failedUploads, 0);
});

test("native capture deadline releases its queue after a stuck child", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-capture-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(
    new URL("../assets/desktop-recorder.swift", import.meta.url),
    "utf8",
  );
  const helper = source.split("// CAPTURE_HARNESS_BEGIN")[1].split("// CAPTURE_HARNESS_END")[0];
  const filename = path.join(directory, "deadline.swift");
  await writeFile(
    filename,
    `import Foundation\nimport Darwin\n${helper}\nlet process = Process()\nprocess.executableURL = URL(fileURLWithPath: "/bin/sleep")\nprocess.arguments = ["30"]\nlet start = Date()\nlet completed = try runCaptureProcess(process, timeout: 0.05)\nassert(!completed)\nassert(Date().timeIntervalSince(start) < 1)\nprint("released")\n`,
  );
  const result = await exec(
    "swift",
    ["-module-cache-path", path.join(directory, "cache"), filename],
    { timeout: 120000 },
  );
  assert.match(result.stdout, /released/);
});
