import {
  app,
  assert,
  assertLightNear,
  assertRedNear,
  createToken,
  multipartFields,
  sharp,
  test,
} from "./server-fixture.js";

test("records, edits, publishes, and revisions a guide incrementally", async () => {
  const owner = createToken("guide owner");
  const other = createToken("guide stranger");
  const auth = { host: "schaffa.test", authorization: `Bearer ${owner.token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      title: "Projekt anlegen",
      description: "Ein belastbarer Beispielguide.",
      targetUrl: "https://app.example.com/projects?view=active&sort=name",
    },
  });
  assert.equal(created.statusCode, 201);
  assert.match(created.json().slug, /^[a-z2-7]{12}$/);
  assert.equal(created.json().status, "recording");
  assert.equal(created.json().editRevision, 1);
  assert.equal(created.json().targetUrl, "https://app.example.com/projects?view=active&sort=name");
  const slug = created.json().slug as string;

  const privateBeforePublish = await app.inject({
    method: "GET",
    url: `/g/${slug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(privateBeforePublish.statusCode, 404);

  const stepOne = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: {
      ...auth,
      "content-type": "application/json",
      "if-match": '"1"',
      "idempotency-key": "guide-step-one",
    },
    payload: {
      title: "Projekt öffnen",
      description: "Die Projektübersicht öffnen.",
      action: { type: "navigate", target: "/projects" },
      verification: "Die Projektliste ist sichtbar.",
      capture: false,
    },
  });
  assert.equal(stepOne.statusCode, 201);
  assert.equal(stepOne.json().steps.length, 1);
  assert.equal(stepOne.json().editRevision, 2);
  const firstStepId = stepOne.json().steps[0].id as string;

  const replay = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: {
      ...auth,
      "content-type": "application/json",
      "if-match": '"1"',
      "idempotency-key": "guide-step-one",
    },
    payload: { title: "would duplicate", description: "would duplicate" },
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.json().steps.length, 1);
  assert.equal(replay.json().steps[0].id, firstStepId);

  const screenshot = await sharp({
    create: { width: 3000, height: 2000, channels: 4, background: "#4b5563" },
  })
    .png()
    .toBuffer();
  const secondBody = multipartFields(
    {
      step: JSON.stringify({
        title: "Neu wählen",
        description: "New project auswählen.",
        action: { type: "click", target: "New project" },
        verification: "Das Formular ist sichtbar.",
        clickMarker: {
          x: 1500,
          y: 1000,
          viewportWidth: 3000,
          viewportHeight: 2000,
          box: { left: 1400, top: 900, width: 200, height: 200 },
        },
      }),
    },
    "screenshot",
    "capture.png",
    "image/png",
    screenshot,
  );
  const stepTwo = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": secondBody.contentType, "if-match": '"2"' },
    payload: secondBody.payload,
  });
  assert.equal(stepTwo.statusCode, 201);
  assert.equal(stepTwo.json().steps.length, 2);
  assert.match(stepTwo.json().steps[1].screenshotUrl, /\/g\/.*\/images\/.*\.webp$/);
  const secondStepId = stepTwo.json().steps[1].id as string;
  const imagePath = new URL(stepTwo.json().steps[1].screenshotUrl).pathname;

  const privateImage = await app.inject({
    method: "GET",
    url: imagePath,
    headers: { host: "schaffa.test" },
  });
  assert.equal(privateImage.statusCode, 404);
  const ownerImage = await app.inject({ method: "GET", url: imagePath, headers: auth });
  assert.equal(ownerImage.statusCode, 200);
  assert.equal((await sharp(ownerImage.rawPayload).metadata()).format, "webp");
  const marked = await sharp(ownerImage.rawPayload).raw().toBuffer({ resolveWithObject: true });
  assert.equal(Math.max(marked.info.width, marked.info.height), 2560);
  const markerX = Math.round(marked.info.width / 2);
  const markerY = Math.round(marked.info.height / 2);
  const markedImage = {
    data: marked.data,
    width: marked.info.width,
    height: marked.info.height,
  };
  assertRedNear(markedImage, markerX, markerY, 3, "uploaded cursor hot spot");
  assertLightNear(markedImage, markerX + 3, markerY + 12, 3, "uploaded cursor fill");

  const stale = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}/steps/${firstStepId}`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"2"' },
    payload: { title: "Stale" },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, "edit_conflict");

  const stranger = await app.inject({
    method: "GET",
    url: `/api/guides/${slug}`,
    headers: { host: "schaffa.test", authorization: `Bearer ${other.token}` },
  });
  assert.equal(stranger.statusCode, 403);

  const edited = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}/steps/${firstStepId}`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"3"' },
    payload: {
      title: "Projektübersicht öffnen",
      description: "Die aktuelle Projektübersicht öffnen.",
    },
  });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().editRevision, 4);
  const reordered = await app.inject({
    method: "PUT",
    url: `/api/guides/${slug}/order`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"4"' },
    payload: { order: [secondStepId, firstStepId] },
  });
  assert.equal(reordered.statusCode, 200);
  assert.equal(reordered.json().steps[0].id, secondStepId);

  const finished = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/finish`,
    headers: { ...auth, "if-match": '"5"' },
  });
  assert.equal(finished.statusCode, 201);
  assert.equal(finished.json().guide.status, "published");
  assert.equal(finished.json().preflight.ready, true);
  assert.equal(finished.json().guide.revision, 1);

  const publicGuide = await app.inject({
    method: "GET",
    url: `/g/${slug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(publicGuide.statusCode, 200);
  assert.match(publicGuide.body, /Projekt anlegen/);
  assert.match(publicGuide.body, /Projektübersicht öffnen/);
  assert.match(
    publicGuide.body,
    /class="target-link" href="https:\/\/app\.example\.com\/projects\?view=active&amp;sort=name"/,
  );
  assert.match(publicGuide.body, /Ziel öffnen/);
  assert.match(
    publicGuide.body,
    /class="step-action-link" href="https:\/\/app\.example\.com\/projects" target="_blank" rel="noopener noreferrer" aria-label="Seite öffnen \(neuer Tab\)">Seite öffnen/,
  );
  assert.doesNotMatch(publicGuide.body, /<code>navigate<\/code>/);
  assert.match(
    publicGuide.body,
    /class="screenshot-link" href="https:\/\/schaffa.test\/g\/[^" ]+" target="_blank"/,
  );
  assert.match(publicGuide.body, /class="zoom-hint"[^>]*>Bild vergrößern/);
  assert.doesNotMatch(publicGuide.body, /role="dialog"|aria-modal/);
  assert.match(publicGuide.body, /öffnet einen neuen Tab/);
  assert.doesNotMatch(publicGuide.body, /<script|<form|onclick=/i);
  assert.match(String(publicGuide.headers["content-security-policy"]), /script-src 'none'/);
  const publicImage = await app.inject({
    method: "GET",
    url: imagePath,
    headers: { host: "schaffa.test" },
  });
  assert.equal(publicImage.statusCode, 200);
  assert.deepEqual(
    publicImage.rawPayload,
    ownerImage.rawPayload,
    "the public guide should serve the same image with the cursor baked in",
  );

  const json = await app.inject({
    method: "GET",
    url: `/g/${slug}.json`,
    headers: { host: "schaffa.test" },
  });
  const markdown = await app.inject({
    method: "GET",
    url: `/g/${slug}.md`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(json.statusCode, 200);
  assert.equal(json.json().revision, 1);
  assert.equal(json.json().targetUrl, "https://app.example.com/projects?view=active&sort=name");
  assert.match(markdown.body, /# Projekt anlegen/);
  assert.match(
    markdown.body,
    /\[Ziel öffnen\]\(<https:\/\/app\.example\.com\/projects\?view=active&sort=name>\)/,
  );

  const revised = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}/steps/${firstStepId}`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"6"' },
    payload: { title: "Revision zwei" },
  });
  assert.equal(revised.statusCode, 200);
  assert.equal(revised.json().status, "published");
  assert.equal(revised.json().revision, 2);
  const immutableV1 = await app.inject({
    method: "GET",
    url: `/g/${slug}/1`,
    headers: { host: "schaffa.test" },
  });
  assert.doesNotMatch(immutableV1.body, /Revision zwei/);
  const latest = await app.inject({
    method: "GET",
    url: `/g/${slug}`,
    headers: { host: "schaffa.test" },
  });
  assert.match(latest.body, /Revision zwei/);

  const blockedRevision = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}/steps/${firstStepId}`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"7"' },
    payload: { description: "password=must-not-become-public" },
  });
  assert.equal(blockedRevision.statusCode, 422);
  assert.equal(blockedRevision.json().error, "preflight_failed");
  const unchanged = await app.inject({
    method: "GET",
    url: `/api/guides/${slug}`,
    headers: auth,
  });
  assert.equal(unchanged.json().editRevision, 7);
  assert.equal(unchanged.json().revision, 2);
  assert.doesNotMatch(JSON.stringify(unchanged.json()), /must-not-become-public/);
});

