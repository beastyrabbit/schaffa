# Deployment

Schaffa runs as one application container and sends uploads to ClamGate over HTTPS. The app uses one persistent `/data` volume. Pangolin exposes only the application through the single origin `https://schaffa.dev`.

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
- `impressum` (exact path `/impressum`)
- `datenschutz` (exact path `/datenschutz`)
- `legal-notice` (exact path `/legal-notice`)
- `privacy` (exact path `/privacy`)
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
- `privacy`
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

The four legal pages are self-contained server-rendered HTML with inline CSS. Optional telemetry adds first-party consent and error-reporting assets; the legal text remains readable without JavaScript. Add only those four exact bypass paths for them, without wildcards. Each sends both a noindex meta tag and an X-Robots-Tag header.

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
| `CLAMGATE_PUBLIC_KEY_FILE` | Trusted Ed25519 public key PEM file; Compose mounts this host path read-only |
| `CLAMGATE_PUBLIC_KEY_ID` | Operator-confirmed ID of that signing key |
| `SHOO_BASE_URL` | Shoo authorization and JWKS origin; defaults to `https://shoo.dev` |
| `SHOO_ISSUER` | Exact accepted Shoo token issuer; defaults to `SHOO_BASE_URL` |

`SCHAFFA_BOOTSTRAP_TOKEN` is required only for initial setup. After creating and verifying a separate admin token, revoke bootstrap and remove the variable; Schaffa revokes any previously active bootstrap row when the value is absent. Optional limits and defaults are documented in [.env.example](../.env.example). Notable defaults are a one-hour anonymous visibility window, 30-day anonymous retention, 20 GiB total storage, 512 MiB anonymous storage, 25 versions per page, 32 MiB image input, two concurrent image pipelines, and 120 writes per token per hour.

Keep the pepper and any active bootstrap value in the approved secret manager and inject them only at runtime. Do not commit an `.env` file, Kubernetes Secret values, internal secret-store addresses, or project identifiers to this public repository. Give each workstation its own `upload` token so it can be revoked independently. Create a separate admin token, verify it works, and revoke the bootstrap token; restarting with the same bootstrap value never reactivates it, while setting a new, different value rotates the stored hash and reactivates bootstrap as the admin recovery path. Rotating `SCHAFFA_TOKEN_PEPPER` invalidates every existing API token and user session and therefore requires issuing replacements.

The admin UI provides immediate page/file takedown, a publishing lockdown, an instance-wide Interactive switch, and per-user Interactive grants. Administrative operations are intentionally unavailable through the public API. Lockdown stops all new uploads and updates but intentionally leaves public reads, content deletion, token revocation, and the setting itself available for recovery. Disabling Interactive globally or removing a user's grant blocks new execution loads of existing interactive pages; removing the grant also revokes that user's interactive tokens. Code already loaded in an open tab continues until that tab is closed or reloaded, so incident response should also remove the page when containment cannot wait. Admin logout only removes the eight-hour browser cookie; revoke the underlying token when it may be compromised.

The user dashboard uses Shoo for Google OAuth/PKCE and stores its own HMAC-hashed, seven-day HttpOnly sessions. The admin can independently disable new local signups, disable all logins (which also clears active sessions), and delete users. User deletion revokes their agent tokens and sessions but deliberately leaves already published content available for a separate, auditable admin takedown. As of this integration Shoo labels itself an early work in progress; keep `SHOO_BASE_URL` and `SHOO_ISSUER` configurable and review Shoo's release/security status before a production rollout.

## Optional analytics and error reporting

Set `UMAMI_URL` to the self-hosted collection origin and `UMAMI_WEBSITE_ID` to
its website UUID. Set `GLITCHTIP_DSN` to the public project DSN. Leave all three
unset for local development and preview builds; no collection SDK then starts.
`SCHAFFA_ENVIRONMENT` defaults to `production` with `NODE_ENV=production`, otherwise
`development`. `SENTRY_RELEASE` defaults to `schaffa@<package.json version>`;
the release upload job uses that version, so keep the default in production.
`GLITCHTIP_TRACES_SAMPLE_RATE` defaults to `0.1` and accepts values from 0 to 1.
A nightly kub-homelab job deletes Umami analytics data after 25 months, session
replays and heatmap recordings after 30 days, and GlitchTip error events after
90 days. The bilingual privacy policy states these periods. The legal pages and
controller details remain specific to schaffa.dev.
The privacy text needs human legal review before rollout.

Own public UI loads Umami only after analytics consent. Normal page loads cover
navigation because Schaffa is a multi-page application. The deployed Umami 3
tracker supports `data-website-id`, `data-domains`, `data-exclude-search`,
`data-exclude-hash`, `data-before-send`, `data-performance`, and `data-do-not-track`;
these were checked against its deployed `script.js`. Outbound links are collected
by a small first-party handler because that script has no outbound-link attribute.
The recorder only accepts website and host attributes. It fetches website settings
from `/api/websites/<website-id>/recorder`, which must be publicly reachable with
appropriate CORS. Enable replay and heatmaps in those settings and select strict
masking. All inputs are masked even in moderate mode; rrweb's `rr-block` class
locally excludes account content, identity and token displays. No recorder loads
on account pages, token-reveal pages or URLs containing queries or fragments.
Consent withdrawal clears the in-memory Umami session and navigates with a GET to
remove recorder observers and suppress its unload flush. The only storage Schaffa's
telemetry writes is `cc_cookie`, after a banner choice, expiring after six months
(182 days). Umami reads, but Schaffa
does not write, the optional `umami.disabled` localStorage preference.

