import { config } from "./config.js";
import type { TokenRow } from "./db.js";
import type { FileSummary, PageSummary } from "./service.js";
import { filePublicUrl } from "./service.js";
import type { InstanceSettings } from "./settings.js";
import type { UserSession, UserSummary } from "./users.js";

export interface AdminFilters {
  q: string;
  uploader: string;
  kind: "all" | "pages" | "files";
  lifetime: "all" | "permanent" | "anonymous-active";
}

export function renderAdminLogin(error?: string): string {
  return layout(
    "Admin sign-in",
    `<main class="login-shell">
      <section class="login-panel">
        <a class="wordmark" href="/">Schaffa</a>
        <h1>Admin-Zugang</h1>
        <p class="lede">Mit einem Admin-Token anmelden. Der Token bleibt in einem HttpOnly-Cookie unter <code>/admin</code>.</p>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
        <form method="post" action="/admin/login">
          <label for="token">Admin-Token</label>
          <input id="token" name="token" type="password" required autocomplete="current-password" placeholder="sfa_…">
          <button type="submit">Anmelden</button>
        </form>
      </section>
    </main>`,
  );
}

export function renderPublicNotFound(): string {
  return layout(
    "Nicht gefunden",
    `<main class="login-shell">
      <section class="login-panel not-found">
        <span class="wordmark">Schaffa</span>
        <p class="error-code">404</p>
        <h1>Seite nicht gefunden</h1>
        <p class="lede">Unter diesem Slug wurde noch nichts veröffentlicht. Prüfe die URL oder veröffentliche die Seite erneut.</p>
      </section>
    </main>`,
  );
}

export function renderAccountLogin(input: {
  loginsEnabled: boolean;
  shooScriptUrl: string;
  signedOut?: boolean;
}): string {
  const action = input.loginsEnabled
    ? `<button id="shoo-sign-in" class="primary-link" type="button">Mit Google anmelden</button>
       <p id="auth-error" class="error" hidden></p>`
    : `<p class="error">Anmeldungen sind auf dieser Instanz derzeit deaktiviert.</p>`;
  const scripts = input.loginsEnabled
    ? `<script defer src="${escapeHtml(input.shooScriptUrl)}"></script><script defer src="/assets/account.js"></script>`
    : "";
  return layout(
    "Anmelden",
    `<main class="login-shell"><section class="login-panel" data-account-login${input.signedOut ? " data-signed-out" : ""}>
      <a class="wordmark" href="/">Schaffa</a>
      <h1>Dein Schaffa-Zugang</h1>
      <p class="lede">Mit Shoo anmelden und eigene Upload-Tokens für CLI und Agenten verwalten.</p>
      ${action}
    </section></main>`,
    scripts,
  );
}

export function renderAccount(input: {
  user: UserSession;
  tokens: TokenRow[];
  newToken?: string;
}): string {
  const tokenRows = input.tokens
    .map(
      (token) =>
        `<tr><td>${escapeHtml(token.name)}<span class="sub mono">${escapeHtml(token.id)}</span></td><td>${token.last_used_at ? formatDate(token.last_used_at) : "Noch nie"}</td><td>${token.revoked_at ? `<span class="state revoked">Widerrufen</span>` : `<span class="state">Aktiv</span>`}</td><td>${token.revoked_at ? "" : `<form method="post" action="/account/tokens/${encodeURIComponent(token.id)}/revoke"><button class="danger" type="submit">Widerrufen</button></form>`}</td></tr>`,
    )
    .join("");
  return layout(
    "Konto",
    `<header class="topbar"><a class="wordmark" href="/account">Schaffa</a><div class="identity"><span>${escapeHtml(input.user.displayName)}</span><form method="post" action="/account/logout"><button class="quiet" type="submit">Abmelden</button></form></div></header>
    <main class="workspace account-workspace">
      <div class="page-heading"><div><h1>Agenten-Tokens</h1><p>Eigene Upload-Tokens erstellen und widerrufen.</p></div></div>
      ${input.newToken ? `<aside class="token-reveal"><strong>Token jetzt speichern</strong><p>Dieser Wert wird nur einmal angezeigt.</p><code>${escapeHtml(input.newToken)}</code></aside>` : ""}
      <section><form class="operation-card token-create" method="post" action="/account/tokens"><label>Name<input name="name" required maxlength="80" placeholder="desktop-codex"></label><button type="submit">Upload-Token erstellen</button></form></section>
      <section><div class="table-wrap"><table><thead><tr><th>Name</th><th>Zuletzt benutzt</th><th>Status</th><th>Aktion</th></tr></thead><tbody>${tokenRows || emptyRow(4, "Noch keine Tokens vorhanden.")}</tbody></table></div></section>
    </main>`,
  );
}

