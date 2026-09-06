import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GuideClickMarker, GuideResult } from "./client.js";

import { recordingUploadQueue } from "./recording-upload.js";

export interface DesktopClick {
  type: "click";
  timestamp: string;
  app: string;
  bundleId: string;
  windowTitle: string;
  windowId: number;
  role: string;
  subrole: string;
  label: string;
  x: number;
  y: number;
  windowWidth: number;
  windowHeight: number;
  sensitive: boolean;
  screenshotPath?: string;
  box?: { left: number; top: number; width: number; height: number };
}

interface DesktopStatus {
  type: "ready" | "bound" | "paused" | "error" | "permissions";
  paused?: boolean;
  allowed?: boolean;
  missing?: string[];
  message?: string;
  windowId?: number;
  ownerPid?: number;
  windowTitle?: string;
}

interface RecordedStep {
  sequence: number;
  timestamp: string;
  url: string;
  pageTitle: string;
  target: string;
  title: string;
  description: string;
  actionType: "click";
  selector: string;
  click: GuideClickMarker;
  screenshot: string | null;
  status: "pending" | "uploaded" | "failed";
  stepId?: string;
  captureError?: string;
  uploadError?: string;
}

interface RecordingManifest {
  schemaVersion: 1;
  recordingId: string;
  slug: string;
  publicUrl: string;
  startedAt: string;
  updatedAt: string;
  source: "desktop";
  steps: RecordedStep[];
}

export interface DesktopRecorderOptions {
  guide: GuideResult;
  appBundleId: string;
  token: string;
  baseUrl?: string;
  language?: string;
  outputDirectory?: string;
  helperExecutable?: string;
  windowId?: number;
  windowTitleToken?: string;
  onRecorderReady?: () => Promise<void> | void;
  onWindowBound?: (window: { id: number; title: string }) => Promise<void> | void;
  fetch?: typeof fetch;
  onMessage?: (message: string) => void;
}

export interface DesktopRecorderResult {
  guide: GuideResult;
  manifestPath: string;
  failedUploads: number;
}

export interface ChromeWindowRecorderOptions {
  guide: GuideResult;
  url: string;
  token: string;
  baseUrl?: string;
  language?: string;
  outputDirectory?: string;
  helperExecutable?: string;
  browserExecutable?: string;
  fetch?: typeof fetch;
  onMessage?: (message: string) => void;
  launchWindow?: (executable: string, url: string) => Promise<void>;
}

interface ChromeLaunchPage {
  url: string;
  release: () => void;
  close: () => Promise<void>;
}

const activeDesktopRecorderChildren = new Set<ReturnType<typeof spawn>>();
const terminatedDesktopRecorderChildren = new WeakSet<ReturnType<typeof spawn>>();
const desktopRecorderTerminationCallbacks = new WeakMap<ReturnType<typeof spawn>, () => void>();
const interruptDesktopRecorders = () => {
  for (const child of activeDesktopRecorderChildren) child.kill("SIGINT");
};
const terminateDesktopRecorders = () => {
  for (const child of activeDesktopRecorderChildren) {
    terminatedDesktopRecorderChildren.add(child);
    desktopRecorderTerminationCallbacks.get(child)?.();
    child.kill("SIGTERM");
  }
};

function registerDesktopRecorderSignals(
  child: ReturnType<typeof spawn>,
  onTerminate: () => void,
): () => void {
  if (activeDesktopRecorderChildren.size === 0) {
    process.on("SIGINT", interruptDesktopRecorders);
    process.on("SIGTERM", terminateDesktopRecorders);
  }
  activeDesktopRecorderChildren.add(child);
  desktopRecorderTerminationCallbacks.set(child, onTerminate);
  return () => {
    activeDesktopRecorderChildren.delete(child);
    desktopRecorderTerminationCallbacks.delete(child);
    if (activeDesktopRecorderChildren.size === 0) {
      process.off("SIGINT", interruptDesktopRecorders);
      process.off("SIGTERM", terminateDesktopRecorders);
    }
  };
}

