# HTTP API and URL model

Set the server origin without placing credentials on the command line:

```sh
export SCHAFFA_URL="https://schaffa.dev"
```

New HTML pages may be uploaded anonymously. They remain visible for one hour, then disappear from public reads, the admin UI, and listing APIs. Their stored data is retained for 30 days before automatic deletion. Anonymous files and page updates are rejected.

Set `SCHAFFA_TOKEN="sfa_…"` for permanent pages, files, and updates. Public page and file reads do not require authentication.

## Pages

Create a page with a random, non-semantic slug:

```sh
curl --fail-with-body --silent --show-error \
  -F "html=@plan.html;type=text/html" \
  "$SCHAFFA_URL/api/pages"
```

Add `-H "Authorization: Bearer $SCHAFFA_TOKEN"` to make the new page permanent. Anonymous uploads are rate-limited and scanned before storage. If ClamAV is unavailable or returns an invalid response, the upload fails closed.

Update an existing page by reusing its slug:

```sh
curl --fail-with-body --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer $SCHAFFA_TOKEN" \
  -F "html=@plan.html;type=text/html" \
  "$SCHAFFA_URL/api/pages/$SLUG"
```

Each update creates the next immutable version:

| URL | Result |
| --- | --- |
| `/p/:slug` | Latest version |
| `/p/:slug/:version` | Specific immutable version |
| `/p/:slug/raw` | Latest byte-identical HTML source |
| `/p/:slug/:version/raw` | Specific byte-identical HTML source |

Schaffa does not inject CSS or add a viewer. Upload one complete UTF-8 HTML file, including its own `<style>` block when needed. Scripts, forms, frames, event handlers, JavaScript URLs, and meta refresh are rejected.

Uploaded HTML is parsed for policy checks and served as inert stored bytes under a strict Content Security Policy. It is never opened, rendered, or executed by the server. ClamAV receives anonymous upload bytes over its `INSTREAM` protocol and runs in a separate container.

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

File reads support byte ranges and immutable caching. Potentially active types such as HTML, SVG, XML, and JavaScript are served as downloads rather than rendered inline.

## Admin operations

Admin-scoped bearer tokens can list pages, files, and token metadata through `GET /api/pages`, `GET /api/files`, and `GET /api/tokens`. They can create a client token with:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $SCHAFFA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"desktop-codex","scopes":["upload"]}' \
  "$SCHAFFA_URL/api/tokens"
```

The plaintext token is returned only once. Store it immediately in the approved credential store.

## Bundled skill

The wrapper in [`skills/schaffa-publish`](../skills/schaffa-publish/SKILL.md) implements the page and file uploads with `curl`. An MCP server is intentionally unnecessary for this small API.
