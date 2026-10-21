import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { assert, bootstrapToken, db, publishHtml, test } from "./server-fixture.js";

const { findBrowserExecutable } = (await import(
  new URL("../packages/cli/dist/recorder.js", import.meta.url).href
)) as typeof import("../packages/cli/src/recorder.js");
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("built app gates Umami, stops recorder on withdrawal, sends scrubbed GlitchTip errors and preserves published content", {}, async (t) => {
  let executablePath: string;
  try {
    executablePath = findBrowserExecutable(process.env.SCHAFFA_TEST_BROWSER);
  } catch (error) {
    if (process.env.CI || process.env.SCHAFFA_TEST_BROWSER) throw error;
    t.skip("Install Chrome or Chromium for telemetry browser acceptance.");
    return;
  }
  const envelopes: string[] = [];
  const umamiRequests: string[] = [];
  // Snapshot of the deployed 3.x tracker, fetched read-only on 2026-10-21.
  const tracker = await readFile(new URL("./fixtures/umami-script.txt", import.meta.url), "utf8");
  const stub = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "*");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    if (request.method === "OPTIONS") {
      response.end();
      return;
    }
    const url = request.url || "/";
    if (!url.startsWith("/api/1/")) umamiRequests.push(url);
    if (url === "/script.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(tracker);
      return;
    }
    if (url === "/recorder.js") {
      // Exercises persistent recorder activity and its unload flush without live replay ingestion.
      response.setHeader("Content-Type", "application/javascript");
      response.end(
        `(function(){const endpoint=document.currentScript.src.replace('recorder.js','api/record');function send(){if(window.umami?.getSession?.()?.cache)fetch(endpoint,{method:'POST',body:'record',keepalive:true})}setInterval(send,50);addEventListener('pagehide',send);send()})();`,
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    if (url.startsWith("/api/1/envelope/")) envelopes.push(body);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ cache: "local-test-session" }));
  });
  const telemetryOrigin = await listen(stub);
  t.after(
    () =>
      new Promise<void>((resolve) => {
        stub.closeAllConnections();
        stub.close(() => resolve());
      }),
  );
  const reserve = createServer();
  const origin = await listen(reserve);
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const html = "<!doctype html><title>Telemetry content fixture</title><h1>Byte-identical</h1>";
  await publishHtml("browser-telemetry-content", html);
  const child = spawn(
    process.execPath,
    ["--import", "./dist/instrumentation.js", "dist/server.js"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: new URL(origin).port,
        SCHAFFA_BASE_URL: origin,
        UMAMI_URL: telemetryOrigin,
        UMAMI_WEBSITE_ID: "4180ec33-490a-4f7b-a628-97ccf816f874",
        GLITCHTIP_DSN: `${telemetryOrigin.replace("://", "://public@")}/1`,
        GLITCHTIP_TRACES_SAMPLE_RATE: "0",
        SCHAFFA_ENVIRONMENT: "test",
        LOG_LEVEL: "silent",
      },
    },
  );
  let startupError = "";
  child.stderr.on("data", (chunk) => {
    startupError += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    startupError += String(chunk);
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Built server exited: ${startupError}`);
    if (
      await fetch(`${origin}/healthz`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await delay(50);
  }
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let tokenPosts = 0;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url() === `${origin}/account/tokens` && request.method() === "POST") tokenPosts++;
    if (
      request.url().startsWith(origin) ||
      request.url().startsWith(telemetryOrigin) ||
      request.url().startsWith("data:")
    )
      void request.continue();
    else void request.abort();
  });
  await page.evaluateOnNewDocument(() => {
    window.addEventListener(
      "DOMContentLoaded",
      () => {
        setTimeout(() => {
          throw new Error(
            "early telemetry browser fixture sfa_private person@example.com https://schaffa.test/a?secret=private",
          );
        }, 0);
      },
      { once: true },
    );
  });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${origin}/?secret=private#fragment`);
  await page.waitForSelector("#cc-main .cm", { visible: true });
  await page.waitForFunction(() => Boolean(window.Sentry));
  for (
    let attempt = 0;
    attempt < 100 && !envelopes.some((entry) => entry.includes("early telemetry browser fixture"));
    attempt++
  )
    await delay(25);
  assert.ok(
    envelopes.some((entry) => entry.includes("early telemetry browser fixture")),
    "early queued error reaches the local envelope stub",
  );
  assert.doesNotMatch(envelopes.join(""), /sfa_private|person@example.com|secret=private/);
  assert.equal(umamiRequests.length, 0, "no Umami connection before analytics consent");
  const storage = () =>
    page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      cookies: document.cookie
        .split(";")
        .map((part) => part.trim().split("=")[0])
        .filter(Boolean),
    }));
  assert.deepEqual(await storage(), { local: [], session: [], cookies: [] });
  if (process.env.SCHAFFA_TEST_EVIDENCE_DIR) {
    await page.waitForFunction(() => {
      const modal = document.querySelector("#cc-main .cm");
      return modal && getComputedStyle(modal).opacity === "1";
    });
    await mkdir(process.env.SCHAFFA_TEST_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "consent-desktop.png"),
    });
  }
  // Opening preferences must not persist an implicit choice.
  await page.click('#cc-main .cm [data-role="show"]');
  await page.waitForSelector("#cc-main .pm", { visible: true });
  assert.deepEqual(await storage(), { local: [], session: [], cookies: [] });
  await page.click('#cc-main .pm [data-role="all"]');
  await page.waitForFunction(() => Boolean(window.umami));
  for (let attempt = 0; attempt < 100 && !umamiRequests.includes("/api/send"); attempt++)
    await delay(25);
  assert.ok(umamiRequests.includes("/script.js"));
  assert.ok(umamiRequests.includes("/api/send"));
  assert.ok(!umamiRequests.includes("/recorder.js"), "recorder skips query and fragment URLs");
  assert.deepEqual(await storage(), { local: [], session: [], cookies: ["cc_cookie"] });
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(window.umami));
  for (let attempt = 0; attempt < 100 && !umamiRequests.includes("/api/record"); attempt++)
    await delay(25);
  assert.ok(umamiRequests.includes("/recorder.js"));
  assert.ok(umamiRequests.includes("/api/record"));
  await page.click('[data-cc="show-preferencesModal"]');
  await page.waitForSelector("#cc-main .pm", { visible: true });
  const navigation = page.waitForNavigation();
  await page.click('#cc-main .pm [data-role="necessary"]');
  await navigation;
  await page.waitForFunction(() => Boolean(window.CookieConsent));
  const stopped = umamiRequests.length;
  await delay(250);
  assert.equal(
    umamiRequests.length,
    stopped,
    "tracking and recorder activity stop after withdrawal",
  );
  assert.equal(await page.evaluate(() => Boolean(window.umami)), false);
  assert.deepEqual(await storage(), { local: [], session: [], cookies: ["cc_cookie"] });
  await page.setViewport({ width: 390, height: 844 });
  await page.click('[data-cc="show-preferencesModal"]');
  await page.waitForSelector("#cc-main .pm", { visible: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.SCHAFFA_TEST_EVIDENCE_DIR) {
    await page.waitForFunction(() => {
      const modal = document.querySelector("#cc-main .pm");
      return modal && getComputedStyle(modal).opacity === "1";
    });
    await page.screenshot({
      path: path.join(process.env.SCHAFFA_TEST_EVIDENCE_DIR, "consent-mobile.png"),
    });
  }
  // Exercise withdrawal from the actual POST-rendered page without resubmitting its form.
  const { createUserSession } = await import("../src/users.js");
  const session = createUserSession({ subject: "telemetry-browser-token-owner" });
  await browser.setCookie({
    name: "schaffa_user",
    value: session.token,
    domain: new URL(origin).hostname,
    path: "/account",
    httpOnly: true,
  });
  const recorderRequests = umamiRequests.filter((url) => url === "/recorder.js").length;
  await page.goto(`${origin}/account`);
  await page.waitForFunction(() => Boolean(window.CookieConsent));
  await page.evaluate(() => window.CookieConsent.acceptCategory("all"));
  await page.waitForFunction(() => Boolean(window.umami));
  assert.equal(umamiRequests.filter((url) => url === "/recorder.js").length, recorderRequests);
  await page.type(
    'form[action="/account/tokens"] input[name="name"]',
    "consent withdrawal fixture",
  );
  await Promise.all([
    page.waitForNavigation(),
    page.click('form[action="/account/tokens"] button[type="submit"]'),
  ]);
  await page.waitForSelector("[data-token-reveal]");
  await page.waitForFunction(() => Boolean(window.umami));
  assert.equal(umamiRequests.filter((url) => url === "/recorder.js").length, recorderRequests);
  const tokenCount = () =>
    (
      db()
        .prepare("SELECT COUNT(*) AS count FROM tokens WHERE user_id = ?")
        .get(session.user.id) as { count: number }
    ).count;
  assert.equal(tokenCount(), 1);
  await page.click('[data-cc="show-preferencesModal"]');
  await page.waitForSelector("#cc-main .pm", { visible: true });
  await Promise.all([page.waitForNavigation(), page.click('#cc-main .pm [data-role="necessary"]')]);
  assert.equal(new URL(page.url()).pathname, "/account");
  assert.equal(tokenPosts, 1);
  assert.equal(tokenCount(), 1, "withdrawal must not create a second token");
  assert.equal(await page.$("[data-token-reveal]"), null);
  const response = await page.goto(`${origin}/p/browser-telemetry-content`);
  assert.equal(await response?.text(), html);
  assert.equal(await page.$$eval("script", (scripts) => scripts.length), 0);
  assert.match(
    response?.headers()["content-security-policy"] || "",
    /script-src 'none'; connect-src 'none'/,
  );
  const denied = await fetch(`${origin}/admin/api/telemetry-test`, { method: "POST" });
  assert.equal(denied.status, 401);
  const deliberate = await fetch(`${origin}/admin/api/telemetry-test`, {
    method: "POST",
    headers: { cookie: `schaffa_admin=${bootstrapToken}` },
  });
  assert.equal(deliberate.status, 500);
  for (
    let attempt = 0;
    attempt < 100 && !envelopes.some((entry) => entry.includes("Schaffa GlitchTip test error"));
    attempt++
  )
    await delay(25);
  assert.ok(
    envelopes.some((entry) => entry.includes("Schaffa GlitchTip test error")),
    "built server reports through Fastify instrumentation",
  );
  assert.doesNotMatch(startupError, /beforeSendSpan|withStaticSpan/);
});
