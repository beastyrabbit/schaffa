import { config } from "./config.js";
import type { GuideRow, TokenRow } from "./db.js";
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

export function renderLanding(): string {
  return layout(
    "Publish agent work",
    `<div class="landing-page"><header class="landing-nav">
      <a class="wordmark" href="/">Schaffa</a>
      <nav aria-label="Primary navigation"><a href="/api">API</a><a class="nav-action" href="/account">Sign in</a></nav>
    </header>
    <main class="landing">
      <section class="landing-hero">
        <div class="hero-content">
          <p class="kicker">Self-hosted publishing for agents</p>
          <h1>Turn finished work into a link.</h1>
          <p class="hero-copy">Give your agents a place to publish standalone HTML pages and files—on infrastructure you control, with revocable tokens and a stable API.</p>
        </div>
        <div class="hero-art" aria-hidden="true"><span>HTML in</span><strong>↘</strong><span>URL out</span></div>
      </section>
      <section class="quickstart" id="quickstart">
        <div><p class="kicker">One command</p><h2>Ship the page.</h2><p>Install nothing globally. Point the CLI at a complete HTML file and get back a public URL.</p></div>
        <pre><code>npx schaffa upload ./mypage.html</code></pre>
      </section>
    </main>
    <footer class="landing-footer"><span>Schaffa means getting work done.</span><span>Inspired by <a href="https://postplan.dev">PostPlan</a> and <a href="https://uploadthing.com">UploadThing</a>. Built to be self-hosted.</span></footer></div>`,
  );
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
      <p class="lede">Mit Shoo anmelden und eigene Uploads sowie Tokens für CLI und Agenten verwalten.</p>
      ${action}
    </section></main>`,
    scripts,
  );
}

export function renderAccount(input: {
  user: UserSession;
  pages: PageSummary[];
  files: FileSummary[];
  tokens: TokenRow[];
  newToken?: string;
  interactivePublishingEnabled: boolean;
}): string {
  const pageRows = input.pages
    .map(
      (page) => `<tr>
        <td><a href="${config.baseUrl}/p/${encodeURIComponent(page.slug)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.slug)}</a>${page.title ? `<span class="sub">${escapeHtml(page.title)}</span>` : ""}<span class="sub">${page.kind === "interactive" ? "Interactive" : "Statisch"}</span></td>
        <td>v${page.current_version}<span class="sub">${page.version_count} ${page.version_count === 1 ? "Version" : "Versionen"}</span></td>
        <td>${escapeHtml(page.uploader_name)}</td>
        <td>${formatBytes(page.latest_bytes)}</td>
        <td><time>${formatDate(page.updated_at)}</time></td>
        <td><div class="row-actions"><details><summary>Versionen</summary><div class="version-actions">${page.version_numbers.map((version) => `<form method="post" action="/account/pages/${encodeURIComponent(page.slug)}/versions/${version}/delete"><span>v${version}</span><button class="danger" type="submit">Löschen</button></form>`).join("")}</div></details><form method="post" action="/account/pages/${encodeURIComponent(page.slug)}/delete"><button class="danger" type="submit">Seite löschen</button></form></div></td>
      </tr>`,
    )
    .join("");
  const fileRows = input.files
    .map(
      (file) => `<tr>
        <td><a href="${filePublicUrl(file.filename)}" target="_blank" rel="noopener noreferrer">${escapeHtml(file.filename)}</a></td>
        <td>${escapeHtml(file.media_type)}</td>
        <td>${escapeHtml(file.uploader_name)}</td>
        <td>${formatBytes(file.bytes)}</td>
        <td><time>${formatDate(file.created_at)}</time></td>
        <td><form method="post" action="/account/files/${encodeURIComponent(file.id)}/delete"><button class="danger" type="submit">Löschen</button></form></td>
      </tr>`,
    )
    .join("");
  const tokenRows = input.tokens
    .map(
      (token) =>
        `<tr><td>${escapeHtml(token.name)}<span class="sub mono">${escapeHtml(token.id)}</span></td><td>${escapeHtml(token.scopes)}</td><td>${token.last_used_at ? formatDate(token.last_used_at) : "Noch nie"}</td><td>${token.revoked_at ? `<span class="state revoked">Widerrufen</span>` : `<span class="state">Aktiv</span>`}</td><td>${token.revoked_at ? "" : `<form method="post" action="/account/tokens/${encodeURIComponent(token.id)}/revoke"><button class="danger" type="submit">Widerrufen</button></form>`}</td></tr>`,
    )
    .join("");
  return layout(
    "Konto",
    `<header class="topbar"><a class="wordmark" href="/account">Schaffa</a><div class="identity"><span>${escapeHtml(input.user.displayName)}</span><form method="post" action="/account/logout"><button class="quiet" type="submit">Abmelden</button></form></div></header>
    <main class="workspace account-workspace">
      <div class="page-heading"><div><h1>Dein Konto</h1><p>Publikationen ansehen, löschen und ihre Zugänge verwalten.</p></div></div>
      ${input.newToken ? `<aside class="token-reveal"><strong>Token jetzt speichern</strong><p>Dieser Wert wird nur einmal angezeigt.</p><code>${escapeHtml(input.newToken)}</code></aside>` : ""}
      <nav class="tabs" aria-label="Kontobereiche"><a href="#pages">Seiten <span>${input.pages.length}</span></a><a href="#files">Dateien <span>${input.files.length}</span></a><a href="#tokens">Tokens <span>${input.tokens.length}</span></a></nav>
      <section id="pages"><div class="section-heading"><h2>Seiten</h2><p>Seiten, die mit einem deiner Tokens veröffentlicht wurden.</p></div><div class="table-wrap"><table><thead><tr><th>Slug</th><th>Stand</th><th>Token</th><th>Größe</th><th>Geändert</th><th>Aktion</th></tr></thead><tbody>${pageRows || emptyRow(6, "Du hast noch keine Seiten veröffentlicht.")}</tbody></table></div></section>
      <section id="files"><div class="section-heading"><h2>Dateien</h2><p>Dateien, die mit einem deiner Tokens hochgeladen wurden.</p></div><div class="table-wrap"><table><thead><tr><th>Datei</th><th>Typ</th><th>Token</th><th>Größe</th><th>Hochgeladen</th><th>Aktion</th></tr></thead><tbody>${fileRows || emptyRow(6, "Du hast noch keine Dateien hochgeladen.")}</tbody></table></div></section>
      <section id="tokens"><div class="section-heading"><h2>Agenten-Tokens</h2><p>Statische und interaktive Publikationen verwenden getrennte Tokens.</p></div><form class="operation-card token-create" method="post" action="/account/tokens"><label>Name<input name="name" required maxlength="80" placeholder="desktop-codex"></label><label>Typ<select name="scope"><option value="upload">Statische Uploads</option>${input.interactivePublishingEnabled && input.user.canPublishInteractive ? `<option value="interactive">Interaktive Seiten</option>` : ""}</select></label><button type="submit">Token erstellen</button></form>${input.interactivePublishingEnabled && input.user.canPublishInteractive ? `<p class="sub">Interactive-Tokens können ausschließlich interaktive HTML-Seiten veröffentlichen.</p>` : `<p class="sub">Interaktives Publishing ist für dieses Konto nicht freigegeben.</p>`}<div class="table-wrap token-table"><table><thead><tr><th>Name</th><th>Scope</th><th>Zuletzt benutzt</th><th>Status</th><th>Aktion</th></tr></thead><tbody>${tokenRows || emptyRow(5, "Noch keine Tokens vorhanden.")}</tbody></table></div></section>
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
  guides: Array<GuideRow & { step_count: number; uploader_name: string }>;
  tokens: TokenRow[];
  users: UserSummary[];
  settings: InstanceSettings;
  actorId: string;
  actorName: string;
  filters: AdminFilters;
  newToken?: string;
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
        <td><a href="${config.baseUrl}/p/${encodeURIComponent(page.slug)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.slug)}</a>${page.title ? `<span class="sub">${escapeHtml(page.title)}</span>` : ""}<span class="sub">${page.kind === "interactive" ? "Interactive" : "Statisch"}</span></td>
        <td>v${page.current_version}</td>
        <td>${page.version_count}</td>
        <td>${escapeHtml(page.uploader_name)}</td>
        <td>${page.expires_at ? `<span class="state temporary">Anonym</span><span class="sub">bis ${formatDate(page.expires_at)}</span>` : `<span class="state">Dauerhaft</span>`}</td>
        <td>${formatBytes(page.latest_bytes)}</td>
        <td><time>${formatDate(page.updated_at)}</time></td>
        <td><div class="row-actions"><details><summary>Versionen</summary><div class="version-actions">${page.version_numbers.map((version) => `<form method="post" action="/admin/pages/${encodeURIComponent(page.slug)}/versions/${version}/delete"><span>v${version}</span><button class="danger" type="submit">Löschen</button></form>`).join("")}</div></details><form method="post" action="/admin/pages/${encodeURIComponent(page.slug)}/delete"><button class="danger" type="submit">Seite löschen</button></form></div></td>
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

  const guideRows = input.guides
    .map(
      (guide) => `<tr>
        <td><a href="${config.baseUrl}/g/${encodeURIComponent(guide.slug)}" target="_blank" rel="noopener noreferrer">${escapeHtml(guide.slug)}</a><span class="sub">${escapeHtml(guide.title)}</span></td>
        <td><span class="state ${guide.status === "published" ? "" : "temporary"}">${escapeHtml(guide.status)}</span></td>
        <td>${guide.current_revision}</td><td>${guide.step_count}</td><td>${escapeHtml(guide.uploader_name)}</td>
        <td><time>${formatDate(guide.updated_at)}</time></td>
        <td><form method="post" action="/admin/guides/${encodeURIComponent(guide.slug)}/delete"><button class="danger" type="submit">Guide löschen</button></form></td>
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
        `<tr><td>${escapeHtml(user.name || user.email || "Shoo user")}<span class="sub mono">${escapeHtml(user.id)}</span></td><td>${user.email ? escapeHtml(user.email) : "Keine PII"}</td><td>${user.active_token_count} / ${user.token_count}</td><td>${user.can_publish_interactive ? `<span class="state">Freigegeben</span>` : `<span class="state revoked">Gesperrt</span>`}</td><td>${formatDate(user.last_login_at)}</td><td><div class="row-actions"><form method="post" action="/admin/users/${encodeURIComponent(user.id)}/interactive"><input type="hidden" name="allowed" value="${user.can_publish_interactive ? "false" : "true"}"><button type="submit">${user.can_publish_interactive ? "Interactive sperren" : "Interactive freigeben"}</button></form><form method="post" action="/admin/users/${encodeURIComponent(user.id)}/delete"><button class="danger" type="submit">Löschen</button></form></div></td></tr>`,
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
      ${input.newToken ? `<aside class="token-reveal"><strong>Admin-Token jetzt speichern</strong><p>Dieser Wert wird nur einmal angezeigt.</p><code>${escapeHtml(input.newToken)}</code></aside>` : ""}
      <form class="filters" method="get" action="/admin">
        <label>Suche<input type="search" name="q" value="${escapeHtml(input.filters.q)}" placeholder="Slug, Titel, Datei …"></label>
        <label>Uploader<select name="uploader"><option value="">Alle</option>${uploaders.map((uploader) => `<option value="${escapeHtml(uploader.id)}"${selected(input.filters.uploader, uploader.id)}>${escapeHtml(uploader.name)}</option>`).join("")}</select></label>
        <label>Art<select name="kind"><option value="all"${selected(input.filters.kind, "all")}>Alles</option><option value="pages"${selected(input.filters.kind, "pages")}>Seiten</option><option value="files"${selected(input.filters.kind, "files")}>Dateien</option></select></label>
        <label>Lebensdauer<select name="lifetime"><option value="all"${selected(input.filters.lifetime, "all")}>Alle</option><option value="permanent"${selected(input.filters.lifetime, "permanent")}>Dauerhaft</option><option value="anonymous-active"${selected(input.filters.lifetime, "anonymous-active")}>Anonym aktiv</option></select></label>
        <button type="submit">Filtern</button><a href="/admin">Zurücksetzen</a>
      </form>
      <nav class="tabs" aria-label="Bereiche"><a href="#operations">Betrieb</a><a href="#guides">Guides <span>${input.guides.length}</span></a><a href="#pages">Seiten <span>${pages.length}</span></a><a href="#files">Dateien <span>${files.length}</span></a><a href="#users">Nutzer <span>${input.users.length}</span></a><a href="#tokens">Tokens <span>${input.tokens.length}</span></a></nav>
      <section id="operations"><div class="section-heading"><h2>Betrieb</h2><p>Zugänge und Publishing im Notfall gezielt sperren.</p></div><div class="operation-list"><form class="operation-card" method="post" action="/admin/settings"><input type="hidden" name="writesLocked" value="${input.settings.writesLocked ? "false" : "true"}"><div><strong>${input.settings.writesLocked ? "Publishing gesperrt" : "Publishing aktiv"}</strong><span class="sub">${input.settings.writesLocked ? "Nur Lesezugriffe und Admin-Wiederherstellung sind möglich." : "Uploads und Seiten-Updates werden angenommen."}</span></div><button class="${input.settings.writesLocked ? "" : "danger"}" type="submit">${input.settings.writesLocked ? "Lockdown aufheben" : "Lockdown aktivieren"}</button></form><form class="operation-card" method="post" action="/admin/settings"><input type="hidden" name="interactivePublishingEnabled" value="${input.settings.interactivePublishingEnabled ? "false" : "true"}"><div><strong>Interaktives Publishing ${input.settings.interactivePublishingEnabled ? "aktiv" : "gesperrt"}</strong><span class="sub">Erfordert zusätzlich eine Freigabe pro Nutzer und einen eigenen Interactive-Token.</span></div><button class="${input.settings.interactivePublishingEnabled ? "danger" : ""}" type="submit">${input.settings.interactivePublishingEnabled ? "Instanzweit sperren" : "Instanzweit aktivieren"}</button></form><form class="operation-card" method="post" action="/admin/settings"><input type="hidden" name="signupsEnabled" value="${input.settings.signupsEnabled ? "false" : "true"}"><div><strong>Registrierungen ${input.settings.signupsEnabled ? "aktiv" : "gesperrt"}</strong><span class="sub">Steuert, ob eine neue Shoo-Identität ein Konto anlegen darf.</span></div><button class="${input.settings.signupsEnabled ? "danger" : ""}" type="submit">${input.settings.signupsEnabled ? "Registrierungen sperren" : "Registrierungen erlauben"}</button></form><form class="operation-card" method="post" action="/admin/settings"><input type="hidden" name="loginsEnabled" value="${input.settings.loginsEnabled ? "false" : "true"}"><div><strong>Anmeldungen ${input.settings.loginsEnabled ? "aktiv" : "gesperrt"}</strong><span class="sub">Beim Sperren werden alle aktiven Nutzersitzungen beendet.</span></div><button class="${input.settings.loginsEnabled ? "danger" : ""}" type="submit">${input.settings.loginsEnabled ? "Anmeldungen sperren" : "Anmeldungen erlauben"}</button></form></div></section>
      <section id="guides"><div class="section-heading"><h2>Guides</h2><p>Aufnahmen, Entwürfe und unveränderliche öffentliche Revisionen.</p></div><div class="table-wrap"><table><thead><tr><th>Guide</th><th>Status</th><th>Revision</th><th>Schritte</th><th>Uploader</th><th>Geändert</th><th>Aktion</th></tr></thead><tbody>${guideRows || emptyRow(7, "Noch keine Guides vorhanden.")}</tbody></table></div></section>
      <section id="pages"><div class="section-heading"><h2>Seiten</h2><p>Anonyme Seiten verschwinden nach einer Stunde; gespeichert bleiben sie 30 Tage.</p></div><div class="table-wrap"><table><thead><tr><th>Slug</th><th>Aktuell</th><th>Versionen</th><th>Uploader</th><th>Status</th><th>Größe</th><th>Geändert</th><th>Aktion</th></tr></thead><tbody>${pageRows || emptyRow(8, "Keine passenden Seiten gefunden.")}</tbody></table></div></section>
      <section id="files"><div class="section-heading"><h2>Dateien</h2><p>Unveränderliche URLs mit zufälliger 128-Bit-ID.</p></div><div class="table-wrap"><table><thead><tr><th>Datei</th><th>Typ</th><th>Uploader</th><th>Größe</th><th>Hochgeladen</th><th>Aktion</th></tr></thead><tbody>${fileRows || emptyRow(6, "Keine passenden Dateien gefunden.")}</tbody></table></div></section>
      <section id="users"><div class="section-heading"><h2>Nutzer</h2><p>Interaktive Seiten benötigen eine ausdrückliche Freigabe pro Shoo-Identität.</p></div><div class="table-wrap"><table><thead><tr><th>Nutzer</th><th>E-Mail</th><th>Aktive / alle Tokens</th><th>Interactive</th><th>Letzte Anmeldung</th><th>Aktion</th></tr></thead><tbody>${userRows || emptyRow(6, "Keine Nutzer vorhanden.")}</tbody></table></div></section>
      <section id="tokens"><div class="section-heading"><h2>Tokens</h2><p>Tokenwerte werden nur einmal ausgegeben; hier liegen ausschließlich HMAC-Hashes.</p></div><form class="operation-card token-create" method="post" action="/admin/tokens"><label>Name<input name="name" required maxlength="80" placeholder="production-admin"></label><label>Rolle<select name="scope"><option value="upload">Upload</option><option value="admin">Admin</option></select></label><button type="submit">Token erstellen</button></form><div class="table-wrap token-table"><table><thead><tr><th>Name</th><th>Scopes</th><th>Zuletzt benutzt</th><th>Status</th><th>Aktion</th></tr></thead><tbody>${tokenRows || emptyRow(5, "Keine Tokens vorhanden.")}</tbody></table></div></section>
    </main>`,
  );
}

