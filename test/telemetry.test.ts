import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import { AppError } from "../src/errors.js";
import { parseTelemetryConfig } from "../src/telemetry-config.js";
import { scrubTelemetry, scrubText, shouldReportServerError } from "../src/telemetry-scrub.js";
import {
  app,
  assert,
  bootstrapToken,
  config,
  createToken,
  db,
  finishPendingScans,
  publishHtml,
  test,
} from "./server-fixture.js";

const { collectorUserAgent, createTelemetryTransport, serverTelemetry } = await import(
  "../src/telemetry.js"
);

test("telemetry configuration is opt-in, validated, and release-aware", () => {
  const empty = parseTelemetryConfig({}, "1.2.3");
  assert.equal(empty.umamiUrl, "");
  assert.equal(empty.glitchtipDsn, "");
  assert.equal(empty.release, "schaffa@1.2.3");
  assert.equal(empty.environment, "development");
  assert.equal(parseTelemetryConfig({ NODE_ENV: "production" }, "1").environment, "production");
  for (const env of [
    { UMAMI_URL: "https://metrics.example" },
    { GLITCHTIP_DSN: "file:///tmp/1" },
    { GLITCHTIP_TRACES_SAMPLE_RATE: "-1" },
  ])
    assert.throws(() => parseTelemetryConfig(env, "1"));
});

test("aggregate transport sends only fixed metadata and skips bots and disabled collection", async () => {
  const calls: RequestInit[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(init || {});
    return new Response("{}");
  };
  const options = {
    url: "https://metrics.invalid",
    website: "site",
    hostname: "schaffa.dev",
    fetch: fetcher,
  };
  const telemetry = createTelemetryTransport(options);
  telemetry.send(
    "content-view",
    "/p/public-id?token=private#secret",
    { kind: "page" },
    "Visitor/1.0",
  );
  telemetry.send("content-view", "/p/public-id", {}, "Googlebot");
  createTelemetryTransport({ ...options, url: "" }).send("disabled", "/");
  await delay(0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.headers, {
    "content-type": "application/json",
    "user-agent": collectorUserAgent,
  });
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), {
    type: "event",
    payload: {
      website: "site",
      hostname: "schaffa.dev",
      url: "/p/public-id",
      name: "content-view",
      data: { kind: "page" },
    },
  });
  assert.equal(telemetry.stats.sent, 1);
});

test("aggregate transport bounds concurrent sends, aborts, counts and swallows failures without retries", async () => {
  let calls = 0;
  const telemetry = createTelemetryTransport({
    url: "https://metrics.invalid",
    website: "site",
    hostname: "site",
    maxInFlight: 1,
    timeoutMs: 5,
    fetch: async (_url, options) => {
      calls++;
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("timeout"))),
      );
    },
  });
  telemetry.send("first", "/");
  telemetry.send("dropped", "/");
  await delay(20);
  assert.deepEqual(telemetry.stats, { sent: 0, failed: 1, dropped: 1 });
  assert.equal(calls, 1);
  telemetry.send("capacity-recovered", "/");
  await delay(20);
  assert.equal(calls, 2);
});

test("aggregate transport holds capacity until response cancellation completes, including rejected responses", async () => {
  for (const status of [200, 503]) {
    let cancelled = false;
    let release = () => {};
    const telemetry = createTelemetryTransport({
      url: "https://metrics.invalid",
      website: "fixture",
      hostname: "site",
      maxInFlight: 1,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
              return new Promise<void>((resolve) => {
                release = resolve;
              });
            },
          }),
          { status },
        ),
    });
    telemetry.send("first", "/");
    await delay(0);
    assert.equal(cancelled, true);
    telemetry.send("dropped-while-cancelling", "/");
    assert.deepEqual(telemetry.stats, { sent: 0, failed: 0, dropped: 1 });
    release();
    await delay(0);
    assert.equal(status === 200 ? telemetry.stats.sent : telemetry.stats.failed, 1);
  }
});

test("server reporting skips known operational errors and keeps unexpected failures", () => {
  for (const code of [
    "interactive_disabled",
    "storage_quota",
    "scanner_unavailable",
    "writes_locked",
  ])
    assert.equal(shouldReportServerError(new AppError("Expected", 503, code)), false);
  assert.equal(shouldReportServerError(new AppError("Unauthorized", 401, "unauthorized")), false);
  assert.equal(shouldReportServerError(new AppError("Internal", 500, "internal_error")), true);
  assert.equal(shouldReportServerError(new AppError("Unknown", 503, "new_failure")), true);
  assert.equal(shouldReportServerError(new Error("Unexpected")), true);
});

