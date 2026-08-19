import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, Page } from "puppeteer-core";
import {
  addGuideStep,
  type GuideClickMarker,
  type GuideResult,
  getGuide,
  SchaffaRequestError,
} from "./client.js";

const recorderBinding = "__schaffaRecordClick";
const pauseBinding = "__schaffaSetPaused";

export interface RecordedClick {
  x: number;
  y: number;
  tag: string;
  role: string | null;
  label: string;
  selector: string;
  url: string;
  pageTitle: string;
  viewportWidth: number;
  viewportHeight: number;
  box: { left: number; top: number; width: number; height: number };
  inFrame: boolean;
  sensitive: boolean;
  timestamp: string;
}

interface RecordedStep {
  sequence: number;
  timestamp: string;
  url: string;
  pageTitle: string;
  target: string;
  title: string;
  description: string;
  actionType: "click" | "navigate";
  selector: string;
  click: GuideClickMarker | null;
  screenshot: string | null;
  status: "pending" | "uploaded" | "failed";
  stepId?: string;
  captureError?: string;
  uploadError?: string;
}

interface RecordingManifest {
  schemaVersion: 1;
  slug: string;
  publicUrl: string;
  startedAt: string;
  updatedAt: string;
  steps: RecordedStep[];
}

export interface LatestFrame {
  data: Buffer;
  receivedAt: number;
}

export interface RecorderOptions {
  guide: GuideResult;
  url: string;
  token: string;
  baseUrl?: string;
  language?: string;
  browserExecutable?: string;
  profileDirectory?: string;
  outputDirectory?: string;
  onMessage?: (message: string) => void;
}

export interface RecorderResult {
  guide: GuideResult;
  manifestPath: string;
  failedUploads: number;
}

