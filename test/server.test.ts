import {
  allSkillsMarkdown,
  app,
  assert,
  bootstrapToken,
  createToken,
  db,
  exampleSkills,
  multipart,
  multipartFields,
  publishHtml,
  sharp,
  test,
} from "./server-fixture.js";

test("migrates legacy ownership and token schemas in place", () => {
  const page = db().prepare("SELECT owner_token_id FROM pages WHERE id = 'legacy-page-id'").get() as
    | { owner_token_id: string }
    | undefined;
  assert.equal(page?.owner_token_id, "legacy-token");
  const tokenColumns = db().prepare("PRAGMA table_info(tokens)").all() as unknown as Array<{
    name: string;
  }>;
  assert.ok(tokenColumns.some((column) => column.name === "user_id"));
  const pageColumns = db().prepare("PRAGMA table_info(pages)").all() as unknown as Array<{
    name: string;
  }>;
  assert.ok(pageColumns.some((column) => column.name === "kind"));
  const migratedVersion = db()
    .prepare("SELECT scan_status, scan_message FROM page_versions WHERE id = 'legacy-version-id'")
    .get() as unknown as { scan_status: string; scan_message: string | null };
  assert.equal(migratedVersion.scan_status, "clean");
  assert.equal(migratedVersion.scan_message, null);
  const userColumns = db().prepare("PRAGMA table_info(users)").all() as unknown as Array<{
    name: string;
  }>;
  assert.ok(userColumns.some((column) => column.name === "can_publish_interactive"));
  const guideColumns = db().prepare("PRAGMA table_info(guides)").all() as unknown as Array<{
    name: string;
  }>;
  assert.ok(guideColumns.some((column) => column.name === "target_url"));
  const guide = db()
    .prepare("SELECT target_url, status FROM guides WHERE id = 'legacy-guide-id'")
    .get() as { target_url: string | null; status: string } | undefined;
  assert.equal(guide?.target_url, null);
  assert.equal(guide?.status, "recording");
  db().prepare("DELETE FROM pages WHERE id = 'legacy-page-id'").run();
  db().prepare("DELETE FROM guides WHERE id = 'legacy-guide-id'").run();
  db().prepare("DELETE FROM tokens WHERE id = 'legacy-token'").run();
});

test("rejects unauthenticated writes and unexpected hosts", async () => {
  const body = multipart("html", "page.html", "text/html", "<h1>Hello</h1>");
  const unauthorized = await app.inject({
    method: "PUT",
    url: "/api/pages/hello",
    headers: { host: "schaffa.test", "content-type": body.contentType },
    payload: body.payload,
  });
  assert.equal(unauthorized.statusCode, 401);

  const wrongHost = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "unexpected.test" },
  });
  assert.equal(wrongHost.statusCode, 404);

  const spoofedForwardedHost = await app.inject({
    method: "GET",
    url: "/admin",
    headers: { host: "unexpected.test", "x-forwarded-host": "schaffa.test" },
  });
  assert.equal(spoofedForwardedHost.statusCode, 404);

  const missingPage = await app.inject({
    method: "GET",
    url: "/p/missing",
    headers: { host: "schaffa.test" },
  });
  assert.equal(missingPage.statusCode, 404);
  assert.match(missingPage.headers["content-type"] || "", /^text\/html/);
  assert.match(missingPage.body, /Seite nicht gefunden/);
});