test("client consent uses safe GET navigation and excludes account and secret pages from replay", async () => {
  for (const [pathname, secret, replay, destination] of [
    ["/account/tokens", true, false, "/account"],
    ["/account", false, false, "/account"],
    ["/skills", true, false, "https://schaffa.dev/skills"],
    ["/skills", false, true, "https://schaffa.dev/skills"],
  ] as const) {
    let accepted = true;
    let sync = () => {};
    let navigation = "";
    const scripts: string[] = [];
    const events: string[] = [];
    const window = {
      addEventListener() {},
      CookieConsent: {
        acceptedCategory: () => accepted,
        run: async (options: { onConsent(): void; onChange(): void }) => {
          sync = options.onChange;
          options.onConsent();
        },
      },
      umami: { track: (name: string) => events.push(name) },
    };
    vm.runInNewContext(
      readFileSync(new URL("../public/scripts/telemetry.js", import.meta.url), "utf8"),
      {
        window,
        setTimeout,
        location: {
          hostname: "schaffa.dev",
          pathname,
          search: "",
          hash: "",
          href: `https://schaffa.dev${pathname}`,
          replace: (url: string) => {
            navigation = url;
          },
        },
        document: {
          readyState: "complete",
          addEventListener() {},
          querySelector: (selector: string) =>
            selector.startsWith("meta")
              ? {
                  getAttribute: () =>
                    JSON.stringify({
                      baseHost: "schaffa.dev",
                      umamiUrl: "https://metrics.invalid",
                      consentJs: "/consent.js",
                    }),
                }
              : selector === "[data-token-reveal]" && secret
                ? {}
                : null,
          createElement: () => ({ src: "", setAttribute() {}, onload() {} }),
          head: {
            append: (script: { src: string; onload(): void }) => {
              scripts.push(script.src);
              script.onload();
            },
          },
        },
      },
    );
    await delay(0);
    assert.equal(scripts.includes("https://metrics.invalid/recorder.js"), replay);
    assert.equal(events.includes("token-created"), false);
    accepted = false;
    sync();
    assert.equal(navigation, destination);
  }
});

test("consent follows the document language and links only to enabled legal pages", async () => {
  interface Translation {
    consentModal: { description: string; acceptAllBtn: string; acceptNecessaryBtn: string };
    preferencesModal: { title: string; savePreferencesBtn: string; closeIconLabel: string };
  }
  for (const lang of ["de", "de-DE", "en"]) {
    for (const legalPages of [true, false]) {
      let language: { default: string; translations: Record<string, Translation> } | undefined;
      vm.runInNewContext(
        readFileSync(new URL("../public/scripts/telemetry.js", import.meta.url), "utf8"),
        {
          setTimeout,
          location: { hostname: "schaffa.dev", pathname: "/", hash: "" },
          window: {
            addEventListener() {},
            CookieConsent: {
              run: async (options: { language: typeof language }) => {
                language = options.language;
              },
            },
          },
          document: {
            readyState: "complete",
            documentElement: { lang },
            addEventListener() {},
            querySelector: () => ({
              getAttribute: () =>
                JSON.stringify({
                  baseHost: "schaffa.dev",
                  umamiUrl: "https://metrics.invalid",
                  consentJs: "/consent.js",
                  legalPages,
                }),
            }),
            createElement: () => ({ setAttribute() {} }),
            head: { append: (script: { onload(): void }) => script.onload() },
          },
        },
      );
      await delay(0);
      assert.ok(language);
      const german = lang.startsWith("de");
      assert.equal(language.default, german ? "de" : "en");
      const selected = language.translations[language.default];
      assert.ok(selected);
      assert.equal(
        selected.preferencesModal.title,
        german ? "Cookie-Einstellungen" : "Cookie settings",
      );
      assert.equal(
        selected.consentModal.acceptAllBtn,
        german ? "Analyse akzeptieren" : "Accept analytics",
      );
      assert.equal(
        selected.consentModal.acceptNecessaryBtn,
        german ? "Nur notwendige" : "Necessary only",
      );
      assert.equal(
        selected.preferencesModal.savePreferencesBtn,
        german ? "Auswahl speichern" : "Save preferences",
      );
      assert.equal(selected.preferencesModal.closeIconLabel, german ? "Schließen" : "Close");
      if (legalPages)
        assert.ok(
          selected.consentModal.description.includes(
            `href="/${german ? "datenschutz" : "privacy"}#privacy-10"`,
          ),
        );
      else assert.doesNotMatch(selected.consentModal.description, /<a|href=|privacy-10/);
    }
  }
});