export async function recordBrowserGuide(options: RecorderOptions): Promise<RecorderResult> {
  const executablePath = findBrowserExecutable(options.browserExecutable);
  const recordingDirectory =
    options.outputDirectory || path.resolve(".schaffa", "recordings", options.guide.slug);
  const profileDirectory =
    options.profileDirectory || path.join(os.homedir(), ".schaffa", "browser-profile");
  const manifestPath = path.join(recordingDirectory, "manifest.json");
  await mkdir(recordingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await chmod(recordingDirectory, 0o700);
  await chmod(profileDirectory, 0o700);

  const manifest: RecordingManifest = {
    schemaVersion: 1,
    slug: options.guide.slug,
    publicUrl: options.guide.publicUrl,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
  };
  await persistManifest(manifestPath, manifest);

  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    userDataDir: profileDirectory,
    defaultViewport: null,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: ["--start-maximized"],
  });

  let guide = options.guide;
  let sequence = 0;
  let stopping = false;
  let paused = false;
  let uploadsBlocked = false;
  const attachedPages = new WeakSet<Page>();
  const frameHistory = new WeakMap<Page, LatestFrame[]>();
  let captureQueue = Promise.resolve();
  let uploadQueue = Promise.resolve();
  let manifestWriteQueue = Promise.resolve();
  const interrupt = () => {
    stopping = true;
    if (browser.connected) void browser.close().catch(() => undefined);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const saveManifest = () => {
    const operation = manifestWriteQueue.then(() => {
      manifest.updatedAt = new Date().toISOString();
      return persistManifest(manifestPath, manifest);
    });
    manifestWriteQueue = operation.catch(() => undefined);
    return operation;
  };
  const saveManifestSafely = async () => {
    try {
      await saveManifest();
    } catch (error) {
      options.onMessage?.(
        `The recording manifest could not be updated: ${error instanceof Error ? error.message : "Unknown error."}`,
      );
    }
  };

  const queueUpload = (
    step: RecordedStep,
    input: Omit<Parameters<typeof addGuideStep>[0], "slug" | "editRevision" | "token" | "baseUrl">,
  ) => {
    uploadQueue = uploadQueue.then(async () => {
      if (uploadsBlocked) {
        step.status = "pending";
        step.uploadError =
          "Waiting for an earlier failed upload. Run `schaffa guide sync` to retry.";
        await saveManifestSafely();
        return;
      }
      try {
        guide = await addGuideStep({
          ...input,
          slug: guide.slug,
          editRevision: guide.editRevision,
          token: options.token,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          idempotencyKey: `recorder-${guide.slug}-${String(step.sequence).padStart(6, "0")}`,
        });
        step.status = "uploaded";
        const stepId = guide.steps.at(-1)?.id;
        if (stepId) step.stepId = stepId;
        delete step.uploadError;
        options.onMessage?.(`Step ${step.sequence} uploaded: ${step.target}`);
      } catch (error) {
        let failure: unknown = error;
        if (isRejectedCapture(error, input)) {
          try {
            const { screenshot: _screenshot, clickMarker: _clickMarker, ...textStep } = input;
            guide = await addGuideStep({
              ...textStep,
              capture: false,
              slug: guide.slug,
              editRevision: guide.editRevision,
              token: options.token,
              ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
              idempotencyKey: `recorder-${guide.slug}-${String(step.sequence).padStart(6, "0")}`,
            });
            step.status = "uploaded";
            step.captureError = `The server rejected the screenshot (HTTP ${error.status}); the text step was preserved.`;
            const stepId = guide.steps.at(-1)?.id;
            if (stepId) step.stepId = stepId;
            delete step.uploadError;
            options.onMessage?.(
              `Step ${step.sequence} uploaded without its rejected screenshot; the local file was kept.`,
            );
            failure = null;
          } catch (fallbackError) {
            failure = fallbackError;
          }
        }
        if (failure) {
          uploadsBlocked = true;
          step.status = "failed";
          step.uploadError = failure instanceof Error ? failure.message : "Unknown upload error.";
          options.onMessage?.(
            `Step ${step.sequence} kept locally; upload failed: ${step.uploadError}`,
          );
        }
      }
      await saveManifestSafely();
    });
  };

  const captureStep = async (
    page: Page,
    click: RecordedClick | null,
    preClickFrame?: LatestFrame,
  ) => {
    const currentSequence = ++sequence;
    const screenshotName = `step-${String(currentSequence).padStart(4, "0")}.${preClickFrame ? "jpg" : "png"}`;
    const screenshotPath = path.join(recordingDirectory, screenshotName);
    const target = click ? describeClick(click) : options.url;
    const german = (options.language || "de").toLowerCase().startsWith("de");
    const title = click
      ? german
        ? `${quote(target)} anklicken`
        : `Click ${quote(target)}`
      : german
        ? "Startseite öffnen"
        : "Open the starting page";
    const description = click
      ? german
        ? `Klicke auf ${quote(target)}.`
        : `Click ${quote(target)}.`
      : german
        ? `Öffne ${options.url}.`
        : `Open ${options.url}.`;
    const step: RecordedStep = {
      sequence: currentSequence,
      timestamp: click?.timestamp || new Date().toISOString(),
      url: click?.url || page.url(),
      pageTitle: click?.pageTitle || (await safePageTitle(page)),
      target,
      title,
      description,
      actionType: click ? "click" : "navigate",
      selector: click?.selector || "",
      click: click ? (markerFromClick(click) ?? null) : null,
      screenshot: null,
      status: "pending",
    };
    manifest.steps.push(step);

    const sensitive = click?.sensitive || isSensitiveLocation(step.url);
    if (!sensitive) {
      if (click && !preClickFrame) {
        step.captureError =
          "No frame from before the click was available; a potentially misleading later screenshot was not used.";
        options.onMessage?.(`Step ${step.sequence} has no screenshot: ${step.captureError}`);
      } else {
        try {
          if (preClickFrame) {
            await writeFile(screenshotPath, preClickFrame.data, { mode: 0o600 });
          } else {
            const screenshot = await page.screenshot({
              type: "png",
              captureBeyondViewport: false,
            });
            await writeFile(screenshotPath, screenshot, { mode: 0o600 });
          }
          step.screenshot = screenshotName;
        } catch (firstError) {
          // The initial navigation screenshot can race with browser startup. A pre-click
          // frame is already immutable and must never be replaced with post-click state.
          if (!click) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (!click && !page.isClosed()) {
            try {
              const screenshot = await page.screenshot({
                type: "png",
                captureBeyondViewport: false,
              });
              await writeFile(screenshotPath, screenshot, { mode: 0o600 });
              step.screenshot = screenshotName;
            } catch (retryError) {
              step.captureError =
                retryError instanceof Error
                  ? retryError.message
                  : firstError instanceof Error
                    ? firstError.message
                    : "The page changed before its screenshot could be saved.";
            }
          } else {
            step.captureError =
              firstError instanceof Error
                ? firstError.message
                : "The pre-click frame could not be saved.";
          }
          if (step.captureError) {
            options.onMessage?.(`Step ${step.sequence} has no screenshot: ${step.captureError}`);
          }
        }
      }
    }

    await saveManifestSafely();
    const clickMarker = click ? markerFromClick(click) : undefined;
    queueUpload(step, {
      title,
      description,
      actionType: step.actionType,
      actionTarget: target,
      ...(clickMarker ? { clickMarker } : {}),
      ...(step.screenshot ? { screenshot: screenshotPath } : { capture: false }),
    });
  };

  const queueCapture = (page: Page, click: RecordedClick | null, preClickFrame?: LatestFrame) => {
    captureQueue = captureQueue
      .then(() => captureStep(page, click, preClickFrame))
      .catch((error: unknown) => {
        options.onMessage?.(
          `A click could not be captured: ${error instanceof Error ? error.message : "Unknown error."}`,
        );
      });
    return captureQueue;
  };

  const attachPage = async (page: Page) => {
    if (page.isClosed() || attachedPages.has(page)) return;
    attachedPages.add(page);
    await page.exposeFunction(recorderBinding, (value: unknown) => {
      const click = parseRecordedClick(value);
      if (!click || stopping || paused) return;
      const preClickFrame = selectPreClickFrame(frameHistory.get(page) || [], click.timestamp);
      void queueCapture(page, click, preClickFrame);
    });
    await page.exposeFunction(pauseBinding, (command: unknown) => {
      if (command === "toggle") {
        paused = !paused;
        options.onMessage?.(paused ? "Capture paused." : "Capture resumed.");
      }
      return paused;
    });
    await page.evaluateOnNewDocument(installClickRecorder);
    await page.evaluate(installClickRecorder).catch(() => undefined);
    const session = await page.createCDPSession().catch(() => null);
    if (session) {
      session.on("Page.screencastFrame", (event) => {
        const history = frameHistory.get(page) || [];
        history.push({
          data: Buffer.from(event.data, "base64"),
          receivedAt: Date.now(),
        });
        if (history.length > 12) history.splice(0, history.length - 12);
        frameHistory.set(page, history);
        void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {
          // A closing or navigating page can detach the CDP session.
        });
      });
      await session
        .send("Page.startScreencast", {
          format: "jpeg",
          quality: 90,
          everyNthFrame: 1,
        })
        .catch(() => undefined);
    }
  };

  browser.on("targetcreated", (target) => {
    if (target.type() !== "page") return;
    void target
      .page()
      .then((page) => (page ? attachPage(page) : undefined))
      .catch(() => undefined);
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    await attachPage(page);
    await page.goto(options.url, { waitUntil: "domcontentloaded" });
    await waitForFreshFrame(page, frameHistory, 1_000);
    await queueCapture(page, null);
    options.onMessage?.(
      "Recording. Close the browser or press Ctrl+C to stop. Alt+Shift+R pauses capture.",
    );

    await waitForBrowserClose(browser, () => {
      stopping = true;
    });
  } finally {
    stopping = true;
    await captureQueue;
    await uploadQueue;
    if (browser.connected) await browser.close().catch(() => undefined);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }

  return {
    guide,
    manifestPath,
    failedUploads: manifest.steps.filter((step) => step.status !== "uploaded").length,
  };
}

