import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function main() {
  const tag = process.env.RELEASE_REF_NAME;
  const environmentFile = process.env.RELEASE_ENV_FILE;
  if (!tag) throw new Error("RELEASE_REF_NAME is required.");
  if (!environmentFile) throw new Error("RELEASE_ENV_FILE is required.");

  const root = readPackageJson("../package.json");
  const cli = readPackageJson("../packages/cli/package.json");
  const release = validateRelease(tag, root.version, cli.version);
  appendFileSync(
    environmentFile,
    [
      `RELEASE_VERSION=${release.version}`,
      `RELEASE_TAG=${tag}`,
      `RELEASE_PRERELEASE=${release.prerelease}`,
      `RELEASE_DIST_TAG=${release.distTag}`,
      "",
    ].join("\n"),
  );
}

export function validateRelease(tagValue, rootVersion, cliVersion) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tagValue)) {
    throw new Error(`Release tag ${tagValue} is not a supported semantic version.`);
  }
  if (rootVersion !== cliVersion || tagValue !== `v${cliVersion}`) {
    throw new Error(
      `Tag ${tagValue} must match root and CLI package versions (${rootVersion}, ${cliVersion}).`,
    );
  }
  const prerelease = cliVersion.includes("-");
  return { version: cliVersion, prerelease, distTag: prerelease ? "next" : "latest" };
}

function readPackageJson(relativePath) {
  const value = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error(`${relativePath} must define a version.`);
  }
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
