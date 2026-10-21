// @ts-check
(function telemetryClient() {
  const meta = document.querySelector('meta[name="schaffa-telemetry"]');
  if (!meta) return;
  const config = JSON.parse(meta.getAttribute("content") || "{}");
  if (location.hostname !== config.baseHost) return;
  const admin = /^\/admin(?:\/|$)/.test(location.pathname);
  /** @param {string} value */
  const scrubText = (value) =>
    value
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
      .replace(/\b(?:sfa|sus)_[\w-]+/g, "[redacted]")
      .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, "[redacted]")
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
      .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url.split(/[?#]/, 1)[0] || "")
      .replace(/(\/[\w/%.:@-]+)[?#][^\s"'<>]*/g, "$1");
  /** @param {unknown} value @param {number} [depth] @returns {unknown} */
  const scrub = (value, depth = 0) => {
    if (depth > 12) return "[truncated]";
    if (typeof value === "string") return scrubText(value);
    if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) =>
          /^(user|ip_address|email|authorization|cookie|set-cookie|password|token|data|body|query_string|query|search|hash)$/i.test(
            key,
          )
            ? []
            : [[key, scrub(item, depth + 1)]],
        ),
      );
    return value;
  };
  /** @type {Error[]} */
  const queue = [];
  let ready = false;
  let analytics = false;
  /** @param {string} name @param {Record<string, string | boolean>} [data] */
  const track = (name, data = {}) => {
    if (analytics && !admin) window.umami?.track(name, data);
  };
  /** @param {unknown} cause */
  const report = (cause) => {
    if (!config.glitchtipDsn) return;
    const error = new Error(scrubText(cause instanceof Error ? cause.message : String(cause)));
    if (cause instanceof Error && cause.stack) error.stack = scrubText(cause.stack);
    if (ready) window.Sentry?.captureException(error);
    else if (queue.length < 20) queue.push(error);
  };
  window.schaffaTelemetry = { track, report, scrub };
  const earlyError = (/** @type {ErrorEvent} */ event) => report(event.error || event.message);
  const earlyRejection = (/** @type {PromiseRejectionEvent} */ event) => report(event.reason);
  if (config.glitchtipDsn) {
    window.addEventListener("error", earlyError);
    window.addEventListener("unhandledrejection", earlyRejection);
    // biome-ignore lint/suspicious/noConsole: preserve console behavior while capturing error reports
    const original = console.error;
    console.error = (...args) => {
      report(
        args
          .map((arg) =>
            arg instanceof Error ? arg.message : typeof arg === "string" ? arg : "[object]",
          )
          .join(" "),
      );
      original.apply(console, args);
    };
  }
  /** @param {string} src @param {Record<string, string>} [attributes] */
  const load = (src, attributes = {}) =>
    new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      Object.entries(attributes).forEach(([key, value]) => {
        script.setAttribute(key, value);
      });
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  const errors = () => {
    if (!config.glitchtipDsn) return;
    void load(config.sentryJs)
      .then(() => {
        const sdk = window.Sentry;
        if (!sdk) return;
        sdk.init({
          dsn: config.glitchtipDsn,
          environment: config.environment,
          release: config.release,
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
          defaultIntegrations: false,
          integrations: [
            sdk.eventFiltersIntegration(),
            sdk.dedupeIntegration(),
            sdk.linkedErrorsIntegration(),
            sdk.globalHandlersIntegration(),
            sdk.breadcrumbsIntegration({ dom: false, fetch: false, xhr: false, history: false }),
            sdk.browserTracingIntegration({
              enableReportPageLoaded: false,
              enableHTTPTimings: false,
              enableInp: false,
              linkPreviousTrace: "off",
            }),
          ],
          tracesSampleRate: config.tracesSampleRate,
          traceLifecycle: "static",
          tracePropagationTargets: [
            /^\/(?!\/)/,
            new RegExp(`^${location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`),
          ],
          beforeSend: (event) => /** @type {typeof event} */ (scrub(event)),
          beforeSendTransaction: (event) => /** @type {typeof event} */ (scrub(event)),
          beforeBreadcrumb: (crumb) => /** @type {typeof crumb} */ (scrub(crumb)),
        });
        ready = true;
        window.removeEventListener("error", earlyError);
        window.removeEventListener("unhandledrejection", earlyRejection);
        queue.splice(0).forEach((error) => {
          sdk.captureException(error);
        });
      })
      .catch(() => {});
  };
  const startAnalytics = () => {
    if (analytics || admin || !config.umamiUrl) return;
    analytics = true;
    window.schaffaUmamiBeforeSend = (_type, payload) => {
      if (!analytics) return null;
      // Referrers, document titles and arbitrary element properties can contain private data.
      return { ...payload, title: "Schaffa", referrer: "", url: location.pathname };
    };
    void load(`${config.umamiUrl}/script.js`, {
      "data-website-id": config.umamiWebsiteId,
      "data-domains": config.baseHost,
      "data-exclude-search": "true",
      "data-exclude-hash": "true",
      "data-performance": "true",
      "data-before-send": "schaffaUmamiBeforeSend",
      "data-do-not-track": "true",
    })
      .then(() => {
        if (document.querySelector(".error:not([hidden])")) track("error-shown");
        // Recorder metadata includes full URLs. Never record a secret-bearing URL.
        if (
          analytics &&
          !location.search &&
          !location.hash &&
          !/^\/account(?:\/|$)/.test(location.pathname) &&
          !document.querySelector("[data-token-reveal]")
        )
          return load(`${config.umamiUrl}/recorder.js`, {
            "data-website-id": config.umamiWebsiteId,
          });
      })
      .catch(() => {});
  };
  const consent = () => {
    if (admin || !config.umamiUrl) return;
    void load(config.consentJs)
      .then(() => {
        const cc = window.CookieConsent;
        if (!cc) return;
        const sync = () => {
          if (cc.acceptedCategory("analytics")) startAnalytics();
          else if (analytics) {
            analytics = false;
            // A full document teardown removes recorder observers, timers and history hooks.
            // Suppress its unload flush before tearing down the document.
            delete window.umami;
            // POST-rendered management pages must return through a safe GET.
            const management = /^\/(account|admin)(?:\/|$)/.exec(location.pathname);
            location.replace(management ? `/${management[1]}` : location.href);
          }
        };
        return cc
          .run({
            mode: "opt-in",
            hideFromBots: false,
            cookie: { name: "cc_cookie", expiresAfterDays: 182 },
            guiOptions: { consentModal: { layout: "box", position: "bottom right" } },
            categories: { necessary: { enabled: true, readOnly: true }, analytics: {} },
            onConsent: sync,
            onChange: sync,
            language: {
              default: "en",
              translations: {
                en: {
                  consentModal: {
                    title: "Your privacy choices",
                    description: `Necessary services keep sign-in and error reporting working. With your permission, Umami measures usage, performance, session replay and heatmaps. <a href="/${document.documentElement?.lang === "de" ? "datenschutz" : "privacy"}#privacy-10">Privacy policy</a>`,
                    acceptAllBtn: "Accept analytics",
                    acceptNecessaryBtn: "Necessary only",
                    showPreferencesBtn: "Cookie settings",
                  },
                  preferencesModal: {
                    title: "Cookie settings",
                    acceptAllBtn: "Accept analytics",
                    acceptNecessaryBtn: "Necessary only",
                    savePreferencesBtn: "Save preferences",
                    closeIconLabel: "Close",
                    sections: [
                      {
                        title: "Necessary",
                        description:
                          "Shoo sign-in and the Schaffa session cookie authenticate your account. cc_cookie remembers your banner choice for six months (182 days). GlitchTip error reporting uses no cookies, localStorage or sessionStorage.",
                        linkedCategory: "necessary",
                      },
                      {
                        title: "Analytics, replay and heatmaps",
                        description:
                          "Self-hosted Umami measures visits, actions and performance and records masked sessions and click heatmaps. Umami keeps its session cache in memory; it reads the optional umami.disabled localStorage preference but this site never writes it. No analytics cookie or other persistent analytics storage is created.",
                        linkedCategory: "analytics",
                      },
                    ],
                  },
                },
              },
            },
          })
          .then(() => {
            if (location.hash === "#cookie-settings") cc.showPreferences();
          });
      })
      .catch(() => {});
  };
  const interactions = () => {
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const button = target.closest("[data-copy], #shoo-sign-in, .nav-action, .primary-link");
      if (button)
        track(
          button.id === "shoo-sign-in"
            ? "sign-in-start"
            : button.hasAttribute("data-copy")
              ? "token-copied"
              : "cta-click",
          { area: location.pathname },
        );
      const link = target.closest("a[href]");
      if (
        link instanceof HTMLAnchorElement &&
        /^https?:/.test(link.protocol) &&
        link.origin !== location.origin
      )
        track("outbound-link", { hostname: link.hostname });
    });
    document.addEventListener("copy", (event) => {
      const anchor = window.getSelection()?.anchorNode;
      const target =
        anchor instanceof Element
          ? anchor
          : anchor?.parentElement || (event.target instanceof Element ? event.target : null);
      if (target?.closest(".quickstart")) track("quickstart-copy");
      if (target?.closest(".skill-install, .skill-example")) track("skill-install-copy");
    });
  };
  const loaded = () => {
    interactions();
    consent();
    if ("requestIdleCallback" in window) window.requestIdleCallback(errors, { timeout: 1000 });
    else setTimeout(errors, 0);
  };
  if (document.readyState === "complete") loaded();
  else window.addEventListener("load", loaded, { once: true });
})();
