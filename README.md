# Schaffa

Schaffa is the workhorse that connects an AI agent's output to the web. Its name comes from the Swabian word for working or getting things done. The self-hosted service publishes standalone HTML pages and public files from one origin.

Schaffa is heavily inspired by [PostPlan](https://postplan.dev) and [UploadThing](https://uploadthing.com), but built to be self-hosted.

- Source: [git.heerlab.com/beasty/schaffa](https://git.heerlab.com/beasty/schaffa)
- Image: `git.heerlab.com/beasty/schaffa:<version>` (`linux/amd64`)
- License: MIT

## What it does

- Publishes complete HTML files under random 12-character slugs.
- Keeps immutable page versions while `/p/:slug` always serves the latest.
- Returns byte-identical HTML from normal and `/raw` URLs.
- Publishes files under random 128-bit IDs without retaining original filenames.
- Converts images to metadata-free WebP, limits them to 2560 px and preserves transparency.
- Accepts new anonymous HTML pages for one hour; tokens make pages permanent and enable files or updates.
- Lets users sign in through Shoo and issue revocable upload tokens for their own agents.
- Scans every upload with an isolated ClamAV service and never executes uploaded content.

## Pangolin access model

Everything is served from one origin and one container on port `3000`:

| URL | Access |
| --- | --- |
| `https://schaffa.dev/admin` | Pangolin login, then a Schaffa admin token |
| `https://schaffa.dev/api/*` | Direct access; writes and management require bearer tokens |
| `https://schaffa.dev/p/*` and `/f/*` | Direct public access |

Configure Pangolin path rules to bypass its login for the supported `/api/*`, `/p/*`, and `/f/*` routes. All paths use the same hostname; Schaffa rejects application traffic sent with a different host.

See [Deployment](docs/deployment.md) for the complete routing and runtime configuration.

## Local test

Node 22.5+ and pnpm are required:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

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

The CLI defaults to `https://schaffa.dev`. New HTML pages work without a token and disappear after one hour. For permanent pages, files, and `--slug <slug>` updates, set `SCHAFFA_TOKEN` or pass `--token <token>` directly.

## Releases

Pushes and pull requests run CI without publishing. A semantic version tag such
as `v0.2.0` publishes the matching CLI package to npmjs.org and Forgejo plus an
immutable container image,
then creates a Forgejo release with checksums and the image digest:

```sh
docker pull git.heerlab.com/beasty/schaffa:0.2.0
```

Production deployments should pin the digest recorded in the Forgejo release.

## Documentation

- [Deployment and Pangolin](docs/deployment.md)
- [Detailed self-hosting with Docker Compose and Infisical](docs/self-hosting.md)
- [HTTP API and URL model](docs/api.md)
- [Codex publishing skill](skills/schaffa-publish/SKILL.md)

Run all project checks with `pnpm check`.
