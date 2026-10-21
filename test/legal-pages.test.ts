import type { LegalRoute } from "../src/legal-pages.js";
import { app, assert, bootstrapToken, config, publishHtml, test } from "./server-fixture.js";

const { legalRoutes } = await import("../src/legal-pages.js");
const { renderManagementError, renderScanStatusPage } = await import("../src/ui.js");

const host = { host: "schaffa.dev" };

void test("all legal routes render complete bilingual HTML without authentication or asset dependencies", async () => {
  for (const route of legalRoutes) {
    const response = await app.inject({ method: "GET", url: route, headers: host });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] || "", /^text\/html/);
    assert.equal(response.headers["x-robots-tag"], "noindex");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.body, /<meta name="robots" content="noindex">/);
    for (const text of [
      "Tobias Heer",
      "c/o Impressumservice Dein-Impressum",
      "Stettiner Str. 41",
      "35410 Hungen",
      "impressum-schaffa@heerlab.com",
      "datenschutz-schaffa@heerlab.com",
      'href="https://beastyrabbit.com/kontakt?from=schaffa"',
    ])
      assert.ok(response.body.includes(text), `${route}: ${text}`);
    assert.doesNotMatch(response.body, /(?:impressum|datenschutz)@heerlab\.com/);
    assert.doesNotMatch(response.body, /\[\[|<!--|MODULE|<script|<iframe|<img|@import|url\(/i);
    assert.doesNotMatch(response.body, /(?:src|href)="\/assets|rel="(?:manifest|stylesheet)"/);
    const german = route === "/impressum" || route === "/datenschutz";
    assert.ok(response.body.includes(`<html lang="${german ? "de" : "en"}">`));
    assertFooter(response.body, german);
    const counterparts: Record<LegalRoute, LegalRoute> = {
      "/impressum": "/legal-notice",
      "/legal-notice": "/impressum",
      "/datenschutz": "/privacy",
      "/privacy": "/datenschutz",
    };
    const counterpart = counterparts[route];
    assert.ok(response.body.includes(`href="${counterpart}" lang="${german ? "en" : "de"}"`));
    if (route === "/privacy" || route === "/datenschutz") {
      assertPrivacyPolicy(response.body, german);
    }
  }
  const wrongHost = await app.inject({
    method: "GET",
    url: "/privacy",
    headers: { host: "other.test" },
  });
  assert.equal(wrongHost.statusCode, 404);
});

function assertPrivacyPolicy(html: string, german: boolean): void {
  assert.doesNotMatch(html, /TODO|Hetzner|Storage Box|offsite/i);
  for (const text of [
    "support@ping.gg",
    'href="https://shoo.dev/privacy"',
    'href="https://policies.google.com/privacy?hl=',
    "Google Ireland Limited",
    "ClamGate",
    german ? "Art. 28 DSGVO" : "Art. 28 GDPR",
    german ? "in der Regel sieben Tage" : "generally for seven days",
    german ? "Netzwerkprotokolle für 30 Tage" : "network logs for 30 days",
    german ? "Anmeldeprotokolle für 90 Tage" : "authentication logs for 90 days",
    german ? "Kurzlebige Anwendungs-Containerlogs" : "Short-lived application container logs",
    german ? "Größenrotation" : "size-based rotation",
    german
      ? "bis zur Löschung, längstens bis zu 10 Jahre"
      : "until deleted, at most up to 10 years",
    german ? "Links sind kein Zugriffsschutz" : "links are not access protection",
    german ? "§ 25 Abs. 2 Nr. 2 TDDDG" : "Section 25(2) no. 2 TDDDG",
    ...(german
      ? [
          "Einzelne Seitenversionen können nur im Konto oder durch den Administrator gelöscht werden.",
          "Guides mit dem zugehörigen Token über CLI/API.",
          "löscht aber keine veröffentlichten Inhalte.",
          "Anonyme Seiten laufen nach kurzer Zeit automatisch ab",
          "Das Benutzerkonto in Pocket-ID und Pangolin besteht, solange der Zugang eingeräumt ist, und wird auf Anfrage oder nach Entzug des Zugangs gelöscht. Anmeldeprotokolle werden nach 90 Tagen gelöscht.",
        ]
      : [
          "Individual page versions can only be deleted through the account or by the administrator.",
          "guides with the owning token through the CLI/API.",
          "but does not delete published content.",
          "Anonymous pages expire automatically after a short time",
          "The user account in Pocket-ID and Pangolin exists for as long as access is granted and is deleted on request or after access is revoked. Authentication logs are deleted after 90 days.",
        ]),
  ]) {
    assert.ok(html.includes(text), `Privacy disclosure must include ${text}`);
  }
  const backupSentence = german
    ? "Zur Datensicherung werden regelmäßig Sicherungskopien innerhalb der eigenen Infrastruktur erstellt; sie werden nach Ablauf ihrer Aufbewahrungszeit überschrieben."
    : "To back up data, backups are regularly created within the controller's own infrastructure; they are overwritten after their retention period has elapsed.";
  assert.equal(html.split(backupSentence).length - 1, 1);
  const hosting = /<section id="privacy-3"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.ok(hosting.includes(backupSentence));
  assert.doesNotMatch(html, /Longhorn|Velero/);
  const analytics = /<section id="privacy-10"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  for (const text of german
    ? [
        "Reichweitenmessung und Fehlerüberwachung",
        "Umami",
        "GlitchTip",
        "Deutschland",
        "Cookie-Einstellungen",
        "Art. 6 Abs. 1 lit. a DSGVO",
        "§ 25 Abs. 1 TDDDG",
        "Art. 6 Abs. 1 lit. f DSGVO",
        "nicht auf veröffentlichten Inhalten",
        "ohne Cookies, IP-Adressen oder andere personenbezogene Daten",
        "Tokens, E-Mail-Adressen und URL-Parameter werden entfernt",
      ]
    : [
        "Analytics and error monitoring",
        "Umami",
        "GlitchTip",
        "Germany",
        "Cookie settings",
        "Art. 6(1)(a) GDPR",
        "Section 25(1) TDDDG",
        "Art. 6(1)(f) GDPR",
        "not on published content",
        "without cookies, IP addresses or other personal data",
        "Tokens, e-mail addresses and URL parameters are removed",
      ])
    assert.ok(analytics.includes(text), `Analytics disclosure must include ${text}`);
  const retention = german
    ? "Umami-Analysedaten werden nach 25 Monaten gelöscht, Sitzungsaufzeichnungen und Heatmaps nach 30 Tagen. GlitchTip-Fehlerberichte werden nach 90 Tagen gelöscht."
    : "Umami analytics data is deleted after 25 months, session recordings and heatmaps after 30 days. GlitchTip error reports are deleted after 90 days.";
  assert.ok(analytics.includes(`<p>${retention}</p>`));
  assert.doesNotMatch(
    analytics,
    /10 Jahre|10 years|Löschung ist nicht eingerichtet|Automatic deletion is not configured/,
  );
  assert.equal(html.match(/id="privacy-10"/g)?.length, 1);
  const cookies = /<section id="privacy-11"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  for (const text of german
    ? [
        "Ohne Anmeldung und ohne Auswahl im Cookie-Banner",
        "cc_cookie",
        "sechs Monate",
        "Umami setzt keine Cookies",
      ]
    : [
        "Without sign-in and without a choice in the cookie banner",
        "cc_cookie",
        "six months",
        "Umami sets no cookies",
      ])
    assert.ok(cookies.includes(text), `Cookie disclosure must include ${text}`);
  assert.doesNotMatch(
    html,
    /geprüft|verifiziert|beobachtet|steht aus|verified|observed|checked|outstanding/i,
  );
  const headings = [...html.matchAll(/<h2[^>]*>(\d+)\./g)].map((match) => Number(match[1]));
  assert.deepEqual(
    headings,
    Array.from({ length: headings.length }, (_, index) => index + 1),
  );
}

void test("legal links cover landing, sign-in, admin, skills, API reference and browser 404 pages", async () => {
  for (const [url, german, status] of [
    ["/", false, 200],
    ["/account", true, 200],
    ["/shoo/callback", true, 200],
    ["/admin", true, 200],
    ["/skills", false, 200],
    ["/api/", false, 200],
    ["/p/legal-page-missing", true, 404],
    ["/g/legal-guide-missing", true, 404],
    ["/missing", true, 404],
  ] as const) {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { ...host, accept: "text/html" },
    });
    assert.equal(response.statusCode, status, url);
    assertFooter(response.body, german);
  }
  const json = await app.inject({
    method: "GET",
    url: "/api/missing",
    headers: { ...host, accept: "text/html" },
  });
  assert.equal(json.statusCode, 404);
  assert.match(json.headers["content-type"] || "", /application\/json/);
  const admin = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { ...host, cookie: `__Secure-schaffa_admin=${bootstrapToken}` },
  });
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /Publikationen/);
  assertFooter(admin.body, true);
});