export function renderInteractiveWarning(input: {
  slug: string;
  title: string | null;
  version: number;
  publisher: string;
  runUrl: string;
  executionAllowed: boolean;
}): string {
  return layout(
    input.title || input.slug,
    `<main class="login-shell"><section class="login-panel interactive-warning">
      <a class="wordmark" href="/">Schaffa</a>
      <p class="kicker">Interaktive Seite</p>
      <h1>Diese Seite führt Code aus.</h1>
      <p class="lede">Veröffentlicht von ${escapeHtml(input.publisher)} · ${escapeHtml(input.slug)} · Version ${input.version}</p>
      <p>Schaffa isoliert die Seite: Netzwerkzugriffe, Formulare, Browser-Speicher, Pop-ups und Navigation sind gesperrt. Trotzdem kann sie irreführende Inhalte zeigen oder den Tab stark belasten.</p>
      ${input.executionAllowed ? `<div class="row-actions"><a class="primary-link" href="${escapeHtml(input.runUrl)}">Seite isoliert starten</a><a href="/">Zurück zu Schaffa</a></div>` : `<p class="error">Die Ausführung wurde vom Betreiber oder für diesen Publisher deaktiviert.</p><a href="/">Zurück zu Schaffa</a>`}
    </section></main>`,
  );
}

