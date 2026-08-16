import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateRelease } from "../scripts/ci-validate-release.mjs";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/ci-validate-release.mjs", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("release validation exports the shared stable-release metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-release-test-"));
  const environmentFile = path.join(directory, "release.env");
  try {
    await execFileAsync(process.execPath, [script], {
      env: {
        ...process.env,
        RELEASE_REF_NAME: `v${packageJson.version}`,
        RELEASE_ENV_FILE: environmentFile,
      },
    });
    const prerelease = packageJson.version.includes("-");
    assert.equal(
      await readFile(environmentFile, "utf8"),
      [
        `RELEASE_VERSION=${packageJson.version}`,
        `RELEASE_TAG=v${packageJson.version}`,
        `RELEASE_PRERELEASE=${prerelease}`,
        `RELEASE_DIST_TAG=${prerelease ? "next" : "latest"}`,
        "",
      ].join("\n"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release validation rejects tags that disagree with package metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-release-test-"));
  const environmentFile = path.join(directory, "release.env");
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [script], {
        env: {
          ...process.env,
          RELEASE_REF_NAME: "v9.9.9",
          RELEASE_ENV_FILE: environmentFile,
        },
      }),
      /must match root and CLI package versions/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release validation rejects unsupported tag formats", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schaffa-release-test-"));
  const environmentFile = path.join(directory, "release.env");
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [script], {
        env: {
          ...process.env,
          RELEASE_REF_NAME: "release-candidate",
          RELEASE_ENV_FILE: environmentFile,
        },
      }),
      /is not a supported semantic version/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release validation selects next for prereleases", () => {
  assert.deepEqual(validateRelease("v1.2.3-rc.1", "1.2.3-rc.1", "1.2.3-rc.1"), {
    version: "1.2.3-rc.1",
    prerelease: true,
    distTag: "next",
  });
});
