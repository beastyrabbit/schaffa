import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { MultipartFile } from "@fastify/multipart";
import sharp from "sharp";
import { config } from "./config.js";
import {
  db,
  type GuideImageRow,
  type GuideRow,
  type GuideStatus,
  type GuideStepRow,
} from "./db.js";
import { AppError } from "./errors.js";
import { randomFileId, randomGuideSlug } from "./ids.js";
import {
  cleanImage,
  type ImageClickMarker,
  isLikelyImage,
  withImageProcessingPermit,
} from "./image-cleaner.js";
import { assertStorageCapacity, guideMetadataBytes } from "./service.js";
import { removeGuide, removeStoredFile, sha256, storeGuideImage } from "./storage.js";
import { scanUpload } from "./virus-scanner.js";

const actionTypes = new Set([
  "click",
  "type",
  "navigate",
  "command",
  "api",
  "file",
  "verify",
  "other",
]);
const sensitivePatterns = [
  { label: "possible token", pattern: /\b(?:sfa_|sk-|ghp_|Bearer\s+)[A-Za-z0-9._-]{12,}\b/gi },
  { label: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  {
    label: "possible secret",
    pattern: /\b(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S+/gi,
  },
] as const;

export interface GuideAction {
  type: string;
  target?: string;
}

export interface GuideStepInput {
  title?: unknown;
  description?: unknown;
  action?: unknown;
  verification?: unknown;
  visible?: unknown;
  capture?: unknown;
  screenshotCaption?: unknown;
  clickMarker?: unknown;
}

export interface GuideStepView {
  id: string;
  position: number;
  title: string;
  description: string;
  action: GuideAction | null;
  verification: string | null;
  visible: boolean;
  capture: boolean;
  screenshotUrl: string | null;
  screenshotCaption: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuideView {
  schemaVersion: 1;
  slug: string;
  title: string;
  description: string | null;
  targetUrl: string | null;
  videoUrl?: string | null;
  language: string;
  status: GuideStatus;
  revision: number;
  editRevision: number;
  publicUrl: string;
  apiUrl: string;
  jsonUrl: string;
  markdownUrl: string;
  createdAt: string;
  updatedAt: string;
  steps: GuideStepView[];
}

export interface GuidePreflight {
  ready: boolean;
  errors: string[];
  warnings: string[];
  missingScreenshots: string[];
  sensitiveFindings: Array<{ stepId?: string; field: string; kind: string }>;
}

interface RevisionRow {
  id: string;
  revision: number;
  json_snapshot: string;
  markdown_snapshot: string;
  html_snapshot: string;
  created_at: string;
}

export function createGuide(
  input: { title?: unknown; description?: unknown; targetUrl?: unknown; language?: unknown },
  tokenId: string,
): GuideView {
  const title = requiredText(input.title, "title", 160);
  const description = optionalText(input.description, "description", 4_000);
  const targetUrl = validateTargetUrl(input.targetUrl);
  const language = validateLanguage(input.language);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = randomGuideSlug();
    if (db().prepare("SELECT 1 FROM guides WHERE slug = ?").get(slug)) continue;
    const guideId = randomUUID();
    db().exec("BEGIN IMMEDIATE");
    try {
      db()
        .prepare(
          `INSERT INTO guides (id, slug, title, description, target_url, language, owner_token_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(guideId, slug, title, description, targetUrl, language, tokenId);
      assertGuideBudget(guideId);
      db().exec("COMMIT");
    } catch (error) {
      db().exec("ROLLBACK");
      throw error;
    }
    return getOwnedGuide(slug, tokenId, false);
  }
  throw new Error("Could not allocate a unique guide slug.");
}

export function getOwnedGuide(slug: string, tokenId: string, isAdmin: boolean): GuideView {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  return guideView(guide, currentSteps(guide.id));
}

export function updateGuide(
  slug: string,
  input: {
    title?: unknown;
    description?: unknown;
    targetUrl?: unknown;
    language?: unknown;
    status?: unknown;
    videoUrl?: unknown;
  },
  tokenId: string,
  isAdmin: boolean,
  expectedRevision: number,
): GuideView {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  assertEditRevision(guide, expectedRevision);
  if (input.status !== undefined) {
    throw new AppError("Guide status is managed automatically.", 422);
  }
  const title = input.title === undefined ? guide.title : requiredText(input.title, "title", 160);
  const description =
    input.description === undefined
      ? guide.description
      : optionalText(input.description, "description", 4_000);
  const targetUrl =
    input.targetUrl === undefined ? guide.target_url : validateTargetUrl(input.targetUrl);
  const language = input.language === undefined ? guide.language : validateLanguage(input.language);
  const videoUrl =
    input.videoUrl === undefined ? null : validateGuideVideo(input.videoUrl, guide.owner_token_id);
  mutateGuide(
    guide.id,
    expectedRevision,
    `UPDATE guides SET title = ?, description = ?, target_url = ?, language = ?, status = ?, video_url = ?,
     edit_revision = edit_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND edit_revision = ?`,
    [title, description, targetUrl, language, guide.status, videoUrl, guide.id, expectedRevision],
  );
  return getOwnedGuide(slug, tokenId, isAdmin);
}

export async function addGuideStep(
  slug: string,
  input: GuideStepInput,
  screenshot: MultipartFile | undefined,
  tokenId: string,
  isAdmin: boolean,
  expectedRevision: number,
  idempotencyKey?: string,
): Promise<GuideView> {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  const replay = readIdempotent<GuideView>(guide.id, idempotencyKey, "add-step");
  if (replay) return replay;
  assertEditRevision(guide, expectedRevision);
  const parsed = parseStep(input, false);
  const count = db()
    .prepare("SELECT COUNT(*) AS count FROM guide_steps WHERE guide_id = ?")
    .get(guide.id) as { count: number };
  if (count.count >= config.maxGuideSteps)
    throw new AppError("The guide step limit has been reached.", 422, "guide_limit");
  const image = screenshot ? await prepareGuideImage(guide, screenshot, parsed.clickMarker) : null;
  const stepId = randomUUID();
  const row = db()
    .prepare(
      "SELECT COALESCE(MAX(position), 0) + 1 AS position FROM guide_steps WHERE guide_id = ?",
    )
    .get(guide.id) as unknown as { position: number };
  db().exec("BEGIN IMMEDIATE");
  try {
    if (image) insertImage(image);
    db()
      .prepare(
        `INSERT INTO guide_steps
         (id, guide_id, position, title, description, action_type, action_target,
          verification, visible, capture, screenshot_id, screenshot_caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stepId,
        guide.id,
        row.position,
        parsed.title,
        parsed.description,
        parsed.action?.type || null,
        parsed.action?.target || null,
        parsed.verification,
        parsed.visible ? 1 : 0,
        parsed.capture ? 1 : 0,
        image?.id || null,
        parsed.screenshotCaption,
      );
    advanceGuideRevision(guide.id, expectedRevision, guide.status);
    if (guide.current_revision > 0) publishEditedGuide(guide.id, expectedRevision + 1);
    const result = guideView(loadGuide(guide.id), currentSteps(guide.id));
    writeIdempotent(guide.id, idempotencyKey, "add-step", result);
    assertGuideBudget(guide.id);
    db().exec("COMMIT");
    return result;
  } catch (error) {
    if (db().isTransaction) db().exec("ROLLBACK");
    if (image) await removeStoredFile(image.storage_path);
    throw error;
  }
}

export function updateGuideStep(
  slug: string,
  stepId: string,
  input: GuideStepInput,
  tokenId: string,
  isAdmin: boolean,
  expectedRevision: number,
): GuideView {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  assertEditRevision(guide, expectedRevision);
  const current = requireStep(guide.id, stepId);
  const parsed = parseStep(
    {
      title: input.title === undefined ? current.title : input.title,
      description: input.description === undefined ? current.description : input.description,
      action:
        input.action === undefined
          ? current.action_type
            ? { type: current.action_type, target: current.action_target || undefined }
            : null
          : input.action,
      verification: input.verification === undefined ? current.verification : input.verification,
      visible: input.visible === undefined ? Boolean(current.visible) : input.visible,
      capture: input.capture === undefined ? Boolean(current.capture) : input.capture,
      screenshotCaption:
        input.screenshotCaption === undefined
          ? current.screenshot_caption
          : input.screenshotCaption,
    },
    false,
  );
  mutateGuide(
    guide.id,
    expectedRevision,
    `UPDATE guide_steps SET title = ?, description = ?, action_type = ?, action_target = ?,
      verification = ?, visible = ?, capture = ?, screenshot_caption = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND guide_id = ?`,
    [
      parsed.title,
      parsed.description,
      parsed.action?.type || null,
      parsed.action?.target || null,
      parsed.verification,
      parsed.visible ? 1 : 0,
      parsed.capture ? 1 : 0,
      parsed.screenshotCaption,
      stepId,
      guide.id,
    ],
  );
  return getOwnedGuide(slug, tokenId, isAdmin);
}

export async function replaceGuideScreenshot(
  slug: string,
  stepId: string,
  screenshot: MultipartFile,
  tokenId: string,
  isAdmin: boolean,
  expectedRevision: number,
): Promise<GuideView> {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  assertEditRevision(guide, expectedRevision);
  const step = requireStep(guide.id, stepId);
  const image = await prepareGuideImage(guide, screenshot);
  db().exec("BEGIN IMMEDIATE");
  try {
    insertImage(image);
    db()
      .prepare(
        "UPDATE guide_steps SET screenshot_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .run(image.id, step.id);
    advanceGuideRevision(guide.id, expectedRevision, guide.status);
    if (guide.current_revision > 0) publishEditedGuide(guide.id, expectedRevision + 1);
    assertGuideBudget(guide.id);
    db().exec("COMMIT");
  } catch (error) {
    if (db().isTransaction) db().exec("ROLLBACK");
    await removeStoredFile(image.storage_path);
    throw error;
  }
  await pruneImage(step.screenshot_id);
  return getOwnedGuide(slug, tokenId, isAdmin);
}

export function reorderGuideSteps(
  slug: string,
  order: unknown,
  tokenId: string,
  isAdmin: boolean,
  expectedRevision: number,
): GuideView {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  assertEditRevision(guide, expectedRevision);
  if (!Array.isArray(order) || order.some((id) => typeof id !== "string")) {
    throw new AppError("order must be a complete array of step IDs.", 422);
  }
  const current = currentSteps(guide.id).map((step) => step.id);
  if (
    order.length !== current.length ||
    new Set(order).size !== order.length ||
    current.some((id) => !order.includes(id))
  ) {
    throw new AppError("order must contain every step ID exactly once.", 422, "invalid_order");
  }
  db().exec("BEGIN IMMEDIATE");
  try {
    const previousBytes = guideMetadataBytes(guide.id);
    const update = db().prepare(
      "UPDATE guide_steps SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND guide_id = ?",
    );
    for (const id of order) update.run(-(order.indexOf(id) + 1), id, guide.id);
    for (const id of order) update.run(order.indexOf(id) + 1, id, guide.id);
    advanceGuideRevision(guide.id, expectedRevision, guide.status);
    if (guide.current_revision > 0) publishEditedGuide(guide.id, expectedRevision + 1);
    assertGuideBudget(guide.id, previousBytes);
    db().exec("COMMIT");
  } catch (error) {
    if (db().isTransaction) db().exec("ROLLBACK");
    throw error;
  }
  return getOwnedGuide(slug, tokenId, isAdmin);
}

export async function deleteGuideStep(
  slug: string,
  stepId: string,
  tokenId: string,
  isAdmin: boolean,
  expectedRevision: number,
): Promise<GuideView> {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  assertEditRevision(guide, expectedRevision);
  const step = requireStep(guide.id, stepId);
  db().exec("BEGIN IMMEDIATE");
  try {
    const previousBytes = guideMetadataBytes(guide.id);
    db().prepare("DELETE FROM guide_steps WHERE id = ? AND guide_id = ?").run(stepId, guide.id);
    const remaining = currentSteps(guide.id);
    const update = db().prepare("UPDATE guide_steps SET position = ? WHERE id = ?");
    remaining.forEach((row, index) => {
      update.run(index + 1, row.id);
    });
    advanceGuideRevision(guide.id, expectedRevision, guide.status);
    if (guide.current_revision > 0) publishEditedGuide(guide.id, expectedRevision + 1);
    assertGuideBudget(guide.id, previousBytes);
    db().exec("COMMIT");
  } catch (error) {
    if (db().isTransaction) db().exec("ROLLBACK");
    throw error;
  }
  await pruneImage(step.screenshot_id);
  return getOwnedGuide(slug, tokenId, isAdmin);
}

export function finishGuide(
  slug: string,
  tokenId: string,
  isAdmin: boolean,
  expectedRevision: number,
): { guide: GuideView; preflight: GuidePreflight; revisionUrl: string } {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  assertEditRevision(guide, expectedRevision);
  if (guide.status === "published") {
    throw new AppError("Guide is already published.", 409, "invalid_state");
  }
  const steps = currentSteps(guide.id);
  const { preflight, revision, snapshot } = preparePublishedRevision(
    guide,
    steps,
    expectedRevision + 1,
  );
  db().exec("BEGIN IMMEDIATE");
  try {
    insertPublishedRevision(guide.id, steps, snapshot);
    const result = db()
      .prepare(
        `UPDATE guides SET status = 'published', current_revision = ?,
         edit_revision = edit_revision + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND edit_revision = ?`,
      )
      .run(revision, guide.id, expectedRevision);
    if (result.changes !== 1) throw conflict();
    assertGuideBudget(guide.id);
    db().exec("COMMIT");
  } catch (error) {
    if (db().isTransaction) db().exec("ROLLBACK");
    throw error;
  }
  return {
    guide: getOwnedGuide(slug, tokenId, isAdmin),
    preflight,
    revisionUrl: `${config.baseUrl}/g/${slug}/${revision}`,
  };
}

function preparePublishedRevision(
  guide: GuideRow,
  steps: GuideStepRow[],
  editRevision: number,
): {
  preflight: GuidePreflight;
  revision: number;
  snapshot: GuideView;
} {
  const preview = guideView(guide, steps);
  const preflight = guidePreflight(preview);
  if (!preflight.ready) {
    throw new AppError(
      `Guide is not ready: ${preflight.errors.join(" ")}`,
      422,
      "preflight_failed",
    );
  }
  const revision = guide.current_revision + 1;
  return {
    preflight,
    revision,
    snapshot: {
      ...preview,
      status: "published",
      revision,
      editRevision,
      steps: preview.steps.filter((step) => step.visible),
    },
  };
}

function insertPublishedRevision(
  guideId: string,
  steps: GuideStepRow[],
  snapshot: GuideView,
): void {
  if (snapshot.revision > config.maxGuideRevisions)
    throw new AppError(
      "The guide revision limit has been reached. Ask the administrator to raise MAX_GUIDE_REVISIONS or take down the guide; existing revisions remain public.",
      422,
      "guide_limit",
    );
  const revisionId = randomUUID();
  db()
    .prepare(
      `INSERT INTO guide_revisions
       (id, guide_id, revision, json_snapshot, markdown_snapshot, html_snapshot)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      revisionId,
      guideId,
      snapshot.revision,
      JSON.stringify(snapshot),
      renderGuideMarkdown(snapshot),
      renderGuideHtml(snapshot),
    );
  const link = db().prepare(
    "INSERT INTO guide_revision_images (revision_id, image_id) VALUES (?, ?)",
  );
  for (const imageId of new Set(
    steps
      .filter((step) => step.visible)
      .map((step) => step.screenshot_id)
      .filter(Boolean),
  )) {
    link.run(revisionId, imageId);
  }
}

function publishEditedGuide(guideId: string, editRevision: number): void {
  const guide = loadGuide(guideId);
  const steps = currentSteps(guideId);
  const { revision, snapshot } = preparePublishedRevision(guide, steps, editRevision);
  insertPublishedRevision(guideId, steps, snapshot);
  const result = db()
    .prepare(
      `UPDATE guides SET status = 'published', current_revision = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND edit_revision = ?`,
    )
    .run(revision, guideId, editRevision);
  if (result.changes !== 1) throw conflict();
}

export function getPublishedGuide(
  slug: string,
  revision?: number,
): { guide: GuideView; html: string; markdown: string; revision: number } | null {
  const guide = db().prepare("SELECT * FROM guides WHERE slug = ?").get(slug) as unknown as
    | GuideRow
    | undefined;
  if (!guide || guide.current_revision < 1) return null;
  const selected = revision ?? guide.current_revision;
  if (!Number.isSafeInteger(selected) || selected < 1) return null;
  const row = db()
    .prepare("SELECT * FROM guide_revisions WHERE guide_id = ? AND revision = ?")
    .get(guide.id, selected) as unknown as RevisionRow | undefined;
  if (!row) return null;
  return {
    guide: JSON.parse(row.json_snapshot) as GuideView,
    html: row.html_snapshot,
    markdown: row.markdown_snapshot,
    revision: row.revision,
  };
}

export function getGuideImage(
  slug: string,
  imageId: string,
  tokenId?: string,
  isAdmin = false,
): GuideImageRow | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(imageId)) return null;
  const image = db()
    .prepare(
      `SELECT gi.* FROM guide_images gi JOIN guides g ON g.id = gi.guide_id
       WHERE g.slug = ? AND gi.id = ?`,
    )
    .get(slug, imageId) as unknown as GuideImageRow | undefined;
  if (!image) return null;
  if (tokenId) {
    const guide = loadGuide(image.guide_id);
    if (guide.owner_token_id === tokenId || isAdmin) return image;
  }
  const published = db()
    .prepare(
      `SELECT 1 FROM guide_revision_images gri
       JOIN guide_revisions gr ON gr.id = gri.revision_id
       WHERE gr.guide_id = ? AND gri.image_id = ? LIMIT 1`,
    )
    .get(image.guide_id, image.id);
  return published ? image : null;
}

export async function deleteGuide(slug: string): Promise<void> {
  const guide = db().prepare("SELECT id FROM guides WHERE slug = ?").get(slug) as
    | { id: string }
    | undefined;
  if (!guide) throw new AppError("Guide not found.", 404, "not_found");
  db().prepare("DELETE FROM guides WHERE id = ?").run(guide.id);
  await removeGuide(slug);
}

export type GuideSummary = GuideRow & {
  step_count: number;
  uploader_id: string;
  uploader_name: string;
  uploader_user_id: string | null;
};

export function listGuides(ids?: string[]): GuideSummary[] {
  return db()
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM guide_steps gs WHERE gs.guide_id = g.id) AS step_count,
              g.owner_token_id AS uploader_id,
              COALESCE(t.name, 'Unknown uploader') AS uploader_name,
              t.user_id AS uploader_user_id
       FROM guides g LEFT JOIN tokens t ON t.id = g.owner_token_id
       WHERE (? IS NULL OR g.id IN (SELECT value FROM json_each(?))) ORDER BY g.updated_at DESC`,
    )
    .all(
      ids ? JSON.stringify(ids) : null,
      ids ? JSON.stringify(ids) : null,
    ) as unknown as GuideSummary[];
}

export function guidePreflight(guide: GuideView): GuidePreflight {
  const visible = guide.steps.filter((step) => step.visible);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (visible.length === 0) errors.push("At least one visible step is required.");
  if (visible.some((step) => !step.title.trim() || !step.description.trim())) {
    errors.push("Every visible step needs a title and description.");
  }
  const missingScreenshots = visible
    .filter((step) => step.capture && !step.screenshotUrl)
    .map((step) => step.id);
  if (missingScreenshots.length)
    warnings.push(`${missingScreenshots.length} visible step(s) have no screenshot.`);
  const sensitiveFindings: GuidePreflight["sensitiveFindings"] = [];
  const inspect = (field: string, value: string | null | undefined, stepId?: string) => {
    if (!value) return;
    let text = value;
    try {
      text += `\n${decodeURIComponent(value.replace(/\+/g, " "))}`;
    } catch {
      /* Keep malformed URL text for the ordinary checks. */
    }
    for (const check of sensitivePatterns) {
      check.pattern.lastIndex = 0;
      if (check.pattern.test(text))
        sensitiveFindings.push({ ...(stepId ? { stepId } : {}), field, kind: check.label });
    }
  };
  inspect("title", guide.title);
  inspect("description", guide.description);
  inspect("targetUrl", guide.targetUrl);
  inspect("language", guide.language);
  for (const step of visible) {
    inspect("title", step.title, step.id);
    inspect("description", step.description, step.id);
    inspect("action.target", step.action?.target, step.id);
    inspect("verification", step.verification, step.id);
    inspect("screenshotCaption", step.screenshotCaption, step.id);
  }
  if (sensitiveFindings.length)
    errors.push("Possible sensitive text must be removed before publication.");
  return { ready: errors.length === 0, errors, warnings, missingScreenshots, sensitiveFindings };
}

function validateGuideVideo(value: unknown, owner: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string")
    throw new AppError("videoUrl must be a Schaffa video URL or null.", 422);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("Invalid videoUrl.", 422);
  }
  if (
    url.origin !== new URL(config.baseUrl).origin ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !/^\/f\/[A-Za-z0-9_-]+\.(webm|mp4)$/.test(url.pathname)
  )
    throw new AppError("videoUrl must reference a video uploaded to this Schaffa instance.", 422);
  const file = db()
    .prepare("SELECT created_by_token_id, media_type, scan_status FROM files WHERE filename = ?")
    .get(url.pathname.slice(3)) as
    | { created_by_token_id: string; media_type: string; scan_status: string }
    | undefined;
  if (
    !file ||
    file.created_by_token_id !== owner ||
    !["video/webm", "video/mp4"].includes(file.media_type) ||
    file.scan_status !== "clean"
  )
    throw new AppError("The guide owner must upload a video that has passed scanning first.", 422);
  return url.href;
}

export function renderGuideMarkdown(guide: GuideView): string {
  const lines = [`# ${guide.title}`, ""];
  if (guide.description) lines.push(guide.description, "");
  if (guide.targetUrl) lines.push(`[Ziel öffnen](<${guide.targetUrl}>)`, "");
  if (guide.videoUrl) lines.push(`[Video ansehen und herunterladen](<${guide.videoUrl}>)`, "");
  lines.push(`Revision ${guide.revision}`, "");
  for (const [index, step] of guide.steps.filter((item) => item.visible).entries()) {
    lines.push(`## ${index + 1}. ${step.title}`, "", step.description, "");
    if (step.screenshotUrl)
      lines.push(`![${step.screenshotCaption || step.title}](${step.screenshotUrl})`, "");
    if (step.action)
      lines.push(
        `**Action:** ${step.action.type}${step.action.target ? ` — ${step.action.target}` : ""}`,
        "",
      );
    if (step.verification) lines.push(`**Verification:** ${step.verification}`, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

export function renderGuideHtml(guide: GuideView): string {
  const steps = guide.steps
    .filter((step) => step.visible)
    .map((step, index) => {
      const navigationUrl = guideNavigationUrl(step.action, guide.targetUrl);
      const action = navigationUrl
        ? `<dl><dt>Aktion</dt><dd><a class="step-action-link" href="${escapeHtml(navigationUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Seite öffnen (neuer Tab)">Seite öffnen <span aria-hidden="true">↗</span></a></dd></dl>`
        : step.action
          ? `<dl><dt>Aktion</dt><dd><code>${escapeHtml(step.action.type)}</code>${step.action.target ? ` ${escapeHtml(step.action.target)}` : ""}</dd></dl>`
          : "";
      return `<section id="step-${index + 1}" class="step">
        <div class="step-copy"><span class="number">${String(index + 1).padStart(2, "0")}</span><h2>${escapeHtml(step.title)}</h2>
        <p>${paragraphs(step.description)}</p>
        ${action}
        ${step.verification ? `<dl><dt>Prüfung</dt><dd>${escapeHtml(step.verification)}</dd></dl>` : ""}</div>
        ${renderGuideScreenshot(step, index)}
      </section>`;
    })
    .join("");
  const toc = guide.steps
    .filter((step) => step.visible)
    .map(
      (step, index) =>
        `<a href="#step-${index + 1}"><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(step.title)}</a>`,
    )
    .join("");
  return `<!doctype html><html lang="${escapeHtml(guide.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(guide.title)}</title><style>${guideCss}</style></head><body>
  <header><div><a class="brand" href="/">Schaffa</a><span>Guide · Revision ${guide.revision}</span></div><h1>${escapeHtml(guide.title)}</h1>${guide.description ? `<p>${escapeHtml(guide.description)}</p>` : ""}<nav aria-label="Guide-Aktionen">${guide.targetUrl ? `<a class="target-link" href="${escapeHtml(guide.targetUrl)}">Ziel öffnen <span aria-hidden="true">↗</span></a>` : ""}<a href="${escapeHtml(guide.jsonUrl)}">JSON</a><a href="${escapeHtml(guide.markdownUrl)}">Markdown</a></nav></header>
  <main><nav class="toc" aria-label="Schritte">${toc}</nav><article>${guide.videoUrl ? `<section aria-label="Video-Anleitung"><h2>Video-Anleitung</h2><video controls playsinline muted preload="metadata" aria-label="Video-Anleitung ohne Ton; Schritte stehen unter dem Video" style="width:100%;max-height:80vh" src="${escapeHtml(guide.videoUrl)}"></video><p><a href="${escapeHtml(guide.videoUrl)}" download>Video herunterladen</a></p></section>` : ""}${steps}</article></main>
  <footer>Veröffentlicht mit Schaffa · ${guide.steps.filter((step) => step.visible).length} Schritte</footer></body></html>`;
}

function renderGuideScreenshot(step: GuideStepView, index: number): string {
  if (!step.screenshotUrl)
    return `<aside class="text-step">Textschritt · kein Bild erforderlich</aside>`;
  const number = index + 1;
  const imageUrl = escapeHtml(step.screenshotUrl);
  const caption = escapeHtml(step.screenshotCaption || step.title);
  return `<figure>
    <a class="screenshot-link" href="${imageUrl}" target="_blank" rel="noopener noreferrer" aria-label="Screenshot zu Schritt ${number} vergrößern, öffnet einen neuen Tab" aria-describedby="image-caption-${number}">
      <img src="${imageUrl}" alt="${caption}" loading="lazy">
      <span class="zoom-hint" aria-hidden="true">Bild vergrößern <span>↗</span></span>
    </a>
    <figcaption id="image-caption-${number}">${caption}</figcaption>
  </figure>`;
}

function guideView(guide: GuideRow, steps: GuideStepRow[]): GuideView {
  return {
    schemaVersion: 1,
    slug: guide.slug,
    title: guide.title,
    description: guide.description,
    targetUrl: guide.target_url,
    videoUrl: guide.video_url,
    language: guide.language,
    status: guide.status,
    revision: guide.current_revision,
    editRevision: guide.edit_revision,
    publicUrl: `${config.baseUrl}/g/${guide.slug}`,
    apiUrl: `${config.baseUrl}/api/guides/${guide.slug}`,
    jsonUrl: `${config.baseUrl}/g/${guide.slug}.json`,
    markdownUrl: `${config.baseUrl}/g/${guide.slug}.md`,
    createdAt: guide.created_at,
    updatedAt: guide.updated_at,
    steps: steps.map((step) => ({
      id: step.id,
      position: step.position,
      title: step.title,
      description: step.description,
      action: step.action_type
        ? { type: step.action_type, ...(step.action_target ? { target: step.action_target } : {}) }
        : null,
      verification: step.verification,
      visible: Boolean(step.visible),
      capture: Boolean(step.capture),
      screenshotUrl: step.screenshot_id
        ? `${config.baseUrl}/g/${guide.slug}/images/${step.screenshot_id}.webp`
        : null,
      screenshotCaption: step.screenshot_caption,
      createdAt: step.created_at,
      updatedAt: step.updated_at,
    })),
  };
}

function parseStep(input: GuideStepInput, partial: boolean) {
  const title = requiredText(input.title, "title", 160);
  const description = requiredText(input.description, "description", 8_000);
  const verification = optionalText(input.verification, "verification", 2_000);
  const screenshotCaption = optionalText(input.screenshotCaption, "screenshotCaption", 500);
  const visible = booleanValue(input.visible, true, "visible");
  const capture = booleanValue(input.capture, true, "capture");
  const clickMarker = parseClickMarker(input.clickMarker);
  let action: GuideAction | null = null;
  if (input.action !== undefined && input.action !== null) {
    if (!input.action || typeof input.action !== "object" || Array.isArray(input.action)) {
      throw new AppError("action must be an object or null.", 422);
    }
    const value = input.action as Record<string, unknown>;
    const type = requiredText(value.type, "action.type", 40);
    if (!actionTypes.has(type)) throw new AppError(`Unsupported action type: ${type}.`, 422);
    const target = optionalText(value.target, "action.target", 1_000);
    action = { type, ...(target ? { target } : {}) };
  }
  void partial;
  return {
    title,
    description,
    action,
    verification,
    visible,
    capture,
    screenshotCaption,
    clickMarker,
  };
}

function parseClickMarker(value: unknown): ImageClickMarker | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("clickMarker must be an object.", 422);
  }
  const marker = value as Record<string, unknown>;
  const x = finiteNumber(marker.x, "clickMarker.x");
  const y = finiteNumber(marker.y, "clickMarker.y");
  const viewportWidth = positiveNumber(marker.viewportWidth, "clickMarker.viewportWidth");
  const viewportHeight = positiveNumber(marker.viewportHeight, "clickMarker.viewportHeight");
  let box: ImageClickMarker["box"];
  if (marker.box !== undefined && marker.box !== null) {
    if (!marker.box || typeof marker.box !== "object" || Array.isArray(marker.box)) {
      throw new AppError("clickMarker.box must be an object.", 422);
    }
    const input = marker.box as Record<string, unknown>;
    const width = nonNegativeNumber(input.width, "clickMarker.box.width");
    const height = nonNegativeNumber(input.height, "clickMarker.box.height");
    if (width > 0 && height > 0) {
      box = {
        left: finiteNumber(input.left, "clickMarker.box.left"),
        top: finiteNumber(input.top, "clickMarker.box.top"),
        width,
        height,
      };
    }
  }
  return { x, y, viewportWidth, viewportHeight, ...(box ? { box } : {}) };
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 100_000) {
    throw new AppError(`${field} must be a finite coordinate.`, 422);
  }
  return value;
}

function positiveNumber(value: unknown, field: string): number {
  const number = finiteNumber(value, field);
  if (number <= 0) throw new AppError(`${field} must be positive.`, 422);
  return number;
}

function nonNegativeNumber(value: unknown, field: string): number {
  const number = finiteNumber(value, field);
  if (number < 0) throw new AppError(`${field} must not be negative.`, 422);
  return number;
}

async function prepareGuideImage(
  guide: GuideRow,
  part: MultipartFile,
  clickMarker?: ImageClickMarker,
): Promise<GuideImageRow> {
  if (!isLikelyImage(part.filename, part.mimetype)) {
    throw new AppError("Screenshot must be a recognized image.", 422, "invalid_image");
  }
  return withImageProcessingPermit(async () => {
    const data = await readLimited(part, config.maxImageInputBytes);
    await scanUpload(data);
    const cleaned = await cleanImage(data, clickMarker);
    const metadata = await sharp(cleaned.data).metadata();
    const id = randomFileId();
    return {
      id,
      guide_id: guide.id,
      storage_path: await storeGuideImage(guide.slug, id, cleaned.data),
      bytes: cleaned.data.length,
      sha256: sha256(cleaned.data),
      width: metadata.width || 0,
      height: metadata.height || 0,
      created_at: "",
    };
  });
}

async function readLimited(part: MultipartFile, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of part.file as Readable) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > limit)
      throw new AppError("Image input exceeds the configured size limit.", 413, "file_too_large");
    chunks.push(chunk);
  }
  if (part.file.readableAborted) {
    throw new AppError("Screenshot upload was interrupted.", 400, "invalid_upload");
  }
  return Buffer.concat(chunks);
}

function insertImage(image: GuideImageRow): void {
  assertStorageCapacity(image.bytes);
  db()
    .prepare(
      `INSERT INTO guide_images (id, guide_id, storage_path, bytes, sha256, width, height)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      image.id,
      image.guide_id,
      image.storage_path,
      image.bytes,
      image.sha256,
      image.width,
      image.height,
    );
}

async function pruneImage(imageId: string | null): Promise<void> {
  if (!imageId) return;
  const image = db().prepare("SELECT * FROM guide_images WHERE id = ?").get(imageId) as unknown as
    | GuideImageRow
    | undefined;
  if (!image) return;
  const referenced = db()
    .prepare(
      "SELECT 1 FROM guide_steps WHERE screenshot_id = ? UNION SELECT 1 FROM guide_revision_images WHERE image_id = ? LIMIT 1",
    )
    .get(imageId, imageId);
  if (referenced) return;
  db().prepare("DELETE FROM guide_images WHERE id = ?").run(imageId);
  await removeStoredFile(image.storage_path);
}

function requireOwnedGuide(slug: string, tokenId: string, isAdmin: boolean): GuideRow {
  if (!/^[a-z2-7]{12}$/.test(slug)) throw new AppError("Guide not found.", 404, "not_found");
  const guide = db().prepare("SELECT * FROM guides WHERE slug = ?").get(slug) as unknown as
    | GuideRow
    | undefined;
  if (!guide) throw new AppError("Guide not found.", 404, "not_found");
  if (guide.owner_token_id !== tokenId && !isAdmin)
    throw new AppError("This token does not own the guide.", 403, "forbidden");
  return guide;
}

function loadGuide(id: string): GuideRow {
  const guide = db().prepare("SELECT * FROM guides WHERE id = ?").get(id) as unknown as
    | GuideRow
    | undefined;
  if (!guide) throw new AppError("Guide not found.", 404, "not_found");
  return guide;
}

function currentSteps(guideId: string): GuideStepRow[] {
  return db()
    .prepare("SELECT * FROM guide_steps WHERE guide_id = ? ORDER BY position")
    .all(guideId) as unknown as GuideStepRow[];
}

function requireStep(guideId: string, stepId: string): GuideStepRow {
  const step = db()
    .prepare("SELECT * FROM guide_steps WHERE guide_id = ? AND id = ?")
    .get(guideId, stepId) as unknown as GuideStepRow | undefined;
  if (!step) throw new AppError("Guide step not found.", 404, "not_found");
  return step;
}

function mutateGuide(
  guideId: string,
  expectedRevision: number,
  sql: string,
  params: unknown[],
): void {
  db().exec("BEGIN IMMEDIATE");
  try {
    const guide = loadGuide(guideId);
    const previousBytes = guideMetadataBytes(guideId);
    const stepMutation = !sql.trimStart().startsWith("UPDATE guides");
    if (stepMutation) {
      const stepResult = db()
        .prepare(sql)
        .run(...(params as never[]));
      if (stepResult.changes !== 1) {
        throw new AppError("Guide step not found.", 404, "not_found");
      }
    }
    const result = stepMutation
      ? db()
          .prepare(
            `UPDATE guides SET status = ?, video_url = NULL, edit_revision = edit_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND edit_revision = ?`,
          )
          .run(guide.status, guideId, expectedRevision)
      : db()
          .prepare(sql)
          .run(...(params as never[]));
    if (result.changes !== 1) throw conflict();
    if (guide.current_revision > 0) publishEditedGuide(guideId, expectedRevision + 1);
    assertGuideBudget(guide.id, previousBytes);
    db().exec("COMMIT");
  } catch (error) {
    if (db().isTransaction) db().exec("ROLLBACK");
    throw error;
  }
}

function advanceGuideRevision(
  guideId: string,
  expectedRevision: number,
  status: GuideStatus,
): void {
  const result = db()
    .prepare(
      `UPDATE guides SET status = ?, video_url = NULL, edit_revision = edit_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND edit_revision = ?`,
    )
    .run(status, guideId, expectedRevision);
  if (result.changes !== 1) throw conflict();
}

function assertEditRevision(guide: GuideRow, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1)
    throw new AppError(
      "If-Match must contain the current editRevision.",
      428,
      "precondition_required",
    );
  if (guide.edit_revision !== expected) throw conflict();
}

function conflict(): AppError {
  return new AppError(
    "The guide changed since it was read. Reload and retry with the latest editRevision.",
    409,
    "edit_conflict",
  );
}

function readIdempotent<T>(guideId: string, key: string | undefined, operation: string): T | null {
  if (!key) return null;
  validateIdempotencyKey(key);
  const row = db()
    .prepare(
      "SELECT operation, response_json FROM guide_idempotency WHERE guide_id = ? AND key = ?",
    )
    .get(guideId, key) as { operation: string; response_json: string } | undefined;
  if (!row) return null;
  if (row.operation !== operation)
    throw new AppError(
      "Idempotency-Key was already used for another operation.",
      409,
      "idempotency_conflict",
    );
  return JSON.parse(row.response_json) as T;
}

function writeIdempotent(
  guideId: string,
  key: string | undefined,
  operation: string,
  response: unknown,
): void {
  if (!key) return;
  validateIdempotencyKey(key);
  db()
    .prepare(
      "INSERT INTO guide_idempotency (guide_id, key, operation, response_json) VALUES (?, ?, ?, ?)",
    )
    .run(guideId, key, operation, JSON.stringify(response));
}

function validateIdempotencyKey(key: string): void {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
    throw new AppError("Idempotency-Key must contain 8-128 safe characters.", 422);
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${field} is required.`, 422);
  const clean = value.trim();
  if (clean.length > maximum)
    throw new AppError(`${field} may not exceed ${maximum} characters.`, 422);
  return clean;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new AppError(`${field} must be a string or null.`, 422);
  const clean = value.trim();
  if (clean.length > maximum)
    throw new AppError(`${field} may not exceed ${maximum} characters.`, 422);
  return clean || null;
}

function booleanValue(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new AppError(`${field} must be a boolean.`, 422);
  return value;
}

function validateLanguage(value: unknown): string {
  if (value === undefined || value === null || value === "") return "de";
  if (typeof value !== "string" || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(value))
    throw new AppError("language must be a BCP 47 language tag such as de or en-US.", 422);
  return value;
}

function validateTargetUrl(value: unknown): string | null {
  const targetUrl = optionalText(value, "targetUrl", 2_000);
  if (!targetUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new AppError("targetUrl must be a valid HTTP or HTTPS URL.", 422);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new AppError("targetUrl must be an HTTP or HTTPS URL without embedded credentials.", 422);
  }
  if (parsed.href.length > 2_000) {
    throw new AppError("targetUrl may not exceed 2000 characters.", 422);
  }
  return parsed.href;
}

function paragraphs(value: string): string {
  return escapeHtml(value)
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ||
      character,
  );
}

