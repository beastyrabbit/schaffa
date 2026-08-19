import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addGuideStep,
  type GuideClickMarker,
  type GuideResult,
  SchaffaRequestError,
} from "./client.js";

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
  type: "ready" | "paused" | "error" | "permissions";
  paused?: boolean;
  allowed?: boolean;
  missing?: string[];
  message?: string;
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
  fetch?: typeof fetch;
  onMessage?: (message: string) => void;
}

export interface DesktopRecorderResult {
  guide: GuideResult;
  manifestPath: string;
  failedUploads: number;
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
  const helper = options.helperExecutable || (await prepareDesktopRecorder());
  const manifest: RecordingManifest = {
    schemaVersion: 1,
    slug: options.guide.slug,
    publicUrl: options.guide.publicUrl,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "desktop",
    steps: [],
  };
  await persistManifest(manifestPath, manifest);

  let guide = options.guide;
  let sequence = 0;
  let uploadsBlocked = false;
  let captureQueue = Promise.resolve();
  let uploadQueue = Promise.resolve();
  let manifestWriteQueue = Promise.resolve();
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

  const queueUpload = (step: RecordedStep, screenshotPath?: string) => {
    uploadQueue = uploadQueue.then(async () => {
      if (uploadsBlocked) {
        step.status = "pending";
        step.uploadError =
          "Waiting for an earlier failed upload. Run `schaffa guide sync` to retry.";
        await saveManifestSafely();
        return;
      }
      const input = {
        slug: guide.slug,
        editRevision: guide.editRevision,
        title: step.title,
        description: step.description,
        actionType: step.actionType,
        actionTarget: step.target,
        clickMarker: step.click,
        ...(screenshotPath ? { screenshot: screenshotPath } : { capture: false }),
        token: options.token,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        idempotencyKey: `recorder-${guide.slug}-${String(step.sequence).padStart(6, "0")}`,
      };
      try {
        guide = await addGuideStep(input);
        step.status = "uploaded";
        const stepId = guide.steps.at(-1)?.id;
        if (stepId) step.stepId = stepId;
        delete step.uploadError;
        options.onMessage?.(`Step ${step.sequence} uploaded: ${step.target}`);
      } catch (error) {
        let failure: unknown = error;
        if (
          screenshotPath &&
          error instanceof SchaffaRequestError &&
          (error.status === 413 || error.status === 422)
        ) {
          try {
            guide = await addGuideStep({
              slug: guide.slug,
              editRevision: guide.editRevision,
              title: step.title,
              description: step.description,
              actionType: step.actionType,
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

  const child = spawn(
    helper,
    ["--output", recordingDirectory, "--bundle-id", options.appBundleId],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const message = chunk.trim();
    if (message) options.onMessage?.(`Desktop recorder: ${message}`);
  });
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() || "";
    for (const line of lines) {
      const event = parseDesktopEvent(line);
      if (!event) continue;
      if (event.type === "click") {
        if (event.bundleId !== options.appBundleId) {
          options.onMessage?.(
            `Ignored a click from ${event.bundleId || "an unknown application"}; recording is scoped to ${options.appBundleId}.`,
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
      } else if (event.type === "paused") {
        options.onMessage?.(event.paused ? "Capture paused." : "Capture resumed.");
      } else if (event.type === "error" && event.message) {
        options.onMessage?.(`Desktop recorder: ${event.message}`);
      }
    }
  });

  const interrupt = () => {
    child.kill("SIGINT");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  try {
    await waitForChild(child);
  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await captureQueue;
    await uploadQueue;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  return {
    guide,
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
  if (["ready", "paused", "error", "permissions"].includes(String(input.type))) {
    return {
      type: input.type as DesktopStatus["type"],
      ...(typeof input.paused === "boolean" ? { paused: input.paused } : {}),
      ...(typeof input.allowed === "boolean" ? { allowed: input.allowed } : {}),
      ...(Array.isArray(input.missing) && input.missing.every((item) => typeof item === "string")
        ? { missing: input.missing }
        : {}),
      ...(typeof input.message === "string" ? { message: normalizeText(input.message, 500) } : {}),
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
