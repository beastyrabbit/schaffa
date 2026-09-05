import {
  app,
  assert,
  assertNoRedNear,
  assertRedNear,
  assertSlateBackground,
  bootstrapToken,
  cleanImage,
  createToken,
  decodeRgbImage,
  finishPendingScans,
  multipart,
  multipartFields,
  redPixelBounds,
  renderMarkedScreenshot,
  rgbAt,
  sharp,
  test,
} from "./server-fixture.js";

test("keeps cursor markers visible at all four screenshot corners", async () => {
  const corners = [
    { name: "top-left", x: 0, y: 0, inwardX: 1, inwardY: 1 },
    { name: "top-right", x: 320, y: 0, inwardX: -1, inwardY: 1 },
    { name: "bottom-left", x: 0, y: 180, inwardX: 1, inwardY: -1 },
    { name: "bottom-right", x: 320, y: 180, inwardX: -1, inwardY: -1 },
  ];

  for (const corner of corners) {
    const image = await renderMarkedScreenshot(320, 180, {
      x: corner.x,
      y: corner.y,
      viewportWidth: 320,
      viewportHeight: 180,
    });
    const expectedX = corner.x === 0 ? 0 : image.width - 1;
    const expectedY = corner.y === 0 ? 0 : image.height - 1;
    assertRedNear(image, expectedX, expectedY, 3, `${corner.name} cursor tip`);
    assertRedNear(
      image,
      expectedX + corner.inwardX * 8,
      expectedY + corner.inwardY * 8,
      3,
      `${corner.name} inward cursor body`,
    );
  }
});

test("scales click coordinates independently for unequal axes and Retina images", async () => {
  const unequal = await renderMarkedScreenshot(480, 180, {
    x: 60,
    y: 240,
    viewportWidth: 240,
    viewportHeight: 360,
  });
  assertRedNear(unequal, 120, 120, 3, "unequal-axis marker");
  assertNoRedNear(unequal, 30, 120, 8, "x coordinate scaled with the y ratio");
  assertNoRedNear(unequal, 120, 60, 8, "y coordinate left at an unscaled position");

  const retina = await renderMarkedScreenshot(800, 600, {
    x: 125.5,
    y: 75.25,
    viewportWidth: 400,
    viewportHeight: 300,
  });
  assertRedNear(retina, 251, 151, 3, "Retina marker");
  assertNoRedNear(retina, 126, 75, 8, "unscaled CSS-pixel position");
});

test("keeps the cursor legible on a small screenshot", async () => {
  const image = await renderMarkedScreenshot(36, 24, {
    x: 18,
    y: 12,
    viewportWidth: 36,
    viewportHeight: 24,
  });

  assert.equal(image.width, 36);
  assert.equal(image.height, 24);
  assertRedNear(image, 18, 12, 3, "small-image cursor tip");
  const preservedBackground = rgbAt(image, 1, 12);
  assert.ok(
    preservedBackground[0] < 120 && preservedBackground[1] < 140 && preservedBackground[2] < 160,
    `small-image marker should not cover the full screenshot: ${preservedBackground.join(",")}`,
  );
});

test("draws a compact cursor instead of covering the clicked content", async () => {
  const image = await renderMarkedScreenshot(2215, 1407, {
    x: 1100,
    y: 700,
    viewportWidth: 2215,
    viewportHeight: 1407,
  });
  const bounds = redPixelBounds(image);

  assert.ok(bounds, "cursor should contain a visible red outline");
  assert.ok(
    bounds.width >= 12 && bounds.width <= 30,
    `cursor outline should stay narrow, received ${bounds.width}px`,
  );
  assert.ok(
    bounds.height >= 20 && bounds.height <= 38,
    `cursor outline should stay compact, received ${bounds.height}px`,
  );
  assertRedNear(image, 1100, 700, 3, "cursor hot spot");
});

test("scales and draws a valid click target outline", async () => {
  const image = await renderMarkedScreenshot(500, 300, {
    x: 210,
    y: 125,
    viewportWidth: 250,
    viewportHeight: 150,
    box: { left: 50, top: 40, width: 75, height: 30 },
  });

  // The target is scaled by 2x and padded by four output pixels on every side.
  const left = 96;
  const top = 76;
  const right = 254;
  const bottom = 144;
  assertRedNear(image, left, (top + bottom) / 2, 3, "target left edge");
  assertRedNear(image, right, (top + bottom) / 2, 3, "target right edge");
  assertRedNear(image, (left + right) / 2, top, 3, "target top edge");
  assertRedNear(image, (left + right) / 2, bottom, 3, "target bottom edge");
  assertRedNear(image, 420, 250, 3, "cursor beside the target outline");
});

