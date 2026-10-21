import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("public/vendor", { recursive: true });
await build({
  stdin: {
    contents:
      'export { init, captureException, captureMessage, browserTracingIntegration, breadcrumbsIntegration, globalHandlersIntegration, eventFiltersIntegration, dedupeIntegration, linkedErrorsIntegration } from "@sentry/browser";',
    resolveDir: process.cwd(),
  },
  outfile: "public/vendor/sentry.js",
  bundle: true,
  format: "iife",
  globalName: "Sentry",
  minify: true,
  sourcemap: false,
  define: { __SENTRY_DEBUG__: "false" },
});

await build({
  entryPoints: ["src/telemetry-scrub-core.ts"],
  outfile: "public/vendor/telemetry-scrub.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "SchaffaScrub",
  minify: true,
  sourcemap: false,
});
