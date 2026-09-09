# Guides and presentations

Schaffa treats a guide as a server-side recording and a presentation as a rendered publication.

## Guide lifecycle

1. `POST /api/guides` allocates a random 12-character slug in `recording` state. Its optional `targetUrl` becomes the “Ziel öffnen” link in the published guide.
2. `POST /api/guides/:slug/steps` appends JSON and an optional screenshot immediately.
3. Mutations use the current `editRevision` in `If-Match`; stale writes return `409 edit_conflict`.
4. Step creation accepts an `Idempotency-Key` and replays its original response on retry.
5. `finish` runs the editorial preflight and publishes complete JSON, Markdown,
   and HTML snapshots as an immutable revision.

Recordings and their screenshots require the owning upload token or an admin
token. Public `/g/:slug`, `.json`, `.md`, and image routes expose only assets
that belong to at least one published revision. Editing a published guide
automatically publishes a new immutable revision and never changes an older
revision.

The preflight blocks empty guides, incomplete visible steps, and likely tokens, secrets, passwords, or email addresses in text. Missing screenshots are warnings because terminal and API steps are intentionally allowed to remain text-only. Image OCR and pixel-level redaction remain future capture-quality work; users must still review visible screenshot contents before publication.

Preflight covers guide title, description, destination URL, and visible step fields. Findings identify the affected field. URL-encoded text is checked too. Public guide revisions and screenshots use five-minute caches with revalidation, matching page/file takedown timing. Existing downloaded copies and caches created under older one-year headers cannot be recalled.

Guide defaults allow 1,000 steps, 1,000 published revisions, and 64 MiB of text metadata per guide, configurable with `MAX_GUIDE_STEPS`, `MAX_GUIDE_REVISIONS`, and `MAX_GUIDE_METADATA_BYTES`. Existing immutable revisions are retained. Exceeding a budget rejects the edit without advancing its revision. Draft edits that do not increase metadata, including text reduction, step deletion, and reordering, remain available when an operator lowers a budget below existing usage.

Every published edit, including a step deletion, creates another immutable snapshot. Reaching the revision cap freezes further edits until an administrator raises `MAX_GUIDE_REVISIONS`. Retained snapshots can also exhaust the metadata or instance storage budget, so deleting text from a published guide may still require additional capacity. An administrator can raise the relevant limit or take down the entire guide. Deleting a step never removes it from previously published revisions; request full takedown for sensitive material in history. Previously downloaded copies cannot be recalled.

Guide text, snapshots, and idempotency responses count toward `MAX_STORAGE_BYTES` alongside publication and image bytes. SQLite triggers maintain per-guide and instance text counters in the same transaction as each write, including rollback and deletion. This is a logical content budget; SQLite indexes, WAL, and temporary conversion files still require extra disk space.

## Presentation pipeline

`schaffa publish deck.md --kind presentation` uses Marp's `bare` renderer. Marp currently emits a small auto-scaling runtime even for this template, so the CLI removes all scripts and rejects active or external content before uploading the HTML through the existing page validator. CSS scroll snap preserves native slide-by-slide navigation without weakening Schaffa's CSP. The Markdown source remains canonical, while PDF and PPTX are optional immutable file uploads. When either format is requested with `--export`, the CLI adds same-origin download links for the generated files to the published deck. The links need no JavaScript and are omitted from printing.

Local PNG, JPEG, GIF, and WebP images inside the Markdown source directory are embedded in the published HTML, including slide backgrounds. The CLI's per-image ceiling is 2 MiB, but base64 adds roughly one third to the image bytes. With the default 2 MiB page limit, aim below 1.4 MiB of image data for an entire one-image deck and leave space for Marp's HTML and CSS. Multiple images share that page budget. The final HTML must fit the instance's configured page limit. Unsupported local formats, images outside the source directory, CSS imports, and unresolved assets fail before publication. Do not put remote fonts, CDNs, or external image URLs in a deck; the CLI rejects the resulting HTML. PDF/PPTX exports require a supported local Chromium installation used by Marp.

## Capture adapter contract

A browser, Chrome, or desktop adapter should explicitly save a screenshot only after a meaningful state transition. It then calls the normal step endpoint with:

- a short action-oriented title,
- enough context to reproduce the step,
- an optional action type and target,
- an expected result or verification,
- the screenshot if the visible state matters.

