// @ts-check
(function telemetryClient() {
  const meta = document.querySelector('meta[name="schaffa-telemetry"]');
  if (!meta) return;
  const config = JSON.parse(meta.getAttribute("content") || "{}");
  if (location.hostname !== config.baseHost) return;
  const admin = /^\/admin(?:\/|$)/.test(location.pathname);
  const pagePath = config.pagePath || "/404";
  /** @param {string} value @param {number} at */
  function emailMatchEnd(value, at) {
    const domain = /[\p{L}\p{N}.+_-]*/uy;
    domain.lastIndex = at + 1;
    const text = domain.exec(value)?.[0] || "";
    let end = 0;
    for (const suffix of text.matchAll(/\.\p{L}{2,}/gu)) {
      if (suffix.index > 0) end = at + 1 + suffix.index + suffix[0].length;
    }
    return end;
  }
  /** @param {string} value @param {number} at @param {number} cursor */
  function emailLocalStart(value, at, cursor) {
    let start = at;
    while (start > cursor) {
      const width = (value.codePointAt(start - 2) || 0) > 0xffff ? 2 : 1;
      if (!/[\p{L}\p{N}.+_-]/u.test(value.slice(start - width, start))) break;
      start -= width;
    }
    return start;
  }
  // Scan each side of an @ once rather than retrying an email regex at every character.
  /** @param {string} value */
  function scrubEmails(value) {
    const parts = [];
    let cursor = 0;
    for (const match of value.matchAll(/@/g)) {
      const start = emailLocalStart(value, match.index, cursor);
      if (start === match.index) continue;
      const end = emailMatchEnd(value, match.index);
      if (!end) continue;
      parts.push(value.slice(cursor, start), "[email]");
      cursor = end;
    }
    parts.push(value.slice(cursor));
    return parts.join("");
  }
  /** @param {string} value */
  const scrubText = (value) =>
    scrubEmails(
      value
        .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
        .replace(/\b(?:sfa|sus)_[\w-]+/g, "[redacted]")
        .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, "[redacted]"),
    )
      .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url.split(/[?#]/, 1)[0] || "")
      // Matching paths without a query too avoids retrying every slash on failure.
      .replace(/\/[\w/%.:@-]+(?:[?#][^\s"'<>]*)?/g, (url) => url.split(/[?#]/, 1)[0] || "");
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
          .map((arg) => {
            if (arg instanceof Error) return arg.message;
            return typeof arg === "string" ? arg : "[object]";
          })
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
        const origin = location.origin.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
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
          tracePropagationTargets: [/^\/(?!\/)/, new RegExp(`^${origin}/`)],
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
      return { ...payload, title: "Schaffa", referrer: "", url: pagePath };
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
          pagePath !== "/404" &&
          pagePath === location.pathname &&
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
              default: document.documentElement?.lang.toLowerCase().startsWith("de") ? "de" : "en",
              translations: {
                en: {
                  consentModal: {
                    title: "Your privacy choices",
                    description: `Necessary services keep sign-in and error reporting working. With your permission, Umami measures usage, performance, session replay and heatmaps.${config.legalPages ? ' <a href="/privacy#privacy-10">Privacy policy</a>' : ""}`,
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
                de: {
                  consentModal: {
                    title: "Ihre Datenschutzeinstellungen",
                    description: `Notwendige Dienste ermöglichen die Anmeldung und Fehlerüberwachung. Mit Ihrer Einwilligung erfasst Umami Besuche, Interaktionen und Leistung sowie maskierte Sitzungsaufzeichnungen und Heatmaps.${config.legalPages ? ' <a href="/datenschutz#privacy-10">Datenschutzerklärung</a>' : ""}`,
                    acceptAllBtn: "Analyse akzeptieren",
                    acceptNecessaryBtn: "Nur notwendige",
                    showPreferencesBtn: "Cookie-Einstellungen",
                  },
                  preferencesModal: {
                    title: "Cookie-Einstellungen",
                    acceptAllBtn: "Analyse akzeptieren",
                    acceptNecessaryBtn: "Nur notwendige",
                    savePreferencesBtn: "Auswahl speichern",
                    closeIconLabel: "Schließen",
                    sections: [
                      {
                        title: "Notwendige Dienste",
                        description:
                          "Die Shoo-Anmeldung und das Schaffa-Sitzungscookie authentifizieren Ihr Konto. cc_cookie speichert Ihre Auswahl im Cookie-Banner für sechs Monate (182 Tage). Die Fehlerüberwachung mit GlitchTip verwendet keine Cookies, localStorage oder sessionStorage.",
                        linkedCategory: "necessary",
                      },
                      {
                        title: "Reichweitenmessung, Sitzungsaufzeichnungen und Heatmaps",
                        description:
                          "Das selbst gehostete Umami erfasst Besuche, Interaktionen und Leistung sowie maskierte Sitzungsaufzeichnungen und Klick-Heatmaps. Umami hält seinen Sitzungscache im Arbeitsspeicher und liest die optionale Einstellung umami.disabled aus localStorage. Schaffa schreibt diese Einstellung nicht. Es werden keine Analyse-Cookies oder anderen dauerhaften Analysedaten im Browser gespeichert.",
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
      const button = target.closest("#shoo-sign-in, .nav-action, .primary-link");
      if (button) {
        let name = "cta-click";
        if (button.id === "shoo-sign-in") name = "sign-in-start";
        track(name, { area: pagePath });
      }
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
      let target = event.target instanceof Element ? event.target : null;
      if (anchor instanceof Element) target = anchor;
      else if (anchor?.parentElement) target = anchor.parentElement;
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
