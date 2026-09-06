# September 2026 review resolution

This change addresses [the review of Schaffa 0.9.1](https://schaffa.dev/p/al8lqp8a2jds12lm).

| Finding | Resolution and verification |
| --- | --- |
| F01 | Updated affected dependencies, replaced hop-count proxy trust with explicit addresses, and added secret/dependency gates to npm publishing. CLI releases bundle the locked runtime tree and audit a clean installation. |
| F02 | Scan the candidate image digest before promoting that same digest to final tags. Stubbed failure and success tests verify the sequence. |
| F03 | Persist the last allocated page version independently of the current version. The deletion/worker regression now requires a new version number. |
| F04 | Select pending pages and files together, with delayed retries. A failing page no longer blocks a fresh file. Ready work drains serially between idle ticks. |
| F05 | Inline supported local presentation images and backgrounds. A real Marp render, CLI upload, temporary server, and Chrome verify that images load. |
| F06 | Refresh the guide revision and retry one conflicting append with the same idempotency key. Browser and desktop capture share the serialized upload queue. |
| F07 | Read the guide slug from an explicit recovery manifest without requiring a session file. Tested through the CLI entry point. |
| F08 | Require Node 22.12.0 for the standalone CLI and Node 24 for server/development. CI covers Linux and macOS, plus clean CLI installation at its minimum runtime. |
| F09 | Preflight inspects guide metadata and visible step text, including URL-decoded text, and identifies the affected field. |
| F10 | Derive the development scanner project name from the worktree path. Stubbed start/stop tests verify independent projects. |
| F11 | The self-hosting smoke upload explicitly uses the configured instance origin. |
| F12 | A shared documented Compose wrapper injects secrets for each maintenance command. Backup stops on failed prerequisites and restarts the application on exit. |
| R01 | Register browser disconnection before initialization and handle an already disconnected browser. |
| R02 | Recheck positive image-conversion growth before metadata promotion. A harmless growing image verifies quota rejection and private output. |
| R03 | Public guide revisions and images use five-minute caches with revalidation. |
| R04 | Native screenshot children have a two-second deadline. A harmless sleeping child verifies timeout handling without capturing desktop input. |

The verification gaps also prompted offline ES256/JWKS tests of the production
Shoo verifier, required identity claims, scanner framing assertions, selected
OpenAPI response checks, real browser recording, and keyboard screenshot
navigation. Enlarged screenshots use ordinary new tabs with accurate accessible
labels. Management form errors provide a page with a recovery link. Browser tests
cover desktop and mobile guide layouts, admin pagination, and the intended fetch
and storage restrictions on interactive pages.

Optional maintenance work includes checked standalone browser scripts and server
tests grouped by behavior with explicit configuration/scanner reset. Guide steps,
published revisions, and retained metadata now have budgets; their logical text
bytes count toward storage usage. Atomic manifests and immutable snapshots remain
unchanged.

Disposable SQLite profiling measured 1.6 MB of retained metadata at 100 guide
steps, 9.8 MB at 250, and 38.9 MB at 500. Cumulative append time was approximately
85 ms, 769 ms, and 5.5 seconds respectively. This supports bounding growth while
keeping the existing recovery format. For 10,000 file records, SQL filtering and
50-item pagination reduced median admin rendering from 537 ms and 4.17 MB of HTML
to 16 ms and 39 KB on the review workstation. These are fixture observations, not
production capacity guarantees.

A disposable production container passed health, asset, and synthetic admin checks.
A stopped-volume backup restored identical SQLite bytes and working authentication.
No production deployment, live identity-provider login, or real desktop input was
used for verification.

Upgrade configuration must replace `TRUST_PROXY_HOPS` with `TRUSTED_PROXIES`, using
the proxy addresses or narrow CIDRs actually seen by the server. Back up the data
volume before the automatic page-version migration. Versions deleted before the
migration cannot be reconstructed. Previously cached or downloaded guide content
cannot be recalled, and the interactive sandbox is not complete network isolation.