Published HTML, interactive runs, raw versions, files and guide viewers receive
no telemetry injection. Their existing CSPs are unchanged. Successful GET 200
responses count as aggregate server views; HEAD, partial responses, 304, scan
status endpoints and obvious bots do not. Published presentations use the same
static HTML transport as pages and are classified by Marp's `data-marpit-svg`
marker. Server events contain public route paths and
bounded categorical properties only, with no visitor headers or identifiers.
The fixed User-Agent is `Schaffa/1.0 (aggregate publication metrics)`. Upstream
Umami's `/api/send` uses `isbot` and accepts this product/version User-Agent;
the service sees the application's egress IP, never the visitor's. The transport
allows eight concurrent requests, a 1.5-second timeout, no redirects and no retries.
Failures and capacity drops are counted. `NODE_DEBUG=schaffa:telemetry` enables
failure diagnostics without payloads or visitor data. A slow collector cannot block serving.

GlitchTip loads lazily on own UI, including admin, with an early bounded error
queue. Admin never loads Umami or the banner. Sentry SDK 11 replaced
`sendDefaultPii` with `dataCollection`; user info, cookies, headers, bodies, queries,
database values, AI inputs/outputs and local variables are explicitly disabled.
Browser integrations are an explicit allowlist without BrowserSession, replay,
feedback or persistent trace linking. `linkPreviousTrace: 'off'` prevents
sessionStorage writes. Error, breadcrumb and trace payloads are scrubbed again.
Static transaction envelopes are used for GlitchTip compatibility.
`POST /admin/api/telemetry-test` requires the existing admin cookie and emits
`Schaffa GlitchTip test error — safe to ignore` for operator verification.

The official Sentry npm package does not ship its CDN bundles. An esbuild step
creates a minified SDK asset with tracing and without replay or feedback, plus
the browser-safe scrubber shared with the server. The UI scripts remain unbundled
and unminified. Runtime serves these assets and CookieConsent's npm dist JS/CSS
under content-hashed, immutable first-party URLs. The browser SDK is a build
dependency; its generated asset stays in the runtime image. No vendor maps are exposed. Docker injects server
debug IDs offline after tsc, then deletes all `dist/**/*.js.map` files before
copying `/app/dist` into the runtime image. The SDK uses the retained debug IDs;
runtime does not need local maps. Do not enable Node's `--enable-source-maps`.

After image publishing, the `ubuntu-latest` tag job rebuilds the server with maps
and injects debug IDs. It authenticates to GHCR with its job token, extracts
`/app/dist` from `ghcr.io/<repository>:sha-<commit>`, and fails before upload if
the image's set of debug IDs differs from the rebuild's or either set is empty.
It then creates `schaffa@<version>`, uploads the rebuilt maps, and finalizes the
release through `https://glitchtip.heerlab.com`. Only the required upload and
release routes bypass SSO; do not run `set-commits`. The upload token is the
existing `GLITCHTIP_AUTH_TOKEN` repository secret and never enters the image.

## Docker Compose

The included [compose.yaml](../compose.yaml) runs only Schaffa and binds its HTTP port to loopback. Provision the trusted ClamGate public key before starting:

```sh
export SCHAFFA_IMAGE="ghcr.io/beastyrabbit/schaffa@sha256:<published-manifest-digest>"
docker compose up -d --pull always --no-build
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
```

Set `SCHAFFA_IMAGE` to the manifest digest produced by the selected CI build; Compose intentionally has no mutable `latest` fallback. Run Compose through the local secret manager so the required values are present in its environment. The repository intentionally does not prescribe or expose instance-specific secret-store coordinates.

## ClamGate scanning

ClamGate v0.1.0 is the only scanner. There is no enable flag or provider selection.
Schaffa defaults to `https://virus.heerlab.com`. Set
`CLAMGATE_PUBLIC_KEY_FILE` and `CLAMGATE_PUBLIC_KEY_ID`.
Obtain the Ed25519 SPKI PEM public key and its ID from
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

Compose mounts the host path in `CLAMGATE_PUBLIC_KEY_FILE` read-only at
`/run/clamgate/public.pem`. The host file must already exist and be readable by
the container's `node` user. Direct server starts and `pnpm dev` read the path
from the same variable. The development script starts Portless without Docker.

Upgrading from the local scanner requires the trusted key before starting this
version. Remove the old scanner-selection and ClamAV connection variables.
The old Compose scanner container and signature volume are no longer used;
an operator can remove those exact obsolete resources after migration.

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
bounded by the smaller of that deadline and `CLAMGATE_GUIDE_TIMEOUT_MS`, default
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
operator. Rolling back requires the previous application image and matching
Compose configuration. Existing rendering and sandbox restrictions still apply.

## Scan monitoring

Schaffa exposes the private Prometheus gauge `schaffa_pending_scans` at
`/metrics`. It counts quarantined page/file jobs plus guide screenshots waiting
for ClamGate. Alert on sustained pending work and service errors. Scanner engine
scaling and signature updates belong to the shared ClamGate service.
Do not expose `/metrics` through the public reverse proxy.

## Persistent data and upgrades

SQLite metadata and stored files must be backed up together. Back up the complete `/data` volume rather than copying only the database or only the object directories. Page and file uploads receive a stable URL immediately and remain in `/data/quarantine` until ClamGate returns a verified clean result. Scanner unavailability leaves them pending for retry; rejected payload bytes are deleted while the URL keeps a status tombstone.

For an update:

1. Back up `/data`.
2. Pull the new release image by its immutable digest.
3. Recreate the container without deleting its volume.
4. Verify `/healthz`, the admin login, one public page, and one public file.