test("serves one general read skill and focused writing skills", async () => {
  assert.equal(exampleSkills.length, 5);
  const readSkill = exampleSkills.find((skill) => skill.slug === "read");
  const htmlSkill = exampleSkills.find((skill) => skill.slug === "html");
  const fileSkill = exampleSkills.find((skill) => skill.slug === "file");
  const guideSkill = exampleSkills.find((skill) => skill.slug === "guide");
  const presentationSkill = exampleSkills.find((skill) => skill.slug === "presentation");
  assert.ok(readSkill);
  assert.ok(htmlSkill);
  assert.ok(fileSkill);
  assert.ok(guideSkill);
  assert.ok(presentationSkill);
  assert.match(readSkill.markdown, /curl --fail --silent --show-error --location/);
  for (const route of ["/p/", "/f/", "/g/"]) assert.match(readSkill.markdown, new RegExp(route));
  assert.match(
    htmlSkill.markdown,
    /description: Use when the user asks to communicate through an HTML document, or if they mention "HTML" with no additional context\./,
  );
  assert.match(htmlSkill.markdown, /-F "html=@<html-file>;type=text\/html"/);
  assert.match(htmlSkill.markdown, /https:\/\/schaffa\.test\/api\/pages/);
  assert.doesNotMatch(htmlSkill.markdown, /SCHAFFA_URL/);
  assert.match(fileSkill.markdown, /-F "file=@<file>"/);
  assert.match(fileSkill.markdown, /https:\/\/schaffa\.test\/api\/files/);
  assert.doesNotMatch(fileSkill.markdown, /SCHAFFA_URL/);
  assert.doesNotMatch(htmlSkill.markdown, /npx schaffa upload/);
  assert.doesNotMatch(fileSkill.markdown, /npx schaffa upload/);
  assert.match(guideSkill.markdown, /npx schaffa record --title "<title>" --chrome/);
  assert.match(guideSkill.markdown, /npx schaffa record --title "<title>" --browser/);
  assert.match(guideSkill.markdown, /existing profile session/);
  assert.match(guideSkill.markdown, /without creating.*profile/);
  assert.match(guideSkill.markdown, /Do not promise a specific profile/);
  assert.doesNotMatch(guideSkill.markdown, /current profile/);
  assert.match(guideSkill.markdown, /exact macOS window|exact window/);
  assert.match(guideSkill.markdown, /npx schaffa record --title "<title>" --desktop/);
  assert.match(guideSkill.markdown, /npx schaffa guide sync/);
  assert.match(guideSkill.markdown, /npx schaffa guide edit-step --step <number-or-id>/);
  assert.match(guideSkill.markdown, /npx schaffa guide replace-screenshot/);
  assert.match(guideSkill.markdown, /npx schaffa guide delete-step/);
  assert.match(guideSkill.markdown, /publishes it automatically/);
  assert.doesNotMatch(guideSkill.markdown, /schaffa guide publish/);
  assert.match(presentationSkill.markdown, /npx schaffa publish/);

  const page = await app.inject({
    method: "GET",
    url: "/skills",
    headers: { host: "schaffa.test" },
  });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] || "", /^text\/html/);
  assert.match(page.body, /<html lang="en">/);
  assert.match(page.body, /general read skill/);
  assert.match(page.body, /curl --fail --silent --show-error --location/);
  assert.match(page.body, /href="\/skills\/all\.md"/);

  for (const skill of exampleSkills) {
    assert.ok(skill.markdown.trim().split("\n").length <= 40);
    assert.ok(skill.markdown.length < 2_500);
    assert.match(skill.markdown, /^---\nname: schaffa-/);
    assert.match(skill.markdown, /^---\nname: schaffa-[^\n]+\ndescription: Use when /);
    const description = skill.markdown.match(/^description: (.+)$/m)?.[1];
    assert.ok(description);
    assert.ok(description.length <= 140);
    assert.match(page.body, new RegExp(`href="/skills/${skill.slug}/SKILL\\.md"`));
    const raw = await app.inject({
      method: "GET",
      url: `/skills/${skill.slug}/SKILL.md`,
      headers: { host: "schaffa.test" },
    });
    assert.equal(raw.statusCode, 200);
    assert.match(raw.headers["content-type"] || "", /^text\/markdown/);
    assert.match(String(raw.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal(raw.body, `${skill.markdown}\n`);
  }

  const missing = await app.inject({
    method: "GET",
    url: "/skills/missing/SKILL.md",
    headers: { host: "schaffa.test" },
  });
  assert.equal(missing.statusCode, 404);

  const allSkills = await app.inject({
    method: "GET",
    url: "/skills/all.md",
    headers: { host: "schaffa.test" },
  });
  assert.equal(allSkills.statusCode, 200);
  assert.match(allSkills.headers["content-type"] || "", /^text\/markdown/);
  assert.match(String(allSkills.headers["content-security-policy"]), /default-src 'none'/);
  assert.equal(allSkills.body, allSkillsMarkdown());
  for (const skill of exampleSkills) assert.ok(allSkills.body.includes(skill.markdown));

  const llm = await app.inject({
    method: "GET",
    url: "/llm.txt",
    headers: { host: "schaffa.test" },
  });
  const llms = await app.inject({
    method: "GET",
    url: "/llms.txt",
    headers: { host: "schaffa.test" },
  });
  assert.equal(llm.statusCode, 200);
  assert.match(llm.headers["content-type"] || "", /^text\/plain/);
  assert.match(String(llm.headers["content-security-policy"]), /default-src 'none'/);
  assert.equal(llm.body, llms.body);
  assert.ok(llm.body.trim().split("\n").length <= 80);
  assert.match(llm.body, /\/p\/<slug>.*published HTML page/);
  assert.match(llm.body, /\/f\/<id>\.<ext>.*published file/);
  assert.match(llm.body, /\/g\/<slug>.*published step-by-step guide/);
  assert.match(llm.body, /All returned publication URLs are public/);
  assert.match(llm.body, /Writes require a bearer token/);
  assert.match(llm.body, /202 Accepted/);
  assert.match(llm.body, /https:\/\/schaffa\.test\/skills/);
  assert.match(llm.body, /https:\/\/schaffa\.test\/skills\/all\.md/);
  assert.match(llm.body, /https:\/\/schaffa\.test\/skills\/read\/SKILL\.md/);
  for (const slug of ["html", "file", "guide", "presentation"]) {
    assert.match(
      llm.body,
      new RegExp(`https:\\/\\/schaffa\\.test\\/skills\\/${slug}\\/SKILL\\.md`),
    );
  }
  assert.match(llm.body, /https:\/\/schaffa\.test\/metadata\/openapi\.json/);
});

