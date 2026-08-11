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

export async function cleanImage(input: Buffer): Promise<CleanImage> {
  try {
    const sharpOptions = {
      animated: true,
      limitInputPixels: config.imageMaxInputPixels,
    } as const;
    const probe = sharp(input, sharpOptions);
    const metadata = await probe.metadata();
    if (!metadata.format) throw new Error("Unknown image format.");

    const qualities = [config.imageWebpQuality, 70, 60, 50, 40].filter(
      (quality, index, values) =>
        quality <= config.imageWebpQuality && values.indexOf(quality) === index,
    );
    for (const quality of qualities) {
      const data = await sharp(input, sharpOptions)
        .rotate()
        .resize({
          width: config.imageMaxEdge,
          height: config.imageMaxEdge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality, alphaQuality: 90, effort: 4 })
        .toBuffer();

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