test("account client shows server rejection without reporting it and reports network exceptions", async () => {
  for (const networkFailure of [false, true]) {
    const reports: unknown[] = [];
    const error = { hidden: true, textContent: "" };
    vm.runInNewContext(
      readFileSync(new URL("../public/scripts/account.js", import.meta.url), "utf8"),
      {
        window: {
          Shoo: { getIdentity: () => ({ token: "fixture" }) },
          schaffaTelemetry: { report: (cause: unknown) => reports.push(cause), track() {} },
        },
        document: {
          querySelector: () => ({ hasAttribute: () => false }),
          getElementById: (id: string) => (id === "auth-error" ? error : null),
        },
        fetch: async () => {
          if (networkFailure) throw new Error("Network failed");
          return { ok: false, json: async () => ({ message: "Sign-in disabled" }) };
        },
      },
    );
    await delay(0);
    assert.equal(error.hidden, false);
    assert.equal(reports.length, networkFailure ? 1 : 0);
    if (!networkFailure) assert.equal(error.textContent, "Sign-in disabled");
  }
});

test("server and browser scrubbers remove private values, request data, users and URL secrets", () => {
  const window: Record<string, unknown> = { addEventListener() {} };
  const context = {
    window,
    location: { hostname: "schaffa.dev", pathname: "/" },
    document: {
      readyState: "loading",
      querySelector: () => ({ getAttribute: () => JSON.stringify({ baseHost: "schaffa.dev" }) }),
    },
  };
  vm.runInNewContext(
    readFileSync(new URL("../public/scripts/telemetry.js", import.meta.url), "utf8"),
    context,
  );
  const browser = window.schaffaTelemetry as { scrub(value: unknown): unknown };
  const input = {
    user: { id: "private" },
    request: {
      headers: { Authorization: "Bearer secret", Cookie: "session=secret" },
      data: "private body",
      url: "https://schaffa.dev/account?token=secret#private",
    },
    message:
      "sfa_abcdefghijkl sus_session Bearer secret person@example.com eyJabc.def.ghi /account?code=secret#fragment",
  };
  const server = scrubTelemetry(input);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.scrub(input))), server);
  assert.equal(JSON.stringify(server).includes("secret"), false);
  assert.equal(JSON.stringify(server).includes("person@example.com"), false);
  assert.equal("user" in server, false);
  assert.equal(scrubText("https://schaffa.dev/a?private=1#fragment"), "https://schaffa.dev/a");
});

test("own UI gets configured CSP hosts, admin excludes analytics, privacy renders, and content stays byte-identical", async () => {
  for (const url of ["/", "/skills"]) {
    const plain = await app.inject({ url, headers: { host: "schaffa.dev" } });
    assert.doesNotMatch(plain.body, /schaffa-telemetry/);
    assert.equal(
      plain.headers["content-security-policy"],
      "default-src 'none'; img-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      "unconfigured telemetry preserves the original public UI CSP",
    );
  }
  config.telemetry = {
    ...config.telemetry,
    umamiUrl: "https://metrics.example",
    umamiWebsiteId: "4180ec33-490a-4f7b-a628-97ccf816f874",
    glitchtipDsn: "https://public@errors.example/1",
  };
  const own = await app.inject({ url: "/", headers: { host: "schaffa.dev" } });
  assert.match(
    String(own.headers["content-security-policy"]),
    /script-src 'self' https:\/\/metrics.example/,
  );
  assert.match(
    String(own.headers["content-security-policy"]),
    /connect-src 'self' https:\/\/metrics.example https:\/\/errors.example/,
  );
  assert.match(own.body, /schaffa-telemetry/);
  const admin = await app.inject({ url: "/admin", headers: { host: "schaffa.dev" } });
  assert.doesNotMatch(String(admin.headers["content-security-policy"]), /metrics.example/);
  assert.doesNotMatch(admin.body, /data-cc=/);
  const privacy = await app.inject({ url: "/privacy", headers: { host: "schaffa.dev" } });
  assert.equal(privacy.statusCode, 200);
  assert.match(privacy.body, /up to 10 years/);
  assert.match(privacy.body, /90 days/);
  assert.match(privacy.body, /Cookie settings/);
  const html = "<!doctype html><title>Untouched</title><h1>Published content</h1>";
  await publishHtml("telemetry-content", html);
  const content = await app.inject({
    url: "/p/telemetry-content",
    headers: { host: "schaffa.dev" },
  });
  assert.equal(content.body, html);
  assert.match(
    String(content.headers["content-security-policy"]),
    /script-src 'none'; connect-src 'none'/,
  );
  assert.doesNotMatch(String(content.headers["content-security-policy"]), /metrics|errors.example/);
});

test("deliberate telemetry error requires existing admin authentication", async () => {
  const denied = await app.inject({
    method: "POST",
    url: "/admin/api/telemetry-test",
    headers: { host: "schaffa.dev" },
  });
  assert.equal(denied.statusCode, 401);
  const allowed = await app.inject({
    method: "POST",
    url: "/admin/api/telemetry-test",
    headers: { host: "schaffa.dev", cookie: `__Secure-schaffa_admin=${bootstrapToken}` },
  });
  assert.equal(allowed.statusCode, 500);
});