void test("telemetry uses the existing legal footer and head on every legal route, excluding admin analytics", async () => {
  config.telemetry = {
    ...config.telemetry,
    umamiUrl: "https://metrics.invalid",
    umamiWebsiteId: "4180ec33-490a-4f7b-a628-97ccf816f874",
    glitchtipDsn: "https://public@errors.invalid/1",
  };
  for (const url of [...legalRoutes, "/", "/skills", "/account", "/admin"]) {
    const response = await app.inject({ url, headers: host });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /name="schaffa-telemetry"/);
    assert.match(response.body, /&quot;legalPages&quot;:true/);
    assert.equal(response.body.match(/data-schaffa-legal/g)?.length, 1);
    assert.doesNotMatch(response.body, /telemetry-footer/);
    if (url === "/admin") {
      assert.doesNotMatch(response.body, /data-cc=/);
      assert.doesNotMatch(String(response.headers["content-security-policy"]), /metrics.invalid/);
    } else {
      assert.match(response.body, /data-cc="show-preferencesModal"/);
      assert.match(String(response.headers["content-security-policy"]), /metrics.invalid/);
    }
  }
  config.telemetry = { ...config.telemetry, umamiUrl: "", umamiWebsiteId: "" };
  const errorOnly = await app.inject({ url: "/privacy", headers: host });
  assert.doesNotMatch(errorOnly.body, /data-cc=/);
});

