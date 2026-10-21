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
