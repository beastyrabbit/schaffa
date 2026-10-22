import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

async function main() {
  const tag = process.env.RELEASE_REF_NAME;
  if (!tag?.startsWith("v")) throw new Error("RELEASE_REF_NAME must be a v* release tag.");
  await smokeDeploy({
    baseUrl: process.env.SMOKE_BASE_URL || "https://schaffa.dev",
    expectedVersion: tag.slice(1),
  });
}

// Waits until the public deployment reports the expected release, then checks
// that the landing page and capability API are healthy on that release.
export async function smokeDeploy({
  baseUrl,
  expectedVersion,
  fetch = globalThis.fetch,
  timeoutMs = 20 * 60_000,
  intervalMs = 15_000,
  now = Date.now,
  sleep = delay,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  // Flux only promotes stable releases, so a prerelease would never appear.
  const expected = parseVersion(expectedVersion);
  if (!expected || expected.prerelease) {
    throw new Error(`Expected version ${expectedVersion} is not a stable release version.`);
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = await deployedVersion({ baseUrl, fetch });
    if (state.version !== undefined) {
      const order = compareVersions(parseVersion(state.version), expected);
      if (order === 0) break;
      if (order > 0) {
        throw new Error(
          `Release ${expectedVersion} was superseded: ${baseUrl} already runs ${state.version}.`,
        );
      }
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${baseUrl} to run ${expectedVersion} (last seen: ${state.description}).`,
      );
    }
    log(`Waiting for ${expectedVersion} on ${baseUrl} (now ${state.description}).`);
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  log(`${baseUrl} runs ${expectedVersion}; checking public endpoints.`);
  await checkPublicEndpoints({ baseUrl, expectedVersion, fetch });
  log(`Release ${expectedVersion} is live and healthy on ${baseUrl}.`);
}

async function checkPublicEndpoints({ baseUrl, expectedVersion, fetch }) {
  const landing = await get(fetch, new URL("/", baseUrl));
  if (landing.status !== 200) throw new Error(`Landing page returned HTTP ${landing.status}.`);
  if (!/<a class="wordmark" href="\/">Schaffa<\/a>/.test(await landing.text())) {
    throw new Error("Landing page is missing the Schaffa wordmark.");
  }
  const response = await get(fetch, new URL("/api/capabilities", baseUrl));
  if (response.status !== 200) throw new Error(`Capabilities returned HTTP ${response.status}.`);
  const capabilities = await response.json();
  if (
    capabilities?.version !== 1 ||
    capabilities.serverVersion !== expectedVersion ||
    capabilities.authenticated !== false ||
    typeof capabilities.capabilities?.staticHtml?.allowed !== "boolean"
  ) {
    throw new Error(`Capabilities returned an unexpected body: ${JSON.stringify(capabilities)}.`);
  }
}

// Rollouts briefly return gateway errors, so only a well-formed 200 that
// reports nonsense fails immediately; transport errors keep waiting.
async function deployedVersion({ baseUrl, fetch }) {
  let response;
  try {
    response = await get(fetch, new URL("/api/capabilities", baseUrl));
  } catch (error) {
    return { description: `request failed: ${error.message}` };
  }
  if (response.status !== 200) return { description: `HTTP ${response.status}` };
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${baseUrl}/api/capabilities returned a non-JSON 200 response.`);
  }
  if (body?.version !== 1) {
    throw new Error(`${baseUrl}/api/capabilities returned an unexpected body.`);
  }
  // Releases before serverVersion existed are older than any release that checks for it.
  if (body.serverVersion === undefined) return { description: "a release without serverVersion" };
  if (typeof body.serverVersion !== "string" || !parseVersion(body.serverVersion)) {
    throw new Error(
      `${baseUrl} reported malformed serverVersion ${JSON.stringify(body.serverVersion)}.`,
    );
  }
  return { version: body.serverVersion, description: body.serverVersion };
}

function get(fetch, url) {
  return fetch(url, {
    headers: { "Cache-Control": "no-cache" },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
}

function parseVersion(value) {
  const match = VERSION.exec(value);
  if (!match || match[0] !== value) return null;
  if (match[4]?.split(".").every(isValidPrereleaseIdentifier) === false) return null;
  if (match[5]?.split(".").some((identifier) => !identifier)) return null;
  return { core: match.slice(1, 4).map(BigInt), prerelease: Boolean(match[4]) };
}

function isValidPrereleaseIdentifier(identifier) {
  return (
    identifier.length > 0 &&
    (!/^\d+$/.test(identifier) || identifier.length === 1 || !identifier.startsWith("0"))
  );
}

// The expected side is always stable, so a prerelease of the same core is older.
function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  return Number(b.prerelease) - Number(a.prerelease);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
