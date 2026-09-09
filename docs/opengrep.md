# OpenGrep PR checks

OpenGrep runs in the homelab and updates one PR summary, with findings grouped
by rule. It does not post inline comments. Findings are advisory. No branch protection is installed, and private
repositories work with GitHub Free. A later paid plan can enforce checks without
moving the scanner. Do not require `OpenGrep / report` while it is advisory: its
neutral result deliberately does not block findings.

The initial implementation is a candidate until the homelab runner, successful
PR/fix cycle, network restrictions and private-repository caller are verified live.

## Shared workflow and per-repository settings

This public repository hosts `.github/workflows/opengrep-shared.yml`, the scanner
scripts and rule profiles. Public and private repositories can call it. Jobs,
checkout credentials, comments and artifacts belong to the calling repository.
Private code is not uploaded to schaffa or to the schaffa.dev publishing service.

Each repository chooses `runner` and `profile`. The default is `all`: enable all
698 validated rules and let their language selectors choose applicable files.
This includes low-confidence audit hints; no severity category is disabled.
Results are sorted by severity so informational word matches cannot displace
higher-priority findings from the first page of the summary.

Optional profiles are `web`, `python`, `go`, `c-cpp`, `dotnet`, `jvm`, `swift`,
`ruby`, `rust`, `php` and `config`; combine them with commas. Configuration rules
are included with every explicit language selection. Profile rule-file counts
are recorded in `.github/opengrep/vendor/manifest.json`. Counts overlap when a
rule supports more than one language. PHP and Rust currently have only one
upstream rule each; the availability of a profile is not comprehensive coverage.
Existing builds, language checks and tests remain in the caller's own workflows.

Schaffa additionally uses ESLint recommended, typescript-eslint strictTypeChecked,
eslint-plugin-security recommended and SonarJS recommended across its server,
scripts, tests and TypeScript CLI. The existing Linux verification job retains
the complete sanitized report as an artifact and reports counts in the run
summary. Findings are advisory; parser/setup failures fail the step. TypeScript
7 remains the build compiler under `@typescript/native`; the compatibility alias
`typescript -> @typescript/typescript6` supplies the API required by ESLint. This
is Microsoft's documented side-by-side configuration. Python/Go/Rust projects
need their own corresponding language checks; invoking OpenGrep does not run
their type checkers or build tools automatically.

## Rule sources and licenses

| Source | Rules | License |
| --- | ---: | --- |
| qodana/opengrep-sast-rules, GitLab-derived subset | 356 | MIT and LGPL-3.0 |
| trailofbits/semgrep-rules | 120 | AGPL-3.0 |
| elttam/semgrep-rules, including audit rules | 106 | MIT |
| 0xdea/semgrep-rules, including noisy C/C++ audit rules | 50 | MIT |
| patched-codes/semgrep-rules, complementary Java rules | 55 | MIT |
| AikidoSec/opengrep-rules | 2 | MIT |
| Locally authored supplementary rules | 9 | MIT |

Each source is pinned by commit in the manifest. License files and upstream
attributions accompany the rule source. The selected rules are plain replaceable
YAML source files. Files without a final newline have one added; rule semantics
are unchanged. Other upstream content is not copied or executed. The generator
produces an explicit patch from locally checked-out exact upstream revisions.

One elttam rule, `rules/generic/jsp-likely-xss.yaml`, is excluded because it lacks
the required `languages` field and fails validation. The Qodana `jetbrains/`
subdirectory is excluded because of Commons Clause licensing. Current Semgrep
Rules License content and the archived opengrep-rules fork are not used. The
patched-codes aggregate duplicates its individual rules, so only complementary
Java rules are included. This is a broad open rule selection, not a claim to
contain every available commercial or registry rule.

For another repository, copy the pilot `.github/workflows/opengrep.yml` and:

1. Replace the local `uses` with
   `beastyrabbit/schaffa/.github/workflows/opengrep-shared.yml@<published-40-character-SHA>`.
2. Set `tooling-ref` to that same published SHA. Never use a branch or floating tag.
3. Select its registered `arc-opengrep-<repository>` runner and matching profiles.
4. Add the corresponding repository-scoped ARC scale set to kub-homelab. The
   personal ARC App must already be installed for that repository. Do not create
   another credential; use the existing Infisical-managed registration credential.
5. Merge the workflow to its actual default branch, run a manual full scan, then
   verify a trusted PR and a subsequent fix. Do not enable a caller before its
   runner is ready.

Alternatively generate the caller without a remote write:

```sh
node --experimental-strip-types scripts/opengrep/caller.ts \
  <published-schaffa-SHA> arc-opengrep-<repository> <default-branch>
```

The output uses all rule profiles. Review it and save it as the target
repository's `.github/workflows/opengrep.yml` after the runner is ready.

Pushes to the pilot's `main` and the daily 04:37 UTC schedule run a full scan.
Adapt the push branch to each caller's real default branch. You can also run
`workflow_dispatch` on the default branch for a full scan. PR scans compare
against the actual merge base, using identical rules and engine version. Rule
updates need a new SHA in every caller and a full scan before broader use.

## Trust and permissions

`pull_request_target` loads the caller workflow from the trusted base rather than
the PR's modified workflow. Before requesting the scan runner, the workflow
requires the same head/base repository and author and actor in the explicit list
`beastyrabbit`, `renovate[bot]`, `dependabot[bot]`. External fork PRs are skipped.
No label bypass exists. A skip is not a security approval. This condition protects
this workflow only; it is not a repository-wide ban on all other workflows.