export async function recordChromeWindowGuide(
  options: ChromeWindowRecorderOptions,
): Promise<DesktopRecorderResult> {
  if (process.platform !== "darwin") {
    throw new Error("Recording through an existing Chrome profile session supports macOS only.");
  }
  const executable = findChromeExecutable(options.browserExecutable);
  // Chrome can elide long tab titles in the CoreGraphics window name. Keep the
  // unique token short and at the start so the native helper can always see it.
  const titleToken = `SFR-${randomBytes(8).toString("hex")}`;
  const launchPage = await createChromeLaunchPage(titleToken, options.url);
  const launchWindow = options.launchWindow || openChromeWindow;
  try {
    return await recordDesktopGuide({
      guide: options.guide,
      appBundleId: "com.google.Chrome",
      token: options.token,
      windowTitleToken: titleToken,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.outputDirectory ? { outputDirectory: options.outputDirectory } : {}),
      ...(options.helperExecutable ? { helperExecutable: options.helperExecutable } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.onMessage ? { onMessage: options.onMessage } : {}),
      onWindowBound: () => {
        launchPage.release();
      },
      onRecorderReady: async () => {
        options.onMessage?.(
          "Opening a new window without creating a Chrome profile. Only that window will be recorded.",
        );
        await launchWindow(executable, launchPage.url);
      },
    });
  } finally {
    await launchPage.close();
  }
}

async function createChromeLaunchPage(title: string, target: string): Promise<ChromeLaunchPage> {
  const destination = new URL(target);
  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    throw new Error("Chrome recording requires an HTTP or HTTPS URL.");
  }
  const token = randomBytes(16).toString("hex");
  const pagePath = `/${token}`;
  const releasePath = `${pagePath}/go`;
  const waiting = new Set<ServerResponse>();
  let released = false;
  let closed = false;

  const sendTarget = (response: ServerResponse) => {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      Connection: "close",
      "Content-Type": "text/plain; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(destination.href);
  };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET", Connection: "close" });
      response.end();
      return;
    }
    if (pathname === pagePath) {
      const script = `fetch(${JSON.stringify(releasePath)}, { cache: "no-store" }).then((response) => { if (!response.ok) throw new Error("Recorder stopped"); return response.text(); }).then((url) => location.replace(url));`;
      response.writeHead(200, {
        "Cache-Control": "no-store",
        Connection: "close",
        "Content-Security-Policy":
          "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><p>Preparing the guide recording…</p><script>${script}</script></body></html>`,
      );
      return;
    }
    if (pathname === releasePath) {
      if (released) {
        sendTarget(response);
      } else {
        waiting.add(response);
        response.once("close", () => waiting.delete(response));
      }
      return;
    }
    response.writeHead(404, { Connection: "close" });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("The local Chrome launch page could not be started.");
  }
  return {
    url: `http://127.0.0.1:${address.port}${pagePath}`,
    release: () => {
      if (closed || released) return;
      released = true;
      for (const response of waiting) sendTarget(response);
      waiting.clear();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const response of waiting) {
        response.writeHead(503, { Connection: "close" });
        response.end();
      }
      waiting.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}

export function findChromeExecutable(explicit?: string): string {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) throw new Error(`Chrome executable not found: ${resolved}`);
    try {
      if (!statSync(resolved).isFile()) throw new Error("not a file");
      accessSync(resolved, constants.X_OK);
    } catch {
      throw new Error(`Chrome executable is not an executable file: ${resolved}`);
    }
    return resolved;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ];
  const found = candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(
      "Google Chrome was not found. Install Chrome or pass --browser-executable <path>.",
    );
  }
  return found;
}

export async function openChromeWindow(executable: string, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, chromeWindowArguments(url), {
      detached: true,
      stdio: "ignore",
    });
    let settled = false;
    let acceptanceTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (acceptanceTimer) clearTimeout(acceptanceTimer);
      child.unref();
      if (error) reject(error);
      else resolve();
    };
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish();
      else
        finish(
          new Error(`Chrome rejected the new window request (${code ?? signal ?? "unknown"}).`),
        );
    });
    child.once("spawn", () => {
      acceptanceTimer = setTimeout(() => finish(), 2_000);
      acceptanceTimer.unref();
    });
  });
}

export function chromeWindowArguments(url: string): string[] {
  return ["--new-window", url];
}

