import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  chromeWindowArguments,
  describeDesktopClick,
  desktopClickMatchesScope,
  desktopMarker,
  findChromeExecutable,
  openChromeWindow,
  parseDesktopEvent,
  prepareDesktopRecorder,
  recordChromeWindowGuide,
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
  assert.deepEqual(
    parseDesktopEvent('{"type":"bound","windowId":42,"ownerPid":99,"windowTitle":"Projects"}'),
    {
      type: "bound",
      windowId: 42,
      ownerPid: 99,
      windowTitle: "Projects",
    },
  );
  assert.equal(desktopClickMatchesScope(event, "com.apple.calculator", 42), true);
  assert.equal(desktopClickMatchesScope(event, "com.apple.calculator", 43), false);
  assert.equal(desktopClickMatchesScope(event, "com.google.Chrome", 42), false);
  assert.throws(() => findChromeExecutable(directory), /not an executable file/);
});

test("records only the dedicated window without creating a Chrome profile", {
  skip: process.platform !== "darwin",
}, async () => {
  const recordingDirectory = path.join(directory, "chrome-window-recording");
  await mkdir(recordingDirectory, { recursive: true });
  const helper = path.join(directory, "fake-chrome-window-helper.mjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
const token = process.argv[process.argv.indexOf("--window-title-token") + 1];
if (!/^SFR-[0-9a-f]{16}$/.test(token)) process.exit(64);
const screenshotPath = path.join(output, "desktop-1234567890abcdefabcd.png");
writeFileSync(screenshotPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), { mode: 0o600 });
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "click", timestamp: new Date().toISOString(), app: "Google Chrome", bundleId: "com.google.Chrome", windowTitle: "Unrelated before binding", windowId: 76, role: "AXButton", subrole: "", label: "Too early", x: 20, y: 30, windowWidth: 800, windowHeight: 600, sensitive: false }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "bound", windowId: 77, ownerPid: 1234, windowTitle: token }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "bound", windowId: 78, ownerPid: 1234, windowTitle: "Adversarial rebind" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "click", timestamp: new Date().toISOString(), app: "Google Chrome", bundleId: "com.google.Chrome", windowTitle: "Unrelated", windowId: 78, role: "AXButton", subrole: "", label: "Wrong window", x: 40, y: 50, windowWidth: 800, windowHeight: 600, sensitive: false }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "click", timestamp: new Date().toISOString(), app: "Google Chrome", bundleId: "com.google.Chrome", windowTitle: "Projects", windowId: 77, role: "AXButton", subrole: "", label: "Create project", x: 100, y: 120, windowWidth: 800, windowHeight: 600, sensitive: false, screenshotPath, box: { left: 80, top: 100, width: 80, height: 40 } }) + "\\n");
}, 20);
setTimeout(() => process.exit(0), 60);
`,
  );
  await chmod(helper, 0o700);
  const fakeChrome = path.join(directory, "fake-existing-chrome");
  await writeFile(fakeChrome, "fake");
  await chmod(fakeChrome, 0o700);
  assert.equal(findChromeExecutable(fakeChrome), fakeChrome);
  const requests = [];
  const launched = [];
  let launchHtml = "";
  let navigationTarget;
  const guide = {
    slug: "chrome234guide",
    status: "recording",
    revision: 0,
    editRevision: 1,
    publicUrl: "https://schaffa.dev/g/chrome234guide",
    apiUrl: "https://schaffa.dev/api/guides/chrome234guide",
    steps: [],
  };
  const result = await recordChromeWindowGuide({
    guide,
    url: "https://app.example.com/projects",
    token,
    outputDirectory: recordingDirectory,
    helperExecutable: helper,
    browserExecutable: fakeChrome,
    launchWindow: async (executable, url) => {
      launched.push({ executable, url });
      const response = await fetch(url);
      launchHtml = await response.text();
      navigationTarget = fetch(`${url}/go`).then(async (release) => {
        assert.equal(release.status, 200);
        return release.text();
      });
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse(
        {
          ...guide,
          editRevision: 2,
          steps: [{ id: "step-chrome-1", position: 1, title: "Create project anklicken" }],
        },
        201,
      );
    },
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(launched.length, 1);
  assert.equal(launched[0].executable, fakeChrome);
  assert.match(launched[0].url, /^http:\/\/127\.0\.0\.1:/);
  assert.match(launchHtml, /<title>SFR-[0-9a-f]{16}<\/title>/);
  assert.equal(await navigationTarget, "https://app.example.com/projects");
  assert.deepEqual(chromeWindowArguments(launched[0].url), ["--new-window", launched[0].url]);
  assert.doesNotMatch(chromeWindowArguments(launched[0].url).join(" "), /user-data-dir/);
  assert.equal(manifest.steps.length, 1);
  assert.match(manifest.recordingId, /^[0-9a-f]{24}$/);
  assert.equal(manifest.steps[0].target, "Create project");
  assert.equal(requests.length, 1);
  assert.match(requests[0].init.headers.get("Idempotency-Key"), /^recorder-[0-9a-f]{24}-000001$/);
  assert.equal(JSON.parse(requests[0].init.body.get("step")).clickMarker.viewportWidth, 800);
});

test("reports a Chrome window binding failure", {
  skip: process.platform !== "darwin",
}, async () => {
  const recordingDirectory = path.join(directory, "chrome-binding-failure");
  const helper = path.join(directory, "fake-chrome-binding-failure.mjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "error", message: "The requested application window could not be found." }) + "\\n");
  process.exit(0);
}, 20);
`,
  );
  await chmod(helper, 0o700);
  const fakeChrome = path.join(directory, "fake-chrome-binding-failure-launcher");
  await writeFile(fakeChrome, "fake");
  await chmod(fakeChrome, 0o700);
  await assert.rejects(
    recordChromeWindowGuide({
      guide: {
        slug: "bindfailguide",
        status: "recording",
        revision: 0,
        editRevision: 1,
        publicUrl: "https://schaffa.dev/g/bindfailguide",
        apiUrl: "https://schaffa.dev/api/guides/bindfailguide",
        steps: [],
      },
      url: "https://app.example.com",
      token,
      outputDirectory: recordingDirectory,
      helperExecutable: helper,
      browserExecutable: fakeChrome,
      launchWindow: async () => {},
    }),
    /Desktop recorder failed: The requested application window could not be found/,
  );
});

