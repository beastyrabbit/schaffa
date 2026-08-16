import { randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import type { MultipartFile } from "@fastify/multipart";
import multipart from "@fastify/multipart";
import scalarApiReference from "@scalar/fastify-api-reference";
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
import type { PageKind, TokenScope } from "./db.js";
import { closeDb, db } from "./db.js";
import { AppError } from "./errors.js";
import {
  addGuideStep,
  createGuide,
  deleteGuide,
  deleteGuideStep,
  finishGuide,
  getGuideImage,
  getOwnedGuide,
  getPublishedGuide,
  listGuides,
  publishGuide,
  reorderGuideSteps,
  replaceGuideScreenshot,
  updateGuide,
  updateGuideStep,
} from "./guides.js";
import { landingBackgroundSvg } from "./landing-background.js";
import { openApiDocument } from "./openapi.js";
import {
  consumeAnonymousUpload,
  consumeAuthenticatedUpload,
  consumeUserLogin,
} from "./rate-limit.js";
import {
  canRunInteractivePage,
  deleteFile,
  deleteFileForUser,
  deletePage,
  deletePageForUser,
  deletePageVersion,
  deletePageVersionForUser,
  getFile,
  getPagePublisher,
  getPageVersion,
  listFiles,
  listFilesForUser,
  listPages,
  listPagesForUser,
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
  renderInteractiveWarning,
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
  setInteractivePublishingPermission,
} from "./users.js";
import { scanUpload } from "./virus-scanner.js";

const adminCookie = config.cookieSecure ? "__Secure-schaffa_admin" : "schaffa_admin";
const userCookie = config.cookieSecure ? "__Secure-schaffa_user" : "schaffa_user";
const scalarNonce = randomBytes(24).toString("base64");
const publicFile = (path: string) => new URL(`../public/${path}`, import.meta.url);
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
const interactivePageCsp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "script-src-attr 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "navigate-to 'none'",
  "webrtc 'block'",
  "sandbox allow-scripts",
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
    limits: { files: 1, fields: 1, parts: 2 },
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
  app.register(scalarApiReference, {
    routePrefix: "/api",
    configuration: {
      url: "/metadata/openapi.json",
      pageTitle: "Schaffa API Reference",
      nonce: scalarNonce,
      theme: "default",
      layout: "modern",
      telemetry: false,
      withDefaultFonts: false,
      persistAuth: false,
      hideClientButton: true,
      showDeveloperTools: "localhost",
      defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
      agent: { disabled: true },
      mcp: { disabled: true },
      favicon: "/assets/favicon-c.svg",
      customCss:
        ":root{--scalar-color-accent:#a43f24;--scalar-font:ui-sans-serif,system-ui,sans-serif;--scalar-font-code:ui-monospace,SFMono-Regular,Menlo,monospace}",
    },
    hooks: { onRequest: (_request, reply, done) => scalarHeaders(reply, done) },
  });
  app.get("/metadata/openapi.json", async () => openApiDocument());

  app.get("/assets/landing-bg.svg", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/svg+xml; charset=utf-8").send(landingBackgroundSvg);
  });

  app.get("/assets/favicon-c.svg", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=86400");
    return reply
      .type("image/svg+xml; charset=utf-8")
      .send(await readFile(publicFile("icons/favicon.svg")));
  });

  for (const size of [16, 32, 180, 192, 512]) {
    app.get(`/assets/favicon-${size}.png`, async (_request, reply) => {
      reply.header("Cache-Control", "public, max-age=86400");
      return reply.type("image/png").send(await readFile(publicFile(`icons/favicon-${size}.png`)));
    });
  }

  app.get("/favicon.ico", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/x-icon").send(await readFile(publicFile("favicon.ico")));
  });

  app.get("/site.webmanifest", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=86400");
    return reply
      .type("application/manifest+json")
      .send(await readFile(publicFile("site.webmanifest")));
  });

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
          pages: listPagesForUser(user.id),
          files: listFilesForUser(user.id),
          tokens: listUserTokens(user.id),
          interactivePublishingEnabled: getInstanceSettings().interactivePublishingEnabled,
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
  app.post<{ Body: { name?: string; scope?: string } }>(
    "/account/tokens",
    async (request, reply) => {
      accountHeaders(reply);
      const user = requireUserSession(request);
      const scope = request.body?.scope || "upload";
      if (scope !== "upload" && scope !== "interactive") {
        throw new AppError("Invalid token scope.", 422, "invalid_scope");
      }
      const created = createUserToken(user.id, request.body?.name || "Unnamed agent", scope);
      return reply.type("text/html").send(
        renderAccount({
          user,
          pages: listPagesForUser(user.id),
          files: listFilesForUser(user.id),
          tokens: listUserTokens(user.id),
          newToken: created.token,
          interactivePublishingEnabled: getInstanceSettings().interactivePublishingEnabled,
        }),
      );
    },
  );
  app.post<{ Params: { id: string } }>("/account/tokens/:id/revoke", async (request, reply) => {
    const user = requireUserSession(request);
    revokeUserToken(user.id, request.params.id);
    return reply.redirect("/account#tokens");
  });
  app.post<{ Params: { slug: string } }>("/account/pages/:slug/delete", async (request, reply) => {
    const user = requireUserSession(request);
    await deletePageForUser(user.id, request.params.slug);
    return reply.redirect("/account#pages");
  });
  app.post<{ Params: { slug: string; version: string } }>(
    "/account/pages/:slug/versions/:version/delete",
    async (request, reply) => {
      const user = requireUserSession(request);
      await deletePageVersionForUser(user.id, request.params.slug, Number(request.params.version));
      return reply.redirect("/account#pages");
    },
  );
  app.post<{ Params: { id: string } }>("/account/files/:id/delete", async (request, reply) => {
    const user = requireUserSession(request);
    await deleteFileForUser(user.id, request.params.id);
    return reply.redirect("/account#files");
  });

  app.put<{
    Params: { slug: string };
    Querystring: { title?: string | string[]; type?: string | string[] };
  }>("/api/pages/:slug", async (request, reply) => {
    const kind = pageKind(request.query.type);
    const auth =
      kind === "interactive"
        ? requireInteractiveApiAuth(request)
        : requireApiAuth(request, "upload");
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
      ...optionalTitle(request.query.title),
      html,
      tokenId: auth.id,
      isAdmin: auth.scopes.has("admin"),
      kind,
    });
    return reply.code(result.version === 1 ? 201 : 200).send(result);
  });

  app.post<{ Querystring: { title?: string | string[]; type?: string | string[] } }>(
    "/api/pages",
    async (request, reply) => {
      const kind = pageKind(request.query.type);
      const auth =
        kind === "interactive" ? requireInteractiveApiAuth(request) : optionalUploadAuth(request);
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
        ...optionalTitle(request.query.title),
        html,
        tokenId: auth?.id || anonymousActorId,
        anonymous: !auth,
        isAdmin: auth?.scopes.has("admin") || false,
        kind,
      });
      return reply.code(201).send(result);
    },
  );

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

  app.post<{ Body: { title?: unknown; description?: unknown; language?: unknown } }>(
    "/api/guides",
    async (request, reply) => {
      const auth = requireApiAuth(request, "upload");
      requireWritesEnabled();
      requireJson(request);
      consumeAuthenticatedUpload(auth.id);
      return reply.code(201).send(createGuide(request.body || {}, auth.id));
    },
  );
  app.get<{ Params: { slug: string } }>("/api/guides/:slug", async (request, reply) => {
    const auth = requireApiAuth(request, "upload");
    const guide = getOwnedGuide(request.params.slug, auth.id, auth.scopes.has("admin"));
    reply.header("ETag", `"${guide.editRevision}"`);
    return guide;
  });
  app.patch<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    "/api/guides/:slug",
    async (request, reply) => {
      const auth = requireApiAuth(request, "upload");
      requireWritesEnabled();
      requireJson(request);
      consumeAuthenticatedUpload(auth.id);
      const guide = updateGuide(
        request.params.slug,
        request.body || {},
        auth.id,
        auth.scopes.has("admin"),
        expectedEditRevision(request),
      );
      reply.header("ETag", `"${guide.editRevision}"`);
      return guide;
    },
  );
  app.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
    "/api/guides/:slug/steps",
    async (request, reply) => {
      const auth = requireApiAuth(request, "upload");
      requireWritesEnabled();
      consumeAuthenticatedUpload(auth.id);
      const { input, screenshot } = await guideStepPayload(request);
      const guide = await addGuideStep(
        request.params.slug,
        input,
        screenshot,
        auth.id,
        auth.scopes.has("admin"),
        expectedEditRevision(request),
        headerValue(request.headers["idempotency-key"]),
      );
      reply.header("ETag", `"${guide.editRevision}"`);
      return reply.code(201).send(guide);
    },
  );
  app.patch<{ Params: { slug: string; stepId: string }; Body: Record<string, unknown> }>(
    "/api/guides/:slug/steps/:stepId",
    async (request, reply) => {
      const auth = requireApiAuth(request, "upload");
      requireWritesEnabled();
      requireJson(request);
      consumeAuthenticatedUpload(auth.id);
      const guide = updateGuideStep(
        request.params.slug,
        request.params.stepId,
        request.body || {},
        auth.id,
        auth.scopes.has("admin"),
        expectedEditRevision(request),
      );
      reply.header("ETag", `"${guide.editRevision}"`);
      return guide;
    },
  );
  app.put<{ Params: { slug: string; stepId: string } }>(
    "/api/guides/:slug/steps/:stepId/screenshot",
    async (request, reply) => {
      const auth = requireApiAuth(request, "upload");
      requireWritesEnabled();
      consumeAuthenticatedUpload(auth.id);
      const part = await request.file({
        limits: { fileSize: config.maxImageInputBytes, files: 1 },
      });
      if (part?.fieldname !== "screenshot")
        throw new AppError("Expected one multipart file field named screenshot.", 422);
      const guide = await replaceGuideScreenshot(
        request.params.slug,
        request.params.stepId,
        part,
        auth.id,
        auth.scopes.has("admin"),
        expectedEditRevision(request),
      );
      reply.header("ETag", `"${guide.editRevision}"`);
      return guide;
    },
  );
  app.put<{ Params: { slug: string }; Body: { order?: unknown } }>(
    "/api/guides/:slug/order",
    async (request, reply) => {
      const auth = requireApiAuth(request, "upload");
      requireWritesEnabled();
      requireJson(request);
      consumeAuthenticatedUpload(auth.id);
      const guide = reorderGuideSteps(
        request.params.slug,
        request.body?.order,
        auth.id,
        auth.scopes.has("admin"),
        expectedEditRevision(request),
      );
      reply.header("ETag", `"${guide.editRevision}"`);
      return guide;
    },
  );
  app.delete<{ Params: { slug: string; stepId: string } }>(
    "/api/guides/:slug/steps/:stepId",
    async (request, reply) => {
      const auth = requireApiAuth(request, "upload");
      requireWritesEnabled();
      consumeAuthenticatedUpload(auth.id);
      const guide = await deleteGuideStep(
        request.params.slug,
        request.params.stepId,
        auth.id,
        auth.scopes.has("admin"),
        expectedEditRevision(request),
      );
      reply.header("ETag", `"${guide.editRevision}"`);
      return guide;
    },
  );
  app.post<{ Params: { slug: string } }>("/api/guides/:slug/finish", async (request) => {
    const auth = requireApiAuth(request, "upload");
    requireWritesEnabled();
    consumeAuthenticatedUpload(auth.id);
    return finishGuide(
      request.params.slug,
      auth.id,
      auth.scopes.has("admin"),
      expectedEditRevision(request),
    );
  });
  app.post<{ Params: { slug: string } }>("/api/guides/:slug/publish", async (request, reply) => {
    const auth = requireApiAuth(request, "upload");
    requireWritesEnabled();
    consumeAuthenticatedUpload(auth.id);
    return reply
      .code(201)
      .send(
        publishGuide(
          request.params.slug,
          auth.id,
          auth.scopes.has("admin"),
          expectedEditRevision(request),
        ),
      );
  });

  app.get<{ Params: { slug: string } }>("/g/:slug", async (request, reply) =>
    sendGuide(reply, request.params.slug),
  );
  app.get<{ Params: { slug: string; revision: string } }>(
    "/g/:slug/:revision",
    async (request, reply) =>
      sendGuide(reply, request.params.slug, Number(request.params.revision)),
  );
  app.get<{ Params: { slug: string } }>("/g/:slug.json", async (request, reply) => {
    const result = getPublishedGuide(request.params.slug);
    if (!result) throw new AppError("Guide not found.", 404, "not_found");
    publicGuideHeaders(reply, result.revision);
    return reply.type("application/json; charset=utf-8").send(result.guide);
  });
  app.get<{ Params: { slug: string } }>("/g/:slug.md", async (request, reply) => {
    const result = getPublishedGuide(request.params.slug);
    if (!result) throw new AppError("Guide not found.", 404, "not_found");
    publicGuideHeaders(reply, result.revision);
    reply.header("Content-Disposition", `attachment; filename="${request.params.slug}.md"`);
    return reply.type("text/markdown; charset=utf-8").send(result.markdown);
  });
  app.get<{ Params: { slug: string; imageId: string } }>(
    "/g/:slug/images/:imageId.webp",
    async (request, reply) => {
      const token = request.headers.authorization
        ? authenticateToken(bearerToken(request.headers.authorization))
        : null;
      const guideImage = getGuideImage(
        request.params.slug,
        request.params.imageId,
        token?.id,
        token?.scopes.has("admin"),
      );
      if (!guideImage) throw new AppError("Guide image not found.", 404, "not_found");
      reply.headers({
        "Cache-Control": token ? "private, no-store" : "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      return reply.type("image/webp").send(openStoredFile(guideImage.storage_path));
    },
  );

  app.get<{ Params: { slug: string } }>("/p/:slug", async (request, reply) => {
    return sendPage(reply, request.params.slug, undefined, "public");
  });
  app.get<{ Params: { slug: string } }>("/p/:slug/raw", async (request, reply) => {
    return sendPage(reply, request.params.slug, undefined, "raw");
  });
  app.get<{ Params: { slug: string } }>("/p/:slug/run", async (request, reply) => {
    return sendPage(reply, request.params.slug, undefined, "run");
  });
  app.get<{ Params: { slug: string; version: string } }>(
    "/p/:slug/:version",
    async (request, reply) => {
      return sendPage(reply, request.params.slug, Number(request.params.version), "public");
    },
  );
  app.get<{ Params: { slug: string; version: string } }>(
    "/p/:slug/:version/raw",
    async (request, reply) => {
      return sendPage(reply, request.params.slug, Number(request.params.version), "raw");
    },
  );
  app.get<{ Params: { slug: string; version: string } }>(
    "/p/:slug/:version/run",
    async (request, reply) => {
      return sendPage(reply, request.params.slug, Number(request.params.version), "run");
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
        guides: listGuides(),
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
    Body: {
      writesLocked?: string;
      signupsEnabled?: string;
      loginsEnabled?: string;
      interactivePublishingEnabled?: string;
    };
  }>("/admin/settings", async (request, reply) => {
    requireAdminCookie(request);
    const keys = [
      "writesLocked",
      "signupsEnabled",
      "loginsEnabled",
      "interactivePublishingEnabled",
    ] as const;
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
  app.post<{ Params: { slug: string; version: string } }>(
    "/admin/pages/:slug/versions/:version/delete",
    async (request, reply) => {
      requireAdminCookie(request);
      await deletePageVersion(request.params.slug, Number(request.params.version));
      return reply.redirect("/admin#pages");
    },
  );
  app.post<{ Params: { id: string } }>("/admin/files/:id/delete", async (request, reply) => {
    requireAdminCookie(request);
    await deleteFile(request.params.id);
    return reply.redirect("/admin#files");
  });
  app.post<{ Params: { slug: string } }>("/admin/guides/:slug/delete", async (request, reply) => {
    requireAdminCookie(request);
    await deleteGuide(request.params.slug);
    return reply.redirect("/admin#guides");
  });
  app.post<{ Params: { id: string } }>("/admin/tokens/:id/revoke", async (request, reply) => {
    const auth = requireAdminCookie(request);
    revokeToken(request.params.id, auth.id);
    if (request.params.id === auth.id) {
      reply.clearCookie(adminCookie, { path: "/admin" });
    }
    return reply.redirect("/admin#tokens");
  });
  app.post<{ Body: { name?: string; scope?: string } }>("/admin/tokens", async (request, reply) => {
    const auth = requireAdminCookie(request);
    const scope = request.body?.scope;
    if (scope !== "upload" && scope !== "admin") {
      throw new AppError("Invalid token scope.", 422);
    }
    const created = createToken(request.body?.name || "Unnamed client", [scope]);
    return reply.type("text/html").send(
      renderAdmin({
        pages: listPages(),
        files: listFiles(),
        guides: listGuides(),
        tokens: listTokens(),
        users: listUsers(),
        settings: getInstanceSettings(),
        actorId: auth.id,
        actorName: auth.name,
        filters: adminFilters({}),
        newToken: created.token,
      }),
    );
  });
  app.post<{ Params: { id: string } }>("/admin/users/:id/delete", async (request, reply) => {
    requireAdminCookie(request);
    deleteUser(request.params.id);
    return reply.redirect("/admin#users");
  });
  app.post<{ Params: { id: string }; Body: { allowed?: string } }>(
    "/admin/users/:id/interactive",
    async (request, reply) => {
      requireAdminCookie(request);
      if (!request.body || !["true", "false"].includes(request.body.allowed || "")) {
        throw new AppError("Invalid interactive permission.", 422);
      }
      setInteractivePublishingPermission(request.params.id, request.body.allowed === "true");
      return reply.redirect("/admin#users");
    },
  );

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
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      Number.isInteger(error.statusCode) &&
      Number(error.statusCode) >= 400 &&
      Number(error.statusCode) < 500
    ) {
      return reply.code(Number(error.statusCode)).send({
        error: "invalid_request",
        message: error instanceof Error ? error.message : "Invalid request.",
      });
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

async function sendPage(
  reply: FastifyReply,
  slug: string,
  version: number | undefined,
  mode: "public" | "raw" | "run",
) {
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
  if (result.page.kind === "interactive" && mode === "public") {
    const executionAllowed = canRunInteractivePage(result.page.id);
    publicSiteHeaders(reply);
    reply.headers({
      "X-Schaffa-Page": result.page.slug,
      "X-Schaffa-Version": String(result.version.version),
      "Cache-Control": "no-store",
    });
    const versionPath = version ? `/${result.version.version}` : "";
    return reply.type("text/html; charset=utf-8").send(
      renderInteractiveWarning({
        slug: result.page.slug,
        title: result.page.title,
        version: result.version.version,
        publisher: getPagePublisher(result.page.id),
        runUrl: `/p/${encodeURIComponent(result.page.slug)}${versionPath}/run`,
        executionAllowed,
      }),
    );
  }
  if (result.page.kind === "static" && mode === "run") {
    throw new AppError("This is a static page.", 404, "not_found");
  }
  if (
    result.page.kind === "interactive" &&
    mode === "run" &&
    !canRunInteractivePage(result.page.id)
  ) {
    throw new AppError(
      "Interactive execution is currently disabled for this page.",
      503,
      "interactive_disabled",
    );
  }
  if (mode === "raw" && result.page.kind === "interactive") {
    reply.headers({
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `inline; filename="${result.page.slug}-${result.version.version}.html.txt"`,
      "X-Frame-Options": "DENY",
      "X-Schaffa-Page": result.page.slug,
      "X-Schaffa-Version": String(result.version.version),
      "Cache-Control": "no-store",
    });
    return reply.type("text/plain; charset=utf-8").send(result.html);
  }
  const interactive = result.page.kind === "interactive";
  reply.headers({
    "Content-Security-Policy": interactive ? interactivePageCsp : pageCsp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(interactive
      ? {
          "Permissions-Policy":
            "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=()",
          "X-DNS-Prefetch-Control": "off",
        }
      : {}),
    "X-Frame-Options": "DENY",
    "X-Schaffa-Page": result.page.slug,
    "X-Schaffa-Version": String(result.version.version),
    "Cache-Control": interactive
      ? "no-store"
      : result.page.expires_at
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
  const fileStat = await stat(`${config.dataDir}/${file.storage_path}`).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new AppError("File not found.", 404, "not_found");
      }
      throw error;
    },
  );
  let range: { start: number; end: number } | undefined;
  try {
    range = parseRange(request.headers.range, fileStat.size);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 416) {
      reply.header("Content-Range", `bytes */${fileStat.size}`);
    }
    throw error;
  }
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
  if (!value.startsWith("bytes=") || value.includes(",")) return undefined;
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(value);
  if (!match) throw new AppError("Invalid range.", 416, "invalid_range");

  if (match[3]) {
    const suffixLength = BigInt(match[3]);
    if (suffixLength === 0n || size === 0) {
      throw new AppError("Requested range is not satisfiable.", 416, "invalid_range");
    }
    const start = suffixLength >= BigInt(size) ? 0 : size - Number(suffixLength);
    return { start, end: size - 1 };
  }

  const startValue = BigInt(match[1] || "0");
  const requestedEnd = match[2] ? BigInt(match[2]) : BigInt(size - 1);
  if (requestedEnd < startValue || startValue >= BigInt(size)) {
    throw new AppError("Requested range is not satisfiable.", 416, "invalid_range");
  }
  const start = Number(startValue);
  const end = requestedEnd >= BigInt(size) ? size - 1 : Number(requestedEnd);
  return { start, end };
}

function safeInlineType(mediaType: string): boolean {
  return /^(image\/(?!svg\+xml)|audio\/|video\/|text\/plain$)/i.test(mediaType);
}

async function sendGuide(reply: FastifyReply, slug: string, revision?: number) {
  const result = getPublishedGuide(slug, revision);
  if (!result) throw new AppError("Guide not found.", 404, "not_found");
  publicGuideHeaders(reply, result.revision, Boolean(revision));
  return reply.type("text/html; charset=utf-8").send(result.html);
}

function publicGuideHeaders(reply: FastifyReply, revision: number, immutable = false): void {
  reply.headers({
    "Content-Security-Policy": pageCsp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "X-Schaffa-Guide-Revision": String(revision),
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
}

function requireJson(request: FastifyRequest): void {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new AppError("This endpoint requires application/json.", 415, "unsupported_media_type");
  }
}

function expectedEditRevision(request: FastifyRequest): number {
  const value = headerValue(request.headers["if-match"]);
  if (!value) throw new AppError("If-Match is required.", 428, "precondition_required");
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(value.trim());
  if (!match) throw new AppError("If-Match must contain the current editRevision.", 422);
  return Number(match[1]);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function guideStepPayload(request: FastifyRequest): Promise<{
  input: Record<string, unknown>;
  screenshot?: MultipartFile;
}> {
  if (request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    return { input: (request.body || {}) as Record<string, unknown> };
  }
  const screenshot = await request.file({
    limits: { files: 1, fields: 1, parts: 2, fileSize: config.maxImageInputBytes },
  });
  if (screenshot?.fieldname !== "screenshot")
    throw new AppError("Expected one screenshot file.", 422);
  const field = screenshot.fields.step;
  if (!field || Array.isArray(field) || field.type !== "field")
    throw new AppError("Expected one JSON field named step before the screenshot.", 422);
  try {
    const parsed: unknown = JSON.parse(String(field.value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return { input: parsed as Record<string, unknown>, screenshot };
  } catch {
    throw new AppError("step must be a valid JSON object.", 422);
  }
}

function requireApiAuth(request: FastifyRequest, scope: TokenScope) {
  const token = bearerToken(request.headers.authorization);
  return requireScope(authenticateToken(token), scope);
}

function requireInteractiveApiAuth(request: FastifyRequest) {
  const auth = requireApiAuth(request, "interactive");
  const settings = getInstanceSettings();
  if (!settings.interactivePublishingEnabled) {
    throw new AppError(
      "Interactive publishing is disabled on this instance.",
      403,
      "interactive_disabled",
    );
  }
  const allowed = auth.userId
    ? (db()
        .prepare("SELECT can_publish_interactive FROM users WHERE id = ?")
        .get(auth.userId) as unknown as { can_publish_interactive: number } | undefined)
    : undefined;
  if (!allowed?.can_publish_interactive) {
    throw new AppError(
      "Interactive publishing has not been enabled for this account.",
      403,
      "interactive_not_allowed",
    );
  }
  return auth;
}

function pageKind(value: string | string[] | undefined): PageKind {
  const selected = singleQueryValue(value, "type") || "static";
  if (selected !== "static" && selected !== "interactive") {
    throw new AppError("type must be static or interactive.", 422, "invalid_page_type");
  }
  return selected;
}

function optionalTitle(value: string | string[] | undefined): { title?: string } {
  const title = singleQueryValue(value, "title");
  return title === undefined ? {} : { title };
}

function singleQueryValue(value: string | string[] | undefined, name: string): string | undefined {
  if (Array.isArray(value)) {
    throw new AppError(`${name} may only be provided once.`, 422, "invalid_query");
  }
  return value;
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
      "default-src 'none'; img-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  });
}

function accountHeaders(reply: FastifyReply): void {
  const shooOrigin = new URL(config.shooBaseUrl).origin;
  reply.headers({
    "Content-Security-Policy": `default-src 'none'; script-src 'self' ${shooOrigin}; connect-src 'self' ${shooOrigin}; img-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "X-Frame-Options": "DENY",
  });
}

function publicSiteHeaders(reply: FastifyReply): void {
  reply.headers({
    "Content-Security-Policy":
      "default-src 'none'; img-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  });
}

function scalarHeaders(reply: FastifyReply, done: () => void): void {
  reply.headers({
    "Content-Security-Policy": `default-src 'none'; script-src 'self' 'nonce-${scalarNonce}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,
    "X-Frame-Options": "DENY",
  });
  done();
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
