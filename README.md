# Mumpitz

Mumpitz is a small self-hosted publisher for standalone HTML pages and public files. It keeps metadata in SQLite and content on one local persistent volume.

- Source: [git.heerlab.com/beasty/mumpitz](https://git.heerlab.com/beasty/mumpitz)
- Image: `git.heerlab.com/beasty/mumpitz:latest` (`linux/amd64`)
- License: MIT

## What it does

- Publishes complete HTML files under random 12-character slugs.
- Keeps immutable page versions while `/p/:slug` always serves the latest.
- Returns byte-identical HTML from normal and `/raw` URLs.
- Publishes files under random 128-bit IDs without retaining original filenames.
- Converts images to metadata-free WebP, limits them to 2560 px and preserves transparency.
- Protects every write and the admin UI with scoped Mumpitz tokens.

## Pangolin access model

All three origins point to the same container on port `3000`:

| Origin | Pangolin login | Purpose |
| --- | --- | --- |
| `mumpitz.heerlab.com` | Required | Admin surface. After Pangolin login, a Mumpitz admin token is still required. |
| `mumpitz-api.heerlab.com` | Disabled | Publicly reachable API origin. Uploads and management operations require bearer tokens. |
| `mumpitz-cdn.heerlab.com` | Disabled | Public HTML and file delivery through `/p/*` and `/f/*`. |

The admin interface therefore lives behind Pangolin. API and CDN deliberately remain free of Pangolin login so agents, `curl`, browsers, and embedded assets can reach them directly. Mumpitz also enforces the configured hostnames itself.

See [Deployment](docs/deployment.md) for the complete routing and runtime configuration.

## Local test

Node 22.5+ and pnpm are required:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` is the only normal local entry point. It starts all configured services through Portless and prints their stable `.localhost` URLs. Open `/admin` on the printed Mumpitz URL and sign in with the temporary token.

In a second terminal, use that printed URL and token:

```sh
export MUMPITZ_API_URL="<Portless URL printed by pnpm dev>"
export MUMPITZ_TOKEN="mpt_…"

skills/mumpitz-publish/scripts/publish.sh page examples/hello.html
skills/mumpitz-publish/scripts/publish.sh file examples/test-asset.png
```

## Container

Every push to `main` publishes `latest`, `main`, and a commit-SHA tag:

```sh
docker pull git.heerlab.com/beasty/mumpitz:latest
```

## Documentation

- [Deployment and Pangolin](docs/deployment.md)
- [HTTP API and URL model](docs/api.md)
- [Codex publishing skill](skills/mumpitz-publish/SKILL.md)

Run all project checks with `pnpm check`.
