# Deployment

Schaffa runs as an application container plus an isolated ClamAV container. The app uses one persistent `/data` volume; ClamAV keeps its signature database separately. Pangolin exposes only the application through the single origin `https://schaffa.dev`.

## Container image

Release jobs run dependency and secret checks before publishing. Container builds
push a candidate digest, scan it, then promote that exact digest to release tags.
The CLI is packed with `pnpm pack:cli <output-directory>`. This bundles the runtime
dependencies from the workspace lockfile so npm consumers receive the patched
versions, including overrides. npm publishes the resulting tarball after
a clean install, dependency audit, and entry-point/import smoke test. Plain
`pnpm --filter schaffa pack` does not produce the supported release artifact.

Version tags publish a Linux AMD64 image and record its immutable digest in the
matching GitHub release:

```sh
docker pull ghcr.io/beastyrabbit/schaffa:0.10.0
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
- `skills`
- `skills/*`
- `skills/*/*`
- `llm.txt`
- `llms.txt`
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

Schaffa bearer tokens protect permanent pages, updates, files, and management operations even on bypassed API paths. A new static HTML page may be uploaded without a token; it is virus-scanned, visible for one hour, hidden afterward, and physically removed after 30 days. Interactive HTML requires the instance switch, a per-user admin grant, and a separate interactive-only token. Its run response uses an opaque CSP sandbox. CSP blocks fetch requests and external resources; the sandbox restricts storage, forms, and pop-ups. Navigation and WebRTC behavior varies by browser, so this is not complete network isolation. Public page and file URLs are readable by anyone who has the URL. Schaffa also rejects application requests arriving on a hostname other than `SCHAFFA_BASE_URL`.

When `SCHAFFA_BASE_URL` uses HTTPS, Schaffa sends HSTS with a one-year lifetime and `includeSubDomains`. Confirm that every subdomain is HTTPS-capable before deploying that policy; TLS termination remains the reverse proxy's responsibility.

Anonymous rate limiting uses the client address reported by the trusted reverse proxy. Schaffa trusts no forwarding headers by default. Set `TRUSTED_PROXIES` to the exact proxy IP addresses or narrow CIDRs seen by the server, separated by commas. Numeric `TRUST_PROXY_HOPS` is no longer supported. Keep direct origin access private. Configure Pangolin to overwrite incoming forwarding headers rather than accepting a client-supplied `X-Forwarded-For` chain.

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

The admin UI provides immediate page/file takedown, a publishing lockdown, an instance-wide Interactive switch, and per-user Interactive grants. Administrative operations are intentionally unavailable through the public API. Lockdown stops all new uploads and updates but intentionally leaves public reads, content deletion, token revocation, and the setting itself available for recovery. Disabling Interactive globally or removing a user's grant blocks new execution loads of existing interactive pages; removing the grant also revokes that user's interactive tokens. Code already loaded in an open tab continues until that tab is closed or reloaded, so incident response should also remove the page when containment cannot wait. Admin logout only removes the eight-hour browser cookie; revoke the underlying token when it may be compromised.

The user dashboard uses Shoo for Google OAuth/PKCE and stores its own HMAC-hashed, seven-day HttpOnly sessions. The admin can independently disable new local signups, disable all logins (which also clears active sessions), and delete users. User deletion revokes their agent tokens and sessions but deliberately leaves already published content available for a separate, auditable admin takedown. As of this integration Shoo labels itself an early work in progress; keep `SHOO_BASE_URL` and `SHOO_ISSUER` configurable and review Shoo's release/security status before a production rollout.

## Docker Compose

The included [compose.yaml](../compose.yaml) binds the app and ClamAV TCP port to loopback. ClamAV has no transport authentication, so port `3310` must never be exposed publicly:

```sh
export SCHAFFA_IMAGE="ghcr.io/beastyrabbit/schaffa@sha256:<published-manifest-digest>"
docker compose up -d --pull always --no-build
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
```

Set `SCHAFFA_IMAGE` to the manifest digest produced by the selected CI build; Compose intentionally has no mutable `latest` fallback. Run Compose through the local secret manager so the required values are present in its environment. The repository intentionally does not prescribe or expose instance-specific secret-store coordinates.

## ClamGate scanning

The default scanner remains local ClamAV. To use ClamGate v0.1.0, set
`VIRUS_SCANNER=clamgate`, `CLAMGATE_BASE_URL`, `CLAMGATE_PUBLIC_KEY_FILE` and
`CLAMGATE_PUBLIC_KEY_ID`. Obtain the Ed25519 SPKI PEM public key and its ID from
the service operator through a trusted channel. The observed ID in the integration
notice is `production-1`; confirm it with the operator. Missing configuration,
an invalid key or upload limits above 2,147,483,645 bytes prevent startup.
The public key is read at startup, so restart Schaffa when rotating the key.

Choose the HTTPS origin by project ownership. Personal projects use
`https://virus.heerlab.com`; SKYWAY projects use `https://virus.skyway.tools`.
Confirm reachability from the actual backend. Do not substitute one origin for
the other when access fails. Optionally inject `CLAMGATE_APPLICATION_TOKEN`
through the existing secret manager for verified application attribution.
Anonymous scanning works without it. Tokens and per-job keys stay on the backend.

