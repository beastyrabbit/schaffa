import * as Sentry from "@sentry/node";
import { config } from "./config.js";
import { scrubTelemetry, shouldReportServerError } from "./telemetry-scrub.js";

if (config.telemetry.glitchtipDsn) {
  const origin = new URL(config.baseUrl).origin.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  Sentry.init({
    dsn: config.telemetry.glitchtipDsn,
    environment: config.telemetry.environment,
    release: config.telemetry.release,
    // SDK 11 replaced sendDefaultPii with explicit dataCollection controls.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
      databaseQueryData: false,
      queues: false,
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
    },
    includeServerName: false,
    tracePropagationTargets: [new RegExp(`^${origin}(?:/|$)`)],
    tracesSampleRate: config.telemetry.tracesSampleRate,
    traceLifecycle: "static",
    integrations: [
      Sentry.captureConsoleIntegration({ levels: ["error"] }),
      Sentry.fastifyIntegration({
        shouldHandleError: shouldReportServerError,
      }),
    ],
    beforeSend(event) {
      if (event.request) {
        const { method, url } = event.request;
        event.request = { ...(method ? { method } : {}), ...(url ? { url } : {}) };
      }
      return scrubTelemetry(event);
    },
    beforeSendTransaction: (event) => scrubTelemetry(event),
    beforeBreadcrumb: (breadcrumb) => scrubTelemetry(breadcrumb),
  });
}

export { Sentry };
