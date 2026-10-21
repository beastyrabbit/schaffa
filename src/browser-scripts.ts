import { readFileSync } from "node:fs";

declare global {
  interface Navigator {
    userAgentData?: { platform?: string };
  }
  interface Window {
    CookieConsent: typeof import("vanilla-cookieconsent");
    Sentry?: typeof import("@sentry/browser");
    umami?: { track(name: string, data?: Record<string, string | boolean>): void };
    schaffaTelemetry?: {
      track(name: string, data?: Record<string, string | boolean>): void;
      report(cause: unknown): void;
      scrub(value: unknown): unknown;
    };
    schaffaUmamiBeforeSend?: (
      type: string,
      payload: Record<string, unknown>,
    ) => Record<string, unknown> | null;
    Shoo?: {
      clearIdentity(): void;
      getIdentity(): { token?: string } | null;
      startSignIn(options: { returnTo: string; requestPii: boolean }): void;
    };
  }
}

export const tokenSetupClientScript = readFileSync(
  new URL("../public/scripts/token-setup.js", import.meta.url),
  "utf8",
);
export const adminFiltersClientScript = readFileSync(
  new URL("../public/scripts/admin-filters.js", import.meta.url),
  "utf8",
);
export const accountClientScript = readFileSync(
  new URL("../public/scripts/account.js", import.meta.url),
  "utf8",
);