export const accountClientScript = `(() => {
  const shell = document.querySelector("[data-account-login]");
  if (!shell || !window.Shoo) return;
  const error = document.getElementById("auth-error");
  const showError = (message) => {
    if (!error) return;
    error.hidden = false;
    error.textContent = message;
  };
  if (shell.hasAttribute("data-signed-out")) {
    window.Shoo.clearIdentity();
    history.replaceState({}, "", "/account");
    return;
  }
  const establishSession = async () => {
    const identity = window.Shoo.getIdentity();
    if (!identity?.token) return false;
    const response = await fetch("/auth/shoo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: identity.token }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || "Anmeldung fehlgeschlagen.");
    }
    location.replace("/account");
    return true;
  };
  const link = document.getElementById("shoo-sign-in");
  link?.addEventListener("click", (event) => {
    event.preventDefault();
    window.Shoo.startSignIn({ returnTo: "/account", requestPii: true });
  });
  establishSession().catch((cause) => showError(cause instanceof Error ? cause.message : "Anmeldung fehlgeschlagen."));
})();`;

export function renderAdmin(input: {
  pages: PageSummary[];
  files: FileSummary[];
  tokens: TokenRow[];
  users: UserSummary[];
  settings: InstanceSettings;
  actorId: string;
  actorName: string;
  filters: AdminFilters;
}): string {
  const uploaders = uniqueUploaders(input.pages, input.files);
  const pages =
    input.filters.kind === "files"
      ? []
      : input.pages.filter((page) => pageMatches(page, input.filters));
  const files =
    input.filters.kind === "pages"
      ? []
      : input.files.filter((file) => fileMatches(file, input.filters));

  const pageRows = pages
    .map(
      (page) => `<tr>
        <td><a href="${config.baseUrl}/p/${encodeURIComponent(page.slug)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.slug)}</a>${page.title ? `<span class="sub">${escapeHtml(page.title)}</span>` : ""}</td>
        <td>v${page.current_version}</td>
        <td>${page.version_count}</td>
        <td>${escapeHtml(page.uploader_name)}</td>
        <td>${page.expires_at ? `<span class="state temporary">Anonym</span><span class="sub">bis ${formatDate(page.expires_at)}</span>` : `<span class="state">Dauerhaft</span>`}</td>
        <td>${formatBytes(page.latest_bytes)}</td>
        <td><time>${formatDate(page.updated_at)}</time></td>
        <td><form method="post" action="/admin/pages/${encodeURIComponent(page.slug)}/delete"><button class="danger" type="submit">Löschen</button></form></td>
      </tr>`,
    )
    .join("");

  const fileRows = files
    .map(
      (file) => `<tr>
        <td><a href="${filePublicUrl(file.filename)}" target="_blank" rel="noopener noreferrer">${escapeHtml(file.filename)}</a></td>
        <td>${escapeHtml(file.media_type)}</td>
        <td>${escapeHtml(file.uploader_name)}</td>
        <td>${formatBytes(file.bytes)}</td>
        <td><time>${formatDate(file.created_at)}</time></td>
        <td><form method="post" action="/admin/files/${encodeURIComponent(file.id)}/delete"><button class="danger" type="submit">Löschen</button></form></td>
      </tr>`,
    )
    .join("");

  const tokenRows = input.tokens
    .map(
      (token) => `<tr>
        <td>${escapeHtml(token.name)}<span class="sub mono">${escapeHtml(token.id)}</span></td>
        <td>${escapeHtml(token.scopes)}</td>
        <td>${token.last_used_at ? formatDate(token.last_used_at) : "Noch nie"}</td>
        <td>${token.revoked_at ? `<span class="state revoked">Widerrufen</span>` : `<span class="state">Aktiv</span>`}</td>
        <td>${token.revoked_at ? "" : token.id === input.actorId && token.id !== "bootstrap" ? `<span class="sub">Aktuelle Sitzung</span>` : `<form method="post" action="/admin/tokens/${encodeURIComponent(token.id)}/revoke"><button class="danger" type="submit">Widerrufen</button></form>`}</td>
      </tr>`,
    )
    .join("");
  const userRows = input.users
    .map(
      (user) =>
        `<tr><td>${escapeHtml(user.name || user.email || "Shoo user")}<span class="sub mono">${escapeHtml(user.id)}</span></td><td>${user.email ? escapeHtml(user.email) : "Keine PII"}</td><td>${user.active_token_count} / ${user.token_count}</td><td>${formatDate(user.last_login_at)}</td><td><form method="post" action="/admin/users/${encodeURIComponent(user.id)}/delete"><button class="danger" type="submit">Löschen</button></form></td></tr>`,
    )
    .join("");

  return layout(
    "Admin",
    `<header class="topbar">
      <a class="wordmark" href="/admin">Schaffa</a>
      <div class="identity"><span>${escapeHtml(input.actorName)}</span><form method="post" action="/admin/logout"><button class="quiet" type="submit">Abmelden</button></form></div>
    </header>
    <main class="workspace">
      <div class="page-heading"><div><h1>Publikationen</h1><p>Öffentliche Seiten und Dateien dieses Servers.</p></div><a class="docs-link" href="${config.baseUrl}/api" target="_blank" rel="noopener noreferrer">API ansehen</a></div>
      <form class="filters" method="get" action="/admin">
        <label>Suche<input type="search" name="q" value="${escapeHtml(input.filters.q)}" placeholder="Slug, Titel, Datei …"></label>
        <label>Uploader<select name="uploader"><option value="">Alle</option>${uploaders.map((uploader) => `<option value="${escapeHtml(uploader.id)}"${selected(input.filters.uploader, uploader.id)}>${escapeHtml(uploader.name)}</option>`).join("")}</select></label>
        <label>Art<select name="kind"><option value="all"${selected(input.filters.kind, "all")}>Alles</option><option value="pages"${selected(input.filters.kind, "pages")}>Seiten</option><option value="files"${selected(input.filters.kind, "files")}>Dateien</option></select></label>
        <label>Lebensdauer<select name="lifetime"><option value="all"${selected(input.filters.lifetime, "all")}>Alle</option><option value="permanent"${selected(input.filters.lifetime, "permanent")}>Dauerhaft</option><option value="anonymous-active"${selected(input.filters.lifetime, "anonymous-active")}>Anonym aktiv</option></select></label>
        <button type="submit">Filtern</button><a href="/admin">Zurücksetzen</a>
      </form>
      <nav class="tabs" aria-label="Bereiche"><a href="#operations">Betrieb</a><a href="#pages">Seiten <span>${pages.length}</span></a><a href="#files">Dateien <span>${files.length}</span></a><a href="#users">Nutzer <span>${input.users.length}</span></a><a href="#tokens">Tokens <span>${input.tokens.length}</span></a></nav>
      <section id="operations"><div class="section-heading"><h2>Betrieb</h2><p>Zugänge und Publishing im Notfall gezielt sperren.</p></div><div class="operation-list"><form class="operation-card" method="post" action="/admin/settings"><input type="hidden" name="writesLocked" value="${input.settings.writesLocked ? "false" : "true"}"><div><strong>${input.settings.writesLocked ? "Publishing gesperrt" : "Publishing aktiv"}</strong><span class="sub">${input.settings.writesLocked ? "Nur Lesezugriffe und Admin-Wiederherstellung sind möglich." : "Uploads und Seiten-Updates werden angenommen."}</span></div><button class="${input.settings.writesLocked ? "" : "danger"}" type="submit">${input.settings.writesLocked ? "Lockdown aufheben" : "Lockdown aktivieren"}</button></form><form class="operation-card" method="post" action="/admin/settings"><input type="hidden" name="signupsEnabled" value="${input.settings.signupsEnabled ? "false" : "true"}"><div><strong>Registrierungen ${input.settings.signupsEnabled ? "aktiv" : "gesperrt"}</strong><span class="sub">Steuert, ob eine neue Shoo-Identität ein Konto anlegen darf.</span></div><button class="${input.settings.signupsEnabled ? "danger" : ""}" type="submit">${input.settings.signupsEnabled ? "Registrierungen sperren" : "Registrierungen erlauben"}</button></form><form class="operation-card" method="post" action="/admin/settings"><input type="hidden" name="loginsEnabled" value="${input.settings.loginsEnabled ? "false" : "true"}"><div><strong>Anmeldungen ${input.settings.loginsEnabled ? "aktiv" : "gesperrt"}</strong><span class="sub">Beim Sperren werden alle aktiven Nutzersitzungen beendet.</span></div><button class="${input.settings.loginsEnabled ? "danger" : ""}" type="submit">${input.settings.loginsEnabled ? "Anmeldungen sperren" : "Anmeldungen erlauben"}</button></form></div></section>
      <section id="pages"><div class="section-heading"><h2>Seiten</h2><p>Anonyme Seiten verschwinden nach einer Stunde; gespeichert bleiben sie 30 Tage.</p></div><div class="table-wrap"><table><thead><tr><th>Slug</th><th>Aktuell</th><th>Versionen</th><th>Uploader</th><th>Status</th><th>Größe</th><th>Geändert</th><th>Aktion</th></tr></thead><tbody>${pageRows || emptyRow(8, "Keine passenden Seiten gefunden.")}</tbody></table></div></section>
      <section id="files"><div class="section-heading"><h2>Dateien</h2><p>Unveränderliche URLs mit zufälliger 128-Bit-ID.</p></div><div class="table-wrap"><table><thead><tr><th>Datei</th><th>Typ</th><th>Uploader</th><th>Größe</th><th>Hochgeladen</th><th>Aktion</th></tr></thead><tbody>${fileRows || emptyRow(6, "Keine passenden Dateien gefunden.")}</tbody></table></div></section>
      <section id="users"><div class="section-heading"><h2>Nutzer</h2><p>Shoo-Identitäten und ihre Agenten-Tokens. Löschen widerruft alle zugehörigen Tokens und Sitzungen.</p></div><div class="table-wrap"><table><thead><tr><th>Nutzer</th><th>E-Mail</th><th>Aktive / alle Tokens</th><th>Letzte Anmeldung</th><th>Aktion</th></tr></thead><tbody>${userRows || emptyRow(5, "Keine Nutzer vorhanden.")}</tbody></table></div></section>
      <section id="tokens"><div class="section-heading"><h2>Tokens</h2><p>Tokenwerte werden nur einmal ausgegeben; hier liegen ausschließlich HMAC-Hashes.</p></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Scopes</th><th>Zuletzt benutzt</th><th>Status</th><th>Aktion</th></tr></thead><tbody>${tokenRows || emptyRow(5, "Keine Tokens vorhanden.")}</tbody></table></div></section>
    </main>`,
  );
}