The scan job has only `contents: read`. It never runs PR scripts, package
installation, local Actions, submodules, builds or hooks. The public tool checkout
is pinned independently; the PR checkout is used only as scanner input. Credentials
are not persisted in either checkout. The reporter runs in a fresh pod, never
checks out PR code, and receives write rights only for PR comments and Checks.
The job tokens are scoped independently; no `secrets: inherit` or Infisical job
access is used.

The runner has no Docker socket, privileged sidecar, Kubernetes service-account
token or shared cache. Cilium permits DNS plus necessary GitHub/Node HTTPS
destinations. This restricted pod is for trusted contributions, not a proven
sandbox for arbitrary hostile public submissions. Public GitHub endpoints remain
network-accessible; this is not a general data-loss-prevention boundary.

Report metadata must match the caller, run ID, attempt, source SHA, base SHA and
tool revision. The reporter rechecks the current PR before writes. Reports are
bounded and contain only rule IDs, paths, line numbers and scan metadata. Raw
engine output, source excerpts, metavariables and arbitrary rule messages are not
published. Artifact retention starts at 14 days. Paths can still disclose private
project structure, so artifacts must stay in their source repository.

Scan failures, missing artifacts and publication failures fail the reporting job.
The reporter writes a separate `OpenGrep / report` check on the PR head, because
`pull_request_target` jobs themselves are associated with the base. Findings and
unsupported-file-only changes produce a neutral head check. Cancellation or an
early setup failure may leave no head check; inspect the Actions run in that case.
GitHub Free does not enforce its presence for private repositories.

Only the bot's marked summary is updated. It shows severity totals and at most
20 rule groups, ordered by severity, with a count for each rule. Repeated audit
hints occupy one row. All findings remain in the JSON artifact with rule IDs,
file paths and line numbers for further review, including findings outside added
diff lines. Existing inline threads from older reporter versions are not changed.

## Engine and exclusions

The engine is OpenGrep v1.30.0, LGPL-2.1. The official Linux x86 release binary is
downloaded per fresh runner and checked against the committed SHA-256. It is not
built or installed from repository code. See the upstream release at
https://github.com/opengrep/opengrep/releases/tag/v1.30.0.

Intrafile taint analysis is enabled. PR-provided `.gitignore`, `.semgrepignore`
and inline `nosem` suppressions cannot change the configured analysis. The trusted
scanner excludes `.git`, `node_modules`, `.venv`, `dist`, `build`, `coverage` and
the vendored scanner rules themselves. Test code is included. Files above 20 MB
and unsupported file types are not covered; no assertion of repository-wide
language coverage is made. Parallelism is three scanner workers, capped at 2 GB
per worker, with a thirty-minute process timeout inside a forty-minute job.

The TypeScript reporter updates the summary and head check through GitHub's API.
Reviewdog is not installed. SARIF is not produced in this first version.

## Updates and recovery

Review engine hashes, rules and Actions pins together. Verify known findings,
existing-baseline findings, a fix, unsupported-file changes and invalid reports
before updating callers. Revert the caller's pinned workflow/tooling SHA to the
previous tested version to recover. Do not silently turn technical failures green.

## Local acceptance evidence, 2026-09-09

- OpenGrep v1.30.0 validates 698 rules without configuration errors.
- A full scan of the local candidate examined 120 files in 55 seconds. It found
  1,617 matches, of which 1,613 were informational `raptor-bad-words` audit hints.
  Findings are not confirmed vulnerabilities and this is not a clean scan:
  `test/browser.test.ts:139` triggers a partial TypeScript parser error.
- The real-engine fixture test verifies new findings, an existing finding
  excluded by baseline, a fix, PR-provided ignore and nosem suppression attempts,
  intrafile data flow, multiple profiles, parser errors and a missing baseline.
- The type-aware ESLint run, including the CLI package, examined 62 files and reported 755 messages with
  no fatal parser failures. Counts change as the candidate changes.
- Unit tests cover malformed reports, unsafe paths, mention/HTML escaping,
  missing language coverage, grouped summary limits and summary-only publishing. The existing application
  suite, including its Chrome browser test, passes; platform-specific native
  macOS tests retain their existing skips on Linux.

## Live acceptance evidence, 2026-09-09

The [full Schaffa scan](https://github.com/beastyrabbit/schaffa/actions/runs/34398262970)
completed on the restricted ARC runner: 124 files, 1,630 findings, 73 seconds,
zero technical errors. Explicit UTF-8 fixes rule loading in the minimal runner
image. An equivalent type-only import in the browser test resolves the parser
limitation observed during local acceptance without excluding the test.

The temporary [acceptance PR](https://github.com/beastyrabbit/schaffa/pull/3)
verified a new eval finding, the then-enabled inline review, the summary and a neutral check
on the PR head. After replacing eval with constant arithmetic, the same summary
reported zero new findings and the new head check succeeded. The PR is closed
without merging the fixture.

The live runner uses UID 1001, drops all capabilities, disallows privilege
escalation and mounts no Kubernetes service-account token. Connectivity probes
reached GitHub and nodejs.org and could not reach the Kubernetes API or the
tested homelab destination. A private repository also completed a full scan
through this public reusable workflow and retained its report in its own run.

Other repositories can still produce parser errors or timeouts. Those results
remain incomplete; successful workflow delivery is not evidence that every
file can be analyzed by the engine. Repository rollout status is tracked in
the private homelab documentation. Daily caller schedules are staggered to
reduce simultaneous runner demand.
