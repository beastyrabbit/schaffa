# HTTP API and URL model

The stable OpenAPI 3.1 contract is published at
`https://schaffa.dev/metadata/openapi.json`.

Set the server origin without placing credentials on the command line:

```sh
export SCHAFFA_URL="https://schaffa.dev"
```

New HTML pages may be uploaded anonymously. They remain visible for one hour, then disappear from public reads and the admin UI. Their stored data is retained for 30 days before automatic deletion. Anonymous files and page updates are rejected.

Set `SCHAFFA_TOKEN="sfa_…"` for permanent pages, files, and updates. Public page and file reads do not require authentication.

## User accounts

`GET /account` provides the Shoo-backed user dashboard. Shoo handles Google OAuth and PKCE in the browser; Schaffa verifies every returned ID token server-side against the configured JWKS, issuer, expiration, ES256 signature, and exact `origin:<SCHAFFA_BASE_URL origin>` audience. The verified `pairwise_sub` becomes the local user identity.

A first login creates a local user when signups are enabled. Users can create and revoke their own upload tokens from the dashboard; plaintext values are shown once. When an administrator enables Interactive Publishing both instance-wide and for a specific user, that user can also mint separate interactive-only tokens. Schaffa stores an HMAC hash of its local HttpOnly session token, not the Shoo ID token. Automated tests inject a local verifier and never call Shoo.

## Pages

Create a page with a random, non-semantic slug:

```sh
curl --fail-with-body --silent --show-error \
  -F "html=@plan.html;type=text/html" \
  "$SCHAFFA_URL/api/pages"
```

Add `-H "Authorization: Bearer $SCHAFFA_TOKEN"` to make the new page permanent. All uploads are rate-limited and scanned before publication. If ClamAV is unavailable or returns an invalid response, the upload fails closed.

Create a permanent page at a chosen slug, or update it later by reusing that slug:

```sh
curl --fail-with-body --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer $SCHAFFA_TOKEN" \
  -F "html=@plan.html;type=text/html" \
  "$SCHAFFA_URL/api/pages/$SLUG"
```

An unused slug creates version 1. Only the token that created a permanent page may update it; admin tokens may update any permanent page. Anonymous pages cannot be claimed or updated, and their expiration is never cleared. Each update creates the next immutable version. The oldest version is deleted when the configured per-page version cap is exceeded:

Both page endpoints accept an optional `?title=` query parameter of up to 160 characters. Omitting it during an update retains the existing title.

### Trusted interactive pages

Static pages remain the default. Interactive publishing is disabled instance-wide until an administrator enables it, grants one Shoo user permission, and that user creates an `interactive` token. The dedicated token cannot publish static pages, files, presentations, or guides. The permission is checked on every write and execution start; removing it revokes the user's interactive tokens and blocks new loads of their existing interactive pages. The instance-wide switch is also a kill switch for new execution starts. Code already loaded in an open tab can continue until the tab is closed or reloaded.

Publish an interactive page by adding `?type=interactive` or using the CLI's `--interactive` flag. Page type is immutable across versions. Anonymous publishing and global admin tokens cannot publish interactive pages.

The public page URL shows a warning screen. Continuing to `/run` executes only inline classic scripts under a CSP sandbox without `allow-same-origin`. Network access, workers, child frames, forms, browser storage, pop-ups, downloads, and top-level navigation are unavailable. External and module scripts, event-handler attributes, frames, forms, JavaScript URLs, and meta refresh are rejected during upload. The sandbox reduces risk but cannot prevent misleading UI or a page from consuming CPU in its own tab.

| URL | Result |
| --- | --- |
| `/p/:slug` | Latest version |
| `/p/:slug/:version` | Specific immutable version |
| `/p/:slug/raw` | Latest byte-identical HTML source |
| `/p/:slug/:version/raw` | Specific byte-identical HTML source |
| `/p/:slug/run` | Latest interactive version in the restricted sandbox |
| `/p/:slug/:version/run` | Specific interactive version in the restricted sandbox |

Server-generated page slugs contain approximately 83 random bits; caller-chosen slugs have only the entropy supplied by the caller. Page URLs are public identifiers—not access control. Treat them the same way as file URLs and use admin takedown when a URL or its content is exposed unintentionally.

Schaffa does not inject CSS into uploaded content. Upload one complete UTF-8 HTML file, including its own `<style>` block when needed. Static pages reject scripts, forms, frames, event handlers, JavaScript URLs, and meta refresh.

Uploaded HTML is parsed for policy checks and served as inert stored bytes under a strict Content Security Policy. It is never opened, rendered, or executed by the server. ClamAV receives every upload over its `INSTREAM` protocol and runs in a separate container.

## Files

Upload one file in the multipart field `file`:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $SCHAFFA_TOKEN" \
  -F "file=@diagram.png" \
  "$SCHAFFA_URL/api/files"
```

The response contains an immutable URL shaped like `/f/<22-character-id>.<extension>`. The original filename is not stored. IDs contain 128 random bits and are difficult to guess, but the URL is not access control.

Recognized images are auto-oriented, resized, stripped of EXIF/XMP/IPTC/ICC metadata, and stored only as WebP. Transparency is retained and the original image is discarded immediately. Videos and other non-image files are currently stored unchanged.

File reads support byte ranges. Public file and version responses use a five-minute cache lifetime so an admin takedown is not hidden behind a year-long immutable cache. Potentially active types such as HTML, SVG, XML, JavaScript, and PDF are served as downloads rather than rendered inline; file responses also carry a sandboxed, deny-by-default CSP.

## Administration

Administration is intentionally not part of the public HTTP API or OpenAPI contract. Use the protected `/admin` interface to list and remove pages, individual page versions, and files; create and revoke upload or admin tokens; delete users; grant interactive publishing per user; and control publishing lockdown, interactive publishing, signups, and logins.

Publishing lockdown preserves reads and takedowns. Disabling logins immediately deletes all active user sessions; disabling signups still permits existing users to log in. Revoking the bootstrap token requires another active admin token. Restarting with the same bootstrap environment value never reactivates it, but setting a new, different value replaces the stored hash and reactivates bootstrap; that rotation is the recovery path when every other admin token is lost.

## Bundled skill

The wrapper in [`skills/schaffa-publish`](../skills/schaffa-publish/SKILL.md) implements the page and file uploads with `curl`. An MCP server is intentionally unnecessary for this small API.
