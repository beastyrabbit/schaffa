# HTTP API and URL model

Set these client variables without placing the token on the command line:

```sh
export MUMPITZ_URL="https://mumpitz.heerlab.com"
export MUMPITZ_TOKEN="mpt_…"
```

API writes use `Authorization: Bearer $MUMPITZ_TOKEN`. Public page and file reads do not require authentication.

## Pages

Create a page with a random, non-semantic slug:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $MUMPITZ_TOKEN" \
  -F "html=@plan.html;type=text/html" \
  "$MUMPITZ_URL/api/pages"
```

Update an existing page by reusing its slug:

```sh
curl --fail-with-body --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer $MUMPITZ_TOKEN" \
  -F "html=@plan.html;type=text/html" \
  "$MUMPITZ_URL/api/pages/$SLUG"
```

Each update creates the next immutable version:

| URL | Result |
| --- | --- |
| `/p/:slug` | Latest version |
| `/p/:slug/:version` | Specific immutable version |
| `/p/:slug/raw` | Latest byte-identical HTML source |
| `/p/:slug/:version/raw` | Specific byte-identical HTML source |

Mumpitz does not inject CSS or add a viewer. Upload one complete UTF-8 HTML file, including its own `<style>` block when needed. Scripts, forms, frames, event handlers, JavaScript URLs, and meta refresh are rejected.

## Files

Upload one file in the multipart field `file`:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $MUMPITZ_TOKEN" \
  -F "file=@diagram.png" \
  "$MUMPITZ_URL/api/files"
```

The response contains an immutable URL shaped like `/f/<22-character-id>.<extension>`. The original filename is not stored. IDs contain 128 random bits and are difficult to guess, but the URL is not access control.

Recognized images are auto-oriented, resized, stripped of EXIF/XMP/IPTC/ICC metadata, and stored only as WebP. Transparency is retained and the original image is discarded immediately. Videos and other non-image files are currently stored unchanged.

File reads support byte ranges and immutable caching. Potentially active types such as HTML, SVG, XML, and JavaScript are served as downloads rather than rendered inline.

## Admin operations

Admin-scoped bearer tokens can list pages, files, and token metadata through `GET /api/pages`, `GET /api/files`, and `GET /api/tokens`. They can create a client token with:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $MUMPITZ_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"desktop-codex","scopes":["upload"]}' \
  "$MUMPITZ_URL/api/tokens"
```

The plaintext token is returned only once. Store it immediately in the approved credential store.

## Bundled skill

The wrapper in [`skills/mumpitz-publish`](../skills/mumpitz-publish/SKILL.md) implements the page and file uploads with `curl`. An MCP server is intentionally unnecessary for this small API.
