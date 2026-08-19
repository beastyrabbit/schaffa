import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { addPresentationDownloads, parseCliArgs } from "../dist/cli.js";
import {
  addGuideStep,
  deleteGuideStep,
  finishGuide,
  getGuide,
  replaceGuideScreenshot,
  startGuide,
  updateGuideStep,
  upload,
} from "../dist/client.js";
import {
  describeDesktopClick,
  desktopMarker,
  parseDesktopEvent,
  prepareDesktopRecorder,
  recordDesktopGuide,
} from "../dist/desktop-recorder.js";
import {
  describeClick,
  findBrowserExecutable,
  readRecordingSlug,
  selectPreClickFrame,
  syncRecording,
} from "../dist/recorder.js";

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

test("requires a token for files", async () => {
  const filePath = path.join(directory, "private.png");
  await writeFile(filePath, Buffer.from([1, 2, 3]));

  await assert.rejects(upload({ filePath }), /SCHAFFA_TOKEN is required to upload files/);
});

test("accepts a command-line token and gives it precedence over the environment", () => {
  const commandToken = `sfa_${"b".repeat(43)}`;
  const options = parseCliArgs(["upload", "plan.html", "--token", commandToken], {
    SCHAFFA_TOKEN: token,
  });
  assert.equal("help" in options, false);
  assert.equal(options.token, commandToken);
});

test("runs when the package binary points to the CLI through a symlink", async () => {
  const binary = path.join(directory, "schaffa");
  await symlink(path.resolve("dist/cli.js"), binary);
  const { stdout, stderr } = await execFileAsync(process.execPath, [binary, "--help"]);
  assert.match(stdout, /schaffa upload <file>/);
  assert.equal(stderr, "");
});

test("adds same-origin PDF and PowerPoint downloads to a presentation", () => {
  const html =
    "<!doctype html><html><head><title>Deck</title></head><body><main>Slides</main></body></html>";
  const published = addPresentationDownloads(
    html,
    {
      pdf: "https://schaffa.dev/f/deck.pdf",
      pptx: "https://schaffa.dev/f/deck.pptx",
      source: "https://schaffa.dev/f/deck.md",
    },
    "https://schaffa.dev",
  );

  assert.match(published, /id="schaffa-presentation-download-styles"/);
  assert.match(published, /aria-label="Download presentation"/);
  assert.match(published, /href="\/f\/deck\.pdf" download/);
  assert.match(published, /href="\/f\/deck\.pptx" download/);
  assert.doesNotMatch(published, /href="https:\/\//);
  assert.doesNotMatch(published, /deck\.md/);
  assert.ok(published.indexOf("<style") < published.indexOf("</head>"));
  assert.ok(published.indexOf("<nav") < published.indexOf("</body>"));
});

test("leaves presentations without PDF or PowerPoint exports unchanged", () => {
  const html = "<!doctype html><html><head></head><body>Slides</body></html>";
  assert.equal(addPresentationDownloads(html, { source: "https://schaffa.dev/f/deck.md" }), html);
});

test("rejects presentation download links from another origin", () => {
  assert.throws(
    () =>
      addPresentationDownloads("<!doctype html><html><head></head><body>Slides</body></html>", {
        pdf: "https://files.example.com/deck.pdf",
      }),
    /another origin/,
  );
});

test("rejects the removed slug option and always creates through the random-ID endpoint", async () => {
  assert.throws(
    () => parseCliArgs(["upload", "plan.html", "--slug", "readable-name"]),
    /Unknown option '--slug'/,
  );

  const filePath = path.join(directory, "legacy-client.html");
  await writeFile(filePath, "<h1>New page</h1>");
  const requests = [];
  await upload({
    filePath,
    token,
    slug: "readable-name",
    baseUrl: "http://schaffa.localhost:1355",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ publicUrl: "http://schaffa.localhost:1355/p/4z9nm23wk1qp8r7t" }, 201);
    },
  });

  assert.equal(requests[0].url, "http://schaffa.localhost:1355/api/pages");
  assert.equal(requests[0].init.method, "POST");
});

test("publishes interactive HTML only with a token and explicit query type", async () => {
  const filePath = path.join(directory, "interactive.html");
  await writeFile(filePath, "<script>document.body.textContent = 'ready'</script>");
  await assert.rejects(
    upload({ filePath, interactive: true }),
    /SCHAFFA_TOKEN is required for interactive publishing/,
  );
  const requests = [];
  await upload({
    filePath,
    token,
    interactive: true,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ publicUrl: "https://schaffa.dev/p/interactive" }, 201);
    },
  });
  assert.equal(requests[0].url, "https://schaffa.dev/api/pages?type=interactive");
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

