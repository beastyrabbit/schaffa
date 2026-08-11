# Deployment

Mumpitz runs as one container with one persistent `/data` volume. Pangolin exposes three origins to keep the private admin surface separate from public publishing and delivery.

## Container image

The public Forgejo workflow publishes a Linux AMD64 image:

```sh
docker pull git.heerlab.com/beasty/mumpitz:latest
```

Use the immutable `sha-<commit>` tag when a deployment must remain pinned. `latest` tracks the current `main` branch.

## Recommended Pangolin resources

Point every resource at the same private backend, for example `http://127.0.0.1:3000`.

| Public origin | Application setting | Pangolin policy | Routes |
| --- | --- | --- | --- |
| `https://mumpitz.heerlab.com` | `MUMPITZ_APP_BASE_URL` | Login required | `/`, `/admin`, `/admin/*` |
| `https://mumpitz-api.heerlab.com` | `MUMPITZ_API_BASE_URL` | No login | `/api`, `/api/*` |
| `https://mumpitz-cdn.heerlab.com` | `MUMPITZ_PUBLIC_BASE_URL` | No login | `/p/*`, `/f/*` |

The health check should normally stay on the private backend at `/healthz`; it does not need a public Pangolin route.

The admin origin has two deliberate gates:

1. Pangolin authenticates the user before the admin page is reachable.
2. Mumpitz requires an admin token before it displays data or permits token management.

Do not enable Pangolin login on the API or CDN origins. Agents and `curl` need direct API access, while browsers and uploaded pages need direct file access. Mumpitz bearer tokens still protect all writes and management operations. Public page and file URLs are readable by anyone who has the URL.

Mumpitz rejects admin, API, page, and file requests arriving on the wrong configured hostname. Pangolin separation and application-level host checks therefore reinforce each other.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `MUMPITZ_APP_BASE_URL` | Pangolin-protected admin origin |
| `MUMPITZ_API_BASE_URL` | Public API origin |
| `MUMPITZ_PUBLIC_BASE_URL` | Public page and file origin |
| `MUMPITZ_TOKEN_PEPPER` | High-entropy HMAC key used to hash stored tokens |
| `MUMPITZ_BOOTSTRAP_TOKEN` | Initial high-entropy admin token |
| `MUMPITZ_DATA_DIR` | Persistent data directory; `/data` in the image |

Optional limits and defaults are documented in [.env.example](../.env.example). Notable defaults are a 2560 px image edge, 40 megapixel decode limit, and 8 MiB published image limit.

Keep both token values in the approved secret manager and inject them only at runtime. Do not commit an `.env` file, Kubernetes Secret values, internal secret-store addresses, or project identifiers to this public repository. Give each workstation its own `upload` token so it can be revoked independently.

## Docker Compose

The included [compose.yaml](../compose.yaml) binds the service to loopback for a local Newt/Pangolin target:

```sh
docker compose up -d --pull always --no-build
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
```

Run Compose through the local secret manager so the required values are present in its environment. The repository intentionally does not prescribe or expose instance-specific secret-store coordinates.

## Persistent data and upgrades

SQLite metadata and stored files must be backed up together. Back up the complete `/data` volume rather than copying only the database or only the object directories.

For an update:

1. Back up `/data`.
2. Pull a pinned SHA tag or the desired `latest` image.
3. Recreate the container without deleting its volume.
4. Verify `/healthz`, the admin login, one public page, and one public file.
