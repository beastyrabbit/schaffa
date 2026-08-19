---
name: schaffa-publish
description: Publish static HTML pages, presentations, files, and incrementally recorded guides to Schaffa. Use when an agent should turn output into a public link or proactively document a workflow step by step. Requires SCHAFFA_URL; permanent content and every guide operation require SCHAFFA_TOKEN.
---

# Schaffa Publish

Publish through the bundled curl wrapper. Never print, echo, or pass `SCHAFFA_TOKEN` on the command line; let the script read it from the environment when required.

## Record a guide proactively

When a user asks for a guide or wants a workflow documented, start the guide before the first relevant action. Do not wait until the task is finished. Keep `.schaffa/guide-session.json` local and out of source control; it contains the random slug and current edit revision, not the bearer token.

Prefer the automatic recorder when the agent can operate a dedicated browser or
native macOS app through desktop control:

```sh
npx schaffa record --title "Project setup" --browser "https://app.example.com/projects"
npx schaffa record --title "Desktop setup" --desktop --app com.example.desktopapp
```

Every trusted primary click is highlighted, saved locally, and uploaded before
publication. Desktop mode ignores clicks outside the bundle ID passed to
`--app`, never reads editable accessibility values, and omits
screenshots for secure controls. Closing the browser or pressing Ctrl+C drains
the capture queue and finishes the guide as a draft. `Alt+Shift+R` pauses private screens. If any
upload fails, run `npx schaffa guide sync`; do not recreate or reorder the local
screenshots manually.

Inspect the complete server-side step list with `npx schaffa guide status
--json`. Correct it with `guide edit-step`, `guide replace-screenshot`, and
`guide delete-step`, using a one-based step number or exact step ID, before
`guide publish`.

```sh
npx schaffa guide start --title "Project setup"
npx schaffa guide step --title "Open projects" --text "Open the project list." --action navigate --target /projects
npx schaffa guide step --title "Create project" --text "Select New project." --screenshot step-002.png --action click --target "New project" --verification "The creation form is visible."
npx schaffa guide finish
npx schaffa guide publish
```

Record semantic state changes, not every technical click. Terminal, API, and file actions may be text-only. Capture browser or desktop screenshots explicitly only when the visible state helps a reader. Set capture false for passwords, authentication, payments, private data, and secret-manager screens. Before publishing, inspect the returned preflight; possible secrets block publication and missing screenshots remain warnings.

Each write sends the persisted `editRevision` as `If-Match`. A conflict means the guide changed elsewhere: load the current guide, reconcile intentionally, and retry. Step creation uses an idempotency key so retrying a timed-out request cannot duplicate it.

## Publish a presentation

Use Marp Markdown as the canonical source. The CLI renders the `bare` template, removes the Marp runtime, rejects active or external content, publishes the script-free HTML, and can upload PDF/PPTX plus the Markdown source:

```sh
npx schaffa publish deck.md --kind presentation --export pdf --export pptx --json
```

Requested PDF and PowerPoint files are linked directly from the published presentation.

Keep images local to the deck and do not reference CDNs or external fonts. The HTML page remains usable through CSS scroll snap with Schaffa's `script-src 'none'` policy.

## Publish a page

Create a page with a random, non-semantic 16-character slug:

```sh
skills/schaffa-publish/scripts/publish.sh page <html-file>
```

Without `SCHAFFA_TOKEN`, the page is anonymous: ClamAV scans it, it disappears after one hour, and its stored data is deleted after 30 days. Set the token when the page must remain permanent.

Do not derive new slugs from the page title or content. To update a previously published page, reuse the returned slug explicitly:

```sh
skills/schaffa-publish/scripts/publish.sh page <existing-slug> <html-file>
```

Reusing a slug creates the next immutable version while its stable URL points to the latest version.

Read `publicUrl`, `rawUrl`, `versionUrl`, `versionRawUrl`, and `version` from the JSON response. Use `publicUrl` for humans. Use `rawUrl` when an agent should fetch and process the exact HTML source. Return immutable version URLs when revision history matters.

Schaffa does not inject CSS into static pages. The uploaded file must be a complete HTML document and should include its own `<style>` block when styling is required. For static pages, both the normal and `/raw` URLs return the exact uploaded bytes; `/raw` is an explicit agent-facing alias, not a transformed representation.

Schaffa rejects scripts, forms, frames, event-handler attributes, JavaScript URLs, and meta refresh. If an upload fails with `unsafe_html`, remove the active construct; do not weaken or bypass the policy.

When the user explicitly needs runtime guidance or another interactive behavior, use the CLI with an approved interactive-only token: `npx schaffa upload <html-file> --interactive`. Do not silently switch a static publication to interactive. The instance and user must already be approved; visitors receive a warning and the page runs without network, storage, forms, pop-ups, or navigation.

## Publish a file

```sh
skills/schaffa-publish/scripts/publish.sh file <path>
```

Return `publicUrl` and `filename` from the JSON response. The canonical URL is `/f/<22-character-id>.<extension>`. The original filename is never retained. File IDs encode 128 random bits in 22 URL-safe characters; uploading the same bytes again creates a new URL.

Recognized images are decoded, reduced to a maximum 2560-pixel edge, stripped of metadata, and stored only as WebP while preserving transparency. The original image is discarded immediately and `/original` does not exist. Videos and other non-image files are currently stored unchanged.

## Safety

- Use only files the user placed in scope.
- Inspect filenames and file types before upload; do not inspect secret-bearing env files.
- Do not add `--verbose`, shell tracing, or commands that expose request headers.
- Treat every returned URL as public and hard to guess only for 128-bit file IDs, not as access control.
- Stop on HTTP errors and report the response's `error` and `message` fields without exposing headers.
