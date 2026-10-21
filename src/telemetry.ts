import { debuglog } from "node:util";
import { config } from "./config.js";

// Marp's bare output uses this marker; no user-controlled metadata is sent.
export function publishedHtmlKind(html: string | Buffer): "page" | "presentation" {
  return html.includes("data-marpit-svg") ? "presentation" : "page";
}

// Honest application attribution, with a product/version prefix accepted by isbot.
export const collectorUserAgent = "Schaffa/1.0 (aggregate publication metrics)";
export const isObviousBot = (ua = "") =>
  /bot|crawler|spider|slurp|headless|preview|curl|wget/i.test(ua);
export function createTelemetryTransport(options: {
  url: string;
  website: string;
  hostname: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxInFlight?: number;
  debug?: () => void;
}) {
  let inFlight = 0;
  const stats = { sent: 0, failed: 0, dropped: 0 };
  const send = (
    name: string,
    url: string,
    data: Record<string, string | boolean> = {},
    visitorUa?: string,
  ) => {
    if (!options.url || !options.website || isObviousBot(visitorUa)) return;
    if (inFlight >= (options.maxInFlight ?? 8)) {
      stats.dropped++;
      return;
    }
    inFlight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
    timer.unref();
    void Promise.resolve()
      .then(() =>
        (options.fetch ?? fetch)(`${options.url}/api/send`, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "content-type": "application/json", "user-agent": collectorUserAgent },
          body: JSON.stringify({
            type: "event",
            payload: {
              website: options.website,
              hostname: options.hostname,
              url: url.split(/[?#]/, 1)[0],
              name,
              data,
            },
          }),
        }),
      )
      .then(async (response) => {
        await response.body?.cancel();
        if (!response.ok) throw new Error("Telemetry rejected");
        stats.sent++;
      })
      .catch(() => {
        stats.failed++;
        options.debug?.();
      })
      .finally(() => {
        clearTimeout(timer);
        inFlight--;
      });
  };
  return { send, stats };
}

export const serverTelemetry = createTelemetryTransport({
  url: config.telemetry.umamiUrl,
  website: config.telemetry.umamiWebsiteId,
  hostname: config.baseHost,
  debug: () => debuglog("schaffa:telemetry")("collection request failed"),
});