function guideNavigationUrl(action: GuideAction | null, targetUrl: string | null): string | null {
  if (action?.type !== "navigate" || !action.target) return null;
  try {
    const url = targetUrl ? new URL(action.target, targetUrl) : new URL(action.target);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password)
      return null;
    return url.href;
  } catch {
    return null;
  }
}

const guideCss = `
:root{--paper:#f3f0e8;--surface:#fffdf8;--ink:#20211e;--muted:#696961;--line:#cbc5b8;--accent:#a43f24;--gold:#d8b64b;font-family:"Avenir Next","Segoe UI",sans-serif;color:var(--ink);background:var(--paper)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;line-height:1.62}header{padding:52px max(24px,calc((100vw - 1120px)/2));border-bottom:2px solid var(--ink);background:var(--surface)}header>div{display:flex;justify-content:space-between;color:var(--muted);font-size:13px}.brand{font:700 22px Georgia,serif;color:var(--ink);text-decoration:none}h1,h2{font-family:Georgia,"Times New Roman",serif;letter-spacing:-.035em}h1{max-width:920px;margin:50px 0 18px;font-size:clamp(44px,7vw,78px);line-height:.98}header>p{max-width:720px;color:#4b4c45;font-size:19px}header nav{display:flex;align-items:center;gap:18px;margin-top:28px}header nav a{color:var(--accent);font-weight:700;text-underline-offset:4px}.target-link,.step-action-link{display:inline-flex;align-items:center;gap:8px;padding:9px 13px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:var(--surface);font-weight:700;text-decoration:none}.target-link:focus-visible,.step-action-link:focus-visible{outline:3px solid var(--gold);outline-offset:3px}.step-action-link:hover{background:#7f2f1b;border-color:#7f2f1b}main{display:grid;grid-template-columns:240px minmax(0,820px);gap:56px;max-width:1120px;margin:auto;padding:52px 24px 100px}.toc{position:sticky;top:24px;align-self:start;border-top:3px solid var(--ink)}.toc a{display:grid;grid-template-columns:34px 1fr;gap:8px;padding:11px 0;border-bottom:1px solid var(--line);color:var(--muted);font-size:13px;text-decoration:none}.toc span{font-family:ui-monospace,monospace;color:var(--accent)}.step{padding:0 0 64px;margin:0 0 60px;border-bottom:2px solid var(--ink)}.number{display:block;color:var(--accent);font:700 13px ui-monospace,monospace}.step h2{margin:8px 0 18px;font-size:36px;line-height:1.08}.step-copy>p{max-width:720px;font-size:17px}.step dl{display:grid;grid-template-columns:90px 1fr;margin:18px 0}.step dt{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase}.step dd{margin:0}.step code{padding:3px 6px;background:#e4ded1;font-family:ui-monospace,monospace}figure{margin:30px 0 0}.screenshot-link{position:relative;display:block;color:inherit;text-decoration:none}.screenshot-link>img{display:block;width:100%;height:auto;border:2px solid var(--ink);background:#ddd;box-shadow:8px 8px 0 var(--gold)}.screenshot-link:focus-visible{outline:4px solid var(--accent);outline-offset:5px}.zoom-hint{position:absolute;right:14px;bottom:14px;display:inline-flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid var(--surface);border-radius:7px;background:var(--ink);color:var(--surface);font-size:13px;font-weight:700;box-shadow:3px 3px 0 var(--gold)}.screenshot-link:hover .zoom-hint,.screenshot-link:focus-visible .zoom-hint{background:var(--accent)}figcaption{margin-top:13px;color:var(--muted);font-size:13px}.text-step{margin-top:28px;padding:18px;border-left:4px solid var(--gold);background:var(--surface);color:var(--muted)}footer{padding:25px;border-top:2px solid var(--ink);text-align:center;color:var(--muted);font-size:13px}@media(max-width:760px){header{padding:34px 20px}header>div{align-items:center}.brand{font-size:20px}h1{margin-top:38px;font-size:46px}header nav{align-items:flex-start;flex-wrap:wrap}main{display:block;padding:34px 20px 70px}.toc{position:static;margin-bottom:50px}.step h2{font-size:31px}.step dl{grid-template-columns:1fr;gap:3px}.screenshot-link>img{box-shadow:5px 5px 0 var(--gold)}.zoom-hint{right:9px;bottom:9px}}@media print{header{padding:0 0 24px}.toc,header nav,footer,.zoom-hint{display:none}main{display:block;padding:20px 0}.step{break-inside:avoid}.screenshot-link>img{box-shadow:none}body{background:#fff;font-size:11pt}}
`;

function assertGuideBudget(guideId: string, previousBytes?: number): void {
  const bytes = guideMetadataBytes(guideId);
  // Non-growing edits cannot worsen an excess after an operator lowers limits.
  if (previousBytes !== undefined && bytes <= previousBytes) return;
  if (bytes > config.maxGuideMetadataBytes)
    throw new AppError(
      "The guide metadata limit has been reached. Reduce draft text or ask the administrator to raise MAX_GUIDE_METADATA_BYTES or take down the guide; published history is retained.",
      422,
      "guide_limit",
    );
  assertStorageCapacity(0);
}
