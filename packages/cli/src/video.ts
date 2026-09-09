import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { GuideClickMarker } from "./client.js";

export interface VideoFrame {
  file: string;
  time: number;
  click?: GuideClickMarker;
  caption?: string;
}
export interface VideoTimeline {
  schemaVersion: 1;
  failure?: string;
  guideSlug?: string;
  frames: VideoFrame[];
}

export function checkVideoEncoder(): void {
  const check = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (check.status !== 0 || !check.stdout.includes("libvpx-vp9")) {
    throw new Error("Video export requires ffmpeg with the libvpx-vp9 encoder installed.");
  }
}

// Capture continuously, but keep at most ten frames per second and 512 MiB locally.
export async function createVideoCapture(
  directory: string,
  guideSlug?: string,
  maximumBytes = 512 * 1024 * 1024,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timeline: VideoTimeline = {
    schemaVersion: 1,
    frames: [],
    ...(guideSlug ? { guideSlug } : {}),
  };
  let pending = Promise.resolve();
  let last = 0;
  let bytes = 0;
  let failure: Error | undefined;
  let cut = true;
  let active = true;
  return {
    pause() {
      cut = true;
    },
    frame(data: Buffer) {
      const now = Date.now();
      if (!active || failure || now - last < 100) return;
      const elapsed = cut ? 100 : Math.min(now - last, 3000);
      cut = false;
      last = now;
      bytes += data.length;
      if (bytes > maximumBytes) {
        failure = new Error("Video capture exceeded its size limit. Start a shorter recording.");
        return;
      }
      const file = `frame-${String(timeline.frames.length).padStart(7, "0")}.jpg`;
      timeline.frames.push({ file, time: (timeline.frames.at(-1)?.time || 0) + elapsed });
      pending = pending
        .then(() => writeFile(path.join(directory, file), data, { mode: 0o600 }))
        .catch(() => {
          failure = new Error("Could not save video frames.");
        });
    },
    click(marker: GuideClickMarker, caption: string) {
      if (!active || cut) return;
      const frame = timeline.frames.at(-1);
      if (frame) timeline.frames.push({ ...frame, click: marker, caption });
    },
    async finish() {
      active = false;
      await pending;
      if (failure) timeline.failure = failure.message;
      const manifest = path.join(directory, "video.json");
      await writeFile(manifest, `${JSON.stringify(timeline)}\n`, { mode: 0o600 });
      if (failure) throw failure;
      return manifest;
    },
  };
}

export async function readVideoTimeline(manifest: string): Promise<VideoTimeline> {
  const input = JSON.parse(await readFile(manifest, "utf8"));
  if (input.schemaVersion !== 1) throw new Error("Unsupported video manifest.");
  if (input.failure !== undefined)
    throw new Error("This video capture failed and is incomplete. Record a new video.");
  const frames = Array.isArray(input.frames)
    ? input.frames
    : Array.isArray(input.steps)
      ? input.steps
          .filter((step: { screenshot?: string }) => step.screenshot)
          .map(
            (
              step: { screenshot: string; click?: GuideClickMarker; title: string },
              index: number,
            ) => ({
              file: step.screenshot,
              time: index * 3000,
              ...(step.click ? { click: step.click } : {}),
              caption: step.title,
            }),
          )
      : [];
  if (!frames.length || frames.length > 100_000) throw new Error("Video needs captured frames.");
  let previous = -1;
  for (const frame of frames) {
    if (
      typeof frame.file !== "string" ||
      path.basename(frame.file) !== frame.file ||
      !/\.(png|jpe?g|webp)$/i.test(frame.file) ||
      !Number.isFinite(frame.time) ||
      frame.time < 0 ||
      frame.time < previous
    ) {
      throw new Error("Invalid video frame.");
    }
    previous = frame.time;
    if (
      frame.caption !== undefined &&
      (typeof frame.caption !== "string" || frame.caption.length > 1000)
    )
      throw new Error("Invalid video caption.");
    if (
      frame.click &&
      (!Number.isFinite(frame.click.x) ||
        !Number.isFinite(frame.click.y) ||
        frame.click.x < 0 ||
        frame.click.y < 0 ||
        frame.click.x > frame.click.viewportWidth ||
        frame.click.y > frame.click.viewportHeight ||
        !(frame.click.viewportWidth > 0) ||
        !(frame.click.viewportHeight > 0) ||
        !Number.isFinite(frame.click.viewportWidth) ||
        !Number.isFinite(frame.click.viewportHeight))
    )
      throw new Error("Invalid video click.");
  }
  return { schemaVersion: 1, frames };
}

