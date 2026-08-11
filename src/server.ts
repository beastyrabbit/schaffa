import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  anonymousActorId,
  authenticateToken,
  bearerToken,
  createToken,
  requireScope,
  seedAnonymousActor,
  seedBootstrapToken,
} from "./auth.js";
import { config } from "./config.js";
import { closeDb, db, type TokenScope } from "./db.js";
import { AppError } from "./errors.js";
import {
  filePublicUrl,
  getFile,
  getPageVersion,
  listFiles,
  listPages,
  listTokens,
  newPageSlug,
  publishFile,
  publishPage,
  purgeRetainedAnonymousPages,
} from "./service.js";
import { openStoredFile } from "./storage.js";
import { type AdminFilters, renderAdmin, renderAdminLogin, renderPublicNotFound } from "./ui.js";
import { scanAnonymousHtml } from "./virus-scanner.js";

const adminCookie = config.cookieSecure ? "__Secure-schaffa_admin" : "schaffa_admin";
const pageCsp = [
  "default-src 'none'",
  "img-src 'self' data:",
  "media-src 'self'",
  "style-src 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function buildServer() {
  if (!config.tokenPepper) {
    throw new Error("SCHAFFA_TOKEN_PEPPER is required.");
  }
  db();
  seedAnonymousActor();
  seedBootstrapToken();
  const anonymousUploads = new Map<string, number[]>();

  const app = Fastify({
    trustProxy: true,
    bodyLimit: Math.max(config.maxPageBytes, 1024 * 1024),
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    },
    genReqId: (request) => {
      const forwarded = request.headers["x-request-id"];
      return typeof forwarded === "string" && forwarded.length <= 128 ? forwarded : randomUUID();
    },
  });

  app.register(cookie);
  app.register(formbody);
  app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1 },
  });

  const cleanupTimer = setInterval(
    () =>
      void purgeRetainedAnonymousPages().catch((error: unknown) => {
        app.log.error({ err: error }, "anonymous page retention cleanup failed");
      }),
    60 * 60 * 1000,
  );
  cleanupTimer.unref();
  void purgeRetainedAnonymousPages().catch((error: unknown) => {
    app.log.error({ err: error }, "initial anonymous page retention cleanup failed");
  });

  app.addHook("onRequest", async (request) => {
    const hostname = rawRequestHostname(request.headers.host);
    if (request.url !== "/healthz" && hostname !== config.baseHost) {
      throw new AppError("Route not found.", 404, "not_found");
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (request.url.startsWith("/api") || request.url.startsWith("/admin")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/", async () => ({
    name: "Schaffa",
    status: "ok",
    baseUrl: config.baseUrl,
    api: `${config.baseUrl}/api`,
  }));
  app.get("/api", async () => ({
    name: "Schaffa API",
    authentication:
      "Bearer tokens are required except for new anonymous HTML pages, which expire after one hour.",
    endpoints: {
      createPage: "POST /api/pages (multipart field: html; random slug)",
      updatePage: "PUT /api/pages/:slug (multipart field: html)",
      uploadFile: "POST /api/files (multipart field: file)",
      listPages: "GET /api/pages (admin)",
      listFiles: "GET /api/files (admin)",
      createToken: "POST /api/tokens (admin)",
    },
  }));

  app.put<{ Params: { slug: string }; Querystring: { title?: string } }>(
    "/api/pages/:slug",
    async (request, reply) => {
      const auth = requireApiAuth(request, "upload");
      const part = await request.file({ limits: { fileSize: config.maxPageBytes, files: 1 } });
      if (part?.fieldname !== "html") {
        throw new AppError("Expected one multipart file field named html.", 422);
      }
      const html = await part.toBuffer();
      const result = await publishPage({
        slug: request.params.slug,
        ...(request.query.title === undefined ? {} : { title: request.query.title }),
        html,
        tokenId: auth.id,
      });
      return reply.code(result.version === 1 ? 201 : 200).send(result);
    },
  );

  app.post<{ Querystring: { title?: string } }>("/api/pages", async (request, reply) => {
    const auth = optionalUploadAuth(request);
    if (!auth) enforceAnonymousRateLimit(anonymousUploads, request.ip);
    const part = await request.file({ limits: { fileSize: config.maxPageBytes, files: 1 } });
    if (part?.fieldname !== "html") {
      throw new AppError("Expected one multipart file field named html.", 422);
    }
    const html = await part.toBuffer();
    if (!auth) await scanAnonymousHtml(html);
    const result = await publishPage({
      slug: newPageSlug(),
      ...(request.query.title === undefined ? {} : { title: request.query.title }),
      html,
      tokenId: auth?.id || anonymousActorId,
      anonymous: !auth,
    });
    return reply.code(201).send(result);
  });

  app.post("/api/files", async (request, reply) => {
    const auth = requireApiAuth(request, "upload");
    const part = await request.file({ limits: { fileSize: config.maxFileBytes, files: 1 } });
    if (part?.fieldname !== "file") {
      throw new AppError("Expected one multipart file field named file.", 422);
    }
    const result = await publishFile(part, auth.id);
    return reply.code(201).send(result);
  });

  app.get("/api/pages", async (request) => {
    requireApiAuth(request, "admin");
    return { pages: listPages() };
  });
  app.get("/api/files", async (request) => {
    requireApiAuth(request, "admin");
    return {
      files: listFiles().map((file) => ({
        ...file,
        publicUrl: filePublicUrl(file.filename),
      })),
    };
  });
  app.get("/api/tokens", async (request) => {
    requireApiAuth(request, "admin");
    return { tokens: listTokens().map(({ token_hash: _hash, ...token }) => token) };
  });
  app.post<{ Body: { name?: string; scopes?: string[] } }>(
    "/api/tokens",
    async (request, reply) => {
      requireApiAuth(request, "admin");
      const scopes = request.body?.scopes || ["upload"];
      if (!scopes.every((scope): scope is TokenScope => ["upload", "admin"].includes(scope))) {
        throw new AppError("Scopes may only contain upload or admin.", 422);
      }
      const created = createToken(request.body?.name || "Unnamed client", scopes);
      return reply.code(201).send({
        ...created,
        scopes,
        warning: "This token is shown once. Store it in the approved credential store now.",
      });
    },
  );
  app.delete<{ Params: { id: string } }>("/api/tokens/:id", async (request, reply) => {
    const auth = requireApiAuth(request, "admin");
    if (
      request.params.id === "bootstrap" ||
      request.params.id === anonymousActorId ||
      request.params.id === auth.id
    ) {
      throw new AppError("The bootstrap or current token cannot revoke itself.", 409, "conflict");
    }
    const result = db()
      .prepare(
        "UPDATE tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL",
      )
      .run(request.params.id);
    if (result.changes === 0) throw new AppError("Token not found.", 404, "not_found");
    return reply.code(204).send();
  });

  app.get<{ Params: { slug: string } }>("/p/:slug", async (request, reply) => {
    return sendPage(reply, request.params.slug);
  });
  app.get<{ Params: { slug: string } }>("/p/:slug/raw", async (request, reply) => {
    return sendPage(reply, request.params.slug);
  });
  app.get<{ Params: { slug: string; version: string } }>(
    "/p/:slug/:version",
    async (request, reply) => {
      return sendPage(reply, request.params.slug, Number(request.params.version));
    },
  );
  app.get<{ Params: { slug: string; version: string } }>(
    "/p/:slug/:version/raw",
    async (request, reply) => {
      return sendPage(reply, request.params.slug, Number(request.params.version));
    },
  );
  app.get<{ Params: { filename: string } }>("/f/:filename", async (request, reply) =>
    sendFile(request, reply),
  );

  app.get<{ Querystring: AdminQuery }>("/admin", async (request, reply) => {
    const auth = adminAuth(request);
    adminHeaders(reply);
    if (!auth?.scopes.has("admin")) return reply.type("text/html").send(renderAdminLogin());
    return reply.type("text/html").send(
      renderAdmin({
        pages: listPages(),
        files: listFiles(),
        tokens: listTokens(),
        actorName: auth.name,
        filters: adminFilters(request.query),
      }),
    );
  });
  app.post<{ Body: { token?: string } }>("/admin/login", async (request, reply) => {
    adminHeaders(reply);
    const auth = authenticateToken(request.body?.token);
    if (!auth?.scopes.has("admin")) {
      return reply
        .code(401)
        .type("text/html")
        .send(renderAdminLogin("Token ungültig oder ohne Admin-Scope."));
    }
    reply.setCookie(adminCookie, request.body.token || "", {
      path: "/admin",
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      maxAge: 8 * 60 * 60,
    });
    return reply.redirect("/admin");
  });
  app.post("/admin/logout", async (_request, reply) => {
    reply.clearCookie(adminCookie, { path: "/admin" });
    return reply.redirect("/admin");
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ error: "not_found", message: "Route not found." });
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "FST_REQ_FILE_TOO_LARGE"
    ) {
      return reply
        .code(413)
        .send({ error: "file_too_large", message: "Upload exceeds the configured limit." });
    }
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: "internal_error", message: "Internal server error." });
  });
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    closeDb();
  });

  return app;
}