export async function syncRecording(options: {
  guide: GuideResult;
  token: string;
  baseUrl?: string;
  manifestPath?: string;
  fetch?: typeof fetch;
  onMessage?: (message: string) => void;
}): Promise<RecorderResult> {
  const manifestPath =
    options.manifestPath ||
    path.resolve(".schaffa", "recordings", options.guide.slug, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RecordingManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.slug !== options.guide.slug ||
    !Array.isArray(manifest.steps)
  ) {
    throw new Error("The recording manifest does not match the active guide.");
  }
  let guide = options.guide;
  for (const step of manifest.steps) {
    if (step.status === "uploaded") continue;
    const screenshot = step.screenshot
      ? recordingScreenshotPath(manifestPath, step.screenshot)
      : undefined;
    try {
      guide = await addGuideStep({
        slug: guide.slug,
        editRevision: guide.editRevision,
        title: step.title || `Click ${quote(step.target)}`,
        description: step.description || `Click ${quote(step.target)}.`,
        actionType: step.actionType || (step.click ? "click" : "navigate"),
        actionTarget: step.target,
        ...(step.click ? { clickMarker: step.click } : {}),
        ...(screenshot && existsSync(screenshot) ? { screenshot } : { capture: false }),
        token: options.token,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        idempotencyKey: `recorder-${guide.slug}-${String(step.sequence).padStart(6, "0")}`,
      });
      step.status = "uploaded";
      const stepId = guide.steps.at(-1)?.id;
      if (stepId) step.stepId = stepId;
      delete step.uploadError;
      options.onMessage?.(`Step ${step.sequence} uploaded: ${step.target}`);
    } catch (error) {
      if (isRejectedManifestCapture(error, step, screenshot)) {
        try {
          guide = await addGuideStep({
            slug: guide.slug,
            editRevision: guide.editRevision,
            title: step.title || `Click ${quote(step.target)}`,
            description: step.description || `Click ${quote(step.target)}.`,
            actionType: step.actionType || (step.click ? "click" : "navigate"),
            actionTarget: step.target,
            capture: false,
            token: options.token,
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
            idempotencyKey: `recorder-${guide.slug}-${String(step.sequence).padStart(6, "0")}`,
          });
          step.status = "uploaded";
          step.captureError = `The server rejected the screenshot (HTTP ${error.status}); the text step was preserved.`;
          const stepId = guide.steps.at(-1)?.id;
          if (stepId) step.stepId = stepId;
          delete step.uploadError;
        } catch (fallbackError) {
          step.status = "failed";
          step.uploadError =
            fallbackError instanceof Error ? fallbackError.message : "Unknown upload error.";
          manifest.updatedAt = new Date().toISOString();
          await persistManifest(manifestPath, manifest);
          break;
        }
      } else {
        step.status = "failed";
        step.uploadError = error instanceof Error ? error.message : "Unknown upload error.";
        manifest.updatedAt = new Date().toISOString();
        await persistManifest(manifestPath, manifest);
        break;
      }
    }
    manifest.updatedAt = new Date().toISOString();
    await persistManifest(manifestPath, manifest);
    guide = await getGuide({
      slug: guide.slug,
      token: options.token,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  return {
    guide,
    manifestPath,
    failedUploads: manifest.steps.filter((step) => step.status !== "uploaded").length,
  };
}

export async function readRecordingSlug(manifestPath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.resolve(manifestPath), "utf8")) as {
    schemaVersion?: unknown;
    slug?: unknown;
  };
  if (manifest.schemaVersion !== 1 || typeof manifest.slug !== "string") {
    throw new Error("The recording manifest is invalid.");
  }
  return manifest.slug;
}

export function describeClick(
  click: Pick<RecordedClick, "label" | "role" | "tag" | "x" | "y">,
): string {
  const label = normalizeText(click.label, 120);
  if (label) return label;
  const kind = click.role || click.tag.toLowerCase() || "element";
  return `${kind} at ${Math.round(click.x)}, ${Math.round(click.y)}`;
}

export function selectPreClickFrame(
  history: LatestFrame[],
  clickTimestamp: string,
): LatestFrame | undefined {
  const clickedAt = Date.parse(clickTimestamp);
  if (!Number.isFinite(clickedAt)) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const frame = history[index];
    if (frame && frame.receivedAt <= clickedAt) return frame;
  }
  return undefined;
}