function layout(title: string, content: string, scripts = ""): string {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Schaffa</title>
  <style>${styles}</style>
</head>
<body>${content}${scripts}</body>
</html>`;
}

function emptyRow(columns: number, message: string): string {
  return `<tr><td colspan="${columns}" class="empty">${escapeHtml(message)}</td></tr>`;
}

function pageMatches(page: PageSummary, filters: AdminFilters): boolean {
  if (filters.uploader && page.uploader_id !== filters.uploader) return false;
  if (filters.lifetime === "permanent" && page.expires_at) return false;
  if (filters.lifetime === "anonymous-active" && !page.expires_at) return false;
  return matchesQuery(filters.q, [page.slug, page.title || "", page.uploader_name]);
}

function fileMatches(file: FileSummary, filters: AdminFilters): boolean {
  if (filters.uploader && file.uploader_id !== filters.uploader) return false;
  if (filters.lifetime === "anonymous-active") return false;
  return matchesQuery(filters.q, [file.filename, file.media_type, file.uploader_name]);
}

function matchesQuery(query: string, values: string[]): boolean {
  const needle = query.toLocaleLowerCase("de-DE");
  return !needle || values.some((value) => value.toLocaleLowerCase("de-DE").includes(needle));
}

function uniqueUploaders(
  pages: PageSummary[],
  files: FileSummary[],
): Array<{ id: string; name: string }> {
  const uploaders = new Map<string, string>();
  for (const item of [...pages, ...files]) uploaders.set(item.uploader_id, item.uploader_name);
  return [...uploaders]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "de-DE"));
}

function selected(actual: string, expected: string): string {
  return actual === expected ? " selected" : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] || character;
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(new Date(value.endsWith("Z") ? value : `${value}Z`));
}

const styles = `
:root{--paper:#f3f0e8;--surface:#fbfaf6;--ink:#20211e;--muted:#68685f;--line:#d6d1c5;--accent:#a43f24;--accent-dark:#7c2e1a;--success:#315a3a;--danger:#8c3329;font-family:"Avenir Next","Segoe UI",sans-serif;color:var(--ink);background:var(--paper);font-synthesis:none}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;background:var(--paper)}a{color:inherit;text-decoration-color:#9a9589;text-underline-offset:3px}a:hover{text-decoration-color:var(--accent)}button,input{font:inherit}.topbar{height:64px;padding:0 32px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;background:var(--surface)}.wordmark{font-family:Georgia,"Times New Roman",serif;font-size:24px;font-weight:700;text-decoration:none;letter-spacing:-.04em}.identity{display:flex;align-items:center;gap:16px;color:var(--muted);font-size:14px}.identity form{margin:0}.quiet,.docs-link{border:1px solid var(--line);background:transparent;border-radius:8px;padding:8px 12px;color:var(--ink);text-decoration:none;cursor:pointer}.quiet:hover,.docs-link:hover{border-color:#9f998d;background:#fff}.workspace{max-width:1180px;margin:0 auto;padding:40px 32px 72px}.page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.page-heading h1{font:700 34px/1.1 Georgia,"Times New Roman",serif;letter-spacing:-.025em;margin:0}.page-heading p,.section-heading p{color:var(--muted);margin:8px 0 0}.tabs{height:52px;margin-top:32px;border-bottom:1px solid var(--line);display:flex;align-items:end;gap:28px}.tabs a{padding:0 0 13px;text-decoration:none;font-weight:600;color:var(--muted);border-bottom:2px solid transparent}.tabs a:first-child{color:var(--ink);border-color:var(--accent)}.tabs span{margin-left:5px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}section{scroll-margin-top:20px;padding-top:36px}.section-heading{display:flex;align-items:baseline;gap:16px;margin-bottom:14px}.section-heading h2{font-size:20px;margin:0}.section-heading p{font-size:14px}.table-wrap{border:1px solid var(--line);border-radius:10px;overflow-x:auto;background:var(--surface)}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:13px 16px;border-bottom:1px solid #e2ddd2;vertical-align:top}th{font-size:12px;letter-spacing:.025em;color:var(--muted);background:#f7f4ed;font-weight:700}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#f7f4ed}td a{font-weight:600}.sub{display:block;color:var(--muted);font-size:12px;margin-top:4px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.state{color:var(--success);font-weight:600}.state.revoked{color:var(--danger)}.empty{text-align:center;color:var(--muted);padding:32px}.login-shell{min-height:100vh;display:grid;place-items:center;padding:24px}.login-panel{width:min(420px,100%);padding:32px;border:1px solid var(--line);border-radius:10px;background:var(--surface);box-shadow:0 12px 32px rgba(44,39,30,.08)}.login-panel h1{font:700 30px/1.1 Georgia,"Times New Roman",serif;margin:32px 0 8px}.lede{color:var(--muted);line-height:1.55;margin:0 0 24px}.login-panel label{display:block;font-weight:700;font-size:13px;margin-bottom:8px}.login-panel input{width:100%;border:1px solid #aaa397;border-radius:8px;background:#fff;padding:11px 12px;outline:none}.login-panel input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(164,63,36,.14)}.login-panel button[type=submit]{width:100%;margin-top:14px;border:0;border-radius:8px;padding:11px 16px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}.login-panel button[type=submit]:hover{background:var(--accent-dark)}.error{padding:10px 12px;border-left:3px solid var(--danger);background:#f8e9e5;color:#6c241d;font-size:14px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}@media(max-width:720px){.topbar{padding:0 18px}.identity>span{display:none}.workspace{padding:28px 18px 56px}.page-heading{align-items:flex-start}.section-heading{display:block}.section-heading p{line-height:1.45}.tabs{gap:20px;overflow-x:auto}.docs-link{display:none}th,td{padding:11px 12px;white-space:nowrap}}
.login-panel.not-found h1{margin-top:8px}.error-code{margin:40px 0 0;color:var(--accent);font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}
.filters{margin-top:28px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--surface);display:grid;grid-template-columns:minmax(200px,2fr) repeat(3,minmax(130px,1fr)) auto auto;gap:12px;align-items:end}.filters label,.token-create label{display:grid;gap:6px;color:var(--muted);font-size:12px;font-weight:700}.filters input,.filters select,.token-create input{min-width:0;border:1px solid #aaa397;border-radius:7px;background:#fff;padding:9px 10px;color:var(--ink)}.filters button,.operation-card button,.primary-link{border:0;border-radius:7px;padding:10px 15px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer;text-decoration:none}.primary-link{display:block;text-align:center}.filters>a{padding:9px 4px;color:var(--muted);font-size:13px}.state.temporary{color:var(--accent)}button.danger{border:1px solid #d9aaa2;border-radius:7px;padding:7px 10px;background:#fff3f0;color:var(--danger);font-weight:700;cursor:pointer}.operation-list{display:grid;gap:10px}.operation-card{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:18px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.token-create label{flex:1}.account-workspace{max-width:900px}.token-reveal{margin-top:28px;padding:18px;border:1px solid #d6b976;border-radius:10px;background:#fff8df}.token-reveal p{color:var(--muted)}.token-reveal code{display:block;overflow-wrap:anywhere;padding:12px;background:#fff;border:1px solid #e1d3a5;border-radius:7px}td form{margin:0}@media(max-width:900px){.filters{grid-template-columns:1fr 1fr}}@media(max-width:720px){.filters{grid-template-columns:1fr}.operation-card{align-items:flex-start;flex-direction:column}.token-create label{width:100%}}
`;