Authentication, password, payment, private-data, and secret-manager steps should use `capture: false`. This deliberate contract avoids depending on undocumented session-internal screenshots and makes interrupted recordings resumable from server state.

## Automatic browser and desktop recorder

`npx schaffa record --title <title> --chrome <url>` opens a new window in the
already running Google Chrome on macOS and starts the server-side guide before
navigation. It does not create a profile or choose among multiple existing
Chrome profiles. Chrome supplies an existing profile session, whose logins,
extensions, and password manager remain available. The native recorder pins the
new window's exact macOS window ID, so clicks in every other Chrome window are
ignored. Closing that window ends the recording without closing Chrome.

`npx schaffa record --title <title> --browser <url>` remains available as an
isolated alternative with a separate persistent Schaffa browser profile.
The compatible legacy form is `npx schaffa guide record --title <title> --url
<url>`.
In Chrome mode, macOS Accessibility derives a short target from the clicked
control and Screen Recording captures that window before the click is
delivered. In isolated browser mode, an injected capture script reads the
control's accessible name, label, or visible text and selects the most recent
pre-click browser frame. Both modes record the target box and click coordinates.
The server renders the red outline and compact cursor into the cleaned WebP. Event
metadata never contains typed values or keystrokes; visible form contents can
still appear in screenshot pixels and must be reviewed.

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

The isolated browser profile lives outside the project at
`~/.schaffa/browser-profile`. Chrome mode never uses it. Both automatic modes
suppress screenshots for password and secure controls; isolated browser mode
also checks common authentication, payment, billing, and secret URL paths. Use
`Alt+Shift+R` to pause and resume on any other private screen. Closing the
recorded window or pressing Ctrl+C
waits for in-flight captures and uploads; a clean recording passes preflight
and is published automatically.

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

An agent can inspect and correct the active guide without working directly with
raw API revisions. Corrections after publication immediately create a new
immutable revision:

```sh
npx schaffa guide status --json
npx schaffa guide edit-step --step 2 --title "Choose New project" --text "Select New project."
npx schaffa guide replace-screenshot --step 2 --screenshot ./correct-step.png
npx schaffa guide delete-step --step 3
npx schaffa guide finish
```

Screenshot replacement runs the supplied image through the normal image
cleaner. The guide step does not retain click-marker coordinates after the first
upload, so replacement cannot recreate the recorder cursor or target outline.
Add those annotations to the replacement image before uploading it when needed.

Desktop mode currently targets macOS. Other operating systems can continue to
use manual guide steps until equivalent native helpers are implemented.

## Guide and standalone video

`schaffa record --browser <url> --title <title> --video` saves continuous browser
frames locally and exports a paced WebM before finishing the guide. The existing
Chrome-window and desktop adapters support `--video` using their saved stills.
`schaffa video record --browser <url> --output demo.webm` records locally without
creating a server guide; `--upload` explicitly publishes the result. Both use
the same renderer. ffmpeg with libvpx-vp9 and a local Chromium are required.

The browser sampler captures the first tab at up to 10 fps, checks private-screen
conditions before and after screenshots, and drops work spanning a pause toggle.
Rendering produces 1280 × 800 video at 20 fps, adds 2.5 seconds per click for
cursor movement and a click ring, caps idle holds at three seconds, and holds
the final frame for two seconds. Cursor paths are illustrated from click
coordinates. Typed values, actual pointer paths, and audio are not event metadata.
Screenshots can still contain visible personal information. Native still exports
cannot recover transitions, scrolling, or a final state absent from the capture.

Frames and `video/video.json` remain under the recording directory with owner-only
permissions. Capture stops accepting frames at 512 MiB and fails export instead
of silently publishing a truncated clip. `schaffa video export --manifest <path>
--output <new.webm>` retries locally. Existing output files are never replaced.
`schaffa guide video` exports a saved recording for the active guide. Edited
guides require a new matching capture; exporting an old manifest does not apply
later screenshot or text corrections.

`PATCH /api/guides/:slug` accepts `videoUrl` or `null`. A video must be an MP4 or
WebM uploaded to this instance by the guide's owning token and have a clean scan.
The URL is saved in immutable revisions and exposed in JSON and Markdown. HTML
renders native playback controls and a download link. Subsequent guide edits
clear the video in the new revision, preserving older snapshots. File takedown
still applies through the normal file endpoint. Videos are public file uploads,
including when attached to a guide that has not been finished yet.