export function findBrowserExecutable(explicit?: string): string {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) throw new Error(`Browser executable not found: ${resolved}`);
    return resolved;
  }
  const home = os.homedir();
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            path.join(
              process.env["PROGRAMFILES(X86)"] || "",
              "Google/Chrome/Application/chrome.exe",
            ),
            path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
            path.join(process.env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : [
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/microsoft-edge",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) {
    throw new Error(
      "No supported Chrome, Edge, or Chromium installation was found. Pass --browser <executable>.",
    );
  }
  return found;
}

function parseRecordedClick(value: unknown): RecordedClick | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.x !== "number" ||
    typeof input.y !== "number" ||
    typeof input.tag !== "string" ||
    typeof input.label !== "string" ||
    typeof input.selector !== "string" ||
    typeof input.url !== "string" ||
    typeof input.pageTitle !== "string" ||
    typeof input.viewportWidth !== "number" ||
    typeof input.viewportHeight !== "number" ||
    typeof input.inFrame !== "boolean" ||
    !input.box ||
    typeof input.box !== "object" ||
    typeof input.sensitive !== "boolean" ||
    typeof input.timestamp !== "string"
  ) {
    return null;
  }
  const box = input.box as Record<string, unknown>;
  if (
    typeof box.left !== "number" ||
    typeof box.top !== "number" ||
    typeof box.width !== "number" ||
    typeof box.height !== "number"
  ) {
    return null;
  }
  return {
    x: input.x,
    y: input.y,
    tag: normalizeText(input.tag, 40),
    role: typeof input.role === "string" ? normalizeText(input.role, 40) : null,
    label: normalizeText(input.label, 200),
    selector: normalizeText(input.selector, 500),
    url: normalizeText(input.url, 2_000),
    pageTitle: normalizeText(input.pageTitle, 200),
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    box: { left: box.left, top: box.top, width: box.width, height: box.height },
    inFrame: input.inFrame,
    sensitive: input.sensitive,
    timestamp: input.timestamp,
  };
}