void test("static page and raw responses stay byte-identical without injected legal chrome", async () => {
  const original =
    '<!doctype html>\n<html lang="en"><head><title>Owned by uploader</title></head><body><main>Exact bytes ✓</main></body></html>\n';
  const created = await publishHtml("legal-byte-identity", original);
  assert.equal(created.statusCode, 202);
  for (const url of [
    "/p/legal-byte-identity",
    "/p/legal-byte-identity/1",
    "/p/legal-byte-identity/raw",
  ]) {
    const response = await app.inject({ method: "GET", url, headers: host });
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.body, original, url);
    assert.doesNotMatch(response.body, /data-schaffa-legal/);
  }
});

void test("management errors and scan screens include legal navigation", () => {
  assertFooter(renderManagementError("Fixture error", "/account"), true);
  for (const status of ["pending", "rejected"] as const) {
    assertFooter(renderScanStatusPage({ status, message: null }), false);
  }
});

void test("self-hosted instances hide legal routes and every generated footer", {}, async (t) => {
  const auth = { ...host, authorization: `Bearer ${bootstrapToken}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: auth,
    payload: { title: "Self-hosted guide", language: "en" },
  });
  assert.equal(created.statusCode, 201);
  const { slug, editRevision } = created.json<{ slug: string; editRevision: number }>();
  const step = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "if-match": String(editRevision) },
    payload: { title: "Open the page", description: "Read the guide.", capture: false },
  });
  assert.equal(step.statusCode, 201);
  const finished = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/finish`,
    headers: { ...auth, "if-match": String(step.json<{ editRevision: number }>().editRevision) },
    payload: {},
  });
  assert.equal(finished.statusCode, 201);

  const original = { baseHost: config.baseHost, baseUrl: config.baseUrl };
  t.after(() => Object.assign(config, original));
  config.baseHost = "publish.example.com";
  config.baseUrl = "https://publish.example.com";
  const headers = { host: config.baseHost, accept: "text/html" };
  const unknown = await app.inject({ method: "GET", url: "/missing", headers });
  for (const route of legalRoutes) {
    const response = await app.inject({ method: "GET", url: route, headers });
    assert.equal(response.statusCode, 404, route);
    assert.equal(response.body, unknown.body, route);
    assert.equal(response.headers["x-robots-tag"], unknown.headers["x-robots-tag"]);
  }
  for (const url of ["/", "/account", "/admin", "/skills", "/api/", `/g/${slug}`, "/missing"]) {
    const response = await app.inject({ method: "GET", url, headers });
    assert.equal(response.statusCode, url === "/missing" ? 404 : 200, url);
    assert.doesNotMatch(
      response.body,
      /data-schaffa-legal|href="\/(?:impressum|datenschutz|legal-notice|privacy)"/,
    );
  }
  assert.doesNotMatch(renderManagementError("Fixture error", "/account"), /data-schaffa-legal/);
  assert.doesNotMatch(
    renderScanStatusPage({ status: "pending", message: null }),
    /data-schaffa-legal/,
  );
});

void test("self-hosted telemetry exposes no legal pages and keeps cookie settings on the current page", {}, async (t) => {
  const original = { baseHost: config.baseHost, baseUrl: config.baseUrl };
  t.after(() => Object.assign(config, original));
  config.baseHost = "publish.example.com";
  config.baseUrl = "https://publish.example.com";
  config.telemetry = {
    ...config.telemetry,
    umamiUrl: "https://metrics.invalid",
    umamiWebsiteId: "4180ec33-490a-4f7b-a628-97ccf816f874",
  };
  const headers = { host: config.baseHost };
  for (const url of ["/", "/account"]) {
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /&quot;legalPages&quot;:false/);
    assert.match(response.body, /href="#cookie-settings" data-cc="show-preferencesModal"/);
    assert.doesNotMatch(response.body, /href="\/(?:privacy|datenschutz)/);
  }
  for (const url of legalRoutes) assert.equal((await app.inject({ url, headers })).statusCode, 404);
});

function assertFooter(html: string, german: boolean): void {
  const footerText = html.slice(html.indexOf("data-schaffa-legal"));
  assert.ok(html.includes("data-schaffa-legal"), "Missing legal footer");
  assert.ok(footerText.includes(`href="${german ? "/impressum" : "/legal-notice"}"`));
  assert.ok(footerText.includes(`href="${german ? "/datenschutz" : "/privacy"}"`));
}
