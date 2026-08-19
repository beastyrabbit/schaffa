import { config } from "./config.js";

export interface ExampleSkill {
  slug: string;
  title: string;
  markdown: string;
}

export const exampleSkills: ExampleSkill[] = [
  {
    slug: "read",
    title: "Read Schaffa",
    markdown: `---
name: schaffa-read
description: Use when the user provides a Schaffa URL to read.
---

# Schaffa Read

Fetch the supplied URL with the shell. Do not use web search or a browser to retrieve it.

\`curl --fail --silent --show-error --location "<url>"\`

- Page URLs use \`/p/<slug>\`; append \`/raw\` when exact HTML source is needed.
- File URLs use \`/f/<id>.<ext>\`; save binary files with \`--output <temporary-file>\` before inspecting them.
- Guide URLs use \`/g/<slug>\`; use \`.md\` or \`.json\` when structured guide content is easier to process.

If curl fails, report its HTTP or network error. Do not substitute search results.`,
  },
  {
    slug: "html",
    title: "Write HTML",
    markdown: `---
name: schaffa-html
description: Use when the user asks to communicate through an HTML document, or if they mention "HTML" with no additional context.
---

# Schaffa HTML

Use this skill for a readable plan, spec, write-up, findings, summary, report, comparison, or set of UI mocks. Do not use it for HTML that ships as part of a product.

Create one complete, self-contained HTML file capped at 512 KB.

- Write it like a spec, not a landing page: dense, scannable, and without hero copy or decorative chrome.
- Make it mobile-readable with a responsive viewport and no fixed-width layout.
- Use semantic HTML, inline CSS, inline SVG, and data-URL images.
- For UI mocks, render real styled variants, label them A, B, C, and so on, and arrange them for direct comparison.
- Do not include scripts, forms, frames, event handlers, JavaScript URLs, meta refresh, external stylesheets, or external assets.
- Never include secrets, private URLs, or local filesystem paths.

Set \`SCHAFFA_URL\` to the Schaffa instance origin, then publish the finished file directly:

\`\`\`sh
curl --fail-with-body --silent --show-error \\
  -F "html=@<html-file>;type=text/html" \\
  "$SCHAFFA_URL/api/pages"
\`\`\`

Add \`-H "Authorization: Bearer $SCHAFFA_TOKEN"\` for a permanent page. Without it, the page expires after one hour. Keep one local file across revisions; for a permanent page, upload later versions with \`PUT /api/pages/<slug>\` so its public URL stays stable.

Read \`publicUrl\` from the JSON response and return it with the local path. Never claim the document is hosted before the upload succeeds, and do not verify it in a browser unless the user asks.`,
  },
  {
    slug: "file",
    title: "Upload File",
    markdown: `---
name: schaffa-file
description: Use when the user asks to upload or share a file, or a public file URL is needed.
---

# Schaffa File

Set \`SCHAFFA_URL\` to the Schaffa instance origin and require \`SCHAFFA_TOKEN\` in the environment. If the token is unset, tell the user instead of guessing.

\`\`\`sh
curl --fail-with-body --silent --show-error \\
  -H "Authorization: Bearer $SCHAFFA_TOKEN" \\
  -F "file=@<file>" \\
  "$SCHAFFA_URL/api/files"
\`\`\`

Read \`publicUrl\` from the JSON response and return it. On HTTP 401, report that the token is missing or invalid and do not retry.

Use only files the user placed in scope. Treat the URL as public. Schaffa removes the original filename; recognized images are stripped of metadata, resized when needed, converted to WebP, and the original image is discarded. Never write the token value literally or expose request headers.`,
  },
  {
    slug: "guide",
    title: "Write Guide",
    markdown: `---
name: schaffa-guide
description: Use when the user asks for a step-by-step guide.
---

# Schaffa Guide

Keep \`SCHAFFA_TOKEN\` in the environment. Start before the first relevant action. Keep \`.schaffa/guide-session.json\` and \`.schaffa/recordings/\` local and uncommitted; neither stores the token.

Prefer the automatic recorder when the agent can operate a dedicated browser or native macOS app:

- Browser: \`npx schaffa record --title "<title>" --browser "<url>"\`
- Desktop: \`npx schaffa record --title "<title>" --desktop --app <bundle-id>\`

Primary clicks are highlighted, saved locally, and uploaded in order. Close the browser or press Ctrl+C to drain captures and create the draft. Use Alt+Shift+R to pause on private screens. After an upload failure, run \`npx schaffa guide sync\`; do not reorder screenshots manually.

Inspect and correct the complete server-side draft before publishing. Use a one-based step number or exact step ID:

- Inspect: \`npx schaffa guide status --json\`
- Edit: \`npx schaffa guide edit-step --step <number-or-id> --title "<title>" --text "<instruction>"\`
- Replace an image: \`npx schaffa guide replace-screenshot --step <number-or-id> --screenshot <path>\`
- Delete: \`npx schaffa guide delete-step --step <number-or-id>\`

For mixed terminal, API, file, and browser workflows, use the manual lifecycle:

- Start: \`npx schaffa guide start --title "<title>"\`
- Add a step: \`npx schaffa guide step --title "<step>" --text "<instruction>" --action <type> --target "<target>" --verification "<expected-result>"\`
- Finish: \`npx schaffa guide finish --json\`

Record semantic state changes, not every technical click. Add \`--screenshot <path>\` only when visible state helps the reader. Never capture passwords, authentication, payments, private data, or secret-manager screens. Desktop mode ignores clicks outside the selected bundle ID, never reads editable accessibility values, and omits screenshots for secure controls. Visible form contents can still appear in screenshots, so review every step before publishing.

Writes use the persisted edit revision. On conflict, load and reconcile the current guide. Retry steps through their original idempotent manifest entry.

Inspect and fix preflight errors or possible secret findings, then run \`npx schaffa guide publish --json\`. Return the published public URL.`,
  },
  {
    slug: "presentation",
    title: "Write Presentation",
    markdown: `---
name: schaffa-presentation
description: Use when the user asks for a presentation, slide deck, or slides.
---

# Schaffa Presentation

Keep \`SCHAFFA_TOKEN\` in the environment and create the deck as Marp Markdown. Keep images local; do not use remote fonts, CDNs, or external image URLs.

Publish the HTML deck and its Markdown source:

\`npx schaffa publish <deck.md> --kind presentation --json\`

Add \`--export pdf\`, \`--export pptx\`, or both when the user wants downloadable exports. Return the presentation's public URL and any requested export URLs from the JSON response.`,
  },
];

