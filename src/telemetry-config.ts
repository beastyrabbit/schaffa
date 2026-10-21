export function parseTelemetryConfig(env: NodeJS.ProcessEnv, version: string) {
  const origin = (name: string) => {
    if (!env[name]) return "";
    const url = new URL(env[name]);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(`${name} must be an HTTP(S) origin.`);
    }
    return url.origin;
  };
  const umamiUrl = origin("UMAMI_URL");
  const umamiWebsiteId = env.UMAMI_WEBSITE_ID || "";
  if (Boolean(umamiUrl) !== Boolean(umamiWebsiteId))
    throw new Error("Configure both UMAMI_URL and UMAMI_WEBSITE_ID.");
  if (umamiWebsiteId && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(umamiWebsiteId))
    throw new Error("UMAMI_WEBSITE_ID must be a UUID.");
  const glitchtipDsn = env.GLITCHTIP_DSN || "";
  if (glitchtipDsn) {
    const dsn = new URL(glitchtipDsn);
    if (
      !["http:", "https:"].includes(dsn.protocol) ||
      !dsn.username ||
      dsn.password ||
      !/^\/\d+$/.test(dsn.pathname) ||
      dsn.search ||
      dsn.hash
    )
      throw new Error("GLITCHTIP_DSN must be a public Sentry DSN.");
  }
  const tracesSampleRate = Number(env.GLITCHTIP_TRACES_SAMPLE_RATE ?? "0.1");
  if (!Number.isFinite(tracesSampleRate) || tracesSampleRate < 0 || tracesSampleRate > 1)
    throw new Error("GLITCHTIP_TRACES_SAMPLE_RATE must be between 0 and 1.");
  return {
    umamiUrl,
    umamiWebsiteId,
    glitchtipDsn,
    tracesSampleRate,
    environment:
      env.SCHAFFA_ENVIRONMENT || (env.NODE_ENV === "production" ? "production" : "development"),
    release: env.SENTRY_RELEASE || `schaffa@${version}`,
  };
}