async function sendPage(reply: FastifyReply, slug: string, version?: number) {
  const result = await getPageVersion(slug, version);
  if (!result) {
    reply.headers({
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
    });
    return reply.code(404).type("text/html; charset=utf-8").send(renderPublicNotFound());
  }
  reply.headers({
    "Content-Security-Policy": pageCsp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "X-Schaffa-Page": result.page.slug,
    "X-Schaffa-Version": String(result.version.version),
    "Cache-Control": result.page.expires_at
      ? "no-store"
      : version
        ? "public, max-age=31536000, immutable"
        : "no-cache",
  });
  return reply.type("text/html; charset=utf-8").send(result.html);
}

async function sendFile(
  request: FastifyRequest<{ Params: { filename: string } }>,
  reply: FastifyReply,
) {
  const file = getFile(request.params.filename);
  if (!file) throw new AppError("File not found.", 404, "not_found");
  const fileStat = await stat(`${config.dataDir}/${file.storage_path}`);
  const range = parseRange(request.headers.range, fileStat.size);
  const disposition = safeInlineType(file.media_type) ? "inline" : "attachment";
  reply.headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  });
  if (range) {
    reply.code(206).headers({
      "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
      "Content-Length": String(range.end - range.start + 1),
    });
  } else {
    reply.header("Content-Length", String(fileStat.size));
  }
  return reply.type(file.media_type).send(openStoredFile(file.storage_path, range));
}

function parseRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) throw new AppError("Invalid range.", 416, "invalid_range");
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= size
  ) {
    throw new AppError("Requested range is not satisfiable.", 416, "invalid_range");
  }
  return { start, end };
}

function safeInlineType(mediaType: string): boolean {
  return /^(image\/(?!svg\+xml)|audio\/|video\/|application\/pdf$|text\/plain$)/i.test(mediaType);
}

function requireApiAuth(request: FastifyRequest, scope: TokenScope) {
  const token = bearerToken(request.headers.authorization);
  return requireScope(authenticateToken(token), scope);
}

function optionalUploadAuth(request: FastifyRequest) {
  if (request.headers.authorization === undefined) return null;
  const token = bearerToken(request.headers.authorization);
  return requireScope(authenticateToken(token), "upload");
}

function enforceAnonymousRateLimit(entries: Map<string, number[]>, address: string): void {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  if (!entries.has(address) && entries.size >= 10_000) {
    for (const [key, timestamps] of entries) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length === 0) entries.delete(key);
      else entries.set(key, active);
    }
    if (entries.size >= 10_000) {
      throw new AppError(
        "Anonymous upload capacity is temporarily exhausted. Try again later.",
        429,
        "rate_limited",
      );
    }
  }
  const recent = (entries.get(address) || []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= config.anonymousUploadsPerHour) {
    throw new AppError(
      "Anonymous upload rate limit exceeded. Try again later.",
      429,
      "rate_limited",
    );
  }
  recent.push(now);
  entries.set(address, recent);
}

interface AdminQuery {
  q?: string;
  uploader?: string;
  kind?: string;
  lifetime?: string;
}

function adminFilters(query: AdminQuery): AdminFilters {
  const kinds = new Set<AdminFilters["kind"]>(["all", "pages", "files"]);
  const lifetimes = new Set<AdminFilters["lifetime"]>(["all", "permanent", "anonymous-active"]);
  const kind = kinds.has(query.kind as AdminFilters["kind"])
    ? (query.kind as AdminFilters["kind"])
    : "all";
  const lifetime = lifetimes.has(query.lifetime as AdminFilters["lifetime"])
    ? (query.lifetime as AdminFilters["lifetime"])
    : "all";
  return {
    q: (query.q || "").trim().slice(0, 100),
    uploader: (query.uploader || "").trim().slice(0, 80),
    kind,
    lifetime,
  };
}

function adminAuth(request: FastifyRequest) {
  return authenticateToken(request.cookies[adminCookie]);
}

function adminHeaders(reply: FastifyReply): void {
  reply.headers({
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  });
}

function rawRequestHostname(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