export async function prepareDesktopRecorder(
  options: { promptForPermissions?: boolean } = {},
): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Desktop recording currently supports macOS only.");
  }
  const sourcePath = fileURLToPath(new URL("../assets/desktop-recorder.swift", import.meta.url));
  const source = await readFile(sourcePath);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 20);
  const binDirectory = path.join(os.homedir(), ".schaffa", "bin");
  const executable = path.join(binDirectory, `desktop-recorder-${hash}`);
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  if (!existsSync(executable)) {
    const temporary = `${executable}.${process.pid}.tmp`;
    try {
      await runProcess("/usr/bin/swiftc", [sourcePath, "-O", "-o", temporary]);
      await runProcess("/usr/bin/codesign", ["--force", "--sign", "-", temporary]);
      await chmod(temporary, 0o700);
      await rename(temporary, executable);
    } finally {
      await rm(temporary, { force: true });
    }
  } else {
    const info = await lstat(executable);
    const owner = typeof process.getuid === "function" ? process.getuid() : info.uid;
    const signature = await runProcess(
      "/usr/bin/codesign",
      ["--verify", "--strict", executable],
      true,
    );
    if (!info.isFile() || info.uid !== owner || (info.mode & 0o077) !== 0 || signature.code !== 0) {
      throw new Error(
        `The cached desktop helper is not a trusted owner-only executable: ${executable}`,
      );
    }
  }
  if (options.promptForPermissions) {
    const checked = await runProcess(executable, ["--check"], true);
    const result = checked.stdout
      .split("\n")
      .map((line) => parseDesktopEvent(line))
      .find((event): event is DesktopStatus => event?.type === "permissions");
    if (!result?.allowed) {
      const missing = result?.missing?.join(" and ") || "Accessibility and Screen Recording";
      throw new Error(
        `macOS permission required: ${missing}. In System Settings > Privacy & Security, enable it for the terminal or agent app that launched Schaffa (for example Terminal or T3 Code), then run the command again.`,
      );
    }
  }
  return executable;
}

export async function recordDesktopGuide(
  options: DesktopRecorderOptions,
): Promise<DesktopRecorderResult> {
  const recordingDirectory =
    options.outputDirectory || path.resolve(".schaffa", "recordings", options.guide.slug);
  const manifestPath = path.join(recordingDirectory, "manifest.json");
  await mkdir(recordingDirectory, { recursive: true, mode: 0o700 });
  await chmod(recordingDirectory, 0o700);
  const lock = await acquireRecordingLock(recordingDirectory);
  try {
    return await recordDesktopGuideLocked(options, recordingDirectory, manifestPath, lock.id);
  } finally {
    await lock.release();
  }
}

