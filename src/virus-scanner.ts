import { Readable } from "node:stream";
import { ClamGateScanner, type ScannedBytes } from "./clamgate.js";
import { config } from "./config.js";
import { openStoredFile } from "./storage.js";

let synchronousScanDemands = 0;
let remoteScanner: ClamGateScanner | undefined;
let remoteOptions: typeof config.clamgate;

export function cancelPendingVirusScans(): void {
  remoteScanner?.close();
}

function clamgate(): ClamGateScanner {
  if (!remoteScanner || remoteOptions !== config.clamgate) {
    remoteOptions = config.clamgate;
    remoteScanner = new ClamGateScanner(remoteOptions);
  }
  return remoteScanner;
}

export async function scanUpload(
  data: Buffer,
  { background = false }: { background?: boolean } = {},
): Promise<void> {
  if (!background) synchronousScanDemands += 1;
  try {
    await clamgate().scan(
      Readable.from([data]),
      background
        ? config.clamgate.timeoutMs
        : Math.min(config.guideScanTimeoutMs, config.clamgate.timeoutMs),
    );
  } finally {
    if (!background) synchronousScanDemands -= 1;
  }
}

export function synchronousScanDemandCount(): number {
  return synchronousScanDemands;
}

export async function scanStoredUpload(storagePath: string): Promise<ScannedBytes> {
  const input = openStoredFile(storagePath);
  try {
    return await clamgate().scan(input);
  } finally {
    input.destroy();
  }
}
