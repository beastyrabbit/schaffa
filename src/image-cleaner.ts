import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import { AppError } from "./errors.js";

const imageExtensions = new Set([
  ".avif",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

export interface CleanImage {
  data: Buffer;
  extension: "webp";
  mediaType: "image/webp";
}

export interface ImageClickMarker {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  box?: { left: number; top: number; width: number; height: number };
}

let activeCleaners = 0;
const cleanerWaiters: Array<() => void> = [];

export function isLikelyImage(filename: string, mediaType: string): boolean {
  return (
    mediaType.toLowerCase().startsWith("image/") ||
    imageExtensions.has(path.extname(filename).toLowerCase())
  );
}

export async function withImageProcessingPermit<T>(operation: () => Promise<T>): Promise<T> {
  await acquireCleaner();
  try {
    return await operation();
  } finally {
    releaseCleaner();
  }
}

export async function cleanImage(
  input: Buffer,
  clickMarker?: ImageClickMarker,
): Promise<CleanImage> {
  try {
    const sharpOptions = {
      animated: true,
      limitInputPixels: config.imageMaxInputPixels,
    } as const;
    const probe = sharp(input, sharpOptions);
    const metadata = await probe.metadata();
    if (!metadata.format) throw new Error("Unknown image format.");
    let markedInput: Buffer | null = null;
    if (clickMarker) {
      // Click guides are still screenshots. If an animated upload reaches this
      // path, use its first frame instead of flattening the frame strip and
      // placing the marker against the wrong combined dimensions.
      const resized = await sharp(input, { limitInputPixels: config.imageMaxInputPixels })
        .rotate()
        .resize({
          width: config.imageMaxEdge,
          height: config.imageMaxEdge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer({ resolveWithObject: true });
      const overlay = markerOverlay(resized.info.width, resized.info.height, clickMarker);
      markedInput = overlay
        ? await sharp(resized.data)
            .composite([{ input: overlay }])
            .png()
            .toBuffer()
        : resized.data;
    }

    const qualities = [config.imageWebpQuality, 70, 60, 50, 40].filter(
      (quality, index, values) =>
        quality <= config.imageWebpQuality && values.indexOf(quality) === index,
    );
    for (const quality of qualities) {
      const pipeline = markedInput
        ? sharp(markedInput)
        : sharp(input, sharpOptions).rotate().resize({
            width: config.imageMaxEdge,
            height: config.imageMaxEdge,
            fit: "inside",
            withoutEnlargement: true,
          });
      const data = await pipeline.webp({ quality, alphaQuality: 90, effort: 4 }).toBuffer();

      if (data.length <= config.maxPublishedImageBytes) {
        return { data, extension: "webp", mediaType: "image/webp" };
      }
    }

    throw new AppError(
      "Optimized image still exceeds the published image size limit.",
      413,
      "image_too_large",
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Image could not be decoded and cleaned.", 422, "invalid_image");
  }
}

function markerOverlay(
  width: number | undefined,
  height: number | undefined,
  marker: ImageClickMarker,
): Buffer | null {
  if (!width || !height || marker.viewportWidth <= 0 || marker.viewportHeight <= 0) return null;
  const scaleX = width / marker.viewportWidth;
  const scaleY = height / marker.viewportHeight;
  const x = clamp(marker.x * scaleX, 0, width);
  const y = clamp(marker.y * scaleY, 0, height);
  const shortestEdge = Math.min(width, height);
  const cursorHeight = Math.min(Math.max(14, shortestEdge * 0.022), 32, shortestEdge * 0.42);
  const cursorScale = cursorHeight / 21;
  const cursorWidth = 14 * cursorScale;
  const cursorStroke = Math.min(Math.max(1.4, shortestEdge * 0.0015), cursorHeight * 0.12, 2.5);
  const cursorHalo = (cursorStroke + 3) / 2;
  const boxStroke = Math.max(6, shortestEdge * 0.0055);
  let rectangle = "";
  if (marker.box && marker.box.width > 0 && marker.box.height > 0) {
    const left = clamp(marker.box.left * scaleX - 4, 0, width);
    const top = clamp(marker.box.top * scaleY - 4, 0, height);
    const boxWidth = clamp(marker.box.width * scaleX + 8, 8, width - left);
    const boxHeight = clamp(marker.box.height * scaleY + 8, 8, height - top);
    rectangle = `<rect x="${left}" y="${top}" width="${boxWidth}" height="${boxHeight}" rx="10" fill="#e11d48" fill-opacity="0.08" stroke="#fff" stroke-width="${boxStroke + 4}"/><rect x="${left}" y="${top}" width="${boxWidth}" height="${boxHeight}" rx="10" fill="none" stroke="#e11d48" stroke-width="${boxStroke}"/>`;
  }
  const fitsRight = x + cursorWidth + cursorHalo <= width;
  const fitsLeft = x - cursorWidth - cursorHalo >= 0;
  const narrowTarget = marker.box !== undefined && marker.box.width * scaleX <= cursorWidth * 1.25;
  const directionX = narrowTarget && fitsLeft ? -1 : fitsRight || !fitsLeft ? 1 : -1;
  const cursorDirectionY =
    y + cursorHeight + cursorHalo <= height || y - cursorHeight - cursorHalo < 0 ? 1 : -1;
  const cursorPoint = (offsetX: number, offsetY: number): string =>
    `${x + offsetX * cursorScale * directionX} ${y + offsetY * cursorScale * cursorDirectionY}`;
  const cursor = `M ${cursorPoint(0, 0)} L ${cursorPoint(0, 18)} L ${cursorPoint(
    4.5,
    13.7,
  )} L ${cursorPoint(8.6, 21)} L ${cursorPoint(11.5, 19.4)} L ${cursorPoint(
    7.5,
    12.2,
  )} L ${cursorPoint(14, 12.2)} Z`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rectangle}<path d="${cursor}" fill="#fff" fill-opacity="0.96" stroke="#fff" stroke-linejoin="round" stroke-width="${cursorStroke + 3}"/><path d="${cursor}" fill="#fff" fill-opacity="0.94" stroke="#dc2626" stroke-linejoin="round" stroke-width="${cursorStroke}"/></svg>`,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

async function acquireCleaner(): Promise<void> {
  if (activeCleaners < config.imageCleanConcurrency) {
    activeCleaners += 1;
    return;
  }
  await new Promise<void>((resolve) => cleanerWaiters.push(resolve));
  activeCleaners += 1;
}

function releaseCleaner(): void {
  activeCleaners -= 1;
  cleanerWaiters.shift()?.();
}
