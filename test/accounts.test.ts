import {
  adminCookie,
  app,
  assert,
  bootstrapToken,
  config,
  createToken,
  db,
  finishPendingScans,
  multipart,
  publishHtml,
  publishHtmlWithToken,
  responseCookie,
  seedBootstrapToken,
  shooLogin,
  test,
  updateSettings,
} from "./server-fixture.js";

test("keeps administration out of the public API", async () => {
  for (const [method, url] of [
    ["GET", "/api/pages"],
    ["GET", "/api/files"],
    ["GET", "/api/tokens"],
    ["POST", "/api/tokens"],
    ["GET", "/api/users"],
    ["GET", "/api/settings"],
    ["PUT", "/api/settings"],
    ["DELETE", "/api/pages/example-page"],
    ["DELETE", "/api/files/aaaaaaaaaaaaaaaaaaaaaa"],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      headers: { host: "schaffa.test", authorization: `Bearer ${bootstrapToken}` },
    });
    assert.equal(response.statusCode, 404, `${method} ${url} must not be an admin API`);
  }

  const admin = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /Lockdown aktivieren/);
  assert.match(admin.body, /Registrierungen sperren/);
  assert.match(admin.body, /Anmeldungen sperren/);
  assert.match(admin.body, /Token erstellen/);
  assert.match(admin.body, /Versionen/);

  const createdToken = await app.inject({
    method: "POST",
    url: "/admin/tokens",
    headers: {
      host: "schaffa.test",
      cookie: adminCookie(bootstrapToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "name=admin-created-upload&scope=upload",
  });
  assert.equal(createdToken.statusCode, 200);
  assert.match(createdToken.body, /Admin-Token jetzt einrichten/);
  assert.match(createdToken.body, /src="\/assets\/token-setup\.js"/);
  assert.match(createdToken.headers["content-security-policy"] || "", /script-src 'self'/);
});

