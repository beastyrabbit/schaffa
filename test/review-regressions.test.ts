import { Ajv } from "ajv";
import type { GuideView } from "../src/guides.js";
import {
  app,
  assert,
  bootstrapToken,
  config,
  createToken,
  db,
  finishPendingScans,
  multipart,
  pendingScanCount,
  processNextPendingScan,
  queueHtmlWithToken,
  scannerState,
  sharp,
  test,
} from "./server-fixture.js";

const { guidePreflight } = await import("../src/guides.js");
const { guideMetadataBytes } = await import("../src/service.js");
const { cleanImage } = await import("../src/image-cleaner.js");
const { openApiDocument } = await import("../src/openapi.js");

test("version backfill resumes after ALTER and preserves previously allocated counters", async () => {
  const { closeDb } = await import("../src/db.js");
  const publish = () => queueHtmlWithToken("migration-restart", "<h1>Fixture</h1>", bootstrapToken);
  assert.equal((await publish()).json().version, 1);
  assert.equal((await publish()).json().version, 2);
  // Model a startup interrupted after the new column committed with its default.
  db()
    .prepare("UPDATE pages SET last_allocated_version = 0 WHERE slug = ?")
    .run("migration-restart");
  closeDb();
  assert.equal((await publish()).json().version, 3);
  // A higher counter can outlive deleted versions and must never be backfilled down.
  db()
    .prepare("UPDATE pages SET last_allocated_version = 5 WHERE slug = ?")
    .run("migration-restart");
  closeDb();
  assert.equal((await publish()).json().version, 6);
  await finishPendingScans();
});

test("real publication and error responses match their OpenAPI schemas", async () => {
  const schemas = openApiDocument().components.schemas;
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const published = await queueHtmlWithToken(
    "schema-fixture",
    "<h1>Schema fixture</h1>",
    bootstrapToken,
  );
  const validatePage = ajv.compile(schemas.PagePublication);
  assert.ok(validatePage(published.json()), JSON.stringify(validatePage.errors));
  const missing = await app.inject({
    url: "/api/guides/abc234def567",
    headers: { host: "schaffa.test" },
  });
  const validateError = ajv.compile(schemas.Error);
  assert.ok(validateError(missing.json()), JSON.stringify(validateError.errors));
  await finishPendingScans();
});

test("guide preflight checks each public metadata and step field", () => {
  const safe = {
    title: "Guide",
    description: "Overview",
    targetUrl: "https://example.test/",
    language: "en",
    steps: [
      { id: "fixture-step", title: "Step", description: "Continue", visible: true, capture: false },
    ],
  } as GuideView;
  assert.equal(guidePreflight(safe).ready, true);
  for (const field of ["title", "description", "targetUrl"] as const) {
    const value =
      field === "targetUrl"
        ? "https://example.test/?contact=fixture%40example.test"
        : "fixture@example.test";
    const result = guidePreflight({ ...safe, [field]: value });
    assert.equal(result.ready, false);
    assert.ok(result.sensitiveFindings.some((item) => item.field === field && !item.stepId));
  }
  const step = safe.steps[0];
  assert.ok(step);
  const result = guidePreflight({
    ...safe,
    steps: [{ ...step, description: "fixture@example.test" }],
  });
  assert.equal(result.sensitiveFindings[0]?.stepId, "fixture-step");
});

test("mixed scan queues make progress while a page keeps failing", async () => {
  await queueHtmlWithToken("mixed-retry", "<h1>Page fixture</h1>", bootstrapToken);
  scannerState.mode = "unavailable";
  assert.equal((await processNextPendingScan()).status, "pending");
  const body = multipart("file", "fixture.txt", "text/plain", "harmless file fixture");
  const uploaded = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(uploaded.statusCode, 202);
  scannerState.mode = "ok";
  const file = await processNextPendingScan();
  assert.equal(file.type, "file");
  assert.equal(file.status, "clean");
  assert.equal((await processNextPendingScan()).processed, false);
  assert.equal(pendingScanCount(), 1);
  await finishPendingScans();
});

test("image conversion rejects positive quota growth and keeps converted bytes private", async () => {
  const input = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#334455" },
  })
    .png({ palette: true })
    .toBuffer();
  // Metadata-free, palette PNGs can be smaller than the required WebP output.
  const candidates = [input, await sharp(input).gif().toBuffer()];
  let fixture: Buffer | undefined;
  for (const candidate of candidates)
    if ((await cleanImage(candidate)).data.length > candidate.length) fixture = candidate;
  assert.ok(fixture, "The harmless image must grow during conversion");
  const body = multipart("file", "fixture.gif", "image/gif", fixture);
  const uploaded = await app.inject({
    method: "POST",
    url: "/api/files?image=true",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(uploaded.statusCode, 202);
  const usage = db()
    .prepare(
      "SELECT (SELECT COALESCE(SUM(bytes),0) FROM page_versions) + (SELECT COALESCE(SUM(bytes),0) FROM files) + (SELECT COALESCE(SUM(bytes),0) FROM guide_images) AS bytes",
    )
    .get() as { bytes: number };
  config.maxStorageBytes = usage.bytes + guideMetadataBytes();
  const result = await processNextPendingScan();
  assert.equal(result.status, "rejected");
  const publicUrl = new URL(uploaded.json().publicUrl).pathname;
  assert.notEqual(
    (await app.inject({ url: publicUrl, headers: { host: "schaffa.test" } })).statusCode,
    200,
  );
});

test("guide metadata and step budgets roll back failed edits", async () => {
  const owner = createToken("guide budget fixture", ["upload"]);
  const headers = { host: "schaffa.test", authorization: `Bearer ${owner.token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers,
    payload: { title: "Budget fixture" },
  });
  assert.equal(created.statusCode, 201);
  const guide = created.json();
  config.maxGuideSteps = 1;
  const first = await app.inject({
    method: "POST",
    url: `/api/guides/${guide.slug}/steps`,
    headers: { ...headers, "if-match": String(guide.editRevision) },
    payload: { title: "First", description: "Continue", capture: false },
  });
  assert.equal(first.statusCode, 201);
  const second = await app.inject({
    method: "POST",
    url: `/api/guides/${guide.slug}/steps`,
    headers: { ...headers, "if-match": String(first.json().editRevision) },
    payload: { title: "Second", description: "Continue", capture: false },
  });
  assert.equal(second.json().error, "guide_limit");
  config.maxGuideMetadataBytes = 1;
  const update = await app.inject({
    method: "PATCH",
    url: `/api/guides/${guide.slug}`,
    headers: { ...headers, "if-match": String(first.json().editRevision) },
    payload: { description: "Should roll back" },
  });
  assert.equal(update.json().error, "guide_limit");
  const current = await app.inject({ url: `/api/guides/${guide.slug}`, headers });
  assert.equal(current.json().description, null);
  assert.equal(current.json().steps.length, 1);
});