test("accepts only safe web destinations for guides", async () => {
  const owner = createToken("guide URL owner");
  const headers = {
    host: "schaffa.test",
    authorization: `Bearer ${owner.token}`,
    "content-type": "application/json",
  };
  for (const targetUrl of [
    "javascript:alert(document.domain)",
    "https://user:password@app.example.com/projects",
    "/projects",
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/guides",
      headers,
      payload: { title: "Unsafe destination", targetUrl },
    });
    assert.equal(response.statusCode, 422);
  }
});

test("sets, clears, and limits a guide destination", async () => {
  const owner = createToken("guide destination owner");
  const headers = {
    host: "schaffa.test",
    authorization: `Bearer ${owner.token}`,
    "content-type": "application/json",
  };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers,
    payload: { title: "Destination edits" },
  });
  assert.equal(created.statusCode, 201);
  const slug = created.json().slug as string;

  const set = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}`,
    headers: { ...headers, "if-match": '"1"' },
    payload: { targetUrl: " https://app.example.com/projects " },
  });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().targetUrl, "https://app.example.com/projects");

  const clear = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}`,
    headers: { ...headers, "if-match": '"2"' },
    payload: { targetUrl: "" },
  });
  assert.equal(clear.statusCode, 200);
  assert.equal(clear.json().targetUrl, null);

  const normalizedOverlong = await app.inject({
    method: "PATCH",
    url: `/api/guides/${slug}`,
    headers: { ...headers, "if-match": '"3"' },
    payload: { targetUrl: `https://example.com/${"é".repeat(990)}` },
  });
  assert.equal(normalizedOverlong.statusCode, 422);
});

test("rejects sensitive guide text during publication", async () => {
  const owner = createToken("sensitive guide owner");
  const auth = { host: "schaffa.test", authorization: `Bearer ${owner.token}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/guides",
    headers: { ...auth, "content-type": "application/json" },
    payload: { title: "Sensitive" },
  });
  const slug = created.json().slug;
  const step = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/steps`,
    headers: { ...auth, "content-type": "application/json", "if-match": '"1"' },
    payload: { title: "Login", description: "password=do-not-publish", capture: false },
  });
  assert.equal(step.statusCode, 201);
  const finished = await app.inject({
    method: "POST",
    url: `/api/guides/${slug}/finish`,
    headers: { ...auth, "if-match": '"2"' },
  });
  assert.equal(finished.statusCode, 422);
  assert.equal(finished.json().error, "preflight_failed");
  const privateGuide = await app.inject({
    method: "GET",
    url: `/g/${slug}`,
    headers: { host: "schaffa.test" },
  });
  assert.equal(privateGuide.statusCode, 404);
});
