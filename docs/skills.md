# Schaffa skill design

Schaffa publishes a small catalog of agent skills at `/skills`. These are
operational instructions for another agent, not general product documentation.
Keep them concise, specific, and grounded in behavior the product actually
supports.

## Architecture

Keep one general read skill and separate writing skills:

- `schaffa-read` handles every public Schaffa URL: pages, files, guides,
  presentations, and future readable output types.
- Each distinct publishing workflow gets its own writing skill. The current
  skills cover HTML documents, files, guides, and presentations.

When adding a public URL type, update `schaffa-read` instead of creating another
reader. Create a new writing skill only when users request that output
independently and it has a meaningfully different command, lifecycle, or safety
model.

Do not combine all writes into a generic `schaffa-write` skill. Separate skills
load only the context needed for the requested operation and avoid collisions
between commands such as `upload`, `guide`, and `publish`.

## Trigger descriptions

The `description` is always visible to the agent and decides whether the skill
is loaded. Treat it as a trigger, not a summary of the implementation.

- Start with `Use when the user ...`.
- Write one short sentence with only the words needed to recognize the user
  intent.
- Avoid exhaustive synonym lists. Keep detailed examples, exclusions,
  commands, environment variables, procedures, and explanations in the body.
- Add a second trigger clause only when it captures a deliberately supported
  shorthand that the first clause misses.

Canonical HTML example:

```yaml
description: Use when the user asks to communicate through an HTML document, or if they mention "HTML" with no additional context.
```

The final clause deliberately lets a user append only `HTML` to a request. The
plan, spec, report, comparison, and UI-mock examples belong in the skill body,
not in this description.

Too vague:

```yaml
description: Helps with Schaffa.
```

Too procedural:

```yaml
description: Uploads multipart HTML to the pages API and parses publicUrl from the JSON response.
```

If two descriptions trigger for the same ordinary request, first try to sharpen
their vocabulary. Merge the skills only when their workflows are also the same.

## Skill body

Write the body for an agent that already understands ordinary software work but
does not know Schaffa's exact contract. Use imperative language and include only
information needed after the skill has triggered:

1. State the required input and environment.
2. Give the canonical command or short command sequence.
3. Explain Schaffa-specific constraints and safety rules.
4. Define success, including which URL or response fields to return.
5. State important failure behavior when guessing would be unsafe.

Prefer one exact command over several equivalent examples. Use direct `curl`
uploads for HTML and ordinary files because those APIs are small and stable:

- HTML: multipart field `html` to `POST /api/pages`. Authentication is
  optional for a temporary page and required for a permanent page or update.
- Files: multipart field `file` to `POST /api/files` with `SCHAFFA_TOKEN`.

Read `publicUrl` from the successful JSON response. If a required token is
unset, stop and tell the user instead of guessing. Keep specialized CLI
workflows for guides and presentations, which have their own recording,
preflight, rendering, and export lifecycles.

The guide skill should prefer `npx schaffa record` when a dedicated browser
or supported native app is available. Document both browser and desktop modes,
the privacy pause, ordered local recovery through `guide sync`, recording review,
and the manual guide lifecycle for mixed terminal and UI workflows. Keep these
details in the skill body; the description remains only the short guide trigger.

Add good and bad examples only when observed agent behavior shows that they
improve results. Do not restate the trigger in a `When to use` section.

Keep all secrets in environment variables. Never instruct an agent to print or
hard-code a token, enable shell tracing, or expose request headers. Explicitly
say when returned URLs are public and when input files or screenshots require
privacy review.

## Template

Website skills use only `name` and `description` in YAML frontmatter:

```markdown
---
name: schaffa-<capability>
description: Use when the user asks to <trigger words for one intent>.
---

# Schaffa <Capability>

State the required input and environment.

`<one canonical curl request or specialized Schaffa command>`

State the constraints, safety behavior, success condition, and result to return.
```

Names and route slugs use lowercase letters, digits, and hyphens. Prefer a
short capability name. Keep the body comfortably below 500 lines; current
skills should remain much smaller than that.

## Adding or changing a website skill

The website catalog is defined in `src/example-skills.ts`. For a new writing
skill:

1. Confirm the user intent with concrete example prompts.
2. Confirm that the CLI or HTTP API already supports the documented workflow.
3. Add one `ExampleSkill` entry with its route `slug`, UI `title`, and complete
   `SKILL.md` content.
4. Add the raw skill URL to `llmText()` so `/llm.txt` and `/llms.txt` advertise
   it.
5. Update the general read skill if the workflow introduces a new public URL
   shape or machine-readable representation.
6. Extend `test/server.test.ts` to cover its exact short trigger, canonical
   command, raw route, page link, and discovery URL.
7. Run `pnpm check` and open `/skills` locally. Verify the raw route returns
   `200` with `text/markdown`.

The skills page renders the registry automatically. Do not duplicate the skill
body in `src/ui.ts`, the README, or another documentation file. The same
registry also generates `/skills/all.md`, a single Markdown bundle for human
review; keep that route generated rather than maintaining a second copy.

When changing an existing skill, preserve its route unless a migration is
intentional. Removing or renaming a route can break agents that installed the
raw URL previously.

## Deciding whether to add a skill

Add a skill when at least one of these is true:

- The workflow uses a different top-level command or multi-step lifecycle.
- It has distinct safety, privacy, or validation rules.
- Users commonly request it without requesting the other publishing modes.
- Repeated agent failures reveal missing Schaffa-specific instructions.

Do not add a skill only because an output has a different file extension, a new
optional flag, or a speculative future use. Extend the closest existing skill
when its trigger and workflow remain the same.

Build skills from real usage. When an agent behaves poorly, verify the failure,
add the smallest instruction that addresses it, and test again. Avoid copying
another person's skill catalog wholesale: the useful rules are the ones derived
from Schaffa's workflows and observed failure modes.

## Review checklist for future skills

Before publishing a new or changed skill, confirm all of the following:

- The description is one short trigger sentence rather than a capability
  summary.
- Detailed examples, exclusions, and failure handling live in the body.
- The general reader still handles the new public URL; another reader was not
  added for one output type.
- A new writer exists only for an independently requested workflow with a
  distinct command, lifecycle, or safety model.
- HTML and file uploads use the documented `curl` API calls; guides and
  presentations use their specialized commands.
- Required credentials are read from the environment and missing credentials
  cause a clear stop instead of guessing.
- Success returns the actual `publicUrl` only after the upload succeeds.
- Tests assert the trigger text, command or endpoint, raw route, catalog link,
  and discovery URL.
