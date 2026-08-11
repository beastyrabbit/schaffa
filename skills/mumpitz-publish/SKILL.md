---
name: mumpitz-publish
description: Publish static HTML pages and arbitrary files to a self-hosted Mumpitz instance and return stable public URLs. Use when Codex needs to upload or update an HTML plan under a chosen slug, publish an image/video/document for public access, or inspect Mumpitz upload failures. Requires MUMPITZ_URL and MUMPITZ_TOKEN in the environment.
---

# Mumpitz Publish

Publish through the bundled curl wrapper. Never print, echo, or pass `MUMPITZ_TOKEN` on the command line; let the script read it from the environment.

## Publish a page

Create a page with a random, non-semantic 12-character slug:

```sh
skills/mumpitz-publish/scripts/publish.sh page <html-file>
```

Do not derive new slugs from the page title or content. To update a previously published page, reuse the returned slug explicitly:

```sh
skills/mumpitz-publish/scripts/publish.sh page <existing-slug> <html-file>
```

Reusing a slug creates the next immutable version while its stable URL points to the latest version.

Read `publicUrl`, `rawUrl`, `versionUrl`, `versionRawUrl`, and `version` from the JSON response. Use `publicUrl` for humans. Use `rawUrl` when an agent should fetch and process the exact HTML source. Return immutable version URLs when revision history matters.

Mumpitz does not inject CSS or wrap the page. The uploaded file must be a complete HTML document and should include its own `<style>` block when styling is required. Both the normal and `/raw` URLs return the exact uploaded bytes; `/raw` is an explicit agent-facing alias, not a transformed representation.

Mumpitz rejects scripts, forms, frames, event-handler attributes, JavaScript URLs, and meta refresh. If an upload fails with `unsafe_html`, remove the active construct; do not weaken or bypass the policy.

## Publish a file

```sh
skills/mumpitz-publish/scripts/publish.sh file <path>
```

Return `publicUrl` and `filename` from the JSON response. The canonical URL is `/f/<22-character-id>.<extension>`. The original filename is never retained. File IDs encode 128 random bits in 22 URL-safe characters; uploading the same bytes again creates a new URL.

Recognized images are decoded, reduced to a maximum 2560-pixel edge, stripped of metadata, and stored only as WebP while preserving transparency. The original image is discarded immediately and `/original` does not exist. Videos and other non-image files are currently stored unchanged.

## Safety

- Use only files the user placed in scope.
- Inspect filenames and file types before upload; do not inspect secret-bearing env files.
- Do not add `--verbose`, shell tracing, or commands that expose request headers.
- Treat every returned URL as public and hard to guess only for 128-bit file IDs, not as access control.
- Stop on HTTP errors and report the response's `error` and `message` fields without exposing headers.
