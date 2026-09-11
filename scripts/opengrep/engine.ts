import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { ENGINE_SHA256, ENGINE_VERSION } from "./model.ts";

export function verifiedEngine(path: string): boolean {
  return (
    existsSync(path) &&
    createHash("sha256").update(readFileSync(path)).digest("hex") === ENGINE_SHA256
  );
}

export async function prepareEngine(path: string): Promise<void> {
  if (verifiedEngine(path)) {
    chmodSync(path, 0o700);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(
        `https://github.com/opengrep/opengrep/releases/download/v${ENGINE_VERSION}/opengrep_manylinux_x86`,
        { signal: AbortSignal.timeout(120000) },
      );
      if (!response.ok) throw new Error("Engine download failed");
      const data = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(data).digest("hex") !== ENGINE_SHA256)
        throw new Error("Engine checksum mismatch");
      const temporary = `${path}.${randomUUID()}.download`;
      writeFileSync(temporary, data, { mode: 0o700, flag: "wx" });
      renameSync(temporary, path);
      chmodSync(path, 0o700);
      return;
    } catch {
      if (attempt === 2) throw new Error("Verified engine unavailable after three attempts");
      await setTimeout(1000 * 2 ** attempt);
    }
  }
}
