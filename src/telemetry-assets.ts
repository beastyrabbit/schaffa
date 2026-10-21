import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const consentDirectory = path.dirname(require.resolve("vanilla-cookieconsent"));
const files = {
  consentJs: [path.join(consentDirectory, "cookieconsent.umd.js"), "application/javascript"],
  consentCss: [path.join(consentDirectory, "cookieconsent.css"), "text/css"],
  sentry: [new URL("../public/vendor/sentry.js", import.meta.url), "application/javascript"],
  client: [new URL("../public/scripts/telemetry.js", import.meta.url), "application/javascript"],
} as const;

export const telemetryAssets = Object.fromEntries(
  Object.entries(files).map(([key, [file, type]]) => {
    const body = readFileSync(file);
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
    return [
      key,
      {
        url: `/assets/telemetry-${key}-${hash}.${key === "consentCss" ? "css" : "js"}`,
        type,
        body,
      },
    ];
  }),
) as Record<keyof typeof files, { url: string; type: string; body: Buffer }>;

export function telemetryHead(): string {
  if (!configEnabled()) return "";
  const client = {
    ...config.telemetry,
    baseHost: config.baseHost,
    consentJs: telemetryAssets.consentJs.url,
    sentryJs: telemetryAssets.sentry.url,
  };
  // Meta content avoids executable inline configuration and remains CSP compatible.
  const encoded = JSON.stringify(client)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  return `<meta name="schaffa-telemetry" content="${encoded}"><style>#cc-main{--cc-font-family:ui-sans-serif,system-ui,sans-serif;--cc-bg:#fbfaf6;--cc-primary-color:#20211e;--cc-secondary-color:#484942;--cc-btn-primary-bg:#a43f24;--cc-btn-primary-border-color:#a43f24;--cc-btn-primary-hover-bg:#82321d;--cc-btn-primary-hover-border-color:#82321d;--cc-btn-secondary-bg:#f3f0e8;--cc-btn-secondary-color:#20211e;--cc-btn-secondary-border-color:#20211e;--cc-cookie-category-block-bg:#f3f0e8;--cc-modal-border-radius:0;--cc-btn-border-radius:0}</style><link rel="stylesheet" href="${telemetryAssets.consentCss.url}"><script src="${telemetryAssets.client.url}"></script>`;
}

import { config } from "./config.js";

const configEnabled = () => Boolean(config.telemetry.umamiUrl || config.telemetry.glitchtipDsn);
