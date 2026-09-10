import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { compactVerify, decodeProtectedHeader, importSPKI } from "jose";
import { AppError } from "./errors.js";

export interface ScannedBytes {
  sha256: string;
  size: number;
}

interface ClamGateOptions {
  baseUrl: string;
  publicKey: string;
  keyId: string;
  applicationToken?: string;
  timeoutMs: number;
  submissionIntervalMs?: number;
  retryDelayMs?: number;
}

const maximumBytes = 2_147_483_645;
const outcomes = ["clean", "infected", "rejected", "failed", "cancelled"];

function unavailable(): AppError {
  // Never expose response bodies, job keys, bearer tokens or fetch causes.
  return new AppError(
    "Virus scanning is temporarily unavailable. Please retry later.",
    503,
    "scanner_unavailable",
  );
}

export class ClamGateScanner {
  private readonly base: URL;
  private readonly key: ReturnType<typeof importSPKI>;
  private nextSubmission = 0;
  private retryAfter = 0;
  private readonly shutdown = new AbortController();

  constructor(private readonly options: ClamGateOptions) {
    this.base = new URL(options.baseUrl);
    if (
      this.base.protocol !== "https:" ||
      this.base.username ||
      this.base.password ||
      this.base.pathname !== "/" ||
      this.base.search ||
      this.base.hash
    ) {
      throw new Error(
        "CLAMGATE_BASE_URL must be an HTTPS origin without credentials, path or query.",
      );
    }
    if (!options.keyId || !options.publicKey)
      throw new Error("ClamGate requires a trusted signing key and key ID.");
    this.key = importSPKI(options.publicKey, "EdDSA");
    // Startup validates the PEM separately; retain a handled promise for lazy WebCrypto import.
    void this.key.catch(() => undefined);
  }

  private async call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, this.base), { ...init, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
    return value as Record<string, unknown>;
  }

  close(): void {
    this.shutdown.abort();
  }

  private async reserveSubmission(signal: AbortSignal): Promise<void> {
    while (true) {
      signal.throwIfAborted();
      if (Date.now() < this.retryAfter) throw unavailable();
      const wait = this.nextSubmission - Date.now();
      if (wait > 0) {
        await delay(wait, undefined, { signal });
        continue;
      }
      this.nextSubmission = Date.now() + (this.options.submissionIntervalMs ?? 6_500);
      return;
    }
  }

  async scan(
    input: AsyncIterable<Uint8Array>,
    timeoutMs = this.options.timeoutMs,
  ): Promise<ScannedBytes> {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), this.shutdown.signal]);
    let job: { id: string; accessKey: string } | undefined;
    let attempted = false;
    try {
      await this.reserveSubmission(signal);
      attempted = true;
      const nonce = randomBytes(24).toString("base64url");
      const hash = createHash("sha256");
      let size = 0;
      let complete = false;
      async function* body() {
        for await (const chunk of input) {
          size += chunk.length;
          if (size > maximumBytes)
            throw new AppError("Upload exceeds the ClamGate size limit.", 422, "scan_rejected");
          hash.update(chunk);
          yield chunk;
        }
        complete = true;
      }
      const accepted = await this.call("/api/v1/scans", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Scan-Nonce": nonce,
          "X-Client-Name": "Schaffa",
          ...(this.options.applicationToken
            ? { Authorization: `Bearer ${this.options.applicationToken}` }
            : {}),
        },
        body: body() as unknown as BodyInit,
        duplex: "half",
        signal,
      } as RequestInit);
      if (
        typeof accepted.id !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(accepted.id) ||
        typeof accepted.accessKey !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(accepted.accessKey)
      )
        throw unavailable();
      job = { id: accepted.id, accessKey: accepted.accessKey };
      if (!complete) throw unavailable();
      const bytes = { sha256: hash.digest("hex"), size };
      while (true) {
        signal.throwIfAborted();
        let status: Record<string, unknown>;
        try {
          status = await this.call(`/api/v1/scans/${job.id}`, {
            headers: { Authorization: `Bearer ${job.accessKey}` },
            signal,
          });
        } catch {
          // Resume the accepted job after transport failures, never resubmit its bytes here.
          await delay(this.options.retryDelayMs ?? 60_000, undefined, { signal });
          continue;
        }
        if (status.id !== job.id) throw unavailable();
        if (["uploading", "queued", "scanning"].includes(String(status.state))) {
          await delay(1_000, undefined, { signal });
          continue;
        }
        if (!outcomes.includes(String(status.state)) || typeof status.result !== "string")
          throw unavailable();
        const outcome = await this.verify(status.result, { ...bytes, jobId: job.id, nonce });
        if (outcome !== status.state) throw unavailable();
        if (outcome === "infected" || outcome === "rejected") {
          throw new AppError(
            outcome === "infected"
              ? "Upload rejected because malware was detected."
              : "The virus scanner could not safely scan this upload.",
            422,
            outcome === "infected" ? "malware_detected" : "scan_rejected",
          );
        }
        if (outcome !== "clean") throw unavailable();
        return bytes;
      }
    } catch (error) {
      if (job) {
        await this.call(`/api/v1/scans/${job.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${job.accessKey}` },
          signal: AbortSignal.timeout(3_000),
        }).catch(() => undefined);
      }
      if (error instanceof AppError && error.statusCode === 422) throw error;
      if (attempted) this.retryAfter = Date.now() + (this.options.retryDelayMs ?? 60_000);
      throw unavailable();
    }
  }

  private async verify(
    jws: string,
    expected: ScannedBytes & { jobId: string; nonce: string },
  ): Promise<string> {
    const header = decodeProtectedHeader(jws);
    if (
      header.alg !== "EdDSA" ||
      header.typ !== "clamgate-result+jws" ||
      header.kid !== this.options.keyId
    )
      throw unavailable();
    const { payload } = await compactVerify(jws, await this.key, { algorithms: ["EdDSA"] });
    const result = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (
      result?.iss !== "urn:clamgate:virus" ||
      result.jobId !== expected.jobId ||
      result.nonce !== expected.nonce ||
      result.sha256 !== expected.sha256 ||
      result.size !== expected.size ||
      typeof result.iat !== "number" ||
      !Number.isInteger(result.iat) ||
      typeof result.exp !== "number" ||
      !Number.isInteger(result.exp) ||
      result.iat > now + 30 ||
      result.exp <= now ||
      result.exp <= result.iat ||
      result.exp - result.iat > 86_400 ||
      result.policy !== "clamgate-v1" ||
      typeof result.outcome !== "string" ||
      !outcomes.includes(result.outcome)
    )
      throw unavailable();
    if (["clean", "infected", "rejected"].includes(result.outcome)) {
      const signatureDate =
        typeof result.signatureDate === "string" ? Date.parse(result.signatureDate) : NaN;
      if (
        typeof result.engine !== "string" ||
        !result.engine ||
        typeof result.signatureVersion !== "string" ||
        !result.signatureVersion ||
        !Number.isFinite(signatureDate) ||
        result.iat * 1_000 - signatureDate > 72 * 3_600_000 ||
        signatureDate > result.iat * 1_000 + 300_000
      )
        throw unavailable();
    }
    return result.outcome;
  }
}
