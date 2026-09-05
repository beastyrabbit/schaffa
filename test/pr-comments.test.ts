import { mkdirSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  app,
  assert,
  bootstrapToken,
  config,
  db,
  multipart,
  processNextPendingScan,
  sharp,
  test,
} from "./server-fixture.js";

const guides = await import("../src/guides.js");
const { guideMetadataBytes } = await import("../src/service.js");
const { parseTrustedProxies } = await import("../src/config.js");

test("proxy configuration rejects invalid addresses with the variable name", () => {
  assert.deepEqual(parseTrustedProxies(), []);
  assert.deepEqual(parseTrustedProxies(" 127.0.0.1, ::1/128,10.0.0.0/8 "), [
    "127.0.0.1",
    "::1/128",
    "10.0.0.0/8",
  ]);
  for (const value of ["localhost", "10.0.0.1/33", "::1/129", "::1/", "10.0.0.1/1/2"])
    assert.throws(() => parseTrustedProxies(value), /TRUSTED_PROXIES/);
});

test("quarantine cleanup failure preserves the committed public image", {}, async (t) => {
  const image = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#195770" },
  })
    .png()
    .toBuffer();
  const body = multipart("file", "fixture.png", "image/png", image);
  const response = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 202);
  const row = db()
    .prepare("SELECT id, storage_path FROM files WHERE scan_status = 'pending'")
    .get() as { id: string; storage_path: string };
  const quarantine = path.join(config.dataDir, row.storage_path);
  db().function("fixture_cleanup_failure", () => {
    unlinkSync(quarantine);
    mkdirSync(quarantine);
    return 1;
  });
  db().exec(
    "CREATE TEMP TRIGGER fixture_cleanup AFTER UPDATE OF scan_status ON files WHEN NEW.scan_status = 'clean' BEGIN SELECT fixture_cleanup_failure(); END;",
  );
  t.after(async () => {
    db().exec("DROP TRIGGER IF EXISTS fixture_cleanup");
    await rm(quarantine, { recursive: true, force: true });
  });
  await assert.rejects(processNextPendingScan());
  const current = db().prepare("SELECT scan_status FROM files WHERE id = ?").get(row.id) as {
    scan_status: string;
  };
  assert.equal(current.scan_status, "clean");
  const download = await app.inject({
    url: new URL(response.json().publicUrl).pathname,
    headers: { host: "schaffa.test" },
  });
  assert.equal(download.statusCode, 200);
  assert.equal((await sharp(download.rawPayload).metadata()).format, "webp");
});

test("draft reductions remain available above lowered budgets; published caps explain recovery", async () => {
  let guide = guides.createGuide(
    { title: "Budget recovery", description: "Long description to reduce" },
    "bootstrap",
  );
  guide = await guides.addGuideStep(
    guide.slug,
    { title: "Remove me", description: "Text to reclaim", capture: false },
    undefined,
    "bootstrap",
    false,
    guide.editRevision,
  );
  config.maxGuideMetadataBytes = 1;
  config.maxStorageBytes = 1;
  guide = guides.updateGuide(
    guide.slug,
    { description: "" },
    "bootstrap",
    false,
    guide.editRevision,
  );
  guide = await guides.deleteGuideStep(
    guide.slug,
    guide.steps[0]?.id || "",
    "bootstrap",
    false,
    guide.editRevision,
  );
  assert.equal(guide.steps.length, 0);
  await guides.deleteGuide(guide.slug);
  config.maxGuideMetadataBytes = 1024 * 1024;
  config.maxStorageBytes = 1024 * 1024;
  guide = guides.createGuide({ title: "Published cap" }, "bootstrap");
  guide = await guides.addGuideStep(
    guide.slug,
    { title: "Keep", description: "Continue", capture: false },
    undefined,
    "bootstrap",
    false,
    guide.editRevision,
  );
  const published = guides.finishGuide(guide.slug, "bootstrap", false, guide.editRevision);
  config.maxGuideRevisions = 1;
  assert.throws(
    () =>
      guides.updateGuide(
        guide.slug,
        { title: "Edit" },
        "bootstrap",
        false,
        published.guide.editRevision,
      ),
    /MAX_GUIDE_REVISIONS.*take down/,
  );
  assert.equal(guides.getPublishedGuide(guide.slug, 1)?.guide.title, "Published cap");
  await guides.deleteGuide(guide.slug);
});

test("metadata counters migrate, track UTF-8 edits, rollback, and cascade deletion", async () => {
  const { closeDb } = await import("../src/db.js");
  const baseline = guideMetadataBytes();
  const guide = guides.createGuide(
    { title: "Übung", description: "測試", language: "en" },
    "bootstrap",
  );
  const { id } = db().prepare("SELECT id FROM guides WHERE slug = ?").get(guide.slug) as {
    id: string;
  };
  const expected = Buffer.byteLength("Übung測試en");
  assert.equal(guideMetadataBytes(id), expected);
  assert.equal(guideMetadataBytes(), baseline + expected);
  db().exec("BEGIN");
  db().prepare("UPDATE guides SET description = ? WHERE id = ?").run("longer text", id);
  assert.notEqual(guideMetadataBytes(id), expected);
  db().exec("ROLLBACK");
  assert.equal(guideMetadataBytes(id), expected);
  await guides.addGuideStep(
    guide.slug,
    { title: "Step", description: "Continue", capture: false },
    undefined,
    "bootstrap",
    false,
    guide.editRevision,
    "counter-fixture",
  );
  const beforeMigration = guideMetadataBytes();
  for (const row of db()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_metadata_%'")
    .all() as Array<{ name: string }>)
    db().exec(`DROP TRIGGER ${row.name}`);
  db().exec("DROP TABLE guide_metadata_usage");
  closeDb();
  assert.equal(guideMetadataBytes(), beforeMigration);
  await guides.deleteGuide(guide.slug);
  assert.equal(guideMetadataBytes(id), 0);
  assert.equal(guideMetadataBytes(), baseline);
});

test("public guide validators return 304 but still enforce takedown", async () => {
  let guide = guides.createGuide({ title: "Cache fixture" }, "bootstrap");
  guide = await guides.addGuideStep(
    guide.slug,
    { title: "Step", description: "Continue", capture: false },
    undefined,
    "bootstrap",
    false,
    guide.editRevision,
  );
  guides.finishGuide(guide.slug, "bootstrap", false, guide.editRevision);
  for (const url of [
    `/g/${guide.slug}`,
    `/g/${guide.slug}/1`,
    `/g/${guide.slug}.json`,
    `/g/${guide.slug}.md`,
  ]) {
    const first = await app.inject({ url, headers: { host: "schaffa.test" } });
    assert.equal(first.statusCode, 200);
    assert.ok(first.headers.etag);
    const cached = await app.inject({
      url,
      headers: { host: "schaffa.test", "if-none-match": `"different", W/${first.headers.etag}` },
    });
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, "");
  }
  const url = `/g/${guide.slug}/1`;
  const first = await app.inject({ url, headers: { host: "schaffa.test" } });
  await guides.deleteGuide(guide.slug);
  assert.equal(
    (
      await app.inject({
        url,
        headers: { host: "schaffa.test", "if-none-match": String(first.headers.etag) },
      })
    ).statusCode,
    404,
  );
});
