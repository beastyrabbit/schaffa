import {
  app,
  assert,
  bootstrapToken,
  createToken,
  db,
  test,
  updateSettings,
} from "./server-fixture.js";

test("capabilities validate tokens and reflect publishing policy without creating content", async () => {
  const check = (token?: string) =>
    app.inject({
      method: "GET",
      url: "/api/capabilities",
      headers: { host: "schaffa.test", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  const counts = () =>
    ["pages", "files", "guides"].map(
      (table) => db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
    );
  const before = counts();
  const anonymous = await check();
  assert.equal(anonymous.statusCode, 200);
  assert.equal(anonymous.headers["cache-control"], "no-store");
  assert.equal(anonymous.json().authenticated, false);
  assert.deepEqual(anonymous.json().capabilities.staticHtml, { allowed: true, reason: null });
  assert.deepEqual(anonymous.json().capabilities.interactiveHtml, {
    allowed: false,
    reason: "token_required",
  });
  assert.equal((await check(`sfa_${"x".repeat(43)}`)).statusCode, 401);
  assert.equal((await check("malformed")).statusCode, 401);

  const upload = createToken("doctor upload");
  const valid = await check(upload.token);
  assert.equal(valid.json().authenticated, true);
  for (const name of ["staticHtml", "fileUploads", "guides"]) {
    assert.deepEqual(valid.json().capabilities[name], { allowed: true, reason: null });
  }
  assert.equal(valid.json().capabilities.interactiveHtml.reason, "interactive_scope_required");
  assert.ok(!valid.body.includes(upload.token));
  db().prepare("UPDATE tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(upload.id);
  assert.equal((await check(upload.token)).statusCode, 401);

  db()
    .prepare("INSERT INTO users (id, shoo_subject) VALUES (?, ?)")
    .run("doctor-user", "doctor-subject");
  const interactive = createToken("doctor interactive", ["interactive"], "doctor-user");
  try {
    assert.equal(
      (await check(interactive.token)).json().capabilities.interactiveHtml.reason,
      "interactive_disabled",
    );
    await updateSettings({ interactivePublishingEnabled: true });
    assert.equal(
      (await check(interactive.token)).json().capabilities.interactiveHtml.reason,
      "interactive_not_allowed",
    );
    db().prepare("UPDATE users SET can_publish_interactive = 1 WHERE id = ?").run("doctor-user");
    const allowed = (await check(interactive.token)).json();
    assert.deepEqual(allowed.capabilities.interactiveHtml, { allowed: true, reason: null });
    assert.equal(allowed.capabilities.staticHtml.reason, "upload_scope_required");
    assert.equal(allowed.capabilities.fileUploads.allowed, false);
    assert.equal(allowed.capabilities.guides.allowed, false);
    assert.equal((await check(bootstrapToken)).json().capabilities.interactiveHtml.allowed, false);
    const unowned = createToken("unowned interactive", ["interactive"]);
    assert.equal(
      (await check(unowned.token)).json().capabilities.interactiveHtml.reason,
      "interactive_not_allowed",
    );
    await updateSettings({ writesLocked: true });
    for (const token of [undefined, interactive.token, bootstrapToken]) {
      const result = await check(token);
      assert.equal(result.statusCode, 200);
      for (const capability of Object.values(result.json().capabilities)) {
        assert.deepEqual(capability, { allowed: false, reason: "writes_locked" });
      }
    }
    assert.deepEqual(counts(), before);
  } finally {
    await updateSettings({ writesLocked: false, interactivePublishingEnabled: false });
  }
});
