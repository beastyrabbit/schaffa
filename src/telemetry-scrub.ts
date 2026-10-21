import { AppError } from "./errors.js";

export { scrubTelemetry, scrubText } from "./telemetry-scrub-core.js";

export function shouldReportServerError(error: unknown): boolean {
  if (error && typeof error === "object" && "statusCode" in error && Number(error.statusCode) < 500)
    return false;
  return !(
    error instanceof AppError &&
    ["interactive_disabled", "storage_quota", "scanner_unavailable", "writes_locked"].includes(
      error.code,
    )
  );
}