test("uploads PowerPoint exports with the official media type", async () => {
  const filePath = path.join(directory, "presentation.pptx");
  await writeFile(filePath, Buffer.from([1, 2, 3]));
  const requests = [];
  await upload({
    filePath,
    token,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ publicUrl: "https://schaffa.dev/f/random.pptx" }, 201);
    },
  });

  assert.equal(
    requests[0].init.body.get("file").type,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
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

test("drives the incremental guide API with revisions and authorization", async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/api/guides")) {
      return jsonResponse(
        {
          slug: "abc234def567",
          status: "recording",
          revision: 0,
          editRevision: 1,
          publicUrl: "https://schaffa.dev/g/abc234def567",
          apiUrl: "https://schaffa.dev/api/guides/abc234def567",
          steps: [],
        },
        201,
      );
    }
    if (String(url).endsWith("/steps")) {
      return jsonResponse(
        {
          slug: "abc234def567",
          status: "recording",
          revision: 0,
          editRevision: 2,
          publicUrl: "https://schaffa.dev/g/abc234def567",
          apiUrl: "https://schaffa.dev/api/guides/abc234def567",
          steps: [{ id: "step-1", title: "Open" }],
        },
        201,
      );
    }
    return jsonResponse(
      {
        guide: {
          slug: "abc234def567",
          status: "published",
          revision: 1,
          editRevision: 3,
          publicUrl: "https://schaffa.dev/g/abc234def567",
          apiUrl: "https://schaffa.dev/api/guides/abc234def567",
          steps: [],
        },
      },
      200,
    );
  };
  const started = await startGuide({
    title: "Guide",
    targetUrl: "https://app.example.com/projects",
    token,
    fetch: fakeFetch,
  });
  const stepped = await addGuideStep({
    slug: started.slug,
    editRevision: started.editRevision,
    title: "Open",
    description: "Open it",
    clickMarker: { x: 20, y: 30, viewportWidth: 1280, viewportHeight: 800 },
    token,
    fetch: fakeFetch,
  });
  const finished = await finishGuide({
    slug: stepped.slug,
    editRevision: stepped.editRevision,
    token,
    fetch: fakeFetch,
  });
  assert.equal(finished.guide.status, "published");
  assert.equal(requests.length, 3);
  assert.equal(requests[0].init.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(JSON.parse(requests[0].init.body).targetUrl, "https://app.example.com/projects");
  assert.equal(requests[1].init.headers.get("If-Match"), "1");
  assert.match(requests[1].init.headers.get("Idempotency-Key"), /^cli-/);
  assert.deepEqual(JSON.parse(requests[1].init.body).clickMarker, {
    x: 20,
    y: 30,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  assert.equal(requests[2].url, "https://schaffa.dev/api/guides/abc234def567/finish");
});

test("reads and corrects recorded guide steps through the owner API", async () => {
  const screenshot = path.join(directory, "replacement.png");
  await writeFile(screenshot, Buffer.from([1, 2, 3]));
  const requests = [];
  const guide = {
    slug: "abc234def567",
    status: "published",
    revision: 1,
    editRevision: 7,
    publicUrl: "https://schaffa.dev/g/abc234def567",
    apiUrl: "https://schaffa.dev/api/guides/abc234def567",
    steps: [{ id: "step-1", position: 1, title: "Open" }],
  };
  const fakeFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return jsonResponse({ ...guide, editRevision: guide.editRevision + requests.length }, 200);
  };

  await getGuide({ slug: guide.slug, token, fetch: fakeFetch });
  await updateGuideStep({
    slug: guide.slug,
    editRevision: 8,
    stepId: "step-1",
    title: "Open projects",
    token,
    fetch: fakeFetch,
  });
  await replaceGuideScreenshot({
    slug: guide.slug,
    editRevision: 9,
    stepId: "step-1",
    screenshot,
    token,
    fetch: fakeFetch,
  });
  await deleteGuideStep({
    slug: guide.slug,
    editRevision: 10,
    stepId: "step-1",
    token,
    fetch: fakeFetch,
  });

  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[1].init.method, "PATCH");
  assert.equal(requests[1].init.headers.get("If-Match"), "8");
  assert.deepEqual(JSON.parse(requests[1].init.body), { title: "Open projects" });
  assert.equal(requests[2].init.method, "PUT");
  assert.equal(requests[2].init.body.get("screenshot").name, "replacement.png");
  assert.equal(requests[3].init.method, "DELETE");
});

