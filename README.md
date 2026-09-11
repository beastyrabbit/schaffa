# Schaffa

Schaffa is the workhorse that connects an AI agent's output to the web. Its name comes from the Swabian word for working or getting things done. The self-hosted service publishes standalone HTML pages and public files from one origin.

Schaffa is heavily inspired by [PostPlan](https://postplan.dev) and [UploadThing](https://uploadthing.com), but built to be self-hosted.

- Source: [github.com/beastyrabbit/schaffa](https://github.com/beastyrabbit/schaffa)
- Image: `ghcr.io/beastyrabbit/schaffa:<version>` (`linux/amd64`)
- License: MIT

## What it does

- Publishes complete HTML files under random 16-character slugs.
- Keeps immutable page versions while `/p/:slug` always serves the latest.
- Returns byte-identical HTML for static pages; interactive pages use a warning screen and isolated run URL.
- Publishes files under random 128-bit IDs without retaining original filenames.
- Records guides incrementally with optimistic concurrency, idempotent steps, cleaned screenshots, preflight checks, and immutable revisions.
- Records browser videos locally or attaches a scanned video player to a published guide.
- Publishes script-free Marp presentations with optional PDF/PPTX/source artifacts through the CLI.
- Converts images to metadata-free WebP, limits them to 2560 px and preserves transparency.
- Accepts new anonymous HTML pages for one hour; tokens make pages permanent and enable files or updates.
- Lets users sign in through Shoo and issue revocable upload tokens for their own agents.
- Lets administrators enable sandboxed interactive pages only for explicitly trusted users.
- Returns a stable URL immediately, scans page/file uploads asynchronously, and never exposes unscanned bytes.
- Scans every upload through ClamGate and verifies its signed result before publication.

## Pangolin access model

Everything is served from one origin and one container on port `3000`:

| URL | Access |
| --- | --- |
| `https://schaffa.dev/admin` | Pangolin login, then a Schaffa admin token |
| `https://schaffa.dev/api/*` | Direct access; writes and management require bearer tokens |
| `https://schaffa.dev/skills`, `/skills/*/SKILL.md`, `/llm.txt`, and `/llms.txt` | Direct public access for agent examples and discovery |
| `https://schaffa.dev/p/*` and `/f/*` | Direct public access |

Configure Pangolin path rules to bypass its login for the supported `/api/*`, `/skills`, `/skills/*/*`, `/llm.txt`, `/llms.txt`, `/p/*`, and `/f/*` routes. All paths use the same hostname; Schaffa rejects application traffic sent with a different host.

See [Deployment](docs/deployment.md) for the complete routing and runtime configuration.

## Local test

The browser integration test uses a local Chrome, Edge, or Chromium installation.
Without one, local test runs report that case as skipped; the remaining tests still
run. CI and an explicit `SCHAFFA_TEST_BROWSER` path require a working browser and
fail if it is missing.

Node 24+ and pnpm are required for the server and local development. The standalone CLI requires Node 22.12.0+:

```sh
pnpm install --frozen-lockfile
export CLAMGATE_PUBLIC_KEY_FILE="/path/to/trusted-public.pem"
export CLAMGATE_PUBLIC_KEY_ID="<operator-confirmed-key-id>"
pnpm dev
```

ClamGate is the only scanner. The default service origin is `https://virus.heerlab.com`; obtain its trusted public key and key ID from the operator before starting the server. Local development uses the same service and needs no scanner container.

`pnpm dev` is the only normal local entry point. It starts all configured services through Portless and prints their stable `.localhost` URLs. Open `/admin` on the printed Schaffa URL and sign in with the temporary token.

In a second terminal, use that printed URL and token:

```sh
export SCHAFFA_URL="<Portless URL printed by pnpm dev>"
export SCHAFFA_TOKEN="sfa_…"

skills/schaffa-publish/scripts/publish.sh page examples/hello.html
skills/schaffa-publish/scripts/publish.sh file examples/test-asset.png
```

## CLI

The separately publishable npm package lives in `packages/cli` and is available
from npmjs.org:

```sh
npx schaffa upload ./plan.html
```

Record a workflow while it happens:

```sh
npx schaffa record --title "Create a project" --chrome "https://app.example.com/projects"
npx schaffa record --title "Configure Calculator" --desktop --app com.apple.calculator
```

Chrome mode opens a new window in the already running Google Chrome without
creating a profile. Chrome uses one of its existing profile sessions, so that
session's logins, extensions, and password manager remain available. It records
only that exact macOS window. The isolated `--browser` mode remains available
when a separate persistent Schaffa browser profile is wanted. Desktop mode
records only the native macOS app selected by bundle ID and needs one-time
Accessibility and Screen Recording permission. Every primary click is captured
before the UI changes, marked with a compact cursor and red target outline,
saved locally under `.schaffa/recordings/<slug>/`, and uploaded immediately as
an incremental guide step. Close the recorded window or press Ctrl+C to stop.
`Alt+Shift+R` pauses capture for private screens. If the network fails, the
local manifest remains recoverable with `npx schaffa guide sync`.

Add `--video` to attach a video player to the guide, or use
`npx schaffa video record --browser https://app.example.com --output ./demo.webm`
for a local standalone recording. Video needs ffmpeg with libvpx-vp9 and Chrome
or Chromium. See the [CLI video guide](packages/cli/README.md) for capture modes,
privacy controls, and publishing options.

Manual recording remains available for terminal, API, and mixed workflows:

```sh
npx schaffa guide start --title "Create a project" --url "https://app.example.com/projects"
npx schaffa guide step --title "Open projects" --text "Open the project list."
npx schaffa guide finish
```

Inspect and correct an active recording before finishing it:

```sh
npx schaffa guide status --json
npx schaffa guide edit-step --step 2 --title "Choose New project" --text "Select New project."
npx schaffa guide replace-screenshot --step 2 --screenshot ./correct-step.png
npx schaffa guide delete-step --step 3
```

`replace-screenshot` cleans the supplied image, but it cannot recreate a
recorder cursor or target outline. Those annotations are baked into the original
screenshot pixels, so add them to the replacement image first when they matter.

Finishing a recording publishes it automatically. Corrections made after that
point immediately create a new immutable public revision.

Publish a Marp presentation and its export artifacts:

```sh
npx schaffa publish deck.md --kind presentation --export pdf --export pptx
```

Requested PDF and PowerPoint exports appear as download links in the published presentation.
Omit either `--export` option when that format should not be generated.

The CLI defaults to `https://schaffa.dev`. Every new HTML page receives a random, non-semantic ID. New HTML pages work without a token and disappear after one hour. For permanent pages, files, presentations, and guides, the CLI automatically reads `SCHAFFA_TOKEN`, local `.env.local` and `.env` files, and [Schaffa token config files](packages/cli/README.md#use-a-token). An explicit `--token <token>` takes precedence. Use `--ignore-token` to skip token lookup and publish an anonymous HTML page.

Trusted users can create a separate Interactive token in their account and publish inline JavaScript with `npx schaffa upload ./plan.html --interactive`. Visitors see a warning before the code runs in an opaque browser sandbox. CSP blocks fetch requests and external resources; the sandbox restricts storage, forms, and pop-ups. Browser-dependent navigation and WebRTC behavior mean this is not complete network isolation.

## Releases

Pushes and pull requests run CI without publishing. A semantic version tag such
as `v0.10.0` publishes the matching CLI package to npmjs.org and an immutable
GHCR container image. Create the GitHub release with reviewed notes; the tag job
attaches the CLI tarball, checksum, and image digest:

```sh
docker pull ghcr.io/beastyrabbit/schaffa:0.10.0
```

Production deployments should pin the digest recorded in the GitHub release.

## Documentation

- [Deployment and Pangolin](docs/deployment.md)
- [Detailed self-hosting with Docker Compose and Infisical](docs/self-hosting.md)
- [HTTP API and URL model](docs/api.md)
- [Website skill design and extension guide](docs/skills.md)
- [Codex publishing skill](skills/schaffa-publish/SKILL.md)

Run all project checks with `pnpm check`.
