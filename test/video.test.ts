import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import {
  app,
  assert,
  config,
  createToken,
  db,
  finishPendingScans,
  sharp,
  test,
} from "./server-fixture.js";

const { findBrowserExecutable, isVideoPageSafe, recordBrowserGuide } = (await import(
  new URL("../packages/cli/dist/recorder.js", import.meta.url).href
)) as typeof import("../packages/cli/src/recorder.js");
const { exportVideo } = (await import(
  new URL("../packages/cli/dist/video.js", import.meta.url).href
)) as typeof import("../packages/cli/src/video.js");
const {
  startGuide,
  setGuideVideo,
  upload,
  finishGuide,
  updateGuideStep,
  addGuideStep,
  deleteGuideStep,
} = (await import(
  new URL("../packages/cli/dist/client.js", import.meta.url).href
)) as typeof import("../packages/cli/src/client.js");

test("continuous guide and standalone recording export paced video that plays in the published guide", {
  timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-video-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  config.baseHost = "127.0.0.1";
  let embeddedUrl = "";
  app.get("/video-embedded", async (_request, reply) =>
    reply
      .type("text/html")
      .send(`<iframe style="width:600px;height:300px;border:0" src="${embeddedUrl}"></iframe>`),
  );
  app.get("/video-fixture", async (_request, reply) =>
    reply
      .type("text/html")
      .send(
        `<!doctype html><html lang="en"><title>Create a project</title><style>body{margin:0;padding:80px;background:#f3f5f9;color:#172340;font:24px system-ui}button{padding:18px 30px;font:inherit;border:0;border-radius:12px;background:#224acc;color:white}#result{margin-top:40px;padding:30px;background:white;transition:transform .3s}#result.done{transform:translateX(70px);background:#d4f5de}</style><h1>Projects</h1><p>Create your first project.</p><button id="create">Create project</button><div id="result">No projects yet</div><script>document.querySelector('button').onclick=()=>{const r=document.querySelector('#result');r.textContent='Project created';r.className='done';};</script></html>`,
      ),
  );
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  config.baseUrl = origin;
  const executablePath = findBrowserExecutable(process.env.SCHAFFA_TEST_BROWSER);
  const owner = createToken("video owner");
  const other = createToken("video stranger");
  const common = { token: owner.token, baseUrl: origin };
  const guide = await startGuide({ ...common, title: "Create a project", language: "en" });
  const browser = await puppeteer.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  let actions: Promise<void> | undefined;
  const recording = await recordBrowserGuide({
    ...common,
    guide,
    video: true,
    url: `${origin}/video-fixture`,
    outputDirectory: path.join(directory, "guide"),
    profileDirectory: path.join(directory, "profile"),
    browserExecutable: executablePath,
    launchBrowser: async () => browser,
    onMessage: (message: string) => {
      if (message.startsWith("Recording."))
        actions = (async () => {
          const [page] = await browser.pages();
          assert.ok(page);
          await new Promise((resolve) => setTimeout(resolve, 300));
          await page.click("#create");
          await page.waitForFunction(
            () => document.querySelector("#result")?.textContent === "Project created",
          );
          await new Promise((resolve) => setTimeout(resolve, 700));
          await browser.close();
        })();
    },
  });
  await actions;
  assert.equal(recording.failedUploads, 0);
  assert.ok(recording.videoManifest);
  const timeline = JSON.parse(await readFile(recording.videoManifest, "utf8"));
  assert.ok(timeline.frames.length >= 3);
  assert.ok(timeline.frames.some((frame: { click?: unknown }) => frame.click));
  const firstFrame = await sharp(
    path.join(path.dirname(recording.videoManifest), timeline.frames[0].file),
  )
    .extract({ left: 1000, top: 100, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.ok(
    (firstFrame[0] || 0) > 200,
    "capture starts on the visible page, not a blank compositor frame",
  );
  const output = path.join(directory, "walkthrough.webm");
  const cliExport = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url)),
      "video",
      "export",
      "--manifest",
      recording.videoManifest,
      "--output",
      output,
      "--browser-executable",
      executablePath,
      "--json",
    ],
    { cwd: directory },
  );
  assert.equal(JSON.parse(cliExport.stdout).filePath, output);
  let draft = await startGuide({ ...common, title: "Draft correction" });
  draft = await addGuideStep({
    ...common,
    ...draft,
    title: "Remove this step",
    description: "An obsolete captured step.",
    capture: false,
  });
  const staleManifest = path.join(directory, "stale-video.json");
  await writeFile(
    staleManifest,
    JSON.stringify({ ...timeline, guideSlug: draft.slug, guideEditRevision: draft.editRevision }),
  );
  const draftStep = draft.steps[0];
  assert.ok(draftStep);
  draft = await deleteGuideStep({ ...common, ...draft, stepId: draftStep.id });
  await mkdir(path.join(directory, ".schaffa"));
  await writeFile(
    path.join(directory, ".schaffa", "guide-session.json"),
    JSON.stringify({ slug: draft.slug, editRevision: draft.editRevision }),
  );
  const filesBefore = db().prepare("SELECT COUNT(*) AS count FROM files").get();
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url)),
        "guide",
        "video",
        "--manifest",
        staleManifest,
      ],
      { cwd: directory, env: { ...process.env, SCHAFFA_TOKEN: owner.token, SCHAFFA_URL: origin } },
    ),
    /guide changed/,
  );
  assert.deepEqual(
    db().prepare("SELECT COUNT(*) AS count FROM files").get(),
    filesBefore,
    "stale draft video is rejected before upload",
  );
  const probe = JSON.parse(
    (
      await promisify(execFile)("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=width,height",
        "-of",
        "json",
        output,
      ])
    ).stdout,
  );
  assert.ok(
    Number(probe.format.duration) >= 5,
    "pacing adds readable pauses to the one-second interaction",
  );
  assert.equal(probe.streams[0].width, 1280);
  assert.equal(probe.streams[0].height, 800);
  await assert.rejects(
    exportVideo({ manifest: recording.videoManifest, output, executablePath }),
    /already exists/,
  );
  const video = await upload({ ...common, filePath: output });
  await finishPendingScans();
  const attached = await setGuideVideo({
    ...common,
    ...recording.guide,
    videoUrl: video.publicUrl,
  });
  const finished = await finishGuide({ ...common, ...attached });
  assert.equal(finished.guide.videoUrl, video.publicUrl);
  const otherGuide = await startGuide({
    token: other.token,
    baseUrl: origin,
    title: "Other guide",
  });
  await assert.rejects(
    setGuideVideo({
      token: other.token,
      baseUrl: origin,
      ...otherGuide,
      videoUrl: video.publicUrl,
    }),
    /owner/,
  );
  await assert.rejects(
    setGuideVideo({ ...common, ...finished.guide, videoUrl: "https://example.org/video.webm" }),
    /instance/,
  );
  const filename = new URL(video.publicUrl).pathname.slice(3);
  db().prepare("UPDATE files SET scan_status = 'pending' WHERE filename = ?").run(filename);
  await assert.rejects(
    setGuideVideo({ ...common, ...finished.guide, videoUrl: video.publicUrl }),
    /scanning/,
  );
  db().prepare("UPDATE files SET scan_status = 'clean' WHERE filename = ?").run(filename);
  const viewer = await puppeteer.launch({ executablePath, headless: true });
  t.after(() => viewer.close());
  const page = await viewer.newPage();
  await page.goto(finished.guide.publicUrl);
  await page.waitForFunction(() => (document.querySelector("video")?.readyState || 0) >= 2);
  await page.$eval("video", async (element) => {
    element.muted = true;
    await element.play();
  });
  await page.waitForFunction(() => (document.querySelector("video")?.currentTime || 0) > 0.1);
  assert.equal(
    await page.$eval("a[download]", (element) => (element as HTMLAnchorElement).href),
    video.publicUrl,
  );
  if (process.env.SCHAFFA_TEST_VIDEO_OUTPUT) {
    await copyFile(output, process.env.SCHAFFA_TEST_VIDEO_OUTPUT);
    await page.screenshot({ path: `${process.env.SCHAFFA_TEST_VIDEO_OUTPUT}.png`, fullPage: true });
  }
  const firstStep = finished.guide.steps[0];
  assert.ok(firstStep);
  const edited = await updateGuideStep({
    ...common,
    ...finished.guide,
    stepId: firstStep.id,
    title: "Updated first step",
    description: "Open the project page.",
  });
  assert.equal(edited.videoUrl, null);
  assert.equal(
    (await (await fetch(finished.revisionUrl as string)).text()).includes(video.publicUrl),
    true,
  );

  const standaloneBrowser = await puppeteer.launch({ executablePath, headless: true });
  t.after(() => standaloneBrowser.close());
  const standalone = await recordBrowserGuide({
    guide,
    token: "",
    localOnly: true,
    video: true,
    url: `${origin}/video-fixture`,
    outputDirectory: path.join(directory, "standalone"),
    profileDirectory: path.join(directory, "local-profile"),
    browserExecutable: executablePath,
    launchBrowser: async () => standaloneBrowser,
    fetch: async () => {
      throw new Error("Standalone mode must not upload guide steps");
    },
    onMessage: (message: string) => {
      if (message.startsWith("Recording."))
        actions = (async () => {
          const [tab] = await standaloneBrowser.pages();
          assert.ok(tab);
          await tab.keyboard.down("Alt");
          await tab.keyboard.down("Shift");
          await tab.keyboard.press("KeyR");
          await tab.keyboard.up("Shift");
          await tab.keyboard.up("Alt");
          await tab.waitForFunction(
            () =>
              (globalThis as typeof globalThis & { __schaffaRecorderPaused?: boolean })
                .__schaffaRecorderPaused === true,
          );
          await tab.evaluate(() => {
            document.body.style.background = "rgb(255, 0, 0)";
          });
          await tab.click("#create");
          await new Promise((resolve) => setTimeout(resolve, 300));
          await standaloneBrowser.close();
        })();
    },
  });
  assert.ok(standalone.videoManifest);
  await actions;
  const localTimeline = JSON.parse(await readFile(standalone.videoManifest, "utf8"));
  assert.equal(localTimeline.guideSlug, undefined);
  assert.equal(JSON.parse(await readFile(standalone.manifestPath, "utf8")).steps.length, 1);
  for (const frame of localTimeline.frames) {
    const pixel: Buffer = await sharp(path.join(path.dirname(standalone.videoManifest), frame.file))
      .extract({ left: 1000, top: 100, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.ok((pixel[1] || 0) > 200, "the red private screen was never saved while paused");
  }
  await page.setContent('<iframe srcdoc="<input autocomplete=cc-number>"></iframe>');
  await page.waitForFunction(() =>
    Boolean(document.querySelector("iframe")?.contentDocument?.querySelector("input")),
  );
  assert.equal(await isVideoPageSafe(page), false, "same-origin private iframe is excluded");
  await page.setContent('<div id="host"></div>');
  await page.$eval("#host", (element) => {
    element.attachShadow({ mode: "open" }).innerHTML = '<input type="password">';
  });
  assert.equal(await isVideoPageSafe(page), false, "private shadow control is excluded");

  const embedded = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<style>body{background:rgb(255,0,0)}</style><input autocomplete="cc-number" value="synthetic-field">',
    );
  });
  await new Promise<void>((resolve) => embedded.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        embedded.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = embedded.address();
  assert.ok(address && typeof address !== "string");
  embeddedUrl = `http://127.0.0.1:${address.port}/form`;
  const privateBrowser = await puppeteer.launch({ executablePath, headless: true });
  t.after(() => privateBrowser.close());
  const privateRecording = await recordBrowserGuide({
    guide,
    token: "",
    localOnly: true,
    video: true,
    url: `${origin}/video-embedded`,
    outputDirectory: path.join(directory, "embedded"),
    profileDirectory: path.join(directory, "private-profile"),
    browserExecutable: executablePath,
    launchBrowser: async () => privateBrowser,
    onMessage: (message: string) => {
      if (message.startsWith("Recording."))
        actions = (async () => {
          const [tab] = await privateBrowser.pages();
          assert.ok(tab);
          const child = await tab.waitForFrame((frame) => frame.url() === embeddedUrl);
          await child.waitForSelector("input");
          assert.equal(await isVideoPageSafe(tab), false);
          await new Promise((resolve) => setTimeout(resolve, 500));
          await privateBrowser.close();
        })();
    },
  });
  assert.ok(privateRecording.videoManifest);
  await actions;
  for (const frame of JSON.parse(await readFile(privateRecording.videoManifest, "utf8")).frames) {
    const pixel: Buffer = await sharp(
      path.join(path.dirname(privateRecording.videoManifest), frame.file),
    )
      .extract({ left: 200, top: 150, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    assert.ok((pixel[1] || 0) > 200, "cross-origin embedded card fields never enter video frames");
  }
});