test("filters admin publications by user and then uploader token", async () => {
  const firstUserId = "admin-filter-user-first";
  const secondUserId = "admin-filter-user-second";
  db()
    .prepare(
      `INSERT INTO users (id, shoo_subject, email, name)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    )
    .run(
      firstUserId,
      "admin-filter-subject-first",
      "first-filter@example.test",
      "First filter user",
      secondUserId,
      "admin-filter-subject-second",
      "second-filter@example.test",
      "Second filter user",
    );
  const firstUploader = createToken("First desktop", ["upload"], firstUserId);
  const secondUploader = createToken("First automation", ["upload"], firstUserId);
  const guideOnlyUploader = createToken("First guide agent", ["upload"], firstUserId);
  const otherUserUploader = createToken("Second desktop", ["upload"], secondUserId);

  assert.equal(
    (
      await publishHtmlWithToken(
        "filter-first-desktop",
        "<h1>First desktop</h1>",
        firstUploader.token,
      )
    ).statusCode,
    202,
  );
  assert.equal(
    (
      await publishHtmlWithToken(
        "filter-first-automation",
        "<h1>First automation</h1>",
        secondUploader.token,
      )
    ).statusCode,
    202,
  );
  assert.equal(
    (
      await publishHtmlWithToken(
        "filter-second-desktop",
        "<h1>Second desktop</h1>",
        otherUserUploader.token,
      )
    ).statusCode,
    202,
  );

  const fileBody = multipart("file", "second-user-file.txt", "text/plain", "Second user file");
  const uploadedFile = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${otherUserUploader.token}`,
      "content-type": fileBody.contentType,
    },
    payload: fileBody.payload,
  });
  assert.equal(uploadedFile.statusCode, 202);
  await finishPendingScans();
  const uploadedFilename = String(uploadedFile.json().filename);

  const firstGuide = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${guideOnlyUploader.token}`,
      "content-type": "application/json",
    },
    payload: {
      title: "First filtered guide-search-needle",
      description: "First guide description",
      targetUrl: "https://first-filter.example.test/projects",
    },
  });
  assert.equal(firstGuide.statusCode, 201);
  const firstGuideSlug = String(firstGuide.json().slug);
  const otherGuide = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${otherUserUploader.token}`,
      "content-type": "application/json",
    },
    payload: {
      title: "Second filtered guide",
      description: "other-guide-description",
    },
  });
  assert.equal(otherGuide.statusCode, 201);
  const otherGuideSlug = String(otherGuide.json().slug);

  const byUser = await app.inject({
    method: "GET",
    url: `/admin?user=${firstUserId}`,
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(byUser.statusCode, 200);
  assert.match(byUser.body, /name="user"/);
  assert.match(byUser.body, /First filter user · first-filter@example\.test/);
  assert.match(byUser.body, /filter-first-desktop/);
  assert.match(byUser.body, /filter-first-automation/);
  assert.match(byUser.body, new RegExp(firstGuideSlug));
  assert.doesNotMatch(byUser.body, new RegExp(otherGuideSlug));
  assert.doesNotMatch(byUser.body, /filter-second-desktop/);
  assert.doesNotMatch(byUser.body, new RegExp(uploadedFilename));
  assert.match(byUser.body, new RegExp(`value="${firstUploader.id}" data-user="${firstUserId}"`));
  assert.match(
    byUser.body,
    new RegExp(`value="${guideOnlyUploader.id}" data-user="${firstUserId}"`),
  );
  assert.match(byUser.body, /src="\/assets\/admin-filters\.js"/);

  const byUploader = await app.inject({
    method: "GET",
    url: `/admin?user=${firstUserId}&uploader=${secondUploader.id}`,
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(byUploader.statusCode, 200);
  assert.match(byUploader.body, /filter-first-automation/);
  assert.doesNotMatch(byUploader.body, new RegExp(firstGuideSlug));
  assert.doesNotMatch(byUploader.body, /filter-first-desktop/);
  assert.doesNotMatch(byUploader.body, /filter-second-desktop/);

  const byGuideUploader = await app.inject({
    method: "GET",
    url: `/admin?user=${firstUserId}&uploader=${guideOnlyUploader.id}`,
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(byGuideUploader.statusCode, 200);
  assert.match(byGuideUploader.body, new RegExp(firstGuideSlug));
  assert.doesNotMatch(byGuideUploader.body, new RegExp(otherGuideSlug));
  assert.doesNotMatch(byGuideUploader.body, /filter-first-desktop/);
  assert.doesNotMatch(byGuideUploader.body, /filter-first-automation/);

  const byGuideSearch = await app.inject({
    method: "GET",
    url: "/admin?q=guide-search-needle",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(byGuideSearch.statusCode, 200);
  assert.match(byGuideSearch.body, new RegExp(firstGuideSlug));
  assert.doesNotMatch(byGuideSearch.body, new RegExp(otherGuideSlug));
  assert.doesNotMatch(byGuideSearch.body, /filter-first-desktop/);
  assert.doesNotMatch(byGuideSearch.body, new RegExp(uploadedFilename));

  const guidesOnly = await app.inject({
    method: "GET",
    url: "/admin?kind=guides",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(guidesOnly.statusCode, 200);
  assert.match(guidesOnly.body, /value="guides" selected/);
  assert.match(guidesOnly.body, new RegExp(firstGuideSlug));
  assert.match(guidesOnly.body, new RegExp(otherGuideSlug));
  assert.doesNotMatch(guidesOnly.body, /filter-first-desktop/);
  assert.doesNotMatch(guidesOnly.body, new RegExp(uploadedFilename));

  const pagesOnly = await app.inject({
    method: "GET",
    url: "/admin?kind=pages",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(pagesOnly.statusCode, 200);
  assert.doesNotMatch(pagesOnly.body, new RegExp(firstGuideSlug));
  assert.doesNotMatch(pagesOnly.body, new RegExp(otherGuideSlug));

  const filesOnly = await app.inject({
    method: "GET",
    url: "/admin?kind=files",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(filesOnly.statusCode, 200);
  assert.doesNotMatch(filesOnly.body, new RegExp(firstGuideSlug));
  assert.doesNotMatch(filesOnly.body, new RegExp(otherGuideSlug));

  const permanentGuides = await app.inject({
    method: "GET",
    url: "/admin?kind=guides&lifetime=permanent",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(permanentGuides.statusCode, 200);
  assert.match(permanentGuides.body, new RegExp(firstGuideSlug));
  assert.match(permanentGuides.body, new RegExp(otherGuideSlug));

  const anonymousOnly = await app.inject({
    method: "GET",
    url: "/admin?kind=guides&lifetime=anonymous-active",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(anonymousOnly.statusCode, 200);
  assert.doesNotMatch(anonymousOnly.body, new RegExp(firstGuideSlug));
  assert.doesNotMatch(anonymousOnly.body, new RegExp(otherGuideSlug));
  assert.match(anonymousOnly.body, /Keine passenden Guides gefunden\./);

  const filterScript = await app.inject({
    method: "GET",
    url: "/assets/admin-filters.js",
    headers: { host: "schaffa.test" },
  });
  assert.equal(filterScript.statusCode, 200);
  assert.match(filterScript.headers["content-type"] || "", /^application\/javascript/);
  assert.match(filterScript.body, /user\.addEventListener\("change", syncUploaders\)/);
});

test("write lockdown blocks publishing but leaves takedown available", async () => {
  const locked = await app.inject({
    method: "POST",
    url: "/admin/settings",
    headers: {
      host: "schaffa.test",
      cookie: adminCookie(bootstrapToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "writesLocked=true",
  });
  assert.equal(locked.statusCode, 302);
  const rejected = await publishHtml("locked-page", "<h1>Locked</h1>");
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.json().error, "writes_locked");
  await app.inject({
    method: "POST",
    url: "/admin/settings",
    headers: {
      host: "schaffa.test",
      cookie: adminCookie(bootstrapToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "writesLocked=false",
  });
});

test("creates Shoo users and lets them manage their own tokens and uploads", async () => {
  const formLogin = await app.inject({
    method: "POST",
    url: "/auth/shoo",
    headers: { host: "schaffa.test", "content-type": "application/x-www-form-urlencoded" },
    payload: "idToken=login-csrf-attempt-1234567890",
  });
  assert.equal(formLogin.statusCode, 415);

  const loginPage = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test" },
  });
  assert.equal(loginPage.statusCode, 200);
  assert.match(loginPage.body, /shoo\.dev\/shoo\.js/);

  const login = await shooLogin("shoo-user-alpha-1234567890");
  assert.equal(login.statusCode, 200);
  const cookie = responseCookie(login, "__Secure-schaffa_user");
  const account = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(account.statusCode, 200);
  assert.match(account.body, /Agenten-Tokens/);

  const created = await app.inject({
    method: "POST",
    url: "/account/tokens",
    headers: {
      host: "schaffa.test",
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "name=my-agent",
  });
  assert.equal(created.statusCode, 200);
  const token = /sfa_[A-Za-z0-9_-]+/.exec(created.body)?.[0];
  assert.ok(token);
  assert.match(created.body, /Token jetzt einrichten/);
  assert.match(created.body, /data-token-os/);
  assert.match(created.body, /<option value="macos">macOS<\/option>/);
  assert.match(created.body, /<option value="linux">Linux<\/option>/);
  assert.match(created.body, /<option value="windows">Windows<\/option>/);
  assert.match(created.body, /data-token-command/);
  assert.match(created.body, /Befehl kopieren/);
  assert.match(created.body, /src="\/assets\/token-setup\.js"/);
  const setupScript = await app.inject({
    method: "GET",
    url: "/assets/token-setup.js",
    headers: { host: "schaffa.test" },
  });
  assert.equal(setupScript.statusCode, 200);
  assert.match(setupScript.body, /~\/\.zshrc/);
  assert.match(setupScript.body, /~\/\.bashrc/);
  assert.match(setupScript.body, /set -Ux SCHAFFA_TOKEN/);
  assert.match(setupScript.body, /SetEnvironmentVariable/);
  assert.match(setupScript.body, /setx SCHAFFA_TOKEN/);
  assert.match(setupScript.body, /Add-Content -Path \.env -Encoding utf8/);
  const tokenRow = db()
    .prepare("SELECT * FROM tokens WHERE token_hash != '' AND name = ?")
    .get("my-agent") as unknown as { id: string; user_id: string; revoked_at: string | null };
  assert.ok(tokenRow.user_id);

  const page = await publishHtmlWithToken("account-owned-page", "<h1>Version one</h1>", token);
  assert.equal(page.statusCode, 202);
  const updatedPage = await publishHtmlWithToken(
    "account-owned-page",
    "<h1>Version two</h1>",
    token,
  );
  assert.equal(updatedPage.statusCode, 202);
  const fileBody = multipart("file", "account-note.txt", "text/plain", "account file");
  const file = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
      "content-type": fileBody.contentType,
    },
    payload: fileBody.payload,
  });
  assert.equal(file.statusCode, 202);
  const fileId = file.json().id as string;

  const populatedAccount = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.match(populatedAccount.body, /Dein Konto/);
  assert.match(populatedAccount.body, /account-owned-page/);
  assert.match(populatedAccount.body, new RegExp(fileId));
  assert.match(populatedAccount.body, /my-agent/);

  const revoked = await app.inject({
    method: "POST",
    url: `/account/tokens/${tokenRow.id}/revoke`,
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(revoked.statusCode, 302);
  assert.ok(
    (
      db().prepare("SELECT revoked_at FROM tokens WHERE id = ?").get(tokenRow.id) as unknown as {
        revoked_at: string | null;
      }
    ).revoked_at,
  );
  const accountAfterRevoke = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.match(accountAfterRevoke.body, /account-owned-page/);
  assert.match(accountAfterRevoke.body, new RegExp(fileId));

  const otherLogin = await shooLogin("shoo-user-beta-1234567890");
  const otherCookie = responseCookie(otherLogin, "__Secure-schaffa_user");
  const deniedPageDelete = await app.inject({
    method: "POST",
    url: "/account/pages/account-owned-page/delete",
    headers: { host: "schaffa.test", cookie: otherCookie },
  });
  assert.equal(deniedPageDelete.statusCode, 404);
  const deniedFileDelete = await app.inject({
    method: "POST",
    url: `/account/files/${fileId}/delete`,
    headers: { host: "schaffa.test", cookie: otherCookie },
  });
  assert.equal(deniedFileDelete.statusCode, 404);

  const deletedVersion = await app.inject({
    method: "POST",
    url: "/account/pages/account-owned-page/versions/1/delete",
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(deletedVersion.statusCode, 302);
  const remainingVersions = db()
    .prepare(
      "SELECT COUNT(*) AS count FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE slug = ?)",
    )
    .get("account-owned-page") as unknown as { count: number };
  assert.equal(remainingVersions.count, 1);
  const deletedPage = await app.inject({
    method: "POST",
    url: "/account/pages/account-owned-page/delete",
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(deletedPage.statusCode, 302);
  const deletedFile = await app.inject({
    method: "POST",
    url: `/account/files/${fileId}/delete`,
    headers: { host: "schaffa.test", cookie },
  });
  assert.equal(deletedFile.statusCode, 302);
  assert.equal(
    db().prepare("SELECT 1 FROM pages WHERE slug = ?").get("account-owned-page"),
    undefined,
  );
  assert.equal(db().prepare("SELECT 1 FROM files WHERE id = ?").get(fileId), undefined);
});

test("admin controls Shoo signups and logins", async () => {
  await shooLogin("existing-shoo-user-1234567890");
  await updateSettings({ signupsEnabled: false });

  const rejectedSignup = await shooLogin("unknown-shoo-user-1234567890");
  assert.equal(rejectedSignup.statusCode, 403);
  assert.equal(rejectedSignup.json().error, "signups_disabled");
  assert.equal(
    db().prepare("SELECT 1 FROM users WHERE shoo_subject = ?").get("unknown-shoo-user-1234567890"),
    undefined,
  );

  const existing = await shooLogin("existing-shoo-user-1234567890");
  assert.equal(existing.statusCode, 200);
  const cookie = responseCookie(existing, "__Secure-schaffa_user");
  await updateSettings({ loginsEnabled: false });
  const rejectedLogin = await shooLogin("existing-shoo-user-1234567890");
  assert.equal(rejectedLogin.statusCode, 403);
  assert.equal(rejectedLogin.json().error, "logins_disabled");
  const expiredSession = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.match(expiredSession.body, /Anmeldungen sind.+deaktiviert/);

  await updateSettings({ signupsEnabled: true, loginsEnabled: true });
});

test("allows only explicitly trusted users to publish sandboxed interactive pages", async () => {
  const interactiveHtml =
    "<!doctype html><h1>Interactive plan</h1><script>document.body.dataset.ready = 'yes'</script>";
  const disabledBody = multipart("html", "interactive.html", "text/html", interactiveHtml);
  const disabled = await app.inject({
    method: "PUT",
    url: "/api/pages/trusted-interactive?type=interactive",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": disabledBody.contentType,
    },
    payload: disabledBody.payload,
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.json().error, "interactive_disabled");

  const login = await shooLogin("interactive-shoo-user-1234567890");
  const cookie = responseCookie(login, "__Secure-schaffa_user");
  const user = db()
    .prepare("SELECT id FROM users WHERE shoo_subject = ?")
    .get("interactive-shoo-user-1234567890") as unknown as { id: string };
  await updateSettings({ interactivePublishingEnabled: true });
  const granted = await app.inject({
    method: "POST",
    url: `/admin/users/${user.id}/interactive`,
    headers: {
      host: "schaffa.test",
      cookie: adminCookie(bootstrapToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "allowed=true",
  });
  assert.equal(granted.statusCode, 302);

  const tokenPage = await app.inject({
    method: "POST",
    url: "/account/tokens",
    headers: {
      host: "schaffa.test",
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "name=interactive-agent&scope=interactive",
  });
  assert.equal(tokenPage.statusCode, 200);
  const token = /sfa_[A-Za-z0-9_-]+/.exec(tokenPage.body)?.[0];
  assert.ok(token);

  const body = multipart("html", "interactive.html", "text/html", interactiveHtml);
  const published = await app.inject({
    method: "POST",
    url: "/api/pages?type=interactive",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(published.statusCode, 202);
  await finishPendingScans();
  assert.equal(published.json().kind, "interactive");
  const pageSlug = published.json().slug as string;
  assert.match(pageSlug, /^[a-z0-9]{16}$/);

  const warning = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(warning.statusCode, 200);
  assert.match(warning.body, /Diese Seite führt Code aus/);
  assert.doesNotMatch(warning.body, /document\.body\.dataset/);
  assert.match(warning.body, new RegExp(`/p/${pageSlug}/run`));

  const run = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}/run`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(run.statusCode, 200);
  assert.equal(run.body, interactiveHtml);
  assert.match(String(run.headers["content-security-policy"]), /sandbox allow-scripts/);
  assert.match(String(run.headers["content-security-policy"]), /connect-src 'none'/);
  assert.match(String(run.headers["content-security-policy"]), /webrtc 'block'/);
  assert.doesNotMatch(String(run.headers["content-security-policy"]), /allow-same-origin/);
  assert.match(String(run.headers["permissions-policy"]), /camera=\(\)/);
  assert.equal(run.headers["x-dns-prefetch-control"], "off");

  const raw = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}/raw`,
    headers: { host: "schaffa.test" },
  });
  assert.match(raw.headers["content-type"] || "", /^text\/plain/);
  assert.equal(raw.body, interactiveHtml);

  const externalBody = multipart(
    "html",
    "external.html",
    "text/html",
    '<script src="https://example.test/app.js"></script>',
  );
  const external = await app.inject({
    method: "PUT",
    url: "/api/pages/external-interactive?type=interactive",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
      "content-type": externalBody.contentType,
    },
    payload: externalBody.payload,
  });
  assert.equal(external.statusCode, 422);
  assert.equal(external.json().error, "unsafe_html");

  const staticBody = multipart("html", "static.html", "text/html", "<h1>Static now</h1>");
  const kindChange = await app.inject({
    method: "PUT",
    url: `/api/pages/${pageSlug}`,
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": staticBody.contentType,
    },
    payload: staticBody.payload,
  });
  assert.equal(kindChange.statusCode, 409);
  assert.equal(kindChange.json().error, "page_kind_mismatch");

  await updateSettings({ interactivePublishingEnabled: false });
  const globallyStoppedRun = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}/run`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(globallyStoppedRun.statusCode, 503);
  assert.equal(globallyStoppedRun.json().error, "interactive_disabled");
  const globallyStoppedWarning = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}`,
    headers: { host: "schaffa.test" },
  });
  assert.doesNotMatch(globallyStoppedWarning.body, /Seite isoliert starten/);
  await updateSettings({ interactivePublishingEnabled: true });

  await app.inject({
    method: "POST",
    url: `/admin/users/${user.id}/interactive`,
    headers: {
      host: "schaffa.test",
      cookie: adminCookie(bootstrapToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "allowed=false",
  });
  const stoppedRun = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}/run`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(stoppedRun.statusCode, 503);
  assert.equal(stoppedRun.json().error, "interactive_disabled");
  const stoppedWarning = await app.inject({
    method: "GET",
    url: `/p/${pageSlug}`,
    headers: { host: "schaffa.test" },
  });
  assert.match(stoppedWarning.body, /Ausführung wurde.+deaktiviert/);
  assert.doesNotMatch(stoppedWarning.body, /Seite isoliert starten/);
  const revokedBody = multipart("html", "revoked.html", "text/html", interactiveHtml);
  const revoked = await app.inject({
    method: "PUT",
    url: "/api/pages/revoked-interactive?type=interactive",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${token}`,
      "content-type": revokedBody.contentType,
    },
    payload: revokedBody.payload,
  });
  assert.equal(revoked.statusCode, 401);
  await updateSettings({ interactivePublishingEnabled: false });
});

test("admin deletion removes a Shoo user and revokes their tokens", async () => {
  const login = await shooLogin("deletable-shoo-user-1234567890");
  const cookie = responseCookie(login, "__Secure-schaffa_user");
  await app.inject({
    method: "POST",
    url: "/account/tokens",
    headers: {
      host: "schaffa.test",
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "name=delete-with-user",
  });
  const user = db()
    .prepare("SELECT id FROM users WHERE shoo_subject = ?")
    .get("deletable-shoo-user-1234567890") as unknown as { id: string };
  const ownedToken = db()
    .prepare("SELECT id FROM tokens WHERE name = 'delete-with-user'")
    .get() as unknown as { id: string };
  const removed = await app.inject({
    method: "POST",
    url: `/admin/users/${user.id}/delete`,
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(removed.statusCode, 302);
  assert.equal(db().prepare("SELECT 1 FROM users WHERE id = ?").get(user.id), undefined);
  const token = db()
    .prepare("SELECT name, user_id, revoked_at FROM tokens WHERE id = ?")
    .get(ownedToken.id) as unknown as {
    name: string;
    user_id: string | null;
    revoked_at: string | null;
  };
  assert.equal(token.name, "Deleted user token");
  assert.equal(token.user_id, null);
  assert.ok(token.revoked_at);
  const oldSession = await app.inject({
    method: "GET",
    url: "/account",
    headers: { host: "schaffa.test", cookie },
  });
  assert.match(oldSession.body, /Mit Google anmelden/);
});

test("bootstrap can be revoked after another admin exists and never resurrects", async () => {
  const replacement = createToken("replacement admin", ["admin"]);
  const revoked = await app.inject({
    method: "POST",
    url: "/admin/tokens/bootstrap/revoke",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(revoked.statusCode, 302);
  assert.deepEqual(seedBootstrapToken(), { active: false, created: false });

  const oldToken = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.match(oldToken.body, /Admin-Zugang/);
  const newToken = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(replacement.token) },
  });
  assert.equal(newToken.statusCode, 200);
  assert.match(newToken.body, /Publikationen/);
});

test("rotating the bootstrap value reactivates it as the admin recovery path", async () => {
  const rotatedToken = `sfa_${"b".repeat(43)}`;
  const original = config.bootstrapToken;
  config.bootstrapToken = rotatedToken;
  try {
    assert.deepEqual(seedBootstrapToken(), { active: true, created: false });
  } finally {
    config.bootstrapToken = original;
  }

  const oldToken = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.match(oldToken.body, /Admin-Zugang/);
  const rotated = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "schaffa.test", cookie: adminCookie(rotatedToken) },
  });
  assert.equal(rotated.statusCode, 200);
  assert.match(rotated.body, /Publikationen/);

  // Revoking again and re-seeding with the same rotated value must not resurrect it.
  db().prepare("UPDATE tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'bootstrap'").run();
  config.bootstrapToken = rotatedToken;
  try {
    assert.deepEqual(seedBootstrapToken(), { active: false, created: false });
  } finally {
    config.bootstrapToken = original;
  }
});