test("requires native binding before accepting an explicitly scoped window click", async () => {
  const recordingDirectory = path.join(directory, "explicit-window-binding");
  const helper = path.join(directory, "fake-explicit-window-helper.mjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node
if (process.argv[process.argv.indexOf("--window-id") + 1] !== "42") process.exit(64);
const click = { type: "click", timestamp: new Date().toISOString(), app: "Calculator", bundleId: "com.apple.calculator", windowTitle: "Calculator", windowId: 42, role: "AXButton", subrole: "", label: "Seven", x: 100, y: 200, windowWidth: 300, windowHeight: 500, sensitive: false };
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
process.stdout.write(JSON.stringify(click) + "\\n");
process.stdout.write(JSON.stringify({ type: "bound", windowId: 42, ownerPid: 1234, windowTitle: "Calculator" }) + "\\n");
process.stdout.write(JSON.stringify(click) + "\\n");
setTimeout(() => process.exit(0), 30);
`,
  );
  await chmod(helper, 0o700);
  const requests = [];
  const guide = {
    slug: "explicit42guide",
    status: "recording",
    revision: 0,
    editRevision: 1,
    publicUrl: "https://schaffa.dev/g/explicit42guide",
    apiUrl: "https://schaffa.dev/api/guides/explicit42guide",
    steps: [],
  };
  const result = await recordDesktopGuide({
    guide,
    appBundleId: "com.apple.calculator",
    windowId: 42,
    token,
    outputDirectory: recordingDirectory,
    helperExecutable: helper,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse(
        { ...guide, editRevision: 2, steps: [{ id: "step-1", position: 1, title: "Seven" }] },
        201,
      );
    },
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.steps.length, 1);
  assert.equal(requests.length, 1);
});

test("locks a recording directory against concurrent recorder processes", async () => {
  const recordingDirectory = path.join(directory, "locked-recording");
  const helper = path.join(directory, "fake-locking-helper.mjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
setTimeout(() => process.exit(0), 180);
`,
  );
  await chmod(helper, 0o700);
  const guide = {
    slug: "locked234guide",
    status: "recording",
    revision: 0,
    editRevision: 1,
    publicUrl: "https://schaffa.dev/g/locked234guide",
    apiUrl: "https://schaffa.dev/api/guides/locked234guide",
    steps: [],
  };
  const first = recordDesktopGuide({
    guide,
    appBundleId: "com.apple.calculator",
    token,
    outputDirectory: recordingDirectory,
    helperExecutable: helper,
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(path.join(recordingDirectory, ".recording.lock"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  await assert.rejects(
    recordDesktopGuide({
      guide,
      appBundleId: "com.apple.calculator",
      token,
      outputDirectory: recordingDirectory,
      helperExecutable: helper,
    }),
    /Another recorder is already using/,
  );
  await first;
  await assert.rejects(access(path.join(recordingDirectory, ".recording.lock")), {
    code: "ENOENT",
  });
});

test("uses distinct idempotency keys for concurrent sessions of the same guide", async () => {
  const helper = path.join(directory, "fake-concurrent-session-helper.mjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "click", timestamp: new Date().toISOString(), app: "Calculator", bundleId: "com.apple.calculator", windowTitle: "Calculator", windowId: 7, role: "AXButton", subrole: "", label: "Seven", x: 100, y: 200, windowWidth: 300, windowHeight: 500, sensitive: false }) + "\\n");
setTimeout(() => process.exit(0), 30);
`,
  );
  await chmod(helper, 0o700);
  const guide = {
    slug: "shared234guide",
    status: "recording",
    revision: 0,
    editRevision: 1,
    publicUrl: "https://schaffa.dev/g/shared234guide",
    apiUrl: "https://schaffa.dev/api/guides/shared234guide",
    steps: [],
  };
  const keys = [];
  const record = async (name) =>
    recordDesktopGuide({
      guide,
      appBundleId: "com.apple.calculator",
      token,
      outputDirectory: path.join(directory, name),
      helperExecutable: helper,
      fetch: async (_url, init) => {
        keys.push(init.headers.get("Idempotency-Key"));
        return jsonResponse(
          { ...guide, editRevision: 2, steps: [{ id: name, position: 1, title: "Seven" }] },
          201,
        );
      },
    });
  const [first, second] = await Promise.all([
    record("shared-session-a"),
    record("shared-session-b"),
  ]);
  const firstManifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
  const secondManifest = JSON.parse(await readFile(second.manifestPath, "utf8"));
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.notEqual(firstManifest.recordingId, secondManifest.recordingId);
});

test("rejects a concurrent automatic recorder before it can replace the active session", async () => {
  const workingDirectory = path.join(directory, "concurrent-cli-recorders");
  const stateDirectory = path.join(workingDirectory, ".schaffa");
  await mkdir(stateDirectory, { recursive: true });
  const sessionPath = path.join(stateDirectory, "guide-session.json");
  const lockPath = path.join(stateDirectory, "guide-session.lock");
  await writeFile(sessionPath, '{"slug":"originalguide","editRevision":7}\n');
  const fakeBrowser = path.join(workingDirectory, "fake-browser.mjs");
  await writeFile(fakeBrowser, "#!/usr/bin/env node\nprocess.exit(1);\n");
  await chmod(fakeBrowser, 0o700);

  let requestCount = 0;
  let releaseFirstStart;
  let markFirstStartReceived;
  const firstStartReceived = new Promise((resolve) => {
    markFirstStartReceived = resolve;
  });
  const server = createServer((request, response) => {
    request.resume();
    if (request.method !== "POST" || request.url !== "/api/guides") {
      response.writeHead(404).end();
      return;
    }
    requestCount += 1;
    const slug = `session${requestCount}guide`;
    const respond = () => {
      if (response.headersSent) return;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          slug,
          status: "recording",
          revision: 0,
          editRevision: 1,
          publicUrl: `${origin}/g/${slug}`,
          apiUrl: `${origin}/api/guides/${slug}`,
          steps: [],
        }),
      );
    };
    if (requestCount === 1) {
      releaseFirstStart = respond;
      markFirstStartReceived();
    } else {
      respond();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const cli = path.resolve("dist/cli.js");
  const argumentsForRecorder = [
    cli,
    "record",
    "--title",
    "Concurrent recording",
    "--browser",
    "https://app.example.com",
    "--browser-executable",
    fakeBrowser,
  ];
  const environment = { ...process.env, SCHAFFA_TOKEN: token, SCHAFFA_URL: origin };
  const first = spawn(process.execPath, argumentsForRecorder, {
    cwd: workingDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let firstStderr = "";
  first.stderr.on("data", (chunk) => {
    firstStderr += chunk;
  });
  const firstCompleted = new Promise((resolve, reject) => {
    first.once("error", reject);
    first.once("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    await Promise.race([
      firstStartReceived,
      firstCompleted.then(({ code, signal }) => {
        throw new Error(
          `The first recorder exited before starting (${code ?? signal}): ${firstStderr}`,
        );
      }),
    ]);
    await access(lockPath);
    await assert.rejects(
      execFileAsync(process.execPath, argumentsForRecorder, {
        cwd: workingDirectory,
        env: environment,
      }),
      /Another guide recorder is active in this directory/,
    );
    assert.equal(requestCount, 1);
    assert.deepEqual(JSON.parse(await readFile(sessionPath, "utf8")), {
      slug: "originalguide",
      editRevision: 7,
    });

    releaseFirstStart();
    const completed = await firstCompleted;
    assert.equal(completed.code, 1);
    assert.match(firstStderr, /Error:/);
    await assert.rejects(access(lockPath), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).slug, "session1guide");
  } finally {
    releaseFirstStart?.();
    if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
    await firstCompleted.catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects conflicting automatic recorder URL modes", async () => {
  const cli = path.resolve("dist/cli.js");
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "record",
      "--title",
      "Conflict",
      "--chrome",
      "https://app.example.com",
      "--url",
      "https://other.example.com",
      "--token",
      token,
    ]),
    /Choose one recording mode/,
  );
});

test("passes only the new-window request to the existing Chrome executable", {
  skip: process.platform !== "darwin",
}, async () => {
  const argumentPath = path.join(directory, "chrome-launch-arguments.json");
  const executable = path.join(directory, "fake-chrome-launcher.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argumentPath)}, JSON.stringify(process.argv.slice(2)));
`,
  );
  await chmod(executable, 0o700);
  const launchUrl = "http://127.0.0.1:43210/recording";
  await openChromeWindow(executable, launchUrl);
  const argumentsPassed = JSON.parse(await readFile(argumentPath, "utf8"));
  assert.deepEqual(argumentsPassed, ["--new-window", launchUrl]);
  assert.doesNotMatch(argumentsPassed.join(" "), /user-data-dir|profile-directory/);
});

test("reports a Chrome launcher failure that happens after the initial spawn", {
  skip: process.platform !== "darwin",
}, async () => {
  const executable = path.join(directory, "late-failing-chrome-launcher.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
setTimeout(() => process.exit(7), 700);
`,
  );
  await chmod(executable, 0o700);
  await assert.rejects(
    openChromeWindow(executable, "http://127.0.0.1:43210/recording"),
    /Chrome rejected the new window request \(7\)/,
  );
});

test("compiles and caches the signed native desktop helper on macOS", {
  skip: process.platform !== "darwin",
}, async () => {
  const first = await prepareDesktopRecorder();
  const second = await prepareDesktopRecorder();
  assert.equal(first, second);
  assert.match(first, /\.schaffa\/bin\/desktop-recorder-[0-9a-f]{20}$/);
});

test("SIGTERM flushes native captures without starting queued uploads", async () => {
  const workingDirectory = path.join(directory, "sigterm-native-wrapper");
  const recordingDirectory = path.join(workingDirectory, "recording");
  await mkdir(workingDirectory, { recursive: true });
  const helper = path.join(workingDirectory, "sigterm-helper.mjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
for (let sequence = 1; sequence <= 4; sequence += 1) {
  process.stdout.write(JSON.stringify({ type: "click", timestamp: new Date().toISOString(), app: "Calculator", bundleId: "com.apple.calculator", windowTitle: "Calculator", windowId: 7, role: "AXButton", subrole: "", label: "Button " + sequence, x: 100, y: 200, windowWidth: 300, windowHeight: 500, sensitive: false }) + "\\n");
}
`,
  );
  await chmod(helper, 0o700);
  const desktopRecorderModule = new URL("../dist/desktop-recorder.js", import.meta.url).href;
  const wrapper = path.join(workingDirectory, "sigterm-wrapper.mjs");
  await writeFile(
    wrapper,
    `import { readFile } from "node:fs/promises";
import { recordDesktopGuide } from ${JSON.stringify(desktopRecorderModule)};
const guide = {
  slug: "sigtermguide",
  status: "recording",
  revision: 0,
  editRevision: 1,
  publicUrl: "https://schaffa.dev/g/sigtermguide",
  apiUrl: "https://schaffa.dev/api/guides/sigtermguide",
  steps: [],
};
let requests = 0;
const upload = async (input, init) => {
  requests += 1;
  process.stdout.write("REQUEST " + String(input) + "\\n");
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1_000);
    init.signal.addEventListener("abort", () => {
      clearInterval(keepAlive);
      setTimeout(() => resolve(new Response(JSON.stringify({
        ...guide,
        editRevision: 2,
        steps: [{ id: "uploaded-1", position: 1, title: "Button 1" }],
      }), { status: 201, headers: { "content-type": "application/json" } })), 25);
    }, { once: true });
  });
};
try {
  await recordDesktopGuide({
    guide,
    appBundleId: "com.apple.calculator",
    token: ${JSON.stringify(token)},
    outputDirectory: ${JSON.stringify(recordingDirectory)},
    helperExecutable: ${JSON.stringify(helper)},
    fetch: upload,
    onMessage: (message) => process.stdout.write(message + "\\n"),
  });
  process.stderr.write("Recorder returned successfully and could be published.\\n");
  process.exitCode = 2;
} catch (error) {
  const manifest = JSON.parse(await readFile(${JSON.stringify(path.join(recordingDirectory, "manifest.json"))}, "utf8"));
  process.stdout.write("SUMMARY " + JSON.stringify({ requests, statuses: manifest.steps.map((step) => step.status) }) + "\\n");
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
  process.exitCode = 1;
}
`,
  );
  const child = spawn(process.execPath, [wrapper], {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    await waitForManifestSteps(path.join(recordingDirectory, "manifest.json"), 4, completed);
    assert.match(stdout, /REQUEST .*\/steps/);
    assert.equal(child.kill("SIGTERM"), true);
    const result = await Promise.race([
      completed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("The native recorder did not stop after SIGTERM.")),
          2_000,
        ),
      ),
    ]);
    assert.deepEqual(result, { code: 1, signal: null });
    assert.match(stderr, /terminated by SIGTERM/);
    assert.match(stderr, /not published/);
    assert.doesNotMatch(stderr, /returned successfully/);
    const requests = stdout.match(/^REQUEST /gm) || [];
    assert.equal(requests.length, 1);
    assert.doesNotMatch(stdout, /\/finish/);
    const summary = JSON.parse(stdout.match(/^SUMMARY (.+)$/m)[1]);
    assert.equal(summary.requests, 1);
    assert.deepEqual(summary.statuses, ["pending", "pending", "pending", "pending"]);
    await assert.rejects(access(path.join(recordingDirectory, ".recording.lock")), {
      code: "ENOENT",
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await completed.catch(() => undefined);
  }
});

test("SIGTERM flushes browser captures without starting queued uploads", async () => {
  const workingDirectory = path.join(directory, "sigterm-browser-wrapper");
  const recordingDirectory = path.join(workingDirectory, "recording");
  const profileDirectory = path.join(workingDirectory, "profile");
  const fakeBrowserExecutable = path.join(workingDirectory, "fake-browser");
  await mkdir(workingDirectory, { recursive: true });
  await writeFile(fakeBrowserExecutable, "fake");
  const recorderModule = new URL("../dist/recorder.js", import.meta.url).href;
  const wrapper = path.join(workingDirectory, "sigterm-browser-wrapper.mjs");
  await writeFile(
    wrapper,
    `import { readFile } from "node:fs/promises";
import { recordBrowserGuide } from ${JSON.stringify(recorderModule)};
const guide = {
  slug: "browsertermguide",
  status: "recording",
  revision: 0,
  editRevision: 1,
  publicUrl: "https://schaffa.dev/g/browsertermguide",
  apiUrl: "https://schaffa.dev/api/guides/browsertermguide",
  steps: [],
};
const bindings = new Map();
const browserListeners = new Map();
let frameListener;
const page = {
  isClosed: () => false,
  url: () => "https://app.example.com",
  title: async () => "Example",
  exposeFunction: async (name, callback) => { bindings.set(name, callback); },
  evaluateOnNewDocument: async () => {},
  evaluate: async () => {},
  goto: async () => {},
  screenshot: async () => Buffer.from("image"),
  createCDPSession: async () => ({
    on: (name, callback) => { if (name === "Page.screencastFrame") frameListener = callback; },
    send: async (name) => {
      if (name === "Page.startScreencast") {
        queueMicrotask(() => frameListener?.({ data: Buffer.from("frame").toString("base64"), sessionId: 1 }));
      }
    },
  }),
};
const browser = {
  connected: true,
  pages: async () => [page],
  newPage: async () => page,
  on: () => {},
  once: (name, callback) => { browserListeners.set(name, callback); },
  close: async () => {
    if (!browser.connected) return;
    browser.connected = false;
    browserListeners.get("disconnected")?.();
  },
};
let requests = 0;
const upload = async (input, init) => {
  requests += 1;
  process.stdout.write("REQUEST " + String(input) + "\\n");
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1_000);
    init.signal.addEventListener("abort", () => {
      clearInterval(keepAlive);
      setTimeout(() => resolve(new Response(JSON.stringify({
        ...guide,
        editRevision: 2,
        steps: [{ id: "uploaded-1", position: 1, title: "Start" }],
      }), { status: 201, headers: { "content-type": "application/json" } })), 25);
    }, { once: true });
  });
};
const emitClicks = () => {
  const record = bindings.get("__schaffaRecordClick");
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    record({
      x: 100,
      y: 120,
      tag: "button",
      role: "button",
      label: "Button " + sequence,
      selector: "#button-" + sequence,
      url: "https://app.example.com",
      pageTitle: "Example",
      viewportWidth: 800,
      viewportHeight: 600,
      box: { left: 80, top: 100, width: 80, height: 40 },
      inFrame: false,
      sensitive: false,
      timestamp: new Date().toISOString(),
    });
  }
};
try {
  await recordBrowserGuide({
    guide,
    url: "https://app.example.com",
    token: ${JSON.stringify(token)},
    browserExecutable: ${JSON.stringify(fakeBrowserExecutable)},
    outputDirectory: ${JSON.stringify(recordingDirectory)},
    profileDirectory: ${JSON.stringify(profileDirectory)},
    fetch: upload,
    launchBrowser: async () => browser,
    onMessage: (message) => {
      process.stdout.write(message + "\\n");
      if (message.startsWith("Recording.")) emitClicks();
    },
  });
  process.stderr.write("Recorder returned successfully and could be published.\\n");
  process.exitCode = 2;
} catch (error) {
  const manifest = JSON.parse(await readFile(${JSON.stringify(path.join(recordingDirectory, "manifest.json"))}, "utf8"));
  process.stdout.write("SUMMARY " + JSON.stringify({ requests, statuses: manifest.steps.map((step) => step.status) }) + "\\n");
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
  process.exitCode = 1;
}
`,
  );
  const child = spawn(process.execPath, [wrapper], {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    await waitForManifestSteps(path.join(recordingDirectory, "manifest.json"), 4, completed);
    assert.match(stdout, /REQUEST .*\/steps/);
    assert.equal(child.kill("SIGTERM"), true);
    const result = await Promise.race([
      completed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("The browser recorder did not stop after SIGTERM.")),
          2_000,
        ),
      ),
    ]);
    assert.deepEqual(result, { code: 1, signal: null });
    assert.match(stderr, /terminated by SIGTERM/);
    assert.match(stderr, /not published/);
    assert.doesNotMatch(stderr, /returned successfully/);
    const requests = stdout.match(/^REQUEST /gm) || [];
    assert.equal(requests.length, 1);
    assert.doesNotMatch(stdout, /\/finish/);
    const summary = JSON.parse(stdout.match(/^SUMMARY (.+)$/m)[1]);
    assert.equal(summary.requests, 1);
    assert.deepEqual(summary.statuses, ["pending", "pending", "pending", "pending"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await completed.catch(() => undefined);
  }
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

async function waitForManifestSteps(manifestPath, count, completed) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.steps.length >= count) return;
    } catch {}
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 10)),
      completed.then(({ code, signal }) => {
        throw new Error(`The recorder exited before capturing every step (${code ?? signal}).`);
      }),
    ]);
  }
  throw new Error(`The recorder did not persist ${count} steps before the timeout.`);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
