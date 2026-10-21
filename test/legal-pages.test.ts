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
      assertPrivacyDraft(response.body, german);
    }
  }
  const wrongHost = await app.inject({
    method: "GET",
    url: "/privacy",
    headers: { host: "other.test" },
  });
  assert.equal(wrongHost.statusCode, 404);
});

function assertPrivacyDraft(html: string, german: boolean): void {
  assert.deepEqual(html.match(/TODO\(legal-[^)]+\)/g), ["TODO(legal-shoo)"]);
  for (const text of [
    german ? "nach sieben Tagen" : "after seven days",
    german ? "5.000" : "5,000",
    "10 MiB",
    "https://shoo.dev/shoo.js",
    "support@ping.gg",
    "shoo_session",
    "shoo_identity",
    "shoo_pkce",
    "shoo_return_to",
    "Google Ireland Limited",
    german ? "Art. 28 DSGVO" : "Art. 28 GDPR",
    german ? "spätestens etwa drei Monaten" : "at most about three months",
    german ? "24 Stunden nach Abschluss" : "24 hours after completion",
    german ? "nach 30 Tagen bereinigt" : "pruned after 30 days",
    german ? "keine automatische Löschfrist" : "no automatic deletion period",
    german ? "aktiven Sperre" : "active block",
    german ? "unter /account, 7 Tage" : "at /account, 7 days",
    german ? "siehe Abschnitt 6" : "see section 6",
    german ? "Der Eintrag bleibt gespeichert" : "The entry remains stored",
    german ? "Die Speicherdauer legt Shoo fest" : "Shoo determines the retention period",
  ]) {
    assert.ok(html.includes(text), `Privacy disclosure must include ${text}`);
  }
  if (german) {
    assert.ok(
      html.includes(
        "Das Benutzerkonto in Pocket-ID und Pangolin besteht, solange der Zugang eingeräumt ist, und wird auf Anfrage oder nach Entzug des Zugangs gelöscht. Anmeldeprotokolle werden nach 90 Tagen gelöscht. Sicherungskopien werden nach spätestens drei Monaten überschrieben.",
      ),
    );
  }
  assert.doesNotMatch(html, /Umami|GlitchTip/);
  const withoutTodo = html.replace(/<p>TODO\(legal-shoo\):[\s\S]*?<\/p>/, "");
  assert.doesNotMatch(
    withoutTodo,
    /geprüft|verifiziert|beobachtet|steht aus|verified|observed|checked|outstanding/,
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

void test("privacy disclosures follow runtime configuration in both languages", async () => {
  const original = {
    userSessionTtlHours: config.userSessionTtlHours,
    anonymousPageTtlSeconds: config.anonymousPageTtlSeconds,
    anonymousPageRetentionDays: config.anonymousPageRetentionDays,
    maxPageVersions: config.maxPageVersions,
  };
  try {
    for (const [values, de, en] of [
      [
        [168, 3600, 30, 25],
        ["7 Tage", "1 Stunde", "30 Tagen", "25 Versionen"],
        ["7 days", "1 hour", "30 days", "25 versions"],
      ],
      [
        [1, 300, 1, 1],
        ["1 Stunde", "5 Minuten", "einem Tag", "1 Version"],
        ["1 hour", "5 minutes", "1 day", "1 version"],
      ],
      [
        [25, 7200, 2, 2],
        ["25 Stunden", "2 Stunden", "2 Tagen", "2 Versionen"],
        ["25 hours", "2 hours", "2 days", "2 versions"],
      ],
      [
        [48, 86400, 365, 1000],
        ["2 Tage", "1 Tag", "365 Tagen", "1.000 Versionen"],
        ["2 days", "1 day", "365 days", "1,000 versions"],
      ],
      [
        [720, 301, 1, 1],
        ["30 Tage", "301 Sekunden", "einem Tag", "1 Version"],
        ["30 days", "301 seconds", "1 day", "1 version"],
      ],
    ] as const) {
      [
        config.userSessionTtlHours,
        config.anonymousPageTtlSeconds,
        config.anonymousPageRetentionDays,
        config.maxPageVersions,
      ] = values;
      for (const [route, expected] of [
        ["/datenschutz", de],
        ["/privacy", en],
      ] as const) {
        const response = await app.inject({ method: "GET", url: route, headers: host });
        assert.equal(response.statusCode, 200);
        const [session, availability, retention, versions] = expected;
        const snippets =
          route === "/datenschutz"
            ? [
                `Eine Kontositzung ist ${session} gültig;`,
                `unter /account, ${session}.</li>`,
                `Anonyme HTML-Seiten sind ${availability} öffentlich erreichbar.`,
                `nach ${retention} beim nächsten`,
                `HTML-Seiten behalten bis zu ${versions},`,
              ]
            : [
                `An account session is valid for ${session};`,
                `at /account, ${session}.</li>`,
                `Anonymous HTML pages are publicly available for ${availability}.`,
                `after ${retention} at the next`,
                `HTML pages retain up to ${versions},`,
              ];
        for (const snippet of snippets)
          assert.ok(response.body.includes(snippet), `${route}: ${snippet}`);
      }
    }
  } finally {
    Object.assign(config, original);
  }
});

function assertFooter(html: string, german: boolean): void {
  const footerText = html.slice(html.indexOf("data-schaffa-legal"));
  assert.ok(html.includes("data-schaffa-legal"), "Missing legal footer");
  assert.ok(footerText.includes(`href="${german ? "/impressum" : "/legal-notice"}"`));
  assert.ok(footerText.includes(`href="${german ? "/datenschutz" : "/privacy"}"`));
}