export async function exportVideo(options: {
  manifest: string;
  output: string;
  executablePath: string;
  title?: string;
}) {
  checkVideoEncoder();
  const timeline = await readVideoTimeline(options.manifest);
  if (path.extname(options.output).toLowerCase() !== ".webm")
    throw new Error("Video output must end in .webm.");
  if (
    await lstat(options.output).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw new Error("Video output already exists. Choose another filename.");
  const directory = await realpath(path.dirname(options.manifest));
  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true, mode: 0o700 });
  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: options.executablePath,
    headless: true,
  });
  const temporaryDirectory = await mkdtemp(
    path.join(path.dirname(path.resolve(options.output)), ".schaffa-video-"),
  );
  const temporary = path.join(temporaryDirectory, "output.webm");
  const encoder = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-f",
      "image2pipe",
      "-framerate",
      "20",
      "-vcodec",
      "mjpeg",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "realtime",
      "-cpu-used",
      "6",
      "-pix_fmt",
      "yuv420p",
      temporary,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let encoderError: Error | undefined;
  encoder.on("error", (error) => {
    encoderError = error;
  });
  encoder.stdin.on("error", (error) => {
    encoderError = error;
  });
  encoder.stderr.resume();
  const completed = new Promise<number | null>((resolve) => encoder.once("close", resolve));
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.setContent(
      '<canvas width="1280" height="800"></canvas><style>html,body{margin:0;overflow:hidden;background:#111827}</style>',
    );
    let cursor = { x: 50, y: 50 };
    let caption = options.title || "";
    for (let index = 0; index < timeline.frames.length; index++) {
      const frame = timeline.frames[index];
      if (!frame) continue;
      const filename = await realpath(path.join(directory, frame.file));
      if (path.dirname(filename) !== directory)
        throw new Error("Video frame escapes its recording directory.");
      if ((await stat(filename)).size > 20 * 1024 * 1024)
        throw new Error("Video frame exceeds 20 MiB.");
      const data = await readFile(filename);
      const mime = /\.png$/i.test(filename)
        ? "image/png"
        : /\.webp$/i.test(filename)
          ? "image/webp"
          : "image/jpeg";
      await page.evaluate(
        async (src) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          (globalThis as typeof globalThis & { videoImage?: HTMLImageElement }).videoImage = img;
        },
        `data:${mime};base64,${data.toString("base64")}`,
      );
      const hold = frame.click
        ? 50
        : Math.max(
            index === 0 ? 30 : 1,
            Math.min(
              60,
              Math.round(
                ((timeline.frames[index + 1]?.time ?? frame.time + 2000) - frame.time) / 50,
              ),
            ),
          );
      const start = { ...cursor };
      caption = frame.caption || caption;
      for (let tick = 0; tick < hold; tick++) {
        const position = await page.evaluate(
          ({ click, caption, tick, start }) => {
            const canvas = document.querySelector("canvas");
            const ctx = canvas?.getContext("2d");
            const img = (globalThis as typeof globalThis & { videoImage?: HTMLImageElement })
              .videoImage;
            if (!ctx || !img) throw new Error("Video canvas unavailable.");
            const scale = Math.min(1280 / img.width, 720 / img.height);
            const left = (1280 - img.width * scale) / 2,
              top = (720 - img.height * scale) / 2;
            ctx.fillStyle = "#111827";
            ctx.fillRect(0, 0, 1280, 800);
            ctx.drawImage(img, left, top, img.width * scale, img.height * scale);
            let x = start.x,
              y = start.y;
            if (click) {
              const progress = Math.min(1, tick / 16),
                eased = progress * progress * (3 - 2 * progress);
              x += (left + (click.x / click.viewportWidth) * img.width * scale - x) * eased;
              y += (top + (click.y / click.viewportHeight) * img.height * scale - y) * eased;
              if (tick >= 16 && tick < 32) {
                ctx.beginPath();
                ctx.arc(x, y, 12 + (tick - 16) * 2, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(250,80,65,${1 - (tick - 16) / 16})`;
                ctx.lineWidth = 4;
                ctx.stroke();
              }
            }
            ctx.save();
            ctx.translate(x, y);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, 25);
            ctx.lineTo(7, 19);
            ctx.lineTo(13, 31);
            ctx.lineTo(18, 28);
            ctx.lineTo(12, 17);
            ctx.lineTo(22, 16);
            ctx.closePath();
            ctx.fillStyle = "white";
            ctx.strokeStyle = "#111827";
            ctx.lineWidth = 2;
            ctx.fill();
            ctx.stroke();
            ctx.restore();
            ctx.fillStyle = "white";
            ctx.font = "24px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(caption || "", 640, 766, 1200);
            return { x, y };
          },
          { click: frame.click ?? null, caption, tick, start },
        );
        cursor = position;
        if (encoderError) throw encoderError;
        const jpeg = await page.screenshot({ type: "jpeg", quality: 85 });
        if (!encoder.stdin.write(jpeg)) await once(encoder.stdin, "drain");
      }
    }
    encoder.stdin.end();
    if ((await completed) !== 0) throw new Error("Video encoding failed.");
    await chmod(temporary, 0o600);
    // Refuse to overwrite an existing output, including a symlink.
    await link(temporary, options.output);
    await rm(temporary);
    return path.resolve(options.output);
  } finally {
    encoder.kill();
    await browser.close();
    await rm(temporary, { force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