async function recordDesktopGuideLocked(
  options: DesktopRecorderOptions,
  recordingDirectory: string,
  manifestPath: string,
  recordingId: string,
): Promise<DesktopRecorderResult> {
  const helper = options.helperExecutable || (await prepareDesktopRecorder());
  if (options.windowId !== undefined && options.windowTitleToken !== undefined) {
    throw new Error("Choose a desktop window ID or title token, not both.");
  }
  const manifest: RecordingManifest = {
    schemaVersion: 1,
    recordingId,
    slug: options.guide.slug,
    publicUrl: options.guide.publicUrl,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "desktop",
    steps: [],
  };
  await persistManifest(manifestPath, manifest);

  const guide = options.guide;
  let sequence = 0;
  let terminated = false;
  let captureQueue = Promise.resolve();
  let manifestWriteQueue = Promise.resolve();
  const terminationController = new AbortController();
  let terminationTimer: NodeJS.Timeout | undefined;
  const saveManifest = () => {
    const operation = manifestWriteQueue.then(() => persistManifest(manifestPath, manifest));
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
  const uploadFetch: typeof fetch = (input, init) => {
    if (terminated) {
      return Promise.reject(new Error("Recording terminated before the upload started."));
    }
    const signal = terminationController.signal;
    const request = (options.fetch || fetch)(input, { ...init, signal });
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(new Error("Recording terminated during the upload."));
      signal.addEventListener("abort", abort, { once: true });
      request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };

  const uploads = recordingUploadQueue({
    guide,
    stopped: () => terminated,
    save: saveManifestSafely,
    onMessage: options.onMessage,
  });
  const queueUpload = (step: RecordedStep, screenshotPath?: string) =>
    uploads.enqueue(step, {
      title: step.title,
      description: step.description,
      actionType: step.actionType,
      actionTarget: step.target,
      clickMarker: step.click,
      ...(screenshotPath ? { screenshot: screenshotPath } : { capture: false }),
      token: options.token,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      fetch: uploadFetch,
      idempotencyKey: recorderIdempotencyKey(manifest, step.sequence),
    });

  const captureClick = async (click: DesktopClick) => {
    const currentSequence = ++sequence;
    const screenshotName = `step-${String(currentSequence).padStart(4, "0")}.png`;
    const screenshotPath = path.join(recordingDirectory, screenshotName);
    const target = describeDesktopClick(click);
    const german = (options.language || "de").toLowerCase().startsWith("de");
    const title = german ? `${quote(target)} anklicken` : `Click ${quote(target)}`;
    const description = german
      ? `Klicke in ${quote(click.app)} auf ${quote(target)}.`
      : `In ${quote(click.app)}, click ${quote(target)}.`;
    const step: RecordedStep = {
      sequence: currentSequence,
      timestamp: click.timestamp,
      url: click.bundleId ? `desktop://${click.bundleId}` : "desktop://application",
      pageTitle: click.windowTitle || click.app,
      target,
      title,
      description,
      actionType: "click",
      selector: [click.bundleId, click.role, click.label].filter(Boolean).join(" > "),
      click: desktopMarker(click),
      screenshot: null,
      status: "pending",
    };
    manifest.steps.push(step);
    if (click.sensitive) {
      step.captureError =
        "Screenshot suppressed because the clicked field may contain sensitive data.";
      if (click.screenshotPath) {
        try {
          await rm(desktopScreenshotPath(recordingDirectory, click.screenshotPath), {
            force: true,
          });
        } catch {
          // Never touch a path outside this recording directory.
        }
      }
    } else if (click.screenshotPath) {
      try {
        const sourcePath = desktopScreenshotPath(recordingDirectory, click.screenshotPath);
        await rename(sourcePath, screenshotPath);
        await chmod(screenshotPath, 0o600);
        step.screenshot = screenshotName;
      } catch (error) {
        step.captureError =
          error instanceof Error ? error.message : "The screenshot could not be saved.";
      }
    } else {
      step.captureError = "The native window screenshot could not be captured.";
    }
    await saveManifestSafely();
    queueUpload(step, step.screenshot ? screenshotPath : undefined);
  };

  const helperArgs = ["--output", recordingDirectory, "--bundle-id", options.appBundleId];
  if (options.windowId !== undefined) helperArgs.push("--window-id", String(options.windowId));
  if (options.windowTitleToken !== undefined) {
    helperArgs.push("--window-title-token", options.windowTitleToken);
  }
  const child = spawn(helper, helperArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const message = chunk.trim();
    if (message) options.onMessage?.(`Desktop recorder: ${message}`);
  });
  let buffered = "";
  let selectedWindowId = options.windowId;
  const windowScopeRequired =
    options.windowId !== undefined || options.windowTitleToken !== undefined;
  let windowWasBound = false;
  let recorderReady = false;
  let startupQueue = Promise.resolve();
  let startupError: unknown;
  let bindingQueue = Promise.resolve();
  let bindingError: unknown;
  let recorderError: string | undefined;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() || "";
    for (const line of lines) {
      const event = parseDesktopEvent(line);
      if (!event) continue;
      if (event.type === "click") {
        if (
          (windowScopeRequired && !windowWasBound) ||
          !desktopClickMatchesScope(event, options.appBundleId, selectedWindowId)
        ) {
          options.onMessage?.(
            windowScopeRequired && !windowWasBound
              ? "Ignored a click before the requested window was bound."
              : event.bundleId !== options.appBundleId
                ? `Ignored a click from ${event.bundleId || "an unknown application"}; recording is scoped to ${options.appBundleId}.`
                : `Ignored a click from window ${event.windowId}; recording is scoped to window ${selectedWindowId}.`,
          );
          continue;
        }
        captureQueue = captureQueue
          .then(() => captureClick(event))
          .catch((error: unknown) => {
            options.onMessage?.(
              `A desktop click could not be captured: ${error instanceof Error ? error.message : "Unknown error."}`,
            );
          });
      } else if (event.type === "ready") {
        options.onMessage?.("Desktop recording. Press Ctrl+C to stop. Alt+Shift+R pauses capture.");
        if (!recorderReady && options.onRecorderReady) {
          recorderReady = true;
          startupQueue = startupQueue
            .then(() => options.onRecorderReady?.())
            .catch((error: unknown) => {
              startupError = error;
              child.kill("SIGTERM");
            });
        }
      } else if (event.type === "bound" && event.windowId !== undefined) {
        if (windowWasBound) {
          if (event.windowId !== selectedWindowId) {
            options.onMessage?.(
              `Ignored a second window binding for ${event.windowId}; recording remains scoped to window ${selectedWindowId}.`,
            );
          }
          continue;
        }
        selectedWindowId = event.windowId;
        windowWasBound = true;
        options.onMessage?.(
          `Recording is scoped to window ${event.windowId}${event.windowTitle ? ` (${event.windowTitle})` : ""}.`,
        );
        if (options.onWindowBound) {
          bindingQueue = bindingQueue
            .then(() =>
              options.onWindowBound?.({
                id: event.windowId as number,
                title: event.windowTitle || "",
              }),
            )
            .catch((error: unknown) => {
              bindingError = error;
              child.kill("SIGTERM");
            });
        }
      } else if (event.type === "paused") {
        options.onMessage?.(event.paused ? "Capture paused." : "Capture resumed.");
      } else if (event.type === "error" && event.message) {
        recorderError = event.message;
        options.onMessage?.(`Desktop recorder: ${event.message}`);
      }
    }
  });

  const unregisterSignals = registerDesktopRecorderSignals(child, () => {
    terminated = true;
    terminationTimer ||= setTimeout(() => terminationController.abort(), 250);
  });

  try {
    await waitForChild(child);
  } catch (error) {
    if (recorderError) throw new Error(`Desktop recorder failed: ${recorderError}`);
    throw error;
  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await startupQueue;
    await bindingQueue;
    await captureQueue;
    await uploads.drain();
    if (terminationTimer) clearTimeout(terminationTimer);
    await saveManifestSafely();
    unregisterSignals();
  }
  if (terminated || terminatedDesktopRecorderChildren.has(child)) {
    throw new Error(
      "Recording terminated by SIGTERM. Captured work remains resumable and the guide was not published.",
    );
  }
  if (startupError) throw startupError;
  if (bindingError) throw bindingError;
  if (recorderError) throw new Error(`Desktop recorder failed: ${recorderError}`);
  if (windowScopeRequired && !windowWasBound) {
    throw new Error("The requested recording window closed before it could be bound.");
  }
  return {
    guide: uploads.guide,
    manifestPath,
    failedUploads: manifest.steps.filter((step) => step.status !== "uploaded").length,
  };
}

