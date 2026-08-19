# Self-host Schaffa with Docker Compose and Infisical

This guide deploys Schaffa on one Linux host with Docker Compose, ClamAV,
Infisical runtime secret injection, persistent storage, and an HTTPS reverse
proxy. It deliberately keeps secret values out of Git, Compose files, shell
history, and Docker image layers.

## What you will run

```text
Internet
   │ HTTPS
   ▼
Reverse proxy ─────► Schaffa :3000 ─────► ClamAV :3310
                         │                     │
                         ▼                     ▼
                   /data volume         signature volume
                  SQLite + uploads       reproducible data
```

Only the reverse proxy is public. Schaffa binds to host loopback and ClamAV is
reachable only inside the Compose network. The entire Schaffa `/data` volume
is one backup unit: SQLite metadata and stored page/file bytes must remain in
sync.

## Prerequisites

- A Linux AMD64 host with Docker Engine and the Compose plugin.
- A DNS name such as `publish.example.com` pointing to the host or its tunnel.
- An HTTPS reverse proxy. Pangolin, Caddy, Traefik, and nginx all work.
- An Infisical organization and project.
- Infisical CLI installed on the host. Pin a tested version in production.
- At least 4 GiB RAM for Schaffa plus ClamAV. ClamAV signature loading is the
  largest baseline memory consumer.
- Storage sized for the configured `MAX_STORAGE_BYTES` plus backups.

The examples use Infisical Cloud's default endpoint. If you self-host
Infisical, add `--domain https://infisical.example.com` to CLI commands or set
the domain in the host's Infisical configuration.

## 1. Create the Infisical project

In Infisical:

1. Create a **Secret Management** project named `Schaffa`.
2. Keep or create a `prod` environment.
3. Create the folder `/runtime` in `prod`.
4. Add a machine identity named `schaffa-production` to this project with
   read-only access to `prod/runtime`.
5. Choose the authentication method for the host:
   - AWS/GCP/Azure VM: prefer the platform-native auth method.
   - Generic Linux VM: use Universal Auth and restrict its trusted IPs when
     your Infisical plan supports it.

The machine identity receives only secret-read access. It does not need project
administration or secret-write permissions.

## 2. Generate the two bootstrap values

Generate both values locally with a cryptographically secure generator. Do not
paste them into chat, tickets, documentation, or command arguments.

```sh
umask 077
openssl rand -base64 48 > /tmp/schaffa-pepper
printf 'sfa_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" \
  > /tmp/schaffa-bootstrap
```

In the Infisical UI, create these `prod/runtime` secrets by reading the two
files into the browser fields:

| Secret | Purpose |
| --- | --- |
| `SCHAFFA_TOKEN_PEPPER` | HMAC key for API tokens and user sessions |
| `SCHAFFA_BOOTSTRAP_TOKEN` | Temporary initial administrator token |

Delete the two temporary files after the values are safely stored. Pepper
rotation invalidates every API token and user session, so treat it like an
encryption root key: back it up through your Infisical disaster-recovery plan
and rotate only as a planned migration.

## 3. Prepare the deployment directory

```sh
sudo install -d -m 0750 -o "$USER" -g docker /opt/schaffa
cd /opt/schaffa
curl --fail --location --output compose.yaml \
  https://git.heerlab.com/beasty/schaffa/raw/tag/v0.2.1/compose.yaml
```

Read the selected release in Forgejo and copy its immutable container digest.
Do not deploy `main`, an unpinned mutable tag, or the example digest below.

Create `/opt/schaffa/deployment.env` containing non-secret settings only:

```dotenv
SCHAFFA_IMAGE=git.heerlab.com/beasty/schaffa@sha256:REPLACE_WITH_RELEASE_DIGEST
SCHAFFA_BASE_URL=https://publish.example.com

MAX_STORAGE_BYTES=21474836480
MAX_ANONYMOUS_STORAGE_BYTES=536870912
MAX_ANONYMOUS_PAGES=5000
ANONYMOUS_PAGE_TTL_SECONDS=3600
ANONYMOUS_PAGE_RETENTION_DAYS=30
MAX_PAGE_VERSIONS=25
TRUST_PROXY_HOPS=1
```

This file is not secret, but keep it host-local so environment-specific DNS
names and capacity choices do not leak into reusable deployment automation.

## 4. Authenticate the host to Infisical

For a generic VM using Universal Auth, create a client secret for the
`schaffa-production` machine identity. Store the client ID and client secret in
the host's root-readable credential store, not in the Schaffa repository.

Use the credentials once to mint a short-lived access token:

```sh
export INFISICAL_TOKEN="$(infisical login \
  --method=universal-auth \
  --client-id="$INFISICAL_CLIENT_ID" \
  --client-secret="$INFISICAL_CLIENT_SECRET" \
  --plain --silent)"
```

For a cloud VM, replace Universal Auth with the appropriate zero-secret AWS,
GCP, or Azure login. The remaining deployment command is identical.

## 5. Start Compose with runtime secret injection

Run Compose as a child of `infisical run`. Infisical places the two secrets in
the Compose process environment, and Compose passes them to Schaffa. They are
never written to a generated `.env` file.

