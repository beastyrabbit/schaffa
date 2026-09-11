import { canonicalOrigin } from "./client.js";
import { resolveTokenWithSource, type TokenContext, type TokenOptions } from "./token.js";

const reasons = {
  writes_locked: "Publishing is temporarily locked on this instance.",
  token_required: "Set SCHAFFA_TOKEN or save a token in a Schaffa config file.",
  upload_scope_required: "Use an Upload token for static HTML, files, and guides.",
  interactive_scope_required: "Use an Interactive token from your account page.",
  interactive_disabled: "Ask the instance administrator to enable interactive publishing.",
  interactive_not_allowed:
    "Ask the instance administrator to approve interactive publishing for your account.",
};

type Reason = keyof typeof reasons;
interface Capability {
  allowed: boolean;
  reason: Reason | null;
}
interface Capabilities {
  staticHtml: Capability;
  interactiveHtml: Capability;
  fileUploads: Capability;
  guides: Capability;
}
interface CapabilityResponse {
  version: 1;
  authenticated: boolean;
  capabilities: Capabilities;
}

export interface DoctorReport {
  ready: boolean;
  server: string | null;
  token: {
    found: boolean;
    source: string | null;
    status: "missing" | "valid" | "invalid" | "unverified" | "lookup_failed";
  };
  capabilities: Capabilities | null;
  error: string | null;
  message: string | null;
}

export async function doctor(
  options: TokenOptions & { baseUrl?: string; interactive?: boolean; fetch?: typeof fetch } = {},
  context: TokenContext = {},
): Promise<DoctorReport> {
  const report: DoctorReport = {
    ready: false,
    server: null,
    token: { found: false, source: null, status: "missing" },
    capabilities: null,
    error: null,
    message: null,
  };
  const fail = (error: string, message: string): DoctorReport => ({ ...report, error, message });
  try {
    report.server = canonicalOrigin(options.baseUrl || "https://schaffa.dev");
  } catch {
    return fail(
      "invalid_server",
      "SCHAFFA_URL must be an HTTP or HTTPS origin without a path or credentials.",
    );
  }
  let selected: ReturnType<typeof resolveTokenWithSource>;
  try {
    selected = resolveTokenWithSource(options, context);
  } catch {
    report.token.status = "lookup_failed";
    return fail(
      "token_lookup_failed",
      "Cannot read the token. Check token files, JSON syntax, token characters, and conflicting --token/--ignore-token options.",
    );
  }
  if (selected) {
    report.token = { found: true, source: selected.source, status: "unverified" };
    if (!/^sfa_[A-Za-z0-9_-]{43,}$/.test(selected.token)) {
      report.token.status = "invalid";
      return fail(
        "invalid_token",
        "The token format is invalid. Copy a complete token from your account page.",
      );
    }
  }
  try {
    const response = await (options.fetch || fetch)(new URL("/api/capabilities", report.server), {
      method: "GET",
      ...(selected ? { headers: { Authorization: `Bearer ${selected.token}` } } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 && selected) {
      report.token.status = "invalid";
      return fail(
        "invalid_token",
        "The server rejected this token. It may be revoked or belong to another instance.",
      );
    }
    if (response.status === 404) {
      return fail(
        "unsupported_server",
        "This server does not support doctor checks. Update the Schaffa server to a version with /api/capabilities.",
      );
    }
    if (!response.ok) {
      return fail("server_error", `The capability check returned HTTP ${response.status}.`);
    }
    const data: unknown = await response.json();
    if (!isCapabilityResponse(data) || data.authenticated !== Boolean(selected)) {
      return fail(
        "invalid_response",
        "The server returned an unsupported capability response. Permissions could not be verified.",
      );
    }
    if (selected) report.token.status = "valid";
    // Copy only known fields. Never print arbitrary server response content.
    const copy = ({ allowed, reason }: Capability): Capability => ({ allowed, reason });
    report.capabilities = {
      staticHtml: copy(data.capabilities.staticHtml),
      interactiveHtml: copy(data.capabilities.interactiveHtml),
      fileUploads: copy(data.capabilities.fileUploads),
      guides: copy(data.capabilities.guides),
    };
    report.ready =
      Boolean(selected) &&
      (options.interactive
        ? report.capabilities.interactiveHtml.allowed
        : report.capabilities.staticHtml.allowed || report.capabilities.interactiveHtml.allowed);
    return report;
  } catch {
    return fail(
      "check_failed",
      "Could not complete the server check. Check SCHAFFA_URL and connectivity; redirects are refused and requests time out after 10 seconds.",
    );
  }
}

function isCapabilityResponse(value: unknown): value is CapabilityResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<CapabilityResponse>;
  if (data.version !== 1 || typeof data.authenticated !== "boolean" || !data.capabilities)
    return false;
  return ["staticHtml", "interactiveHtml", "fileUploads", "guides"].every((name) => {
    const capability = data.capabilities?.[name as keyof Capabilities];
    return (
      capability &&
      typeof capability.allowed === "boolean" &&
      (capability.allowed
        ? capability.reason === null
        : typeof capability.reason === "string" && Object.hasOwn(reasons, capability.reason))
    );
  });
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Server: ${report.server ?? "invalid SCHAFFA_URL"}`,
    `Token: ${report.token.status}${report.token.source ? ` (found in ${report.token.source})` : ""}`,
  ];
  const labels = {
    staticHtml: "Static HTML",
    interactiveHtml: "Interactive HTML",
    fileUploads: "File uploads",
    guides: "Guides",
  };
  for (const [name, label] of Object.entries(labels)) {
    const capability = report.capabilities?.[name as keyof Capabilities];
    lines.push(
      `${label}: ${capability ? (capability.allowed ? "allowed" : "not allowed") : "unknown"}${capability?.reason ? `. ${reasons[capability.reason]}` : ""}`,
    );
  }
  if (report.token.status === "missing")
    lines.push(
      "No token selected. Anonymous static HTML expires after one hour. Set SCHAFFA_TOKEN or save a token in a Schaffa config file.",
    );
  if (report.message) lines.push(report.message);
  return `${lines.join("\n")}\n`;
}