test("content events classify presentations, skip HEAD/status/errors, and never expose maps", {}, async (t) => {
  config.telemetry = {
    ...config.telemetry,
    umamiUrl: "https://metrics.invalid",
    umamiWebsiteId: "fixture",
  };
  const send = serverTelemetry.send;
  const events: Array<{ name: string; url: string; data: Record<string, string | boolean> }> = [];
  serverTelemetry.send = (name, url, data = {}) => {
    events.push({ name, url, data });
  };
  t.after(() => {
    serverTelemetry.send = send;
  });
  await publishHtml(
    "telemetry-presentation",
    '<!doctype html><title>Deck</title><svg data-marpit-svg=""><text>Slide</text></svg>',
  );
  assert.ok(
    events.some(
      (event) => event.name === "content-published" && event.data.kind === "presentation",
    ),
  );
  events.length = 0;
  const headers = { host: "schaffa.dev" };
  await app.inject({ url: "/p/telemetry-presentation?private=never-forward", headers });
  assert.deepEqual(events, [
    { name: "content-view", url: "/p/telemetry-presentation", data: { kind: "presentation" } },
  ]);
  events.length = 0;
  await app.inject({ method: "HEAD", url: "/p/telemetry-presentation", headers });
  await app.inject({ url: "/p/telemetry-presentation/status", headers });
  await app.inject({ url: "/p/missing", headers });
  assert.equal(events.length, 0);
  for (const url of ["/dist/server.js.map", "/assets/telemetry-sentry.js.map"])
    assert.equal((await app.inject({ url, headers })).statusCode, 404);
});

test("content views exclude guide exports and interactive warnings, counting the run content once", {}, async (t) => {
  const { createGuide, addGuideStep, finishGuide } = await import("../src/guides.js");
  const { createUserSession } = await import("../src/users.js");
  const { publishPage } = await import("../src/service.js");
  const { updateInstanceSettings } = await import("../src/settings.js");
  const events: string[] = [];
  const original = serverTelemetry.send;
  serverTelemetry.send = (name, url) => {
    if (name === "content-view") events.push(url);
  };
  t.after(() => {
    serverTelemetry.send = original;
  });
  const owner = createUserSession({ subject: "telemetry-interactive-owner" }).user;
  db().prepare("UPDATE users SET can_publish_interactive = 1 WHERE id = ?").run(owner.id);
  const token = createToken("telemetry guide and interactive", ["upload", "interactive"], owner.id);
  const guide = createGuide({ title: "Telemetry guide" }, token.id);
  const edited = await addGuideStep(
    guide.slug,
    { title: "Step", description: "Text step", capture: false },
    undefined,
    token.id,
    false,
    guide.editRevision,
  );
  finishGuide(guide.slug, token.id, false, edited.editRevision);
  const headers = { host: "schaffa.dev" };
  for (const url of [`/g/${guide.slug}.json`, `/g/${guide.slug}.md`])
    assert.equal((await app.inject({ url, headers })).statusCode, 200);
  await app.inject({ url: "/g/x.json", headers });
  assert.deepEqual(events, []);
  assert.equal((await app.inject({ url: `/g/${guide.slug}`, headers })).statusCode, 200);
  assert.deepEqual(events, [`/g/${guide.slug}`]);
  events.length = 0;
  updateInstanceSettings({ interactivePublishingEnabled: true });
  t.after(() => {
    updateInstanceSettings({ interactivePublishingEnabled: false });
  });
  await publishPage({
    slug: "telemetry-interactive",
    operation: "create",
    kind: "interactive",
    tokenId: token.id,
    html: Buffer.from("<!doctype html><title>Interactive</title><h1>Content</h1>"),
  });
  await finishPendingScans();
  assert.equal((await app.inject({ url: "/p/telemetry-interactive", headers })).statusCode, 200);
  assert.deepEqual(events, []);
  assert.equal(
    (await app.inject({ url: "/p/telemetry-interactive/run", headers })).statusCode,
    200,
  );
  assert.deepEqual(events, ["/p/telemetry-interactive/run"]);
});

test("page scan publication skips telemetry work when Umami is disabled", {}, async (t) => {
  const events: string[] = [];
  const original = serverTelemetry.send;
  serverTelemetry.send = (name) => {
    events.push(name);
  };
  t.after(() => {
    serverTelemetry.send = original;
  });
  await publishHtml("telemetry-disabled-publication", "<!doctype html><title>Disabled</title>");
  assert.deepEqual(events, []);
});
