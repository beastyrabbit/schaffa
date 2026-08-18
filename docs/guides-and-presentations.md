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

`schaffa publish deck.md --kind presentation` uses Marp's `bare` renderer. Marp currently emits a small auto-scaling runtime even for this template, so the CLI removes all scripts and rejects active or external content before uploading the HTML through the existing page validator. CSS scroll snap preserves native slide-by-slide navigation without weakening Schaffa's CSP. The Markdown source remains canonical, while PDF and PPTX are optional immutable file uploads.

Local images are allowed during rendering. Do not put remote fonts, CDNs, or external image URLs in a deck; the CLI rejects the resulting HTML. PDF/PPTX exports require a supported local Chromium installation used by Marp.

## Capture adapter contract

A browser, Chrome, or desktop adapter should explicitly save a screenshot only after a meaningful state transition. It then calls the normal step endpoint with:

- a short action-oriented title,
- enough context to reproduce the step,
- an optional action type and target,
- an expected result or verification,
- the screenshot if the visible state matters.

Authentication, password, payment, private-data, and secret-manager steps should use `capture: false`. This deliberate contract avoids depending on undocumented session-internal screenshots and makes interrupted recordings resumable from server state.