function installClickRecorder(): void {
  type RecorderWindow = typeof globalThis & {
    __schaffaRecorderInstalled?: boolean;
    __schaffaRecorderPaused?: boolean;
    __schaffaRecordClick?: (value: unknown) => Promise<void>;
    __schaffaSetPaused?: (command?: "toggle") => Promise<boolean>;
  };
  const root = globalThis as RecorderWindow;
  if (root.__schaffaRecorderInstalled) return;
  root.__schaffaRecorderInstalled = true;
  root.__schaffaRecorderPaused = false;
  void root.__schaffaSetPaused?.().then((paused) => {
    root.__schaffaRecorderPaused = paused;
  });

  const text = (value: string | null | undefined, maximum = 200) =>
    (value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
  const cssEscape = (value: string) =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const targetLabel = (element: Element) => {
    const html = element as HTMLElement;
    const aria = text(element.getAttribute("aria-label"));
    if (aria) return aria;
    if (element instanceof HTMLInputElement) {
      const explicit = element.id
        ? document.querySelector(`label[for="${cssEscape(element.id)}"]`)
        : null;
      const label = text(explicit?.textContent || element.closest("label")?.textContent);
      if (label) return label;
      const inputLabel = text(element.placeholder);
      if (inputLabel) return inputLabel;
    }
    return text(
      html.innerText ||
        element.getAttribute("title") ||
        element.getAttribute("alt") ||
        element.getAttribute("name") ||
        element.id,
    );
  };
  const selectorFor = (element: Element) => {
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      const role = current.getAttribute("role");
      if (role) part += `[role="${cssEscape(role)}"]`;
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === current?.tagName,
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const isSensitive = (element: Element) => {
    if (element.closest('[data-private], [data-sensitive], [aria-label*="password" i]'))
      return true;
    if (!(element instanceof HTMLInputElement)) return false;
    const autocomplete = element.autocomplete.toLowerCase();
    return (
      element.type === "password" ||
      autocomplete.includes("password") ||
      autocomplete.startsWith("cc-") ||
      autocomplete.includes("one-time-code")
    );
  };
  addEventListener(
    "keydown",
    (event) => {
      if (!(event.altKey && event.shiftKey && event.code === "KeyR")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void root.__schaffaSetPaused?.("toggle").then((paused) => {
        root.__schaffaRecorderPaused = paused;
      });
    },
    true,
  );
  addEventListener(
    "pointerdown",
    (event) => {
      if (root.__schaffaRecorderPaused || event.button !== 0 || !event.isTrusted) return;
      const path = event.composedPath();
      const raw = path.find((entry) => entry instanceof Element);
      if (!(raw instanceof Element)) return;
      const element =
        raw.closest(
          'button, a, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="option"]',
        ) || raw;
      void root.__schaffaRecordClick?.({
        x: event.clientX,
        y: event.clientY,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        label: targetLabel(element),
        selector: selectorFor(element),
        url: location.href,
        pageTitle: document.title,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        box: {
          left: element.getBoundingClientRect().left,
          top: element.getBoundingClientRect().top,
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        },
        inFrame: window !== window.top,
        sensitive: isSensitive(element),
        timestamp: new Date().toISOString(),
      });
    },
    true,
  );
}

function isSensitiveLocation(value: string): boolean {
  try {
    const parsed = new URL(value);
    const location = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    return /(?:^|[._/-])(?:login|log-in|signin|sign-in|sign_in|auth|oauth\d*|authorize|password|passwd|credentials?|2fa|mfa|checkout|payment|billing|secrets?)(?:[._/-]|$)/.test(
      location,
    );
  } catch {
    return false;
  }
}

function markerFromClick(click: RecordedClick): GuideClickMarker | undefined {
  if (click.inFrame) return undefined;
  return {
    x: click.x,
    y: click.y,
    viewportWidth: click.viewportWidth,
    viewportHeight: click.viewportHeight,
    ...(click.box.width > 0 && click.box.height > 0 ? { box: click.box } : {}),
  };
}

function quote(value: string): string {
  return `“${value.replace(/[“”]/g, '"')}”`;
}

function normalizeText(value: string, maximum: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function recordingScreenshotPath(manifestPath: string, screenshot: string): string {
  const directory = path.resolve(path.dirname(manifestPath));
  const resolved = path.resolve(directory, screenshot);
  if (
    path.dirname(resolved) !== directory ||
    !/^step-\d{4,}\.(?:jpe?g|png)$/.test(path.basename(resolved))
  ) {
    throw new Error(`Unsafe screenshot path in recording manifest: ${screenshot}`);
  }
  return resolved;
}

function isRejectedCapture(
  error: unknown,
  input: { screenshot?: string },
): error is SchaffaRequestError {
  return (
    error instanceof SchaffaRequestError &&
    (error.status === 413 || error.status === 422) &&
    typeof input.screenshot === "string"
  );
}

function isRejectedManifestCapture(
  error: unknown,
  step: RecordedStep,
  screenshot: string | undefined,
): error is SchaffaRequestError {
  return (
    error instanceof SchaffaRequestError &&
    (error.status === 413 || error.status === 422) &&
    typeof screenshot === "string" &&
    step.screenshot !== null
  );
}

async function safePageTitle(page: Page): Promise<string> {
  return page.title().catch(() => "");
}

async function waitForFreshFrame(
  page: Page,
  frames: WeakMap<Page, LatestFrame[]>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!page.isClosed() && Date.now() < deadline) {
    const frame = frames.get(page)?.at(-1);
    if (frame && Date.now() - frame.receivedAt <= 500) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function persistManifest(manifestPath: string, manifest: RecordingManifest): Promise<void> {
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function waitForBrowserClose(browser: Browser, onStop: () => void): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      onStop();
      resolve();
    };
    browser.once("disconnected", finish);
  });
}
