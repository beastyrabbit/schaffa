import { config } from "./config.js";
import type { FileRow, TokenRow } from "./db.js";
import type { PageSummary } from "./service.js";
import { filePublicUrl } from "./service.js";

export function renderAdminLogin(error?: string): string {
  return layout(
    "Admin sign-in",
    `<main class="login-shell">
      <section class="login-panel">
        <a class="wordmark" href="/">Mumpitz</a>
        <h1>Admin-Zugang</h1>
        <p class="lede">Mit einem Admin-Token anmelden. Der Token bleibt in einem HttpOnly-Cookie unter <code>/admin</code>.</p>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
        <form method="post" action="/admin/login">
          <label for="token">Admin-Token</label>
          <input id="token" name="token" type="password" required autocomplete="current-password" placeholder="mpt_…">
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
        <span class="wordmark">Mumpitz</span>
        <p class="error-code">404</p>
        <h1>Seite nicht gefunden</h1>
        <p class="lede">Unter diesem Slug wurde noch nichts veröffentlicht. Prüfe die URL oder veröffentliche die Seite erneut.</p>
      </section>
    </main>`,
  );
}

export function renderAdmin(input: {
  pages: PageSummary[];
  files: FileRow[];
  tokens: TokenRow[];
  actorName: string;
}): string {
  const pageRows = input.pages
    .map(
      (page) => `<tr>
        <td><a href="${config.baseUrl}/p/${encodeURIComponent(page.slug)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.slug)}</a>${page.title ? `<span class="sub">${escapeHtml(page.title)}</span>` : ""}</td>
        <td>v${page.current_version}</td>
        <td>${page.version_count}</td>
        <td>${formatBytes(page.latest_bytes)}</td>
        <td><time>${formatDate(page.updated_at)}</time></td>
      </tr>`,
    )
    .join("");

  const fileRows = input.files
    .map(
      (file) => `<tr>
        <td><a href="${filePublicUrl(file.filename)}" target="_blank" rel="noopener noreferrer">${escapeHtml(file.filename)}</a></td>
        <td>${escapeHtml(file.media_type)}</td>
        <td>${formatBytes(file.bytes)}</td>
        <td><time>${formatDate(file.created_at)}</time></td>
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
      </tr>`,
    )
    .join("");

  return layout(
    "Admin",
    `<header class="topbar">
      <a class="wordmark" href="/admin">Mumpitz</a>
      <div class="identity"><span>${escapeHtml(input.actorName)}</span><form method="post" action="/admin/logout"><button class="quiet" type="submit">Abmelden</button></form></div>
    </header>
    <main class="workspace">
      <div class="page-heading"><div><h1>Publikationen</h1><p>Öffentliche Seiten und Dateien dieses Servers.</p></div><a class="docs-link" href="${config.baseUrl}/api" target="_blank" rel="noopener noreferrer">API ansehen</a></div>
      <nav class="tabs" aria-label="Bereiche"><a href="#pages">Seiten <span>${input.pages.length}</span></a><a href="#files">Dateien <span>${input.files.length}</span></a><a href="#tokens">Tokens <span>${input.tokens.length}</span></a></nav>
      <section id="pages"><div class="section-heading"><h2>Seiten</h2><p>Ein erneuter Upload unter demselben Slug erzeugt die nächste Version.</p></div><div class="table-wrap"><table><thead><tr><th>Slug</th><th>Aktuell</th><th>Versionen</th><th>Größe</th><th>Geändert</th></tr></thead><tbody>${pageRows || emptyRow(5, "Noch keine Seiten veröffentlicht.")}</tbody></table></div></section>
      <section id="files"><div class="section-heading"><h2>Dateien</h2><p>Unveränderliche URLs mit zufälliger 128-Bit-ID.</p></div><div class="table-wrap"><table><thead><tr><th>Datei</th><th>Typ</th><th>Größe</th><th>Hochgeladen</th></tr></thead><tbody>${fileRows || emptyRow(4, "Noch keine Dateien hochgeladen.")}</tbody></table></div></section>
      <section id="tokens"><div class="section-heading"><h2>Tokens</h2><p>Tokenwerte werden nur einmal ausgegeben; hier liegen ausschließlich HMAC-Hashes.</p></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Scopes</th><th>Zuletzt benutzt</th><th>Status</th></tr></thead><tbody>${tokenRows || emptyRow(4, "Keine Tokens vorhanden.")}</tbody></table></div></section>
    </main>`,
  );
}

function layout(title: string, content: string): string {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Mumpitz</title>
  <style>${styles}</style>
</head>
<body>${content}</body>
</html>`;
}

function emptyRow(columns: number, message: string): string {
  return `<tr><td colspan="${columns}" class="empty">${escapeHtml(message)}</td></tr>`;
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
`;
