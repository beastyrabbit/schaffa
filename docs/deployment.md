# Deployment

Schaffa runs as an application container plus an isolated ClamAV container. The app uses one persistent `/data` volume; ClamAV keeps its signature database separately. Pangolin exposes only the application through the single origin `https://schaffa.dev`.

## Container image

The public Forgejo workflow publishes a Linux AMD64 image:

```sh
docker pull git.heerlab.com/beasty/schaffa:latest
```

Use the immutable `sha-<commit>` tag when a deployment must remain pinned. `latest` tracks the current `main` branch.

## Recommended Pangolin resource

Create one public Pangolin resource for `schaffa.dev` and point it at the Schaffa container on port `3000`.

Set `SCHAFFA_BASE_URL=https://schaffa.dev`. Keep Pangolin authentication enabled on the resource, then add high-priority **Bypass Auth** path rules for:

- `api`
- `api/*`
- `api/*/*`
- `p/*`
- `p/*/*`
- `p/*/*/*`
- `f/*`

Pangolin matches each path segment separately, so the additional patterns cover page versions, `/raw`, and API operations containing an ID or slug. Requests to `/admin` therefore continue to Pangolin authentication. API clients, public pages, and files remain directly reachable on the same hostname. Pangolin evaluates rules by priority; do not add a broader bypass rule that also matches `/admin`.

The health check should normally stay on the private backend at `/healthz`; it does not need a public Pangolin route.

The `/admin` path has two deliberate gates:

1. Pangolin authenticates the user before the admin page is reachable.
2. Schaffa requires an admin token before it displays data or permits token management.

Schaffa bearer tokens protect permanent pages, updates, files, and management operations even on bypassed API paths. A new HTML page may be uploaded without a token; it is virus-scanned, visible for one hour, hidden afterward, and physically removed after 30 days. Public page and file URLs are readable by anyone who has the URL. Schaffa also rejects application requests arriving on a hostname other than `SCHAFFA_BASE_URL`.

Anonymous rate limiting uses the client address reported by the trusted reverse proxy. Configure Pangolin to overwrite incoming forwarding headers rather than accepting a client-supplied `X-Forwarded-For` chain.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `SCHAFFA_BASE_URL` | Canonical origin for admin, API, pages, and files |
| `SCHAFFA_TOKEN_PEPPER` | High-entropy HMAC key used to hash stored tokens |
| `SCHAFFA_BOOTSTRAP_TOKEN` | Initial high-entropy admin token |
| `SCHAFFA_DATA_DIR` | Persistent data directory; `/data` in the image |
| `CLAMAV_HOST` | Private hostname of the ClamAV container |

Optional limits and defaults are documented in [.env.example](../.env.example). Notable defaults are a one-hour anonymous visibility window, 30-day anonymous retention, 2560 px image edge, 40 megapixel decode limit, and 8 MiB published image limit.

Keep both token values in the approved secret manager and inject them only at runtime. Do not commit an `.env` file, Kubernetes Secret values, internal secret-store addresses, or project identifiers to this public repository. Give each workstation its own `upload` token so it can be revoked independently.

## Docker Compose

The included [compose.yaml](../compose.yaml) binds the app and ClamAV TCP port to loopback. ClamAV has no transport authentication, so port `3310` must never be exposed publicly:

```sh
docker compose up -d --pull always --no-build
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
```

Run Compose through the local secret manager so the required values are present in its environment. The repository intentionally does not prescribe or expose instance-specific secret-store coordinates.

## Persistent data and upgrades

SQLite metadata and stored files must be backed up together. Back up the complete `/data` volume rather than copying only the database or only the object directories. The ClamAV signature volume is reproducible and does not contain uploads.

For an update:

1. Back up `/data`.
2. Pull a pinned SHA tag or the desired `latest` image.
3. Recreate the container without deleting its volume.
4. Verify `/healthz`, the admin login, one public page, and one public file.