test("describes click targets and accepts an explicit browser executable", async () => {
  assert.equal(
    describeClick({ label: "  Create   project ", role: "button", tag: "button", x: 42, y: 24 }),
    "Create project",
  );
  assert.equal(
    describeClick({ label: "", role: "button", tag: "div", x: 42.4, y: 24.6 }),
    "button at 42, 25",
  );
  const executable = path.join(directory, "fake-chrome");
  await writeFile(executable, "fake");
  assert.equal(findBrowserExecutable(executable), executable);
  assert.throws(() => findBrowserExecutable(path.join(directory, "missing")), /not found/);
});

test("selects only a frame received before the click", () => {
  const clickedAt = Date.parse("2026-08-19T12:00:00.000Z");
  const before = { data: Buffer.from("before"), receivedAt: clickedAt - 10 };
  const after = { data: Buffer.from("after"), receivedAt: clickedAt + 10 };
  assert.equal(selectPreClickFrame([before, after], new Date(clickedAt).toISOString()), before);
  const oldButUnchanged = { data: Buffer.from("old"), receivedAt: clickedAt - 60_000 };
  assert.equal(
    selectPreClickFrame([oldButUnchanged], new Date(clickedAt).toISOString()),
    oldButUnchanged,
  );
});

test("parses native desktop events and converts window-relative markers", () => {
  const event = parseDesktopEvent(
    JSON.stringify({
      type: "click",
      timestamp: "2026-08-19T12:00:00Z",
      app: "Calculator",
      bundleId: "com.apple.calculator",
      windowTitle: "Calculator",
      windowId: 42,
      role: "AXButton",
      subrole: "",
      label: "Seven",
      x: 120,
      y: 240,
      windowWidth: 320,
      windowHeight: 480,
      sensitive: false,
      screenshotPath: "/tmp/desktop-1234567890abcdefabcd.png",
      box: { left: 100, top: 220, width: 40, height: 40 },
    }),
  );
  assert.equal(event.type, "click");
  assert.equal(describeDesktopClick(event), "Seven");
  assert.deepEqual(desktopMarker(event), {
    x: 120,
    y: 240,
    viewportWidth: 320,
    viewportHeight: 480,
    box: { left: 100, top: 220, width: 40, height: 40 },
  });
  assert.equal(parseDesktopEvent("not json"), null);
  assert.equal(parseDesktopEvent('{"type":"click","x":null}'), null);
});

test("compiles and caches the signed native desktop helper on macOS", {
  skip: process.platform !== "darwin",
}, async () => {
  const first = await prepareDesktopRecorder();
  const second = await prepareDesktopRecorder();
  assert.equal(first, second);
  assert.match(first, /\.schaffa\/bin\/desktop-recorder-[0-9a-f]{20}$/);
});