Mount the public key read-only into the application container, for example with
an operator-owned Compose override:

```yaml
services:
  schaffa:
    environment:
      VIRUS_SCANNER: clamgate
      CLAMGATE_PUBLIC_KEY_FILE: /run/clamgate/public.pem
    volumes:
      - ./clamgate-public.pem:/run/clamgate/public.pem:ro
```

The main Compose file passes the other ClamGate variables through. It retains
its ClamAV service and health dependency for rollback. After validating ClamGate,
`docker compose up -d --no-deps schaffa` can start only the application; stop the
local scanner separately if it is no longer needed. A normal `compose up` still
starts ClamAV. Local `pnpm dev` continues to use ClamAV by default.

Schaffa implements the ClamGate v0.1.0 HTTP and signed-result contract with its
existing `jose` dependency. Builds do not need access to ClamGate's private
repository. Only Ed25519 signatures from the configured key are accepted, with
the expected issuer, job, nonce, file hash, size, policy, expiry and recent scanner
evidence. Redirects are rejected. Raw files and HTML are checked again when
copied out of quarantine. Images and guide screenshots are scanned both before
conversion and after conversion, so the published WebP bytes also pass scanning.

Submissions across pages, files and guide screenshots are spaced at least 6.5
seconds apart per application process. This stays below the service's default
ten submissions per minute for one process. Other applications or replicas
sharing the egress IP share the service budget; a token does not increase it.
Images use two submissions, so allow fewer than five images per minute before
other traffic and actual scan time. High-volume recordings require more service
capacity. The default service also scans only one file at a time.

Each page/file scan has a one-hour overall deadline, configurable with
`CLAMGATE_TIMEOUT_MS`. Guide scans wait inside the upload request, with each scan
bounded by the smaller of that deadline and `CLAMAV_WAKE_TIMEOUT_MS`, default
120 seconds. Allow up to twice that for screenshot scans plus conversion and
upload time through proxies. A failed guide request does not publish the image;
the recorder's local files can be synced later.

Polling failures retry the same accepted job after 60 seconds. Failed submissions,
invalid results, timeouts and operational failures impose a 60-second submission
cooldown and leave page/file bytes quarantined. Known jobs are cancelled on
failure with a separate three-second cleanup deadline. Malware and signed policy
rejections delete page/file payloads and preserve their rejected status URLs.
Unknown jobs from lost acknowledgements expire at the service. After a Schaffa
restart, pending work is resubmitted; remote job credentials are not persisted.

Before switching production, test harmless files, EICAR, wrong signing keys,
service failures, timeouts, representative archives and recording bursts. Verify
actual proxy upload sizes and deadlines, and confirm service retention with the
operator. Retain local ClamAV until those checks pass; set `VIRUS_SCANNER=clamav`
and restart to switch back. Existing rendering and sandbox restrictions still apply.

## Kubernetes scale-to-zero

Schaffa exposes the private Prometheus gauge `schaffa_pending_scans` at `/metrics`. It counts quarantined page/file jobs plus a guide screenshot waiting for ClamAV. A Kubernetes deployment can scrape it and use KEDA's Prometheus scaler with `minReplicaCount: 0`, `maxReplicaCount: 1`, and a cooldown period. Keep the Schaffa application running: it returns the stable URL, stores payloads in quarantine, and retries while KEDA starts ClamAV. Persist `/var/lib/clamav` so cold starts reuse downloaded signatures. Do not expose `/metrics` through the public reverse proxy.

## Persistent data and upgrades

SQLite metadata and stored files must be backed up together. Back up the complete `/data` volume rather than copying only the database or only the object directories. The ClamAV signature volume is reproducible and does not contain uploads. Page and file uploads receive a stable URL immediately and remain in `/data/quarantine` until ClamAV accepts them. Scanner unavailability leaves them pending for retry; rejected payload bytes are deleted while the URL keeps a status tombstone.

For an update:

1. Back up `/data`.
2. Pull the new release image by its immutable digest.
3. Recreate the container without deleting its volume.
4. Verify `/healthz`, the admin login, one public page, and one public file.
