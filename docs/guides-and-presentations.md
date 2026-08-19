# Guides and presentations

Schaffa treats a guide as a server-side recording and a presentation as a rendered publication.

## Guide lifecycle

1. `POST /api/guides` allocates a random 12-character slug in `recording` state. Its optional `targetUrl` becomes the “Ziel öffnen” link in the published guide.
2. `POST /api/guides/:slug/steps` appends JSON and an optional screenshot immediately.
3. Mutations use the current `editRevision` in `If-Match`; stale writes return `409 edit_conflict`.
4. Step creation accepts an `Idempotency-Key` and replays its original response on retry.
5. `finish` moves the recording to `draft` and returns the editorial preflight.
6. `publish` stores complete JSON, Markdown, and HTML snapshots as an immutable revision.

Drafts and their screenshots require the owning upload token or an admin token. Public `/g/:slug`, `.json`, `.md`, and image routes expose only assets that belong to at least one published revision. Editing a published guide automatically begins a new draft and never changes an older revision.

The preflight blocks empty guides, incomplete visible steps, and likely tokens, secrets, passwords, or email addresses in text. Missing screenshots are warnings because terminal and API steps are intentionally allowed to remain text-only. Image OCR and pixel-level redaction remain future capture-quality work; users must still review visible screenshot contents before publication.

## Presentation pipeline

`schaffa publish deck.md --kind presentation` uses Marp's `bare` renderer. Marp currently emits a small auto-scaling runtime even for this template, so the CLI removes all scripts and rejects active or external content before uploading the HTML through the existing page validator. CSS scroll snap preserves native slide-by-slide navigation without weakening Schaffa's CSP. The Markdown source remains canonical, while PDF and PPTX are optional immutable file uploads. When either format is requested with `--export`, the CLI adds same-origin download links for the generated files to the published deck. The links need no JavaScript and are omitted from printing.

Local images are allowed during rendering. Do not put remote fonts, CDNs, or external image URLs in a deck; the CLI rejects the resulting HTML. PDF/PPTX exports require a supported local Chromium installation used by Marp.

## Capture adapter contract

A browser, Chrome, or desktop adapter should explicitly save a screenshot only after a meaningful state transition. It then calls the normal step endpoint with:

- a short action-oriented title,
- enough context to reproduce the step,
- an optional action type and target,
- an expected result or verification,
- the screenshot if the visible state matters.

Authentication, password, payment, private-data, and secret-manager steps should use `capture: false`. This deliberate contract avoids depending on undocumented session-internal screenshots and makes interrupted recordings resumable from server state.

## Automatic browser and desktop recorder

`npx schaffa record --title <title> --browser <url>` launches a dedicated,
persistent browser profile and starts the server-side guide before navigation.
The compatible legacy form is `npx schaffa guide record --title <title> --url
<url>`.
The initial page and every trusted primary-button click become ordered steps.
The capture script derives a short target from accessible names, labels, or
visible text and records the target box plus click coordinates against the most
recent pre-click browser frame. The server renders the red outline and click
dot into the cleaned WebP. Event metadata never contains typed values or keystrokes; visible
form contents can still appear in screenshot pixels and must be reviewed.

Each screenshot is written first to a JPEG or PNG under
`.schaffa/recordings/<slug>/step-NNNN.*`. The adjacent `manifest.json` records
the page URL, title, selector, click coordinates, timestamp, upload state, and
server step ID. Uploads are serialized because the guide API uses optimistic
revisions. After one upload fails, later uploads remain local instead of being
appended out of order. `npx schaffa guide sync` retries the manifest in order
with the original idempotency keys. An older recording can be recovered even
when another guide is active by passing `--manifest <path>`; the guide slug is
read from that manifest.

Manifest updates use an atomic same-directory rename, so an interrupted write
leaves either the previous complete manifest or the new one. Screenshot and
manifest files are owner-readable only.

The browser profile lives outside the project at `~/.schaffa/browser-profile`
so website sessions survive between recordings. The recorder automatically
suppresses screenshots for password/card inputs and common authentication,
payment, billing, and secret URL paths. Use `Alt+Shift+R` to pause and resume on
any other private screen. Closing the recording browser or pressing Ctrl+C
waits for in-flight captures and uploads; a clean recording is moved to draft
and returns the preflight result.

`npx schaffa record --title <title> --desktop --app <bundle-id>` records one
native macOS app instead of opening a URL. A small ad-hoc-signed Swift helper is compiled once into a
stable, source-hashed path under `~/.schaffa/bin/`. Accessibility identifies the
clicked control and Screen Recording captures the window before the click is
delivered. Clicks in the Dock or any app whose bundle ID does not match `--app`
are ignored. The helper reads only accessibility role, title, description, help,
identifier, and bounds—never an editable value. Secure/password controls
suppress the screenshot entirely. Coordinates and bounds are window-relative,
and desktop events reuse the same atomic manifest, serialized upload, sync,
review, and correction pipeline as browser recordings.

Before publishing, an agent can inspect and correct the active guide without
working directly with raw API revisions:

```sh
npx schaffa guide status --json
npx schaffa guide edit-step --step 2 --title "Choose New project" --text "Select New project."
npx schaffa guide replace-screenshot --step 2 --screenshot ./correct-step.png
npx schaffa guide delete-step --step 3
npx schaffa guide finish
npx schaffa guide publish
```

Desktop mode currently targets macOS. Other operating systems can continue to
use manual guide steps until equivalent native helpers are implemented.
