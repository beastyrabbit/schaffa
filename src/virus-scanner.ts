import net from "node:net";
import { config } from "./config.js";
import { AppError } from "./errors.js";

const chunkBytes = 64 * 1024;

export async function scanAnonymousHtml(data: Buffer): Promise<void> {
  if (!config.clamavHost) {
    throw new AppError(
      "Anonymous uploads are unavailable because the virus scanner is not configured.",
      503,
      "scanner_unavailable",
    );
  }

  const response = await sendInstream(data).catch(() => {
    throw new AppError(
      "Anonymous uploads are temporarily unavailable because the virus scanner could not be reached.",
      503,
      "scanner_unavailable",
    );
  });
  if (/\bFOUND\b/.test(response)) {
    throw new AppError(
      "The anonymous upload was rejected by the virus scanner.",
      422,
      "malware_detected",
    );
  }
  if (!/\bOK\b/.test(response)) {
    throw new AppError(
      "Anonymous uploads are temporarily unavailable because the virus scanner returned an invalid response.",
      503,
      "scanner_unavailable",
    );
  }
}

function sendInstream(data: Buffer): Promise<string> {
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
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < data.length; offset += chunkBytes) {
        const chunk = data.subarray(offset, Math.min(offset + chunkBytes, data.length));
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
  });
}
