import { debuglog } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { anonymousActorId } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { Sentry } from "./instrumentation.js";
import { shouldReportServerError } from "./telemetry-scrub.js";

export function captureBackgroundError(error: unknown): void {
  if (shouldReportServerError(error)) Sentry.captureException(error);
}

// Marp's bare output uses this marker; no user-controlled metadata is sent.
export function publishedHtmlKind(html: string | Buffer): "page" | "presentation" {
  return html.includes("data-marpit-svg") ? "presentation" : "page";
}

// A bounded category, never an identifier: admin-issued tokens have no account.
export function publisherOwner(tokenId: string): "anonymous" | "operator" | "user" {
  if (tokenId === anonymousActorId) return "anonymous";
  const token = db().prepare("SELECT user_id FROM tokens WHERE id = ?").get(tokenId) as
    | { user_id: string | null }
    | undefined;
  return token?.user_id ? "user" : "operator";
}

export function publishedFileFormat(mediaType: string): string {
  const [type = "", subtype = ""] = mediaType.toLowerCase().replace(/;.*/, "").trim().split("/");
  if (["image", "video", "audio"].includes(type)) return type;
  if (subtype === "pdf") return "pdf";
  if (type === "text" || subtype === "json") return "text";
  if (/zip|tar|7z|bzip|xz|rar/.test(subtype)) return "archive";
  return "other";
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

function recordContentView(request: FastifyRequest, pathname: string, contentKind: string) {
  const match = /^\/([pfg])\/([^/]+)(?:\/(?:\d+(?:\/(?:raw|run))?|raw|run))?$/.exec(pathname);
  if (!match) return;
  if (match[1] === "g" && /\.(?:json|md)$/.test(match[2] || "")) return;
  let kind = contentKind;
  if (match[1] === "g") kind = "guide";
  else if (match[1] === "f") kind = "file";
  serverTelemetry.send("content-view", pathname, { kind }, request.headers["user-agent"]);
}

function deletedContentKind(route: string): string {
  if (route.includes("guides")) return "guide";
  if (route.includes("files")) return "file";
  return "page";
}

function recordApiAction(request: FastifyRequest) {
  const route = request.routeOptions.url || "";
  if (route === "/auth/shoo") serverTelemetry.send("login-success", "/auth/shoo");
  if (/\/(?:account|admin)\/tokens(?:\/:id\/revoke)?$/.test(route))
    serverTelemetry.send(route.endsWith("revoke") ? "token-revoked" : "token-created", "/account");
  const deleted =
    (request.method === "DELETE" && /^\/api\/(pages|files|guides)\/:\w+$/.test(route)) ||
    /\/(pages|files|guides)\/:\w+(?:\/versions\/:version)?\/delete$/.test(route);
  if (deleted) serverTelemetry.send("content-deleted", "/api", { kind: deletedContentKind(route) });
  if (route === "/api/guides/:slug/finish" && config.telemetry.umamiUrl) {
    const { slug } = request.params as { slug: string };
    const guide = db().prepare("SELECT owner_token_id FROM guides WHERE slug = ?").get(slug) as
      | { owner_token_id: string }
      | undefined;
    serverTelemetry.send("content-published", "/api/guides", {
      kind: "guide",
      anonymous: false,
      interactive: false,
      owner: guide ? publisherOwner(guide.owner_token_id) : "operator",
    });
  }
}

export function recordResponseTelemetry(
  request: FastifyRequest,
  reply: FastifyReply,
  contentKind = "page",
  interstitial = false,
) {
  if (request.method === "GET" && reply.statusCode === 200 && !interstitial)
    recordContentView(request, request.url.split("?", 1)[0] || "/", contentKind);
  if (reply.statusCode < 400 && ["POST", "PUT", "DELETE"].includes(request.method))
    recordApiAction(request);
}

function rejectionEvent(code: string): string {
  if (/malware|scan_rejected/.test(code)) return "scan-rejected";
  if (code.includes("scanner")) return "scan-failed";
  return "upload-rejected";
}

export function recordErrorTelemetry(error: unknown, route: string | undefined) {
  let code = "internal_error";
  if (error && typeof error === "object" && "code" in error) code = String(error.code);
  if (route === "/auth/shoo") serverTelemetry.send("login-failure", "/auth/shoo", { reason: code });
  if (code === "signups_disabled")
    serverTelemetry.send("signup-failure", "/auth/shoo", { reason: code });
  if (
    /^\/api\/(?:pages|files|guides|presentations)(?:\/|$)/.test(route || "") &&
    /rate_limit|locked|too_large|limit_exceeded|storage_quota|malware|scan_rejected|scanner_unavailable/i.test(
      code,
    )
  )
    serverTelemetry.send(rejectionEvent(code), "/api", { reason: code });
}