export function parseDesktopEvent(line: string): DesktopClick | DesktopStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (["ready", "bound", "paused", "error", "permissions"].includes(String(input.type))) {
    return {
      type: input.type as DesktopStatus["type"],
      ...(typeof input.paused === "boolean" ? { paused: input.paused } : {}),
      ...(typeof input.allowed === "boolean" ? { allowed: input.allowed } : {}),
      ...(Array.isArray(input.missing) && input.missing.every((item) => typeof item === "string")
        ? { missing: input.missing }
        : {}),
      ...(typeof input.message === "string" ? { message: normalizeText(input.message, 500) } : {}),
      ...(positive(input.windowId) ? { windowId: input.windowId } : {}),
      ...(positive(input.ownerPid) ? { ownerPid: input.ownerPid } : {}),
      ...(typeof input.windowTitle === "string"
        ? { windowTitle: normalizeText(input.windowTitle, 240) }
        : {}),
    };
  }
  if (
    input.type !== "click" ||
    typeof input.timestamp !== "string" ||
    typeof input.app !== "string" ||
    typeof input.bundleId !== "string" ||
    typeof input.windowTitle !== "string" ||
    typeof input.windowId !== "number" ||
    typeof input.role !== "string" ||
    typeof input.subrole !== "string" ||
    typeof input.label !== "string" ||
    !finite(input.x) ||
    !finite(input.y) ||
    !positive(input.windowWidth) ||
    !positive(input.windowHeight) ||
    typeof input.sensitive !== "boolean"
  ) {
    return null;
  }
  let box: DesktopClick["box"];
  if (input.box && typeof input.box === "object") {
    const candidate = input.box as Record<string, unknown>;
    if (
      finite(candidate.left) &&
      finite(candidate.top) &&
      positive(candidate.width) &&
      positive(candidate.height)
    ) {
      box = {
        left: candidate.left,
        top: candidate.top,
        width: candidate.width,
        height: candidate.height,
      };
    }
  }
  return {
    type: "click",
    timestamp: normalizeText(input.timestamp, 100),
    app: normalizeText(input.app, 160) || "Application",
    bundleId: normalizeText(input.bundleId, 240),
    windowTitle: normalizeText(input.windowTitle, 240),
    windowId: input.windowId,
    role: normalizeText(input.role, 80),
    subrole: normalizeText(input.subrole, 80),
    label: normalizeText(input.label, 200),
    x: input.x,
    y: input.y,
    windowWidth: input.windowWidth,
    windowHeight: input.windowHeight,
    sensitive: input.sensitive,
    ...(typeof input.screenshotPath === "string" ? { screenshotPath: input.screenshotPath } : {}),
    ...(box ? { box } : {}),
  };
}