test("keeps legacy readable slugs but rejects new caller-chosen slugs", async () => {
  const created = await publishHtml("legacy-readable-page", "<h1>Existing page</h1>");
  assert.equal(created.statusCode, 202);
  const existing = await app.inject({
    method: "GET",
    url: "/p/legacy-readable-page",
    headers: { host: "schaffa.test" },
  });
  assert.equal(existing.statusCode, 200);
  assert.equal(existing.body, "<h1>Existing page</h1>");

  const body = multipart("html", "named.html", "text/html", "<h1>New named page</h1>");
  const rejected = await app.inject({
    method: "PUT",
    url: "/api/pages/new-readable-page",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(rejected.statusCode, 404);
  assert.equal(rejected.json().error, "not_found");
  assert.equal(
    db().prepare("SELECT 1 FROM pages WHERE slug = ?").get("new-readable-page"),
    undefined,
  );
});

test("keeps hidden-step screenshots private and maps multipart errors to 4xx", async () => {
  const owner = createToken("hidden screenshot owner");
  const auth = { host: "schaffa.test", authorization: `Bearer ${owner.token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: { ...auth, "content-type": "application/json" },
    payload: { title: "Hidden screenshot" },
  });
  const slug = created.json().slug;
  const invalid = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded", "if-match": '"1"' },
    payload: "title=nope",
  });
  assert.ok(invalid.statusCode >= 400 && invalid.statusCode < 500);

  const screenshot = await sharp({
    create: { width: 80, height: 50, channels: 4, background: "#315a3a" },
  })
    .png()
    .toBuffer();
  const body = multipartFields(
    {
      step: JSON.stringify({
        title: "Hidden",
        description: "Not part of publication",
        visible: false,
      }),
    },
    "screenshot",
    "hidden.png",
    "image/png",
    screenshot,
  );
  const step = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": body.contentType, "if-match": '"1"' },
    payload: body.payload,
  });
  assert.equal(step.statusCode, 201);
  const hiddenPath = new URL(step.json().steps[0].screenshotUrl).pathname;
  const visible = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"2"' },
    payload: { title: "Visible", description: "Publishable text step", capture: false },
  });
  assert.equal(visible.statusCode, 201);
  const published = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/finish`,
    headers: { ...auth, "if-match": '"3"' },
  });
  assert.equal(published.statusCode, 201);
  const hidden = await app.inject({
    method: "GET",
    url: hiddenPath,
    headers: { host: "schaffa.test" },
  });
  assert.equal(hidden.statusCode, 404);
});

test("rejects active HTML content", async () => {
  const response = await publishHtml("unsafe", '<button onclick="alert(1)">Nope</button>');
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error, "unsafe_html");

  const template = await publishHtml(
    "unsafe-template",
    "<template><script>alert(1)</script></template>",
  );
  assert.equal(template.statusCode, 422);
  assert.equal(template.json().error, "unsafe_html");

  const obfuscatedUrl = await publishHtml("unsafe-url", '<a href="jav\nascript:alert(1)">Nope</a>');
  assert.equal(obfuscatedUrl.statusCode, 422);
  assert.equal(obfuscatedUrl.json().error, "unsafe_html");
});
