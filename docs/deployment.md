# Deployment

Schaffa runs as an application container plus an isolated ClamAV container. The app uses one persistent `/data` volume; ClamAV keeps its signature database separately. Pangolin exposes only the application through the single origin `https://schaffa.dev`.

## Container image

Version tags publish a Linux AMD64 image and record its immutable digest in the
matching Forgejo release:

```sh
docker pull git.heerlab.com/beasty/schaffa:0.2.0
```

Production deployments should use the release's manifest digest. Release tags
also publish a commit-SHA image tag; `latest` tracks the newest stable release,
not the `main` branch.

## Recommended Pangolin resource

Create one public Pangolin resource for `schaffa.dev` and point it at the Schaffa container on port `3000`.

Set `SCHAFFA_BASE_URL=https://schaffa.dev`. Keep Pangolin authentication enabled on the resource, then add high-priority **Bypass Auth** path rules for:

- `/`
- `api`
- `api/*`
- `api/*/*`
- `api/*/*/*`
- `api/*/*/*/*`
- `api/*/*/*/*/*`
- `account`
- `account/*`
- `assets/*`
- `auth/*`
- `shoo/*`
- `p/*`
- `p/*/*`
- `p/*/*/*`
- `f/*`
- `g/*`
- `g/*/*`
- `g/*/*/*`
- `metadata/*`

Pangolin matches each path segment separately, so the additional patterns cover the landing page, OpenAPI metadata, page versions, `/raw`, API operations containing an ID or slug, and the Shoo user login flow. Requests to `/admin` therefore continue to Pangolin authentication. API clients, user accounts, public pages, and files remain directly reachable on the same hostname. Pangolin evaluates rules by priority; do not add a broader bypass rule that also matches `/admin`.

The health check should normally stay on the private backend at `/healthz`; it does not need a public Pangolin route.

The `/admin` path has two deliberate gates:

1. Pangolin authenticates the user before the admin page is reachable.
2. Schaffa requires an admin token before it displays data or permits token management.

Schaffa bearer tokens protect permanent pages, updates, files, and management operations even on bypassed API paths. A new HTML page may be uploaded without a token; it is virus-scanned, visible for one hour, hidden afterward, and physically removed after 30 days. Public page and file URLs are readable by anyone who has the URL. Schaffa also rejects application requests arriving on a hostname other than `SCHAFFA_BASE_URL`.

When `SCHAFFA_BASE_URL` uses HTTPS, Schaffa sends HSTS with a one-year lifetime and `includeSubDomains`. Confirm that every subdomain is HTTPS-capable before deploying that policy; TLS termination remains the reverse proxy's responsibility.

Anonymous rate limiting uses the client address reported by the trusted reverse proxy. Schaffa trusts one proxy hop by default; set `TRUST_PROXY_HOPS` only when the deployment has a known additional proxy layer. Configure Pangolin to overwrite incoming forwarding headers rather than accepting a client-supplied `X-Forwarded-For` chain.

## Required configuration

| Variable | Purpose |
| --- | --- |
| `SCHAFFA_BASE_URL` | Canonical origin for admin, API, pages, and files |
| `SCHAFFA_TOKEN_PEPPER` | High-entropy HMAC key used to hash stored tokens |
| `SCHAFFA_DATA_DIR` | Persistent data directory; `/data` in the image |
| `CLAMAV_HOST` | Private hostname of the ClamAV container |
| `SHOO_BASE_URL` | Shoo authorization and JWKS origin; defaults to `https://shoo.dev` |
| `SHOO_ISSUER` | Exact accepted Shoo token issuer; defaults to `SHOO_BASE_URL` |

`SCHAFFA_BOOTSTRAP_TOKEN` is required only for initial setup. After creating and verifying a separate admin token, revoke bootstrap and remove the variable; Schaffa revokes any previously active bootstrap row when the value is absent. Optional limits and defaults are documented in [.env.example](../.env.example). Notable defaults are a one-hour anonymous visibility window, 30-day anonymous retention, 20 GiB total storage, 512 MiB anonymous storage, 25 versions per page, 32 MiB image input, two concurrent image pipelines, and 120 writes per token per hour.

Keep the pepper and any active bootstrap value in the approved secret manager and inject them only at runtime. Do not commit an `.env` file, Kubernetes Secret values, internal secret-store addresses, or project identifiers to this public repository. Give each workstation its own `upload` token so it can be revoked independently. Create a separate admin token, verify it works, and revoke the bootstrap token; restarting with the same bootstrap value never reactivates it, while setting a new, different value rotates the stored hash and reactivates bootstrap as the admin recovery path. Rotating `SCHAFFA_TOKEN_PEPPER` invalidates every existing API token and user session and therefore requires issuing replacements.

The admin UI provides immediate page/file takedown and a publishing lockdown. Administrative operations are intentionally unavailable through the public API. Lockdown stops all new uploads and updates but intentionally leaves public reads, content deletion, token revocation, and the setting itself available for recovery. Admin logout only removes the eight-hour browser cookie; revoke the underlying token when it may be compromised.

The user dashboard uses Shoo for Google OAuth/PKCE and stores its own HMAC-hashed, seven-day HttpOnly sessions. The admin can independently disable new local signups, disable all logins (which also clears active sessions), and delete users. User deletion revokes their agent tokens and sessions but deliberately leaves already published content available for a separate, auditable admin takedown. As of this integration Shoo labels itself an early work in progress; keep `SHOO_BASE_URL` and `SHOO_ISSUER` configurable and review Shoo's release/security status before a production rollout.

## Docker Compose

The included [compose.yaml](../compose.yaml) binds the app and ClamAV TCP port to loopback. ClamAV has no transport authentication, so port `3310` must never be exposed publicly:

```sh
export SCHAFFA_IMAGE="git.heerlab.com/beasty/schaffa@sha256:<published-manifest-digest>"
docker compose up -d --pull always --no-build
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
```

Set `SCHAFFA_IMAGE` to the manifest digest produced by the selected CI build; Compose intentionally has no mutable `latest` fallback. Run Compose through the local secret manager so the required values are present in its environment. The repository intentionally does not prescribe or expose instance-specific secret-store coordinates.

## Persistent data and upgrades

SQLite metadata and stored files must be backed up together. Back up the complete `/data` volume rather than copying only the database or only the object directories. The ClamAV signature volume is reproducible and does not contain uploads. All page and file uploads are scanned, including authenticated writes; scanner unavailability fails closed.

For an update:

1. Back up `/data`.
2. Pull a pinned SHA tag or the desired `latest` image.
3. Recreate the container without deleting its volume.
4. Verify `/healthz`, the admin login, one public page, and one public file.
