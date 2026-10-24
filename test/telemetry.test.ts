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
  multipart,
  processNextPendingScan,
  publishHtml,
  queueHtmlWithToken,
  scannerState,
  test,
} from "./server-fixture.js";

const { collectorUserAgent, createTelemetryTransport, recordErrorTelemetry, serverTelemetry } =
  await import("../src/telemetry.js");

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

test("only publishing routes emit upload rejection events, including storage quota", {}, (t) => {
  const events: Array<{ name: string; data: unknown }> = [];
  t.mock.method(serverTelemetry, "send", (name: string, _url: string, data: unknown) => {
    events.push({ name, data });
  });
  recordErrorTelemetry(new AppError("Limited", 429, "rate_limited"), "/auth/shoo");
  assert.deepEqual(events, [{ name: "login-failure", data: { reason: "rate_limited" } }]);
  for (const route of [
    "/api/pages",
    "/api/files",
    "/api/guides/:slug/steps",
    "/api/presentations",
  ]) {
    for (const code of ["rate_limited", "storage_quota"]) {
      events.length = 0;
      recordErrorTelemetry(new AppError("Expected", 507, code), route);
      assert.deepEqual(events, [{ name: "upload-rejected", data: { reason: code } }]);
    }
  }
  events.length = 0;
  recordErrorTelemetry(new AppError("Limited", 429, "rate_limited"), "/admin/tokens");
  assert.deepEqual(events, []);
});

