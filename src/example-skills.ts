import { config } from "./config.js";

export interface ExampleSkill {
  slug: string;
  title: string;
  markdown: string;
}

export const exampleSkills: ExampleSkill[] = [
  {
    slug: "read",
    title: "Read",
    markdown: `---
name: schaffa-read
description: This skill should be used to read any Schaffa URL.
---

# Read

Run \`curl -fsSL "<url>"\`. Works for \`/p/\`, \`/f/\`, and \`/g/\`.`,
  },
  {
    slug: "write",
    title: "Write",
    markdown: `---
name: schaffa-write
description: This skill should be used to publish a page or file to Schaffa.
---

# Write

Keep \`SCHAFFA_TOKEN\` in the environment. Run \`npx schaffa upload <file>\`; return the public URL.`,
  },
];

export function findExampleSkill(slug: string): ExampleSkill | undefined {
  return exampleSkills.find((skill) => skill.slug === slug);
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

## Tools

### Read skill

Use when a Schaffa URL is provided. It fetches the URL with curl and works for pages, files, and guides.

${config.baseUrl}/skills/read/SKILL.md

### Write skill

Use to publish a local page or file. It runs \`npx schaffa upload <file>\` and returns the public URL. Keep \`SCHAFFA_TOKEN\` in the environment.

${config.baseUrl}/skills/write/SKILL.md

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

- Example skills: ${config.baseUrl}/skills
- API reference: ${config.baseUrl}/api
`;
}
