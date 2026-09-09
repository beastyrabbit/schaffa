// Emit a small caller workflow. It never writes to GitHub or modifies a repository.
import { SHA } from "./model.ts";

const [revision, runner, defaultBranch = "main"] = process.argv.slice(2);
if (
  !revision ||
  !SHA.test(revision) ||
  !runner ||
  !/^arc-opengrep-[a-z0-9-]+$/.test(runner) ||
  !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(defaultBranch)
) {
  throw new Error(
    "Usage: caller.ts <published-schaffa-SHA> <arc-opengrep-repository> [default-branch]",
  );
}
process.stdout.write(`name: OpenGrep
on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]
  workflow_dispatch:
  push:
    branches: [${JSON.stringify(defaultBranch)}]
  schedule:
    - cron: '37 4 * * *'
permissions:
  contents: read
  actions: read
  pull-requests: write
  checks: write
concurrency:
  group: opengrep-\${{ github.event.pull_request.number || 'full' }}
  cancel-in-progress: true
jobs:
  opengrep:
    uses: beastyrabbit/schaffa/.github/workflows/opengrep-shared.yml@${revision}
    with:
      runner: ${runner}
      profile: all
      tooling-ref: ${revision}
`);