test("background cleanup and worker exceptions reach Sentry while expected states are skipped", {}, async (t) => {
  const { Sentry } = await import("../src/instrumentation.js");
  const { captureBackgroundError } = await import("../src/telemetry.js");
  const { buildServer } = await import("../src/server.js");
  const captured: unknown[] = [];
  t.mock.method(Sentry.getCurrentScope(), "captureException", (error: unknown) => {
    captured.push(error);
    return "fixture-event";
  });
  for (const code of ["scanner_unavailable", "storage_quota"])
    captureBackgroundError(new AppError("Expected", 503, code));
  assert.deepEqual(captured, []);
  const cleanupError = new Error("Fixture cleanup failed");
  const scanError = new Error("Fixture scan worker failed");
  const database = db();
  const prepare = database.prepare;
  t.mock.method(database, "prepare", (sql: string) => {
    if (sql.includes("purge_at IS NOT NULL")) throw cleanupError;
    if (sql.includes("SELECT type FROM")) throw scanError;
    return prepare.call(database, sql);
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const hour = 60 * 60 * 1000;
  const background = buildServer({ scanIntervalMs: hour });
  t.after(() => background.close());
  await delay(0);
  assert.deepEqual(captured, [cleanupError], "initial cleanup is reported");
  t.mock.timers.tick(hour);
  await delay(0);
  assert.equal(
    captured.filter((error) => error === cleanupError).length,
    2,
    "interval cleanup is reported",
  );
  assert.equal(
    captured.filter((error) => error === scanError).length,
    1,
    "worker catch is reported",
  );
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
      SchaffaScrub: browserScrubber(),
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
                      pagePath: pathname,
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

test("analytics bounds and clears its loading queue and counts visible errors once", async () => {
  for (const outcome of [
    "ready",
    "queued-error",
    "sent-error",
    "visible-error",
    "withdrawn",
    "failed",
    "missing",
  ]) {
    interface Script {
      src: string;
      onload(): void;
      onerror(): void;
    }
    const scripts: Script[] = [];
    const events: Array<{ name: string; data: Record<string, string | boolean> }> = [];
    const tracker = {
      track: (name: string, data: Record<string, string | boolean>) => {
        events.push({ name, data: JSON.parse(JSON.stringify(data)) });
      },
    };
    let accepted = false;
    let sync = () => {};
    const window = {
      SchaffaScrub: browserScrubber(),
      addEventListener() {},
      umami: undefined as typeof tracker | undefined,
      schaffaTelemetry: undefined as { track: typeof tracker.track } | undefined,
      CookieConsent: {
        acceptedCategory: () => accepted,
        run: async (options: { onConsent(): void; onChange(): void }) => {
          sync = options.onChange;
          options.onConsent();
        },
      },
    };
    vm.runInNewContext(
      readFileSync(new URL("../public/scripts/telemetry.js", import.meta.url), "utf8"),
      {
        window,
        setTimeout,
        location: { hostname: "schaffa.dev", pathname: "/account", replace() {} },
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
              : selector === ".error:not([hidden])" && outcome.endsWith("-error")
                ? {}
                : null,
          createElement: () => ({ setAttribute() {} }),
          head: {
            append: (script: Script) => {
              if (script.src.endsWith("/script.js")) scripts.push(script);
              else script.onload();
            },
          },
        },
      },
    );
    await delay(0);
    const telemetry = window.schaffaTelemetry;
    assert.ok(telemetry);
    telemetry.track("before-consent", {});
    accepted = true;
    sync();
    if (outcome === "sent-error") window.umami = tracker;
    if (outcome === "queued-error" || outcome === "sent-error") {
      telemetry.track("error-shown", { area: "sign-in" });
    } else if (outcome !== "visible-error") {
      for (let index = 0; index < 25; index++) telemetry.track(`event-${index}`, { pending: true });
    }
    if (outcome !== "sent-error")
      assert.deepEqual([...events], [], "no delivery before the script loads");
    const script = scripts[0];
    assert.ok(script);
    if (outcome === "ready" || outcome.endsWith("-error")) {
      window.umami = tracker;
      script.onload();
      await delay(0);
      if (outcome === "ready") {
        assert.deepEqual(
          events,
          Array.from({ length: 20 }, (_, index) => ({
            name: `event-${index}`,
            data: { pending: true },
          })),
        );
      } else {
        const data = outcome === "visible-error" ? {} : { area: "sign-in" };
        assert.deepEqual(
          events,
          [{ name: "error-shown", data }],
          "each visible error is counted once",
        );
      }
      telemetry.track("after-ready", {});
      assert.equal(events.at(-1)?.name, "after-ready");
      continue;
    }
    if (outcome === "failed") script.onerror();
    else if (outcome === "missing") script.onload();
    else {
      accepted = false;
      sync();
      window.umami = tracker;
      script.onload();
    }
    await delay(0);
    telemetry.track("after-stop", {});
    assert.deepEqual([...events], []);
    accepted = false;
    sync();
    window.umami = undefined;
    accepted = true;
    sync();
    window.umami = tracker;
    scripts.at(-1)?.onload();
    await delay(0);
    assert.deepEqual([...events], [], "discarded events never return on a subsequent load");
    telemetry.track("fresh", {});
    assert.equal(events.at(-1)?.name, "fresh");
  }
});

test("browser analytics uses server route templates and a fixed path for unknown and error pages", async () => {
  const { telemetryHead } = await import("../src/telemetry-assets.js");
  config.telemetry = {
    ...config.telemetry,
    umamiUrl: "https://metrics.invalid",
    umamiWebsiteId: "fixture",
  };
  for (const [pathname, route, status, expected] of [
    ["/", "/", 200, "/"],
    ["/skills", "/skills", 200, "/skills"],
    ["/privacy", "/privacy", 200, "/privacy"],
    [
      "/account/tokens/private-id/revoke",
      "/account/tokens/:id/revoke",
      200,
      "/account/tokens/:id/revoke",
    ],
    [
      "/account/pages/private-slug/versions/2/delete",
      "/account/pages/:slug/versions/:version/delete",
      200,
      "/account/pages/:slug/versions/:version/delete",
    ],
    [
      "/account/files/private-id/delete",
      "/account/files/:id/delete",
      200,
      "/account/files/:id/delete",
    ],
    ["/unknown-private-path", undefined, 404, "/404"],
    ["/unknown-private-path", undefined, 200, "/404"],
    ["/account/tokens/private-id/revoke", "/account/tokens/:id/revoke", 403, "/404"],
    ["/privacy", "/privacy", 500, "/404"],
  ] as const) {
    const head = telemetryHead(route, status);
    const encoded = /name="schaffa-telemetry" content="([^"]*)"/.exec(head)?.[1] || "";
    const content = encoded.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    const window = {
      SchaffaScrub: browserScrubber(),
      addEventListener() {},
      CookieConsent: {
        acceptedCategory: () => true,
        run: async (options: { onConsent(): void }) => options.onConsent(),
      },
    };
    vm.runInNewContext(
      readFileSync(new URL("../public/scripts/telemetry.js", import.meta.url), "utf8"),
      {
        window,
        setTimeout,
        location: { hostname: "schaffa.dev", pathname, search: "", hash: "" },
        document: {
          readyState: "complete",
          addEventListener() {},
          querySelector: (selector: string) =>
            selector.startsWith("meta") ? { getAttribute: () => content } : null,
          createElement: () => ({ setAttribute() {} }),
          head: { append: (script: { onload(): void }) => script.onload() },
        },
      },
    );
    await delay(0);
    const beforeSend = (
      window as typeof window & {
        schaffaUmamiBeforeSend(type: string, payload: object): { url: string };
      }
    ).schaffaUmamiBeforeSend;
    assert.equal(beforeSend("event", { url: pathname }).url, expected);
  }
});

test("token copy events wait for successful clipboard completion and skip denied writes", async () => {
  for (const succeeds of [true, false]) {
    const events: string[] = [];
    let click = async () => {};
    let complete = () => {};
    class Select {
      value = "macos";
      addEventListener() {}
      replaceChildren() {}
    }
    const os = new Select();
    const target = new Select();
    const source = { textContent: "fixture-token" };
    const button = {
      textContent: "Copy",
      getAttribute: () => "[data-token-value]",
      addEventListener: (_name: string, handler: typeof click) => {
        click = handler;
      },
    };
    const reveal = {
      querySelector: (selector: string) => {
        if (selector === "select[data-token-os]") return os;
        if (selector === "select[data-token-target]") return target;
        if (selector === "[data-token-value]") return source;
        return { textContent: "" };
      },
      querySelectorAll: () => [button],
    };
    vm.runInNewContext(
      readFileSync(new URL("../public/scripts/token-setup.js", import.meta.url), "utf8"),
      {
        HTMLSelectElement: Select,
        DOMException,
        navigator: {
          platform: "Linux",
          clipboard: {
            writeText: () =>
              new Promise<void>((resolve, reject) => {
                complete = () =>
                  succeeds ? resolve() : reject(new DOMException("Denied", "NotAllowedError"));
              }),
          },
        },
        window: {
          setTimeout() {},
          getSelection: () => null,
          schaffaTelemetry: { track: (name: string) => events.push(name) },
        },
        document: {
          querySelector: () => reveal,
          createElement: () => ({}),
          createRange: () => ({ selectNodeContents() {} }),
        },
      },
    );
    const pending = click();
    assert.deepEqual(events, [], "a pending write is not a successful copy");
    complete();
    await pending;
    assert.deepEqual(events, succeeds ? ["token-copied"] : []);
    assert.equal(button.textContent, succeeds ? "Kopiert" : "Markiert");
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
            SchaffaScrub: browserScrubber(),
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

function browserScrubber() {
  const context: {
    URL: typeof URL;
    SchaffaScrub?: typeof import("../src/telemetry-scrub-core.js");
  } = { URL };
  vm.runInNewContext(
    readFileSync(new URL("../public/vendor/telemetry-scrub.js", import.meta.url), "utf8"),
    context,
  );
  assert.ok(context.SchaffaScrub);
  return context.SchaffaScrub;
}

test("shared scrubber is served immutably before the client without exposing a source map", async () => {
  const { telemetryAssets, telemetryHead } = await import("../src/telemetry-assets.js");
  config.telemetry = {
    ...config.telemetry,
    umamiUrl: "https://metrics.invalid",
    umamiWebsiteId: "fixture",
  };
  const head = telemetryHead("/account", 200);
  const scrubScript = `<script src="${telemetryAssets.scrub.url}"></script>`;
  assert.ok(head.includes(scrubScript));
  assert.ok(
    head.indexOf(scrubScript) < head.indexOf(`<script src="${telemetryAssets.client.url}"`),
  );
  const response = await app.inject({
    url: telemetryAssets.scrub.url,
    headers: { host: "schaffa.dev" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.match(response.headers["content-type"] || "", /application\/javascript/);
  assert.equal(response.body, telemetryAssets.scrub.body.toString());
  assert.doesNotMatch(response.body, /sourceMappingURL|node:|AppError/);
  assert.equal(
    (
      await app.inject({
        url: `${telemetryAssets.scrub.url}.map`,
        headers: { host: "schaffa.dev" },
      })
    ).statusCode,
    404,
  );
});

test("server and browser scrubbers remove private values, request data, users and URL secrets", () => {
  const browser = browserScrubber();
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
  assert.deepEqual(JSON.parse(JSON.stringify(browser.scrubTelemetry(input))), server);
  assert.equal(JSON.stringify(server).includes("secret"), false);
  assert.equal(JSON.stringify(server).includes("person@example.com"), false);
  assert.equal("user" in server, false);
  assert.equal(scrubText("https://schaffa.dev/a?private=1#fragment"), "https://schaffa.dev/a");
});

test("server Sentry events omit concrete request URLs and retain route-template transactions", async () => {
  const { scrubServerEvent } = await import("../src/instrumentation.js");
  for (const transaction of ["POST /account/pages/:slug/versions/:version/delete", undefined]) {
    const event = scrubServerEvent({
      ...(transaction ? { transaction } : {}),
      request: {
        method: "POST",
        url: "https://schaffa.dev/account/pages/private-slug/versions/private-version/delete?secret=1",
      },
    });
    assert.deepEqual(event.request, { method: "POST" });
    assert.equal(event.transaction, transaction);
    assert.doesNotMatch(JSON.stringify(event), /private-slug|private-version|secret/);
  }
  assert.deepEqual(scrubServerEvent({ message: "Background failure" }), {
    message: "Background failure",
  });
});

test("browser Sentry hooks normalize request, breadcrumb and transaction URLs without exposing IDs", async () => {
  for (const pagePath of ["/account/pages/:slug/versions/:version/delete", "/404", "/skills"]) {
    const pathname = "/account/pages/private-slug/versions/private-version/delete";
    const url = `https://schaffa.dev${pathname}?secret=1#private`;
    const hooks: Record<string, (event: unknown) => unknown> = {};
    const integration = () => ({});
    const sdk = {
      init: (options: typeof hooks) => Object.assign(hooks, options),
      eventFiltersIntegration: integration,
      dedupeIntegration: integration,
      linkedErrorsIntegration: integration,
      globalHandlersIntegration: integration,
      breadcrumbsIntegration: integration,
      browserTracingIntegration: integration,
    };
    vm.runInNewContext(
      readFileSync(new URL("../public/scripts/telemetry.js", import.meta.url), "utf8"),
      {
        URL,
        window: {
          SchaffaScrub: browserScrubber(),
          Sentry: sdk,
          addEventListener() {},
          removeEventListener() {},
          requestIdleCallback: (callback: () => void) => callback(),
        },
        console: { error() {} },
        location: { origin: "https://schaffa.dev", hostname: "schaffa.dev", pathname },
        document: {
          readyState: "complete",
          addEventListener() {},
          querySelector: () => ({
            getAttribute: () =>
              JSON.stringify({ baseHost: "schaffa.dev", glitchtipDsn: "fixture", pagePath }),
          }),
          createElement: () => ({}),
          head: { append: (script: { onload(): void }) => script.onload() },
        },
      },
    );
    await delay(0);
    for (const name of ["beforeSend", "beforeSendTransaction"]) {
      const result = JSON.parse(
        JSON.stringify(
          hooks[name]?.({
            request: { url },
            transaction: pathname,
            breadcrumbs: [
              { data: { url, from: pathname, to: "/account/tokens/private-token/revoke" } },
            ],
            spans: [
              { description: `POST ${url}` },
              { description: "GET /account/tokens/private-token/revoke" },
            ],
          }),
        ),
      );
      assert.equal(result.request.url, pagePath);
      assert.equal(result.transaction, pagePath);
      assert.equal(result.spans[0].description, pagePath);
      assert.equal(result.spans[1].description, "/[redacted]");
      assert.doesNotMatch(
        JSON.stringify(result),
        /private-slug|private-version|private-token|secret/,
      );
    }
    const breadcrumb = hooks.beforeBreadcrumb?.({
      data: { url, from: pathname },
      message: "Navigation",
    });
    assert.doesNotMatch(JSON.stringify(breadcrumb), /private-slug|private-version|secret/);
  }
});

test("scrubbers preserve email and path redaction and handle long adversarial inputs quickly", () => {
  const browser = browserScrubber();
  for (const [value, expected] of [
    ["first.last+tag@sub.example.co.uk", "[email]"],
    ["user@[127.0.0.1]", "[email]"],
    ["user@[IPv6:2001:db8::1]", "[email]"],
    ['"a b"@[10.0.0.1]', "[email]"],
    ["user@EXAMPLE.COM", "[email]"],
    ["user@example.com.", "[email]"],
    ["user@xn--bcher-kva.xn--p1ai", "[email]"],
    ["user@e\u0301xample.com", "[email]"],
    ["user@[other@domain.com] next@example.org", "[email] [email]"],
    [`user@[${"a".repeat(64)}]`, "[email]"],
    [`user@[${"a".repeat(65)}]`, `user@[${"a".repeat(65)}]`],
    ["user@[]", "user@[]"],
    ['"john doe"@example.com', "[email]"],
    [String.raw`"john\"doe"@example.com`, "[email]"],
    [String.raw`"john\" doe"@example.com`, "[email]"],
    [String.raw`"john\\"@example.com`, "[email]"],
    [String.raw`prefix "john\" doe"@example.com suffix`, "prefix [email] suffix"],
    ['john doe"@example.com', "[email]"],
    ['"first name"@example.com "second name"@example.org', "[email] [email]"],
    ["e\u0301@example.com", "[email]"],
    ["o'connor@example.com", "[email]"],
    ["用户@example.com", "[email]"],
    ["mailto:a@b.de", "mailto:[email]"],
    ["<x@y.org>", "<[email]>"],
    ["(a@b.de, x@y.org; mailto:z@t.io", "([email], [email]; mailto:[email]"],
    [
      "@sentry/node @scope/pkg user@localhost @decorator",
      "@sentry/node @scope/pkg user@localhost @decorator",
    ],
    ["o'connor@example.com a!b=c@example.com", "[email] [email]"],
    ["!#$%&'*+/=?^_`{|}~.-@example.com", "[email]"],
    ["jörg@example.com 用户@example.com", "[email] [email]"],
    ["用户@例子.公司 𐐀name@例子.公司", "[email] [email]"],
    ["a@b.com1c@d.com", "[email][email]"],
    ["a@b.c+cc@d.ee", "[email]"],
    ["a@.com a@b.c a@@b.com", "a@.com a@b.c [email]"],
    ["a@example.com123! next@example.org", "[email]123! [email]"],
    ["/path/no-query /a/b?private=yes#fragment /c/d#private", "/path/no-query /a/b /c/d"],
  ]) {
    assert.equal(scrubText(value || ""), expected);
    assert.equal(browser.scrubTelemetry(value), expected);
  }
  const started = performance.now();
  for (const adversarial of [
    `${"a".repeat(100_000)} ${"/".repeat(100_000)} a@${"a.".repeat(50_000)}`,
    `${"a".repeat(100_000)}${"@".repeat(100_000)}`,
    "@[".repeat(50_000),
  ]) {
    assert.equal(scrubText(adversarial), adversarial);
    assert.equal(browser.scrubTelemetry(adversarial), adversarial);
  }
  const quotedAdversarial = ['"', String.raw`\" `.repeat(25_000), 'end"@example.com'].join("");
  assert.equal(scrubText(quotedAdversarial), "[email]");
  assert.equal(browser.scrubTelemetry(quotedAdversarial), "[email]");
  assert.ok(performance.now() - started < 1000, "both scrubbers finish within one second");
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
      (event) =>
        event.name === "content-published" &&
        event.data.kind === "presentation" &&
        event.data.owner === "operator",
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

test("file publications report a bounded format and owner category without identifiers", {}, async (t) => {
  const { createUserSession } = await import("../src/users.js");
  const { publishedFileFormat } = await import("../src/telemetry.js");
  assert.deepEqual(
    [
      "image/png",
      "video/mp4",
      "application/pdf",
      "text/plain; charset=utf-8",
      "application/json",
      "application/zip",
      "application/octet-stream",
    ].map(publishedFileFormat),
    ["image", "video", "pdf", "text", "text", "archive", "other"],
  );
  config.telemetry = {
    ...config.telemetry,
    umamiUrl: "https://metrics.invalid",
    umamiWebsiteId: "fixture",
  };
  const events: Array<{ name: string; data: Record<string, string | boolean> }> = [];
  t.mock.method(serverTelemetry, "send", (name: string, _url: string, data = {}) =>
    events.push({ name, data }),
  );
  const owner = createUserSession({ subject: "telemetry-file-owner" }).user;
  const token = createToken("telemetry file owner", ["upload"], owner.id);
  const body = multipart("file", "notes.txt", "text/plain", "plain notes");
  const upload = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.dev",
      authorization: `Bearer ${token.token}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(upload.statusCode, 202);
  await finishPendingScans();
  assert.deepEqual(
    events.filter((event) => event.name === "content-published").map((event) => event.data),
    [{ kind: "file", anonymous: false, interactive: false, format: "text", owner: "user" }],
  );
});

test("publications skip telemetry work when Umami is disabled", {}, async (t) => {
  const { createGuide, addGuideStep } = await import("../src/guides.js");
  const events: string[] = [];
  const original = serverTelemetry.send;
  serverTelemetry.send = (name) => {
    events.push(name);
  };
  t.after(() => {
    serverTelemetry.send = original;
  });
  await publishHtml("telemetry-disabled-publication", "<!doctype html><title>Disabled</title>");
  const auth = { host: "schaffa.dev", authorization: `Bearer ${bootstrapToken}` };
  const body = multipart("file", "disabled.txt", "text/plain", "disabled");
  const file = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: { ...auth, "content-type": body.contentType },
    payload: body.payload,
  });
  assert.equal(file.statusCode, 202);
  await finishPendingScans();
  const tokenId = db()
    .prepare("SELECT id FROM tokens WHERE scopes LIKE '%admin%' LIMIT 1")
    .get() as {
    id: string;
  };
  const guide = createGuide({ title: "Disabled telemetry guide" }, tokenId.id);
  const edited = await addGuideStep(
    guide.slug,
    { title: "Step", description: "Text step", capture: false },
    undefined,
    tokenId.id,
    false,
    guide.editRevision,
  );
  const finished = await app.inject({
    method: "POST",
    url: `/api/guides/${guide.slug}/finish`,
    headers: { ...auth, "if-match": `"${edited.editRevision}"` },
  });
  assert.equal(finished.statusCode, 201);
  assert.deepEqual(events, []);
});

test("scanner retries emit no failures while terminal policy rejection is counted once", {}, async (t) => {
  const events: string[] = [];
  t.mock.method(serverTelemetry, "send", (name: string) => events.push(name));
  const queued = await queueHtmlWithToken(
    "telemetry-scan-retry",
    "<!doctype html><title>Retry</title>",
    bootstrapToken,
  );
  assert.equal(queued.statusCode, 202);
  scannerState.mode = "unavailable";
  for (let attempt = 0; attempt < 2; attempt++) {
    db().exec("UPDATE page_versions SET scan_attempted_at = NULL WHERE scan_status = 'pending'");
    assert.equal((await processNextPendingScan()).status, "pending");
  }
  assert.deepEqual(events, []);
  scannerState.mode = "infected";
  db().exec("UPDATE page_versions SET scan_attempted_at = NULL WHERE scan_status = 'pending'");
  assert.equal((await processNextPendingScan()).status, "rejected");
  assert.deepEqual(events, ["scan-rejected"]);
  await processNextPendingScan();
  assert.deepEqual(events, ["scan-rejected"]);
});
