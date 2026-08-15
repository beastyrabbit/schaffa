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
import { randomFileId, randomPageSlug } from "./ids.js";
import { cleanImage, isLikelyImage, withImageProcessingPermit } from "./image-cleaner.js";
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
  sensitiveFindings: Array<{ stepId: string; kind: string }>;
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
  input: { title?: unknown; description?: unknown; language?: unknown },
  tokenId: string,
): GuideView {
  const title = requiredText(input.title, "title", 160);
  const description = optionalText(input.description, "description", 4_000);
  const language = validateLanguage(input.language);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = randomPageSlug();
    if (db().prepare("SELECT 1 FROM guides WHERE slug = ?").get(slug)) continue;
    db()
      .prepare(
        `INSERT INTO guides (id, slug, title, description, language, owner_token_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), slug, title, description, language, tokenId);
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
  input: { title?: unknown; description?: unknown; language?: unknown; status?: unknown },
  tokenId: string,
  isAdmin: boolean,
  expectedRevision: number,
): GuideView {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  assertEditRevision(guide, expectedRevision);
  if (input.status !== undefined && input.status !== "recording" && input.status !== "draft") {
    throw new AppError("Status may only be recording or draft; use publish for publication.", 422);
  }
  const title = input.title === undefined ? guide.title : requiredText(input.title, "title", 160);
  const description =
    input.description === undefined
      ? guide.description
      : optionalText(input.description, "description", 4_000);
  const language = input.language === undefined ? guide.language : validateLanguage(input.language);
  const status = input.status === undefined ? mutableStatus(guide) : input.status;
  mutateGuide(
    guide.id,
    expectedRevision,
    `UPDATE guides SET title = ?, description = ?, language = ?, status = ?,
     edit_revision = edit_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND edit_revision = ?`,
    [title, description, language, status, guide.id, expectedRevision],
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
  const image = screenshot ? await prepareGuideImage(guide, screenshot) : null;
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
    advanceGuideRevision(guide.id, expectedRevision, mutableStatus(guide));
    const result = guideView(loadGuide(guide.id), currentSteps(guide.id));
    writeIdempotent(guide.id, idempotencyKey, "add-step", result);
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
    advanceGuideRevision(guide.id, expectedRevision, mutableStatus(guide));
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
    const update = db().prepare(
      "UPDATE guide_steps SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND guide_id = ?",
    );
    for (const id of order) update.run(-(order.indexOf(id) + 1), id, guide.id);
    for (const id of order) update.run(order.indexOf(id) + 1, id, guide.id);
    advanceGuideRevision(guide.id, expectedRevision, mutableStatus(guide));
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
    db().prepare("DELETE FROM guide_steps WHERE id = ? AND guide_id = ?").run(stepId, guide.id);
    const remaining = currentSteps(guide.id);
    const update = db().prepare("UPDATE guide_steps SET position = ? WHERE id = ?");
    remaining.forEach((row, index) => {
      update.run(index + 1, row.id);
    });
    advanceGuideRevision(guide.id, expectedRevision, mutableStatus(guide));
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
): { guide: GuideView; preflight: GuidePreflight } {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  assertEditRevision(guide, expectedRevision);
  if (guide.status === "recording" || guide.status === "published") {
    mutateGuide(
      guide.id,
      expectedRevision,
      `UPDATE guides SET status = 'draft', edit_revision = edit_revision + 1,
       updated_at = CURRENT_TIMESTAMP WHERE id = ? AND edit_revision = ?`,
      [guide.id, expectedRevision],
    );
  } else {
    throw new AppError("Guide is already a draft.", 409, "invalid_state");
  }
  const result = getOwnedGuide(slug, tokenId, isAdmin);
  return { guide: result, preflight: guidePreflight(result) };
}

export function publishGuide(
  slug: string,
  tokenId: string,
  isAdmin: boolean,
  expectedRevision: number,
): { guide: GuideView; preflight: GuidePreflight; revisionUrl: string } {
  const guide = requireOwnedGuide(slug, tokenId, isAdmin);
  assertEditRevision(guide, expectedRevision);
  if (guide.status !== "draft")
    throw new AppError("Finish the guide before publishing.", 409, "invalid_state");
  const steps = currentSteps(guide.id);
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
  const snapshot: GuideView = {
    ...preview,
    status: "published",
    revision,
    editRevision: expectedRevision + 1,
    steps: preview.steps.filter((step) => step.visible),
  };
  const revisionId = randomUUID();
  const markdown = renderGuideMarkdown(snapshot);
  const html = renderGuideHtml(snapshot);
  db().exec("BEGIN IMMEDIATE");
  try {
    db()
      .prepare(
        `INSERT INTO guide_revisions
         (id, guide_id, revision, json_snapshot, markdown_snapshot, html_snapshot)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(revisionId, guide.id, revision, JSON.stringify(snapshot), markdown, html);
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
    const result = db()
      .prepare(
        `UPDATE guides SET status = 'published', current_revision = ?,
         edit_revision = edit_revision + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND edit_revision = ?`,
      )
      .run(revision, guide.id, expectedRevision);
    if (result.changes !== 1) throw conflict();
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

export function listGuides(): Array<GuideRow & { step_count: number; uploader_name: string }> {
  return db()
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM guide_steps gs WHERE gs.guide_id = g.id) AS step_count,
              COALESCE(t.name, 'Unknown uploader') AS uploader_name
       FROM guides g LEFT JOIN tokens t ON t.id = g.owner_token_id ORDER BY g.updated_at DESC`,
    )
    .all() as unknown as Array<GuideRow & { step_count: number; uploader_name: string }>;
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
  const sensitiveFindings: Array<{ stepId: string; kind: string }> = [];
  for (const step of visible) {
    const text = [
      step.title,
      step.description,
      step.action?.target,
      step.verification,
      step.screenshotCaption,
    ]
      .filter(Boolean)
      .join("\n");
    for (const check of sensitivePatterns) {
      check.pattern.lastIndex = 0;
      if (check.pattern.test(text)) sensitiveFindings.push({ stepId: step.id, kind: check.label });
    }
  }
  if (sensitiveFindings.length)
    errors.push("Possible sensitive text must be removed before publication.");
  return { ready: errors.length === 0, errors, warnings, missingScreenshots, sensitiveFindings };
}

export function renderGuideMarkdown(guide: GuideView): string {
  const lines = [`# ${guide.title}`, ""];
  if (guide.description) lines.push(guide.description, "");
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
    .map(
      (step, index) => `<section id="step-${index + 1}" class="step">
        <div class="step-copy"><span class="number">${String(index + 1).padStart(2, "0")}</span><h2>${escapeHtml(step.title)}</h2>
        <p>${paragraphs(step.description)}</p>
        ${step.action ? `<dl><dt>Aktion</dt><dd><code>${escapeHtml(step.action.type)}</code>${step.action.target ? ` ${escapeHtml(step.action.target)}` : ""}</dd></dl>` : ""}
        ${step.verification ? `<dl><dt>Prüfung</dt><dd>${escapeHtml(step.verification)}</dd></dl>` : ""}</div>
        ${step.screenshotUrl ? `<figure><img src="${escapeHtml(step.screenshotUrl)}" alt="${escapeHtml(step.screenshotCaption || step.title)}" loading="lazy"><figcaption>${escapeHtml(step.screenshotCaption || step.title)}</figcaption></figure>` : `<aside class="text-step">Textschritt · kein Bild erforderlich</aside>`}
      </section>`,
    )
    .join("");
  const toc = guide.steps
    .filter((step) => step.visible)
    .map(
      (step, index) =>
        `<a href="#step-${index + 1}"><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(step.title)}</a>`,
    )
    .join("");
  return `<!doctype html><html lang="${escapeHtml(guide.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(guide.title)}</title><style>${guideCss}</style></head><body>
  <header><div><a class="brand" href="/">Schaffa</a><span>Guide · Revision ${guide.revision}</span></div><h1>${escapeHtml(guide.title)}</h1>${guide.description ? `<p>${escapeHtml(guide.description)}</p>` : ""}<nav aria-label="Downloads"><a href="${escapeHtml(guide.jsonUrl)}">JSON</a><a href="${escapeHtml(guide.markdownUrl)}">Markdown</a></nav></header>
  <main><nav class="toc" aria-label="Schritte">${toc}</nav><article>${steps}</article></main>
  <footer>Veröffentlicht mit Schaffa · ${guide.steps.filter((step) => step.visible).length} Schritte</footer></body></html>`;
}

function guideView(guide: GuideRow, steps: GuideStepRow[]): GuideView {
  return {
    schemaVersion: 1,
    slug: guide.slug,
    title: guide.title,
    description: guide.description,
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
  return { title, description, action, verification, visible, capture, screenshotCaption };
}

async function prepareGuideImage(guide: GuideRow, part: MultipartFile): Promise<GuideImageRow> {
  if (!isLikelyImage(part.filename, part.mimetype)) {
    throw new AppError("Screenshot must be a recognized image.", 422, "invalid_image");
  }
  const data = await readLimited(part, config.maxImageInputBytes);
  await scanUpload(data);
  const cleaned = await withImageProcessingPermit(() => cleanImage(data));
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
  return Buffer.concat(chunks);
}

function insertImage(image: GuideImageRow): void {
  const usage = db()
    .prepare(
      `SELECT COALESCE((SELECT SUM(bytes) FROM page_versions), 0) +
              COALESCE((SELECT SUM(bytes) FROM files), 0) +
              COALESCE((SELECT SUM(bytes) FROM guide_images), 0) AS bytes`,
    )
    .get() as unknown as { bytes: number };
  if (usage.bytes + image.bytes > config.maxStorageBytes) {
    throw new AppError("The server storage quota has been reached.", 507, "storage_quota");
  }
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
            `UPDATE guides SET status = ?, edit_revision = edit_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND edit_revision = ?`,
          )
          .run(mutableStatus(loadGuide(guideId)), guideId, expectedRevision)
      : db()
          .prepare(sql)
          .run(...(params as never[]));
    if (result.changes !== 1) throw conflict();
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
      `UPDATE guides SET status = ?, edit_revision = edit_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND edit_revision = ?`,
    )
    .run(status, guideId, expectedRevision);
  if (result.changes !== 1) throw conflict();
}