export function findExampleSkill(slug: string): ExampleSkill | undefined {
  return exampleSkills.find((skill) => skill.slug === slug);
}

export function allSkillsMarkdown(): string {
  const sections = exampleSkills.flatMap((skill) => [
    `## ${skill.title}`,
    "",
    "````markdown",
    skill.markdown,
    "````",
    "",
  ]);
  return [
    "# Schaffa skills",
    "",
    "Each section contains one complete SKILL.md file.",
    "",
    ...sections,
  ].join("\n");
}

export function llmText(): string {
  return `# Schaffa

> Publish agent output as public URLs on self-hosted infrastructure.

## URL types

- \`/p/<slug>\`: published HTML page
- \`/f/<id>.<ext>\`: published file
- \`/g/<slug>\`: published step-by-step guide

All returned publication URLs are public. Read any of them with:

\`curl -fsSL "<url>"\`

## Skills

Install the general read skill and only the writing skills needed for the task.

### Read Schaffa

Use for every Schaffa URL, including pages, files, guides, and presentations.

${config.baseUrl}/skills/read/SKILL.md

### Write HTML

Use for readable plans, specs, reports, comparisons, and UI mocks.

${config.baseUrl}/skills/html/SKILL.md

### Upload a file

${config.baseUrl}/skills/file/SKILL.md

### Write a guide

${config.baseUrl}/skills/guide/SKILL.md

### Write a presentation

${config.baseUrl}/skills/presentation/SKILL.md

### HTTP API

Use for direct integrations:

- \`POST /api/pages\`: create a random page; anonymous static pages are supported
- \`PUT /api/pages/<slug>\`: create or update a permanent page
- \`POST /api/files\`: publish a file under a random ID
- \`/api/guides/*\`: record steps, attach screenshots, preflight, and publish a guide

Page and file writes return \`202 Accepted\` with \`publicUrl\`, \`scanStatus\`, and \`statusUrl\`. The public URL first shows a self-refreshing scan page, then serves clean content at the same URL. A rejected upload keeps the URL but deletes the payload and shows the scanner reason. Poll \`statusUrl\` only when machine-readable state is needed.

Writes require a bearer token except supported anonymous page creation. The full request schemas, limits, status codes, and guide operations are defined here:

${config.baseUrl}/metadata/openapi.json

## Resources

- Schaffa skills: ${config.baseUrl}/skills
- All skills as Markdown: ${config.baseUrl}/skills/all.md
- API reference: ${config.baseUrl}/api
`;
}