```sh
set -a
. /opt/schaffa/deployment.env
set +a

infisical run \
  --projectId YOUR_SCHAFFA_PROJECT_ID \
  --env prod \
  --path /runtime \
  -- docker compose up -d --pull always --no-build
```

Verify both containers:

```sh
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
docker compose logs --tail=100 schaffa clamav
```

The first ClamAV startup can take several minutes while signatures download.
Schaffa returns the final URL immediately, shows a no-cache scan status page,
and keeps the payload quarantined until ClamAV is ready. Scanner outages are
retried; unscanned bytes are never served.

For unattended restarts, configure your service manager to authenticate the
machine identity and invoke the same `infisical run -- docker compose up ...`
command. Do not persist the short-lived `INFISICAL_TOKEN`; mint it for every
deployment operation.

## 6. Configure HTTPS and public paths

Proxy `https://publish.example.com` to `http://127.0.0.1:3000` and preserve the
original `Host` header. Overwrite client-supplied forwarding headers. Set
`TRUST_PROXY_HOPS` to the exact number of trusted proxy hops between the client
and Schaffa; the default is one.

The following paths are intentionally public:

- `/` — landing page
- `/skills`, `/skills/*`, `/llm.txt`, and `/llms.txt` — agent examples and discovery
- `/metadata/*` — stable OpenAPI metadata
- `/api`, `/api/*`, and `/api/*/*` — bearer-protected API plus anonymous page creation
- `/account`, `/account/*`, `/assets/*`, `/auth/*`, `/shoo/*` — user login and token dashboard
- `/p/*`, `/p/*/*`, `/p/*/*/*` — public pages and versions
- `/f/*` — public files and scan status

Keep `/admin` behind your reverse proxy's SSO when available. Schaffa then
applies a second gate by requiring an admin token. Keep `/healthz` private to
the proxy or load balancer.

After TLS is issued, verify:

```sh
curl --fail https://publish.example.com/metadata/openapi.json
curl --fail --head https://publish.example.com/account
curl --fail --silent https://publish.example.com/api
```

The responses should include HSTS, `X-Content-Type-Options: nosniff`, and the
route-appropriate Content Security Policy.

## 7. Replace the bootstrap administrator

Open `/admin`, sign in once with the bootstrap token from Infisical, and create
a separate administrator token in the Tokens section. Store the displayed
administrator token immediately in Infisical with a narrow human/operator
access policy. Confirm it works, revoke the bootstrap token through `/admin`, then delete
`SCHAFFA_BOOTSTRAP_TOKEN` from `prod/runtime` and recreate Schaffa. An absent
bootstrap value keeps the bootstrap row revoked.

## 8. Verify publishing end to end

Create a harmless anonymous page:

```sh
printf '<!doctype html><title>Schaffa works</title><h1>It works</h1>\n' \
  > /tmp/schaffa-smoke.html
npx schaffa upload /tmp/schaffa-smoke.html
```

Open the returned URL, then remove the smoke page through the admin UI. Also
verify a user can sign in at `/account`, create a dedicated agent token, upload
a permanent page with a random ID, and revoke the token. If Interactive
Publishing is enabled, also verify an unapproved user is denied, an approved
user can create an interactive-only token, and `/run` returns the restrictive
sandbox CSP before disabling the feature again.

## Backup and restore

Back up the entire `schaffa-data` volume as one consistency unit. A practical
maintenance-window backup is:

```sh
docker compose stop schaffa
docker run --rm \
  --volume schaffa_schaffa-data:/source:ro \
  --volume /srv/backups/schaffa:/backup \
  alpine:3.22 \
  tar -C /source -czf /backup/schaffa-data-$(date +%F).tar.gz .
docker compose start schaffa
```

Store backups encrypted and off-host. Test restores regularly on an isolated
hostname. Restore the complete archive into an empty data volume, restore the
same `SCHAFFA_TOKEN_PEPPER` from Infisical, start Schaffa, and verify page/file
reads plus admin authentication. The ClamAV signature volume is reproducible
and does not need backup.

## Upgrade and rollback

1. Read the release notes and copy the new immutable digest.
2. Back up `/data`.
3. Change only `SCHAFFA_IMAGE` in `deployment.env`.
4. Run the same Infisical-wrapped Compose command with `--pull always`.
5. Verify health, OpenAPI metadata, login, one page, and one file.

Rollback by restoring the previous digest and recreating the container. If a
release includes a database migration that is not backward compatible, restore
the matching `/data` backup as well.

## Operational checklist

- Monitor disk usage against `MAX_STORAGE_BYTES` and leave filesystem headroom.
- Alert when either container is unhealthy or uploads return scanner errors.
- Back up `/data` and the Infisical project independently.
- Give every user or workstation its own revocable upload token.
- Keep anonymous limits conservative on public instances.
- Use the admin lockdown before incident response; it preserves reads and
  takedown operations while stopping new writes.
- Revoke exposed tokens. Logging out of the admin UI does not revoke its token.
- Upgrade by immutable digest and scan the selected image in your own registry
  policy pipeline when required.

No screenshots are required for the command-driven installation. The only UI
steps—creating the Infisical project, machine identity, and secrets—use labels
that can change between Infisical versions; the concepts and least-privilege
requirements above are the stable source of truth.