function mutableStatus(guide: GuideRow): GuideStatus {
  return guide.status === "published" ? "draft" : guide.status;
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

const guideCss = `
:root{--paper:#f3f0e8;--surface:#fffdf8;--ink:#20211e;--muted:#696961;--line:#cbc5b8;--accent:#a43f24;--gold:#d8b64b;font-family:"Avenir Next","Segoe UI",sans-serif;color:var(--ink);background:var(--paper)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;line-height:1.62}header{padding:52px max(24px,calc((100vw - 1120px)/2));border-bottom:2px solid var(--ink);background:var(--surface)}header>div{display:flex;justify-content:space-between;color:var(--muted);font-size:13px}.brand{font:700 22px Georgia,serif;color:var(--ink);text-decoration:none}h1,h2{font-family:Georgia,"Times New Roman",serif;letter-spacing:-.035em}h1{max-width:920px;margin:50px 0 18px;font-size:clamp(44px,7vw,78px);line-height:.98}header>p{max-width:720px;color:#4b4c45;font-size:19px}header nav{display:flex;gap:18px;margin-top:28px}header nav a{color:var(--accent);font-weight:700;text-underline-offset:4px}main{display:grid;grid-template-columns:240px minmax(0,820px);gap:56px;max-width:1120px;margin:auto;padding:52px 24px 100px}.toc{position:sticky;top:24px;align-self:start;border-top:3px solid var(--ink)}.toc a{display:grid;grid-template-columns:34px 1fr;gap:8px;padding:11px 0;border-bottom:1px solid var(--line);color:var(--muted);font-size:13px;text-decoration:none}.toc span{font-family:ui-monospace,monospace;color:var(--accent)}.step{padding:0 0 64px;margin:0 0 60px;border-bottom:2px solid var(--ink)}.number{display:block;color:var(--accent);font:700 13px ui-monospace,monospace}.step h2{margin:8px 0 18px;font-size:36px;line-height:1.08}.step-copy>p{max-width:720px;font-size:17px}.step dl{display:grid;grid-template-columns:90px 1fr;margin:18px 0}.step dt{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase}.step dd{margin:0}.step code{padding:3px 6px;background:#e4ded1;font-family:ui-monospace,monospace}figure{margin:30px 0 0}img{display:block;width:100%;height:auto;border:2px solid var(--ink);background:#ddd;box-shadow:8px 8px 0 var(--gold)}figcaption{margin-top:13px;color:var(--muted);font-size:13px}.text-step{margin-top:28px;padding:18px;border-left:4px solid var(--gold);background:var(--surface);color:var(--muted)}footer{padding:25px;border-top:2px solid var(--ink);text-align:center;color:var(--muted);font-size:13px}@media(max-width:760px){header{padding:34px 20px}header>div{align-items:center}.brand{font-size:20px}h1{margin-top:38px;font-size:46px}main{display:block;padding:34px 20px 70px}.toc{position:static;margin-bottom:50px}.step h2{font-size:31px}.step dl{grid-template-columns:1fr;gap:3px}img{box-shadow:5px 5px 0 var(--gold)}}@media print{header{padding:0 0 24px}.toc,header nav,footer{display:none}main{display:block;padding:20px 0}.step{break-inside:avoid}img{box-shadow:none}body{background:#fff;font-size:11pt}}
`;