test("keeps a tiny checkbox target and its adjacent label visible", async () => {
  const image = await renderMarkedScreenshot(500, 300, {
    x: 205,
    y: 105,
    viewportWidth: 500,
    viewportHeight: 300,
    box: { left: 200, top: 100, width: 10, height: 10 },
  });

  // A checkbox-sized target keeps its red outline while the cursor is mirrored
  // to the left instead of covering the label immediately to its right.
  assertRedNear(image, 214, 105, 3, "tiny target right edge");
  assertRedNear(image, 205, 105, 3, "tiny-target cursor tip");
  assertSlateBackground(rgbAt(image, 224, 108), "space reserved for the checkbox label");
});

test("keeps annotation pixels already present in a replacement screenshot", async () => {
  const owner = createToken("pre-annotated replacement owner");
  const auth = { host: "schaffa.test", authorization: `Bearer ${owner.token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: { ...auth, "content-type": "application/json" },
    payload: { title: "Pre-annotated replacement" },
  });
  assert.equal(created.statusCode, 201);
  const slug = created.json().slug as string;
  const marker = { x: 80, y: 45, viewportWidth: 200, viewportHeight: 120 };
  const originalScreenshot = await sharp({
    create: { width: 400, height: 240, channels: 4, background: "#334155" },
  })
    .png()
    .toBuffer();
  const stepBody = multipartFields(
    {
      step: JSON.stringify({
        title: "Marked step",
        description: "The original upload has a generated click marker.",
        clickMarker: marker,
      }),
    },
    "screenshot",
    "original.png",
    "image/png",
    originalScreenshot,
  );
  const added = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": stepBody.contentType, "if-match": '"1"' },
    payload: stepBody.payload,
  });
  assert.equal(added.statusCode, 201);
  assert.equal(
    added.json().steps[0].clickMarker,
    undefined,
    "the step API does not persist click-marker coordinates for later replacements",
  );
  const stepId = added.json().steps[0].id as string;
  const originalPath = new URL(added.json().steps[0].screenshotUrl).pathname;

  // Guide steps do not retain click-marker coordinates. The replacement route
  // can keep annotation pixels already in the file, but cannot recreate them.
  const replacementSource = await sharp({
    create: { width: 400, height: 240, channels: 4, background: "#0f766e" },
  })
    .png()
    .toBuffer();
  const annotatedReplacement = await cleanImage(replacementSource, marker);
  const replacementBody = multipart(
    "screenshot",
    "replacement.webp",
    "image/webp",
    annotatedReplacement.data,
  );
  const replaced = await app.inject({
    method: "PUT",
    url: `/api/guides/${slug}/steps/${stepId}/screenshot`,
    headers: {
      ...auth,
      "content-type": replacementBody.contentType,
      "if-match": '"2"',
    },
    payload: replacementBody.payload,
  });
  assert.equal(replaced.statusCode, 200);
  assert.equal(replaced.json().editRevision, 3);
  const replacementPath = new URL(replaced.json().steps[0].screenshotUrl).pathname;
  assert.notEqual(replacementPath, originalPath);

  const removedOriginal = await app.inject({ method: "GET", url: originalPath, headers: auth });
  assert.equal(removedOriginal.statusCode, 404);
  const replacementImage = await app.inject({
    method: "GET",
    url: replacementPath,
    headers: auth,
  });
  assert.equal(replacementImage.statusCode, 200);
  const decoded = await decodeRgbImage(replacementImage.rawPayload);
  assertRedNear(decoded, 160, 90, 4, "replacement marker");
});

test("downscales images, preserves alpha, and strips identifying metadata", async () => {
  const source = await sharp({
    create: {
      width: 4000,
      height: 1000,
      channels: 4,
      background: { r: 179, g: 55, b: 42, alpha: 0.4 },
    },
  })
    .withExif({ IFD0: { Copyright: "private-camera-owner" } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><private>home-location</private></x:xmpmeta>')
    .png()
    .toBuffer();
  const body = multipart("file", "private-holiday-name.png", "image/png", source);
  const upload = await app.inject({
    method: "POST",
    url: "/api/files",
    headers: {
      host: "schaffa.test",
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });

  assert.equal(upload.statusCode, 202);
  await finishPendingScans();
  assert.match(upload.json().filename, /^[A-Za-z0-9_-]{22}\.webp$/);
  assert.doesNotMatch(upload.body, /private-holiday-name/);
  assert.equal(upload.json().mediaType, "image/webp");
  assert.equal(upload.json().bytes, null);
  assert.equal(upload.json().sha256, null);

  const publicPath = new URL(upload.json().publicUrl).pathname;
  const download = await app.inject({
    method: "GET",
    url: publicPath,
    headers: { host: "schaffa.test" },
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "image/webp");

  const metadata = await sharp(download.rawPayload).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 2560);
  assert.equal(metadata.height, 640);
  assert.equal(metadata.hasAlpha, true);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.iptc, undefined);
  assert.equal(metadata.icc, undefined);

  const { data, info } = await sharp(download.rawPayload).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  assert.ok(info.channels === 4 && data[3] !== undefined && data[3] < 255);

  const original = await app.inject({
    method: "GET",
    url: `${publicPath}/original`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(original.statusCode, 404);
});