test("records a native click locally and uploads it in order", async () => {
  const recordingDirectory = path.join(directory, "desktop-recording");
  await mkdir(recordingDirectory, { recursive: true });
  const helper = path.join(directory, "fake-desktop-helper.mjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
const bundleID = process.argv[process.argv.indexOf("--bundle-id") + 1];
if (bundleID !== "com.apple.calculator") process.exit(64);
const screenshotPath = path.join(output, "desktop-1234567890abcdefabcd.png");
const sensitivePath = path.join(output, "desktop-abcdef1234567890abcd.png");
writeFileSync(screenshotPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), { mode: 0o600 });
writeFileSync(sensitivePath, Buffer.from("private"), { mode: 0o600 });
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "click", timestamp: new Date().toISOString(), app: "Calculator", bundleId: "com.apple.calculator", windowTitle: "Calculator", windowId: 7, role: "AXButton", subrole: "", label: "Seven", x: 100, y: 200, windowWidth: 300, windowHeight: 500, sensitive: false, screenshotPath, box: { left: 80, top: 180, width: 40, height: 40 } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "click", timestamp: new Date().toISOString(), app: "Dock", bundleId: "com.apple.dock", windowTitle: "Dock", windowId: 8, role: "AXButton", subrole: "", label: "Safari", x: 120, y: 220, windowWidth: 500, windowHeight: 600, sensitive: false }) + "\\n");
process.stdout.write(JSON.stringify({ type: "click", timestamp: new Date().toISOString(), app: "Calculator", bundleId: "com.apple.calculator", windowTitle: "Calculator", windowId: 7, role: "AXTextField", subrole: "AXSecureTextField", label: "Password", x: 120, y: 220, windowWidth: 300, windowHeight: 500, sensitive: true, screenshotPath: sensitivePath }) + "\\n");
setTimeout(() => process.exit(0), 30);
`,
  );
  await chmod(helper, 0o700);
  const requests = [];
  const guide = {
    slug: "desk234guide",
    status: "recording",
    revision: 0,
    editRevision: 1,
    publicUrl: "https://schaffa.dev/g/desk234guide",
    apiUrl: "https://schaffa.dev/api/guides/desk234guide",
    steps: [],
  };
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const count = requests.length;
    return jsonResponse(
      {
        ...guide,
        editRevision: 1 + count,
        steps: Array.from({ length: count }, (_, index) => ({
          id: `step-native-${index + 1}`,
          position: index + 1,
          title: index === 0 ? "Seven anklicken" : "Password anklicken",
        })),
      },
      201,
    );
  };
  const result = await recordDesktopGuide({
    guide,
    appBundleId: "com.apple.calculator",
    token,
    outputDirectory: recordingDirectory,
    helperExecutable: helper,
    fetch,
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(result.failedUploads, 0);
  assert.equal(manifest.source, "desktop");
  assert.equal(manifest.steps.length, 2);
  assert.equal(manifest.steps[0].status, "uploaded");
  assert.equal(manifest.steps[0].target, "Seven");
  assert.equal(manifest.steps[0].screenshot, "step-0001.png");
  assert.equal(requests[0].init.body.get("screenshot").name, "step-0001.png");
  const submittedStep = JSON.parse(requests[0].init.body.get("step"));
  assert.equal(submittedStep.action.target, "Seven");
  assert.equal(submittedStep.clickMarker.viewportWidth, 300);
  assert.equal(manifest.steps[1].screenshot, null);
  assert.match(manifest.steps[1].captureError, /sensitive data/);
  assert.equal(JSON.parse(requests[1].init.body).capture, false);
});

test("sync preserves a rejected screenshot as an ordered text step", async () => {
  const recordingDirectory = path.join(directory, "recoverable-recording");
  await mkdir(recordingDirectory, { recursive: true });
  await writeFile(path.join(recordingDirectory, "step-0001.png"), Buffer.from([1, 2, 3]));
  const manifestPath = path.join(recordingDirectory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      slug: "abc234def567",
      publicUrl: "https://schaffa.dev/g/abc234def567",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [
        {
          sequence: 1,
          timestamp: new Date().toISOString(),
          url: "https://app.example.com",
          pageTitle: "App",
          target: "Create project",
          title: "Click Create project",
          description: "Click Create project.",
          actionType: "click",
          selector: "#create",
          click: { x: 20, y: 30, viewportWidth: 800, viewportHeight: 600 },
          screenshot: "step-0001.png",
          status: "pending",
        },
      ],
    }),
  );
  const requests = [];
  const guide = {
    slug: "abc234def567",
    status: "recording",
    revision: 0,
    editRevision: 1,
    publicUrl: "https://schaffa.dev/g/abc234def567",
    apiUrl: "https://schaffa.dev/api/guides/abc234def567",
    steps: [],
  };
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) return jsonResponse({ message: "Screenshot rejected." }, 422);
    return jsonResponse(
      {
        ...guide,
        editRevision: 2,
        steps: [{ id: "step-1", position: 1, title: "Click Create project" }],
      },
      requests.length === 2 ? 201 : 200,
    );
  };

  assert.equal(await readRecordingSlug(manifestPath), guide.slug);
  const result = await syncRecording({ guide, token, manifestPath, fetch });
  const saved = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(result.failedUploads, 0);
  assert.equal(saved.steps[0].status, "uploaded");
  assert.match(saved.steps[0].captureError, /HTTP 422/);
  assert.equal(JSON.parse(requests[1].init.body).capture, false);
  assert.equal(
    requests[0].init.headers.get("Idempotency-Key"),
    requests[1].init.headers.get("Idempotency-Key"),
  );
});

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
