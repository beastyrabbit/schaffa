import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import {
  app,
  assert,
  bootstrapToken,
  config,
  createToken,
  db,
  finishPendingScans,
  sharp,
  test,
} from "./server-fixture.js";

const exec = promisify(execFile);
const { findBrowserExecutable, recordBrowserGuide } = (await import(
  new URL("../packages/cli/dist/recorder.js", import.meta.url).href
)) as typeof import("../packages/cli/src/recorder.js");

test("local presentation assets, screenshot keyboard navigation, and browser recording work in Chrome", {}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  config.baseHost = "127.0.0.1";
  config.cookieSecure = false;
  config.maxStorageBytes = 32 * 1024 * 1024;
  config.maxPageBytes = 4 * 1024 * 1024;
  app.get("/fixture", async (_request, reply) =>
    reply
      .type("text/html")
      .send(
        '<!doctype html><title>Recording fixture</title><h1>Recording fixture</h1><button type="button">Continue</button>',
      ),
  );
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  config.baseUrl = origin;
  const executablePath = findBrowserExecutable(process.env.SCHAFFA_TEST_BROWSER);
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const screenshot = await sharp({
    create: { width: 960, height: 540, channels: 3, background: "#195770" },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(directory, "local.png"), screenshot);
  const source = path.join(directory, "deck.md");
  await writeFile(
    source,
    "---\nmarp: true\n---\n# Local image fixture\n![width:600](local.png)\n\n---\n![bg](local.png)\n# Background image fixture\n",
  );
  const cli = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));
  const published = await exec(
    process.execPath,
    [cli, "publish", source, "--kind", "presentation", "--json"],
    { env: { PATH: process.env.PATH, SCHAFFA_TOKEN: bootstrapToken, SCHAFFA_URL: origin } },
  );
  await finishPendingScans();
  const publication = JSON.parse(published.stdout) as { publicUrl: string };
  const page = await browser.newPage();
  await page.goto(publication.publicUrl);
  await page.waitForFunction(
    () =>
      [...document.images].length > 0 &&
      [...document.images].every((image) => image.complete && image.naturalWidth > 0),
  );
  assert.equal(await page.$$eval('img[src="local.png"]', (images) => images.length), 0);
  assert.ok(
    await page.evaluate(() =>
      [...document.querySelectorAll("*")].some((element) =>
        getComputedStyle(element).backgroundImage.includes("data:image/png"),
      ),
    ),
  );
  if (process.env.SCHAFFA_TEST_EVIDENCE_DIR) {
    await mkdir(process.env.SCHAFFA_TEST_EVIDENCE_DIR, { recursive: true });
    await page.setViewport({ width: 1280, height: 850 });
    await page.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "presentation.png"),
    });
  }
  const headers = { authorization: `Bearer ${bootstrapToken}`, "content-type": "application/json" };
  const created = await fetch(`${origin}/api/guides`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Guide screenshot fixture", language: "en" }),
  });
  const guide = await created.json();
  const form = new FormData();
  form.set(
    "step",
    JSON.stringify({
      title: "Inspect the screenshot",
      description: "Open the screenshot with the keyboard, then return to the guide.",
    }),
  );
  form.set(
    "screenshot",
    new Blob([new Uint8Array(screenshot)], { type: "image/png" }),
    "fixture.png",
  );
  const added = await fetch(`${origin}/api/guides/${guide.slug}/steps`, {
    method: "POST",
    headers: { authorization: `Bearer ${bootstrapToken}`, "if-match": String(guide.editRevision) },
    body: form,
  });
  assert.equal(added.status, 201);
  const draft = await added.json();
  const finished = await fetch(`${origin}/api/guides/${guide.slug}/finish`, {
    method: "POST",
    headers: { ...headers, "if-match": String(draft.editRevision) },
    body: "{}",
  });
  assert.equal(finished.status, 201);
  const result = await finished.json();
  await page.goto(result.guide.publicUrl);
  assert.equal(await page.$('[aria-modal="true"]'), null);
  await page.focus(".screenshot-link");
  if (process.env.SCHAFFA_TEST_EVIDENCE_DIR) {
    await page.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "guide-focus.png"),
    });
  }
  const popup = new Promise<import("puppeteer-core").Page | null>((resolve) =>
    page.once("popup", resolve),
  );
  await page.keyboard.press("Enter");
  const enlarged = await popup;
  assert.ok(enlarged);
  await enlarged.waitForFunction(() => document.images[0]?.naturalWidth === 960);
  if (process.env.SCHAFFA_TEST_EVIDENCE_DIR) {
    await enlarged.setViewport({ width: 1280, height: 850 });
    await enlarged.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "guide-enlarged.png"),
    });
  }
  await enlarged.close();
  await page.bringToFront();
  assert.equal(await page.evaluate(() => document.activeElement?.className), "screenshot-link");
  if (process.env.SCHAFFA_TEST_EVIDENCE_DIR) {
    await page.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "guide-return.png"),
    });
  }
  if (process.env.SCHAFFA_TEST_EVIDENCE_DIR) {
    await page.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "guide.png"),
      fullPage: true,
    });
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "guide-mobile.png"),
      fullPage: true,
    });
  }
  const imageUrl = draft.steps[0].screenshotUrl;
  assert.match((await fetch(imageUrl)).headers.get("cache-control") || "", /max-age=300/);
  assert.match((await fetch(result.revisionUrl)).headers.get("cache-control") || "", /max-age=300/);
  const recordingGuide = await (
    await fetch(`${origin}/api/guides`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Browser capture fixture", language: "en" }),
    })
  ).json();
  const captureBrowser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => captureBrowser.close());
  const recording = await recordBrowserGuide({
    guide: recordingGuide,
    token: bootstrapToken,
    baseUrl: origin,
    url: `${origin}/fixture`,
    language: "en",
    browserExecutable: executablePath,
    outputDirectory: path.join(directory, "recording"),
    profileDirectory: path.join(directory, "profile"),
    launchBrowser: async () => captureBrowser,
    onMessage: (message) => {
      if (message.startsWith("Recording."))
        void captureBrowser.pages().then(async ([tab]) => {
          await tab?.click("button");
        });
      if (message.startsWith("Step 2 uploaded")) void captureBrowser.close();
    },
  });
  assert.equal(recording.failedUploads, 0);
  assert.equal(recording.guide.steps.length, 2);
  const manifest = JSON.parse(await readFile(recording.manifestPath, "utf8"));
  assert.ok(manifest.steps.every((step: { screenshot: string }) => step.screenshot));
  const insert = db().prepare(
    "INSERT INTO files(id,filename,storage_path,media_type,bytes,sha256,created_by_token_id) VALUES(?,?,?,'text/plain',1,'fixture','bootstrap')",
  );
  for (let index = 0; index < 60; index++)
    insert.run(
      `browser-fixture-${index}`,
      `review-fixture-${String(index).padStart(2, "0")}.txt`,
      "fixture",
    );
  await page.setExtraHTTPHeaders({ cookie: `__Secure-schaffa_admin=${bootstrapToken}` });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${origin}/admin?kind=files&q=review-fixture`);
  assert.equal(await page.$$eval("#files tbody tr", (rows) => rows.length), 50);
  await page.click(".pagination a");
  await page.waitForFunction(() =>
    document.querySelector(".pagination")?.textContent?.includes("Seite 2 von 2"),
  );
  assert.equal(await page.$$eval("#files tbody tr", (rows) => rows.length), 10);
  if (process.env.SCHAFFA_TEST_EVIDENCE_DIR) {
    await page.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "admin-pagination.png"),
      fullPage: true,
    });
  }
  await page.goto(`${origin}/admin`);
  await page.$eval('form[action="/admin/tokens"]', (form) => {
    const input = form.querySelector<HTMLSelectElement>('[name="scope"]');
    if (input) input.remove();
    (form as HTMLFormElement).submit();
  });
  await page.waitForFunction(
    () => document.querySelector("h1")?.textContent === "Aktion fehlgeschlagen",
  );
  assert.ok(await page.$('a[href="/admin"]'));
  if (process.env.SCHAFFA_TEST_EVIDENCE_DIR) {
    await page.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "management-error.png"),
    });
  }
  await page.setExtraHTTPHeaders({});
  const { createUserSession } = await import("../src/users.js");
  const { updateInstanceSettings } = await import("../src/settings.js");
  const { publishPage } = await import("../src/service.js");
  const user = createUserSession({ subject: "browser-sandbox-fixture" }).user;
  db().prepare("UPDATE users SET can_publish_interactive = 1 WHERE id = ?").run(user.id);
  updateInstanceSettings({ interactivePublishingEnabled: true });
  const interactiveToken = createToken("Sandbox fixture", ["interactive"], user.id);
  const interactive = await publishPage({
    slug: "sandbox-fixture",
    operation: "create",
    tokenId: interactiveToken.id,
    kind: "interactive",
    html: Buffer.from(
      '<!doctype html><title>Sandbox fixture</title><h1>Sandbox fixture</h1><script>document.body.dataset.ready="yes";fetch("/fixture").then(()=>document.body.dataset.fetch="allowed",()=>document.body.dataset.fetch="blocked");try{localStorage.setItem("fixture","1");document.body.dataset.storage="allowed"}catch{document.body.dataset.storage="blocked"}</script>',
    ),
  });
  await finishPendingScans();
  await page.goto(`${interactive.publicUrl}/run`);
  await page.waitForFunction(() => document.body.dataset.fetch === "blocked");
  assert.equal(await page.evaluate(() => document.body.dataset.ready), "yes");
  assert.equal(await page.evaluate(() => document.body.dataset.storage), "blocked");
});
