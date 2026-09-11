import {
  adminCookie,
  app,
  assert,
  bootstrapToken,
  createToken,
  db,
  test,
} from "./server-fixture.js";

const { selectAdminPublications } = await import("../src/admin-publications.js");

test("management form failures offer HTML recovery while API clients retain JSON", async () => {
  for (const accept of ["text/html", "application/json"]) {
    const response = await app.inject({
      method: "POST",
      url: "/admin/tokens",
      headers: {
        host: "schaffa.test",
        cookie: adminCookie(bootstrapToken),
        accept,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "name=Fixture&scope=invalid",
    });
    assert.equal(response.statusCode, 422);
    if (accept === "text/html") {
      assert.match(response.headers["content-type"] || "", /text\/html/);
      assert.match(response.body, /Aktion fehlgeschlagen/);
      assert.match(response.body, /href="\/admin"/);
      assert.match(response.headers["cache-control"] || "", /no-store/);
    } else assert.ok(response.json().message);
  }
});

test("admin filtering precedes pagination and preserves totals, uploaders, and Unicode search", async () => {
  const owner = createToken("Pagination owner");
  const other = createToken("Other owner");
  const insert = db().prepare(
    "INSERT INTO files(id,filename,storage_path,media_type,bytes,sha256,created_by_token_id,created_at) VALUES(?,?,?,'text/plain',1,'fixture',?,'2026-01-01 00:00:00')",
  );
  for (let index = 0; index < 125; index++) {
    const id = `fixture-${String(index).padStart(4, "0")}`;
    insert.run(id, `Übung-${id}.txt`, "fixture", index < 120 ? owner.id : other.id);
  }
  const filters = {
    q: "übung",
    user: "",
    uploader: owner.id,
    kind: "files" as const,
    lifetime: "all" as const,
  };
  const first = selectAdminPublications(filters, 1);
  const last = selectAdminPublications(filters, 99);
  assert.equal(first.total, 120);
  assert.equal(first.ids.files.length, 50);
  assert.equal(last.page, 3);
  assert.equal(last.ids.files.length, 20);
  assert.ok(first.uploaders.some((item) => item.id === other.id));
  assert.ok(first.ids.files.every((id) => !last.ids.files.includes(id)));
  const page = await app.inject({
    url: `/admin?kind=files&q=%C3%BCbung&uploader=${owner.id}&page=2`,
    headers: { host: "schaffa.test", cookie: adminCookie(bootstrapToken) },
  });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /120 Treffer · Seite 2 von 3/);
  assert.equal((page.body.match(/action="\/admin\/files\//g) || []).length, 50);
  assert.match(page.body, /page=3/);
  assert.ok(!page.body.includes("Übung-fixture-0000.txt"));
});
