import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBrowserManifestTargets } from "../scripts/lib/native_host_browsers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["scripts/install-native-host.mjs", "--", "--browser", "brave", "--help"],
  {
    cwd: root,
    encoding: "utf8"
  }
);

assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /nub run native:install --browser all/);
assert.match(result.stdout, /nub run native:install --browser brave/);

assert.deepEqual(
  resolveBrowserManifestTargets("all").map((target) => target.id),
  ["chrome", "brave", "edge", "chromium", "chrome-canary", "helium"]
);
assert.deepEqual(
  resolveBrowserManifestTargets("chrome").map((target) => target.id),
  ["chrome"]
);
assert.throws(
  () => resolveBrowserManifestTargets("firefox"),
  /Unsupported browser "firefox"\. Supported: all, chrome, brave, edge, chromium, chrome-canary, helium\./
);

console.log("Native host installer argument tests passed.");