function layout(title: string, content: string, scripts = ""): string {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/assets/favicon-c.svg" type="image/svg+xml">
  <link rel="icon" href="/assets/favicon-32.png" type="image/png" sizes="32x32">
  <link rel="apple-touch-icon" href="/assets/favicon-180.png" sizes="180x180">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#20211e">
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
.filters{margin-top:28px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--surface);display:grid;grid-template-columns:minmax(200px,2fr) repeat(3,minmax(130px,1fr)) auto auto;gap:12px;align-items:end}.filters label,.token-create label{display:grid;gap:6px;color:var(--muted);font-size:12px;font-weight:700}.filters input,.filters select,.token-create input,.token-create select{min-width:0;border:1px solid #aaa397;border-radius:7px;background:#fff;padding:9px 10px;color:var(--ink)}.filters button,.operation-card button,.primary-link{border:0;border-radius:7px;padding:10px 15px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer;text-decoration:none}.primary-link{display:block;text-align:center}.filters>a{padding:9px 4px;color:var(--muted);font-size:13px}.state.temporary{color:var(--accent)}button.danger{border:1px solid #d9aaa2;border-radius:7px;padding:7px 10px;background:#fff3f0;color:var(--danger);font-weight:700;cursor:pointer}.operation-list{display:grid;gap:10px}.operation-card{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:18px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.token-create{margin-bottom:14px}.token-create label{flex:1}.token-table{margin-top:14px}.account-workspace{max-width:1100px}.token-reveal{margin-top:28px;padding:18px;border:1px solid #d6b976;border-radius:10px;background:#fff8df}.token-reveal p{color:var(--muted)}.token-reveal code{display:block;overflow-wrap:anywhere;padding:12px;background:#fff;border:1px solid #e1d3a5;border-radius:7px}.row-actions{display:flex;align-items:flex-start;gap:8px}.row-actions summary{cursor:pointer;font-weight:700;color:var(--accent)}.version-actions{position:absolute;z-index:2;min-width:170px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:0 10px 24px rgba(44,39,30,.14)}.version-actions form{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px}.version-actions span{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}td form{margin:0}@media(max-width:900px){.filters{grid-template-columns:1fr 1fr}}@media(max-width:720px){.filters{grid-template-columns:1fr}.operation-card{align-items:flex-start;flex-direction:column}.token-create label{width:100%}.row-actions{min-width:230px}}
.landing-page{min-height:100vh;background-color:#f3f0e8;background-image:linear-gradient(rgba(32,33,30,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(32,33,30,.035) 1px,transparent 1px);background-size:32px 32px}.landing-nav{max-width:1240px;height:76px;margin:0 auto;padding:0 32px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid var(--ink)}.landing-nav .wordmark{font-size:28px}.landing-nav nav{display:flex;align-items:center;gap:24px;font-size:14px;font-weight:700}.landing-nav nav a{text-decoration:none}.landing-nav .nav-action{border:2px solid var(--ink);padding:9px 14px;background:#fbfaf6;box-shadow:3px 3px 0 var(--ink)}.landing-nav .nav-action:hover{background:#d8b64b}.landing{max-width:1240px;margin:0 auto;padding:0 32px}.landing-hero{min-height:650px;padding:68px 0 72px;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(340px,.85fr);gap:64px;align-items:center;border-bottom:2px solid var(--ink)}.hero-content{position:relative;z-index:1}.kicker{display:inline-block;margin:0 0 22px;padding:7px 10px;color:#fbfaf6;background:var(--accent);font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;transform:rotate(-1deg)}.landing-hero h1{max-width:760px;margin:0;font:700 clamp(58px,7.3vw,100px)/.88 Georgia,"Times New Roman",serif;letter-spacing:-.065em;text-wrap:balance}.hero-copy{max-width:640px;margin:32px 0 0;color:#484942;font-size:19px;line-height:1.6}.hero-art{aspect-ratio:760/720;position:relative;display:flex;align-items:flex-end;justify-content:center;gap:12px;padding:0 24px 32px;background:url('/assets/landing-bg.svg') center/contain no-repeat;filter:drop-shadow(11px 14px 0 rgba(32,33,30,.14));transform:rotate(2deg)}.hero-art span{padding:7px 9px;border:2px solid var(--ink);background:#fbfaf6;font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;box-shadow:3px 3px 0 var(--ink)}.hero-art strong{font-size:25px}.quickstart{display:grid;grid-template-columns:minmax(250px,.75fr) minmax(420px,1.25fr);gap:70px;align-items:center;padding:78px 0}.quickstart .kicker{margin-bottom:16px;background:#315a3a;transform:rotate(1deg)}.quickstart h2{margin:0;font:700 44px/1 Georgia,"Times New Roman",serif;letter-spacing:-.04em}.quickstart p{max-width:440px;color:var(--muted);line-height:1.6}.quickstart pre{margin:0;overflow-x:auto;padding:27px;border:2px solid var(--ink);background:#292a26;color:#f6f2e9;box-shadow:9px 9px 0 #d8b64b;transform:rotate(-.5deg)}.quickstart code{font-size:14px;line-height:1.8}.landing-footer{max-width:1240px;margin:0 auto;padding:26px 32px 42px;border-top:2px solid var(--ink);display:flex;justify-content:space-between;gap:24px;color:var(--muted);font-size:13px}@media(max-width:860px){.landing-hero{grid-template-columns:minmax(0,1fr) minmax(280px,.7fr);gap:30px}.landing-hero h1{font-size:64px}}@media(max-width:680px){.landing-nav{height:66px;padding:0 18px}.landing-nav nav{gap:14px}.landing{padding:0 18px}.landing-hero{min-height:auto;padding:58px 0 54px;grid-template-columns:1fr;gap:42px}.landing-hero h1{font-size:56px}.hero-copy{font-size:17px}.hero-art{width:min(430px,94%);margin:0 auto}.quickstart{grid-template-columns:1fr;gap:30px;padding:58px 0}.quickstart pre{margin-right:9px;padding:20px}.quickstart code{font-size:12px}.landing-footer{padding:24px 18px 34px;flex-direction:column}}
`;
