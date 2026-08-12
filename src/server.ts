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
  canRevokeBootstrap,
  createToken,
  requireScope,
  seedAnonymousActor,
  seedBootstrapToken,
} from "./auth.js";
import { config } from "./config.js";
import { closeDb, db, type TokenScope } from "./db.js";
import { AppError } from "./errors.js";
import { openApiDocument } from "./openapi.js";
import {
  consumeAnonymousUpload,
  consumeAuthenticatedUpload,
  consumeUserLogin,
} from "./rate-limit.js";
import {
  deleteFile,
  deletePage,
  deletePageVersion,
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
import { getInstanceSettings, updateInstanceSettings } from "./settings.js";
import { type ShooTokenVerifier, verifyShooToken } from "./shoo-auth.js";
import { openStoredFile } from "./storage.js";
import {
  type AdminFilters,
  accountClientScript,
  renderAccount,
  renderAccountLogin,
  renderAdmin,
  renderAdminLogin,
  renderLanding,
  renderPublicNotFound,
} from "./ui.js";
import {
  authenticateUserSession,
  createUserSession,
  createUserToken,
  deleteUser,
  listUsers,
  listUserTokens,
  revokeUserSession,
  revokeUserToken,
} from "./users.js";
import { scanUpload } from "./virus-scanner.js";

const adminCookie = config.cookieSecure ? "__Secure-schaffa_admin" : "schaffa_admin";
const userCookie = config.cookieSecure ? "__Secure-schaffa_user" : "schaffa_user";
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

export function buildServer(options: { verifyShooToken?: ShooTokenVerifier } = {}) {
  const shooVerifier = options.verifyShooToken || verifyShooToken;
  if (!config.tokenPepper) {
    throw new Error("SCHAFFA_TOKEN_PEPPER is required.");
  }
  db();
  seedAnonymousActor();
  const bootstrap = seedBootstrapToken();

  const app = Fastify({
    trustProxy: config.trustedProxyHops,
    bodyLimit: Math.max(config.maxPageBytes, 1024 * 1024),
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    },
    genReqId: (request) => {
      const forwarded = request.headers["x-request-id"];
      return typeof forwarded === "string" && /^[A-Za-z0-9-]{1,64}$/.test(forwarded)
        ? forwarded
        : randomUUID();
    },
  });
  if (bootstrap.active) {
    app.log.warn(
      { created: bootstrap.created },
      "bootstrap admin token is active; create a separate admin token and revoke bootstrap",
    );
  } else if (!hasActiveAdminToken()) {
    app.log.error(
      "no active admin token exists; set SCHAFFA_BOOTSTRAP_TOKEN to a new value for recovery",
    );
  }

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
    if (config.cookieSecure) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (
      request.url.startsWith("/api") ||
      request.url.startsWith("/admin") ||
      request.url.startsWith("/account") ||
      request.url.startsWith("/auth/shoo") ||
      request.url.startsWith("/shoo/callback")
    ) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/", async (_request, reply) => {
    publicSiteHeaders(reply);
    return reply.type("text/html; charset=utf-8").send(renderLanding());
  });
  app.get("/api", async () => ({
    name: "Schaffa API",
    openapi: `${config.baseUrl}/metadata/openapi.json`,
    authentication:
      "Bearer tokens are required except for new anonymous HTML pages, which expire after one hour.",
    endpoints: {
      createPage: "POST /api/pages (multipart field: html; random slug)",
      updatePage: "PUT /api/pages/:slug (multipart field: html)",
      uploadFile: "POST /api/files (multipart field: file)",
      listPages: "GET /api/pages (admin)",
      listFiles: "GET /api/files (admin)",
      deletePage: "DELETE /api/pages/:slug (admin)",
      deletePageVersion: "DELETE /api/pages/:slug/versions/:version (admin)",
      deleteFile: "DELETE /api/files/:id (admin)",
      createToken: "POST /api/tokens (admin)",
      listUsers: "GET /api/users (admin)",
      settings: "GET|PUT /api/settings (admin)",
    },
  }));
  app.get("/metadata/openapi.json", async () => openApiDocument());

  app.get("/assets/account.js", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.type("application/javascript; charset=utf-8").send(accountClientScript);
  });
  app.get<{ Querystring: { signedOut?: string } }>("/account", async (request, reply) => {
    accountHeaders(reply);
    const user = authenticateUserSession(request.cookies[userCookie]);
    if (user) {
      return reply.type("text/html").send(
        renderAccount({
          user,
          tokens: listUserTokens(user.id),
        }),
      );
    }
    return reply.type("text/html").send(renderUserLogin(request.query.signedOut === "1"));
  });
  app.get("/shoo/callback", async (_request, reply) => {
    accountHeaders(reply);
    return reply.type("text/html").send(renderUserLogin(false));
  });
  app.post<{ Body: { idToken?: string } }>("/auth/shoo", async (request, reply) => {
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      throw new AppError("Shoo login requires a JSON request.", 415, "unsupported_media_type");
    }
    consumeUserLogin(request.ip);
    if (!getInstanceSettings().loginsEnabled) {
      throw new AppError("User logins are disabled on this instance.", 403, "logins_disabled");
    }
    const idToken = request.body?.idToken;
    if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 20_000) {
      throw new AppError("A valid Shoo ID token is required.", 401, "unauthorized");
    }
    const identity = await shooVerifier(idToken).catch(() => {
      throw new AppError("Shoo token verification failed.", 401, "unauthorized");
    });
    const session = createUserSession(identity);
    reply.setCookie(userCookie, session.token, {
      path: "/account",
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      maxAge: config.userSessionTtlHours * 60 * 60,
    });
    return { user: session.user };
  });
  app.post("/account/logout", async (request, reply) => {
    revokeUserSession(request.cookies[userCookie]);
    reply.clearCookie(userCookie, { path: "/account" });
    return reply.redirect("/account?signedOut=1");
  });
  app.post<{ Body: { name?: string } }>("/account/tokens", async (request, reply) => {
    accountHeaders(reply);
    const user = requireUserSession(request);
    const created = createUserToken(user.id, request.body?.name || "Unnamed agent");
    return reply.type("text/html").send(
      renderAccount({
        user,
        tokens: listUserTokens(user.id),
        newToken: created.token,
      }),
    );
  });
  app.post<{ Params: { id: string } }>("/account/tokens/:id/revoke", async (request, reply) => {
    const user = requireUserSession(request);
    revokeUserToken(user.id, request.params.id);
    return reply.redirect("/account");
  });

  app.put<{ Params: { slug: string }; Querystring: { title?: string } }>(
    "/api/pages/:slug",
    async (request, reply) => {
      const auth = requireApiAuth(request, "upload");
      requireWritesEnabled();
      consumeAuthenticatedUpload(auth.id);
      const part = await request.file({ limits: { fileSize: config.maxPageBytes, files: 1 } });
      if (part?.fieldname !== "html") {
        throw new AppError("Expected one multipart file field named html.", 422);
      }
      const html = await part.toBuffer();
      await scanUpload(html);
      const result = await publishPage({
        slug: request.params.slug,
        ...(request.query.title === undefined ? {} : { title: request.query.title }),
        html,
        tokenId: auth.id,
        isAdmin: auth.scopes.has("admin"),
      });
      return reply.code(result.version === 1 ? 201 : 200).send(result);
    },
  );

  app.post<{ Querystring: { title?: string } }>("/api/pages", async (request, reply) => {
    const auth = optionalUploadAuth(request);
    requireWritesEnabled();
    if (auth) consumeAuthenticatedUpload(auth.id);
    else consumeAnonymousUpload(request.ip);
    const part = await request.file({ limits: { fileSize: config.maxPageBytes, files: 1 } });
    if (part?.fieldname !== "html") {
      throw new AppError("Expected one multipart file field named html.", 422);
    }
    const html = await part.toBuffer();
    await scanUpload(html);
    const result = await publishPage({
      slug: newPageSlug(),
      ...(request.query.title === undefined ? {} : { title: request.query.title }),
      html,
      tokenId: auth?.id || anonymousActorId,
      anonymous: !auth,
      isAdmin: auth?.scopes.has("admin") || false,
    });
    return reply.code(201).send(result);
  });

  app.post("/api/files", async (request, reply) => {
    const auth = requireApiAuth(request, "upload");
    requireWritesEnabled();
    consumeAuthenticatedUpload(auth.id);
    const part = await request.file({ limits: { fileSize: config.maxFileBytes, files: 1 } });
    if (part?.fieldname !== "file") {
      throw new AppError("Expected one multipart file field named file.", 422);
    }
    const contentLength = Number(request.headers["content-length"]);
    const result = await publishFile(
      part,
      auth.id,
      Number.isSafeInteger(contentLength) ? contentLength : undefined,
    );
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
  app.get("/api/users", async (request) => {
    requireApiAuth(request, "admin");
    return { users: listUsers() };
  });
  app.get("/api/settings", async (request) => {
    requireApiAuth(request, "admin");
    return getInstanceSettings();
  });
  app.put<{
    Body: { writesLocked?: boolean; signupsEnabled?: boolean; loginsEnabled?: boolean };
  }>("/api/settings", async (request) => {
    requireApiAuth(request, "admin");
    const body = request.body || {};
    const entries = Object.entries(body);
    if (
      entries.length === 0 ||
      entries.some(
        ([key, value]) =>
          !["writesLocked", "signupsEnabled", "loginsEnabled"].includes(key) ||
          typeof value !== "boolean",
      )
    ) {
      throw new AppError("Settings must contain supported boolean values.", 422);
    }
    return updateInstanceSettings(body);
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
    revokeToken(request.params.id, auth.id);
    return reply.code(204).send();
  });
  app.delete<{ Params: { slug: string } }>("/api/pages/:slug", async (request, reply) => {
    requireApiAuth(request, "admin");
    await deletePage(request.params.slug);
    return reply.code(204).send();
  });
  app.delete<{ Params: { slug: string; version: string } }>(
    "/api/pages/:slug/versions/:version",
    async (request, reply) => {
      requireApiAuth(request, "admin");
      await deletePageVersion(request.params.slug, Number(request.params.version));
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: { id: string } }>("/api/files/:id", async (request, reply) => {
    requireApiAuth(request, "admin");
    await deleteFile(request.params.id);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    requireApiAuth(request, "admin");
    deleteUser(request.params.id);
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
        users: listUsers(),
        settings: getInstanceSettings(),
        actorId: auth.id,
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
  app.post<{
    Body: { writesLocked?: string; signupsEnabled?: string; loginsEnabled?: string };
  }>("/admin/settings", async (request, reply) => {
    requireAdminCookie(request);
    const keys = ["writesLocked", "signupsEnabled", "loginsEnabled"] as const;
    const selected = keys.find((key) => request.body?.[key] !== undefined);
    if (!selected || !["true", "false"].includes(request.body[selected] || "")) {
      throw new AppError("Invalid setting.", 422);
    }
    updateInstanceSettings({ [selected]: request.body[selected] === "true" });
    return reply.redirect("/admin#operations");
  });
  app.post<{ Params: { slug: string } }>("/admin/pages/:slug/delete", async (request, reply) => {
    requireAdminCookie(request);
    await deletePage(request.params.slug);
    return reply.redirect("/admin#pages");
  });
  app.post<{ Params: { id: string } }>("/admin/files/:id/delete", async (request, reply) => {
    requireAdminCookie(request);
    await deleteFile(request.params.id);
    return reply.redirect("/admin#files");
  });
  app.post<{ Params: { id: string } }>("/admin/tokens/:id/revoke", async (request, reply) => {
    const auth = requireAdminCookie(request);
    revokeToken(request.params.id, auth.id);
    if (request.params.id === auth.id) {
      reply.clearCookie(adminCookie, { path: "/admin" });
    }
    return reply.redirect("/admin#tokens");
  });
  app.post<{ Params: { id: string } }>("/admin/users/:id/delete", async (request, reply) => {
    requireAdminCookie(request);
    deleteUser(request.params.id);
    return reply.redirect("/admin#users");
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
        ? "public, max-age=300"
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
    "Cache-Control": "public, max-age=300",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
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
  return /^(image\/(?!svg\+xml)|audio\/|video\/|text\/plain$)/i.test(mediaType);
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

function requireWritesEnabled(): void {
  if (getInstanceSettings().writesLocked) {
    throw new AppError(
      "This Schaffa instance is temporarily locked for publishing.",
      503,
      "writes_locked",
    );
  }
}

function revokeToken(id: string, currentTokenId: string): void {
  if (id === anonymousActorId) {
    throw new AppError("The anonymous system actor cannot be revoked.", 409, "conflict");
  }
  if (id === currentTokenId && id !== "bootstrap") {
    throw new AppError("The current token cannot revoke itself.", 409, "conflict");
  }
  if (id === "bootstrap" && !canRevokeBootstrap()) {
    throw new AppError(
      "Create another active admin token before revoking bootstrap.",
      409,
      "conflict",
    );
  }
  const result = db()
    .prepare("UPDATE tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL")
    .run(id);
  if (result.changes === 0) throw new AppError("Token not found.", 404, "not_found");
}

function hasActiveAdminToken(): boolean {
  return Boolean(
    db()
      .prepare(
        `SELECT 1 FROM tokens
         WHERE revoked_at IS NULL AND (',' || scopes || ',') LIKE '%,admin,%'
         LIMIT 1`,
      )
      .get(),
  );
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

function requireAdminCookie(request: FastifyRequest) {
  return requireScope(adminAuth(request), "admin");
}

function adminHeaders(reply: FastifyReply): void {
  reply.headers({
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  });
}

function accountHeaders(reply: FastifyReply): void {
  const shooOrigin = new URL(config.shooBaseUrl).origin;
  reply.headers({
    "Content-Security-Policy": `default-src 'none'; script-src 'self' ${shooOrigin}; connect-src 'self' ${shooOrigin}; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "X-Frame-Options": "DENY",
  });
}

function publicSiteHeaders(reply: FastifyReply): void {
  reply.headers({
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  });
}

function renderUserLogin(signedOut: boolean): string {
  return renderAccountLogin({
    loginsEnabled: getInstanceSettings().loginsEnabled,
    shooScriptUrl: new URL("/shoo.js", config.shooBaseUrl).toString(),
    signedOut,
  });
}

function requireUserSession(request: FastifyRequest) {
  const user = authenticateUserSession(request.cookies[userCookie]);
  if (!user) throw new AppError("A valid user session is required.", 401, "unauthorized");
  return user;
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