export function desktopClickMatchesScope(
  click: Pick<DesktopClick, "bundleId" | "windowId">,
  bundleId: string,
  windowId?: number,
): boolean {
  return click.bundleId === bundleId && (windowId === undefined || click.windowId === windowId);
}

export function describeDesktopClick(
  click: Pick<DesktopClick, "label" | "role" | "x" | "y">,
): string {
  const label = normalizeText(click.label, 120);
  if (label) return label;
  const role = normalizeText(click.role.replace(/^AX/, ""), 80).toLowerCase() || "element";
  return `${role} at ${Math.round(click.x)}, ${Math.round(click.y)}`;
}

export function desktopMarker(
  click: Pick<DesktopClick, "x" | "y" | "windowWidth" | "windowHeight" | "box">,
): GuideClickMarker {
  return {
    x: click.x,
    y: click.y,
    viewportWidth: click.windowWidth,
    viewportHeight: click.windowHeight,
    ...(click.box ? { box: click.box } : {}),
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function normalizeText(value: string, maximum: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function quote(value: string): string {
  return `“${value.replace(/[“”]/g, '"')}”`;
}

function desktopScreenshotPath(recordingDirectory: string, value: string): string {
  const directory = path.resolve(recordingDirectory);
  const resolved = path.resolve(value);
  if (
    path.dirname(resolved) !== directory ||
    !/^desktop-[0-9a-f-]{20,}\.png$/i.test(path.basename(resolved))
  ) {
    throw new Error("The desktop helper returned an unsafe screenshot path.");
  }
  return resolved;
}

function recorderIdempotencyKey(manifest: RecordingManifest, sequence: number): string {
  return `recorder-${manifest.recordingId}-${String(sequence).padStart(6, "0")}`;
}

async function acquireRecordingLock(
  recordingDirectory: string,
): Promise<{ id: string; release: () => Promise<void> }> {
  const lockPath = path.join(recordingDirectory, ".recording.lock");
  const id = randomBytes(12).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        );
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true });
        throw error;
      }
      let released = false;
      return {
        id,
        release: async () => {
          if (released) return;
          released = true;
          await handle.close().catch(() => undefined);
          try {
            const current = JSON.parse(await readFile(lockPath, "utf8")) as { id?: unknown };
            if (current.id === id) await rm(lockPath, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && (await removeStaleRecordingLock(lockPath))) continue;
      throw new Error(
        `Another recorder is already using ${recordingDirectory}. Stop it or choose another output directory.`,
      );
    }
  }
  throw new Error(`The recording directory could not be locked: ${recordingDirectory}`);
}

async function removeStaleRecordingLock(lockPath: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, "r");
    const [contents, openedInfo] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
    const value = JSON.parse(contents) as { pid?: unknown };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return false;
    try {
      process.kill(value.pid as number, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    const currentInfo = await lstat(lockPath);
    if (currentInfo.dev !== openedInfo.dev || currentInfo.ino !== openedInfo.ino) return false;
    await rm(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function persistManifest(manifestPath: string, manifest: RecordingManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  const temporary = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function runProcess(
  executable: string,
  args: string[],
  acceptFailure = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = { stdout, stderr, code: code ?? 1 };
      if (code === 0 || acceptFailure) resolve(result);
      else
        reject(new Error(`${path.basename(executable)} failed: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") resolve();
      else
        reject(new Error(`Desktop recorder exited unexpectedly (${code ?? signal ?? "unknown"}).`));
    });
  });
}
