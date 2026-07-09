import assert from "node:assert/strict";
import {
  getAllProviderOrigins,
  getAllProviderPermissions,
  getFriendlyProviderErrorMessage,
  getProviderDataScope,
  getProviderLabel,
  getProviderOrigins,
  getProviderPermissions
} from "../lib/provider_metadata.js";

assert.equal(getProviderLabel("heuristic"), "Local heuristic");
assert.equal(getProviderLabel("local-codex-cli"), "Local Codex CLI");
assert.equal(getProviderLabel("openai"), "OpenAI API");
assert.equal(getProviderLabel("unknown-provider"), "unknown-provider");

assert.deepEqual(
  getProviderDataScope({ provider: "heuristic", includeFullUrls: false }),
  {
    dataMode: "On-device",
    dataSummary: "Tab titles and URLs stay in Chrome."
  }
);

assert.deepEqual(
  getProviderDataScope({ provider: "local-codex-cli", includeFullUrls: false }),
  {
    dataMode: "Local CLI account",
    dataSummary: "Tab titles and domains are sent to the local Tab Grouper bridge, then to Codex through your signed-in Codex CLI account."
  }
);

assert.deepEqual(
  getProviderDataScope({ provider: "local-claude-cli", includeFullUrls: true }),
  {
    dataMode: "Local CLI account",
    dataSummary: "Tab titles and full URLs are sent to the local bridge, then to the selected local CLI account."
  }
);

assert.deepEqual(
  getProviderDataScope({ provider: "openai", includeFullUrls: false }),
  {
    dataMode: "Cloud AI",
    dataSummary: "Tab titles and domains are sent by default."
  }
);

assert.deepEqual(
  getProviderDataScope({ provider: "anthropic", includeFullUrls: true }),
  {
    dataMode: "Cloud AI",
    dataSummary: "Tab titles and full URLs are sent to the selected API provider."
  }
);

assert.deepEqual(getProviderOrigins("heuristic"), []);
assert.deepEqual(getProviderOrigins("local-codex-cli"), []);
assert.deepEqual(getProviderOrigins("chrome-ai"), []);
assert.deepEqual(getProviderOrigins("openai"), ["https://api.openai.com/*"]);
assert.deepEqual(getProviderOrigins("anthropic"), ["https://api.anthropic.com/*"]);
assert.deepEqual(getAllProviderOrigins(), ["https://api.openai.com/*", "https://api.anthropic.com/*"]);
assert.deepEqual(getProviderPermissions("local-codex-cli"), ["nativeMessaging"]);
assert.deepEqual(getProviderPermissions("local-claude-cli"), ["nativeMessaging"]);
assert.deepEqual(getProviderPermissions("heuristic"), []);
assert.deepEqual(getAllProviderPermissions(), ["nativeMessaging"]);

assert.equal(
  getFriendlyProviderErrorMessage({ providerErrorKind: "native-host-forbidden" }),
  "Native bridge is not allowed for this extension ID. Reinstall the native host."
);
assert.equal(
  getFriendlyProviderErrorMessage({ providerErrorKind: "native-host-not-found" }),
  "Native bridge is not installed. Run npm run native:install."
);
assert.equal(
  getFriendlyProviderErrorMessage({ providerErrorKind: "unknown-kind", message: "raw detail" }),
  "raw detail"
);
assert.equal(getFriendlyProviderErrorMessage({}), "Native bridge check failed.");

console.log("Provider metadata tests passed.");
