import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { waitForVideoScan } from "../dist/client.js";
import {
  assertGuideVideoProvenance,
  createVideoCapture,
  readVideoTimeline,
} from "../dist/video.js";

test("video capture retains click order, excludes paused clicks, and persists owner identity", {}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-video-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capture = await createVideoCapture(directory, "abc234def567");
  const click = { x: 30, y: 40, viewportWidth: 1280, viewportHeight: 720 };
  capture.frame(Buffer.from("fixture frame"));
  capture.click(click, "First");
  capture.click(click, "Second");
  capture.pause();
  capture.click(click, "Private");
  const manifest = await capture.finish();
  const timeline = await readVideoTimeline(manifest);
  assert.deepEqual(
    timeline.frames.filter((frame) => frame.click).map((frame) => frame.caption),
    ["First", "Second"],
  );
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).guideSlug, "abc234def567");
  assert.equal(
    await readFile(path.join(directory, timeline.frames[0].file), "utf8"),
    "fixture frame",
  );
});

test("video manifests reject traversal and bad coordinates and accept native guide stills", {}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-video-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = path.join(directory, "manifest.json");
  for (const frame of [
    { file: "../private.png", time: 0 },
    { file: "step.png", time: -1 },
    { file: "step.png", time: 0, click: { x: 90, y: 10, viewportWidth: 0, viewportHeight: 720 } },
  ]) {
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, frames: [frame] }));
    await assert.rejects(readVideoTimeline(manifest), /Invalid/);
  }
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      steps: [
        { screenshot: "step.png", title: "Open projects" },
        { screenshot: null, title: "Private" },
      ],
    }),
  );
  assert.deepEqual((await readVideoTimeline(manifest)).frames, [
    { file: "step.png", time: 0, caption: "Open projects" },
  ]);
});

test("scan polling refuses other origins and accepts only clean results", async () => {
  let requests = 0;
  const fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ scanStatus: "clean" }));
  };
  await assert.rejects(
    waitForVideoScan({ statusUrl: "https://example.org/f/test.webm/status", fetch }),
    /Invalid/,
  );
  assert.equal(requests, 0);
  await waitForVideoScan({ statusUrl: "https://schaffa.dev/f/test.webm/status", fetch });
  assert.equal(requests, 1);
  await assert.rejects(
    waitForVideoScan({
      statusUrl: "https://schaffa.dev/f/test.webm/status",
      fetch: async () => new Response(JSON.stringify({ scanStatus: "rejected" })),
    }),
    /rejected/,
  );
});

test("capture failure stays failed when reopening the saved manifest", {}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-video-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capture = await createVideoCapture(directory, undefined, 4);
  capture.frame(Buffer.from("too large"));
  await assert.rejects(capture.finish(), /size limit/);
  await assert.rejects(readVideoTimeline(path.join(directory, "video.json")), /incomplete/);
});

test("guide video rejects draft edits while allowing an unchanged first publication", {}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-video-provenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = path.join(directory, "video.json");
  const guide = { slug: "abc234def567", status: "recording", revision: 0, editRevision: 3 };
  await writeFile(manifest, JSON.stringify({ guideSlug: guide.slug, guideEditRevision: 3 }));
  await assertGuideVideoProvenance(manifest, guide);
  await assert.rejects(
    assertGuideVideoProvenance(manifest, { ...guide, editRevision: 4 }),
    /guide changed/,
  );
  await assertGuideVideoProvenance(manifest, {
    ...guide,
    status: "published",
    revision: 1,
    editRevision: 4,
  });
  await assert.rejects(
    assertGuideVideoProvenance(manifest, {
      ...guide,
      status: "published",
      revision: 2,
      editRevision: 5,
    }),
    /guide changed/,
  );
});
