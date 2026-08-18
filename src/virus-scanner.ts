import net from "node:net";
import type { Readable } from "node:stream";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { openStoredFile } from "./storage.js";

const chunkBytes = 64 * 1024;
let synchronousScanDemands = 0;

export async function scanUpload(data: Buffer): Promise<void> {
  if (!config.clamavHost) {
    throw new AppError(
      "Uploads are unavailable because the virus scanner is not configured.",
      503,
      "scanner_unavailable",
    );
  }
  synchronousScanDemands += 1;
  const deadline = Date.now() + config.clamavWakeTimeoutMs;
  try {
    while (true) {
      try {
        await scan(data);
        return;
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          error.code !== "scanner_unavailable" ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  } finally {
    synchronousScanDemands -= 1;
  }
}

export function synchronousScanDemandCount(): number {
  return synchronousScanDemands;
}

export async function scanStoredUpload(storagePath: string): Promise<void> {
  const input = openStoredFile(storagePath);
  try {
    await scan(input);
  } finally {
    input.destroy();
  }
}

async function scan(data: Buffer | Readable): Promise<void> {
  if (!config.clamavHost) {
    throw new AppError(
      "Uploads are unavailable because the virus scanner is not configured.",
      503,
      "scanner_unavailable",
    );
  }

  const response = await sendInstream(data).catch(() => {
    throw new AppError(
      "Uploads are temporarily unavailable because the virus scanner could not be reached.",
      503,
      "scanner_unavailable",
    );
  });
  if (/\bFOUND\b/.test(response)) {
    const signature = malwareSignature(response);
    throw new AppError(
      signature ? `Rejected by the virus scanner: ${signature}.` : "Rejected by the virus scanner.",
      422,
      "malware_detected",
    );
  }
  if (/\bERROR\b/.test(response)) {
    throw new AppError(
      "Rejected because the virus scanner could not safely scan this upload.",
      422,
      "scan_rejected",
    );
  }
  if (!/\bOK\b/.test(response)) {
    throw new AppError(
      "Uploads are temporarily unavailable because the virus scanner returned an invalid response.",
      503,
      "scanner_unavailable",
    );
  }
}

function malwareSignature(response: string): string | null {
  const match = /:\s*([A-Za-z0-9._-]{1,120})\s+FOUND\b/.exec(response);
  return match?.[1] || null;
}

function sendInstream(data: Buffer | Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.clamavHost, port: config.clamavPort });
    const response: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(response).toString("utf8").replace(/\0/g, "").trim());
    };

    socket.setTimeout(config.clamavTimeoutMs);
    socket.on("timeout", () => finish(new Error("Virus scanner timed out.")));
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => response.push(chunk));
    socket.on("end", () => finish());
    socket.on("connect", () => {
      void writeInstream(socket, data).catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error("Virus scanner stream failed.")),
      );
    });
  });
}

async function writeInstream(socket: net.Socket, data: Buffer | Readable): Promise<void> {
  await writeChunk(socket, Buffer.from("zINSTREAM\0"));
  const source: AsyncIterable<Buffer> = Buffer.isBuffer(data)
    ? (async function* () {
        yield data;
      })()
    : data;
  for await (const inputChunk of source) {
    const buffer = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk);
    for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
      const chunk = buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length));
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(chunk.length);
      await writeChunk(socket, length);
      await writeChunk(socket, chunk);
    }
  }
  socket.end(Buffer.alloc(4));
}

async function writeChunk(socket: net.Socket, chunk: Buffer): Promise<void> {
  if (socket.destroyed) throw new Error("Virus scanner connection closed.");
  if (socket.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Virus scanner connection closed."));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("drain", onDrain);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}
