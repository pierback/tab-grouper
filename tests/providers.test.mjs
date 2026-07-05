import assert from "node:assert/strict";
import { createGroupPlanWithFallback } from "../lib/providers.js";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

const tabs = [
  { id: 1, title: "GitHub Issue", domain: "github.com" },
  { id: 2, title: "Pull Request", domain: "github.com" },
  { id: 3, title: "OpenAI Docs", domain: "developers.openai.com" },
  { id: 4, title: "Chrome Extensions", domain: "developer.chrome.com" }
];

const heuristic = await createGroupPlanWithFallback(tabs, {
  provider: "heuristic",
  minimumGroupSize: 2
});

assert.equal(heuristic.provider, "heuristic");
assert.equal(heuristic.usedFallback, false);
assert.equal(heuristic.plan.groups.length > 0, true);

const fallback = await createGroupPlanWithFallback(tabs, {
  provider: "chrome-ai",
  minimumGroupSize: 2
});

assert.equal(fallback.provider, "heuristic");
assert.equal(fallback.requestedProvider, "chrome-ai");
assert.equal(fallback.usedFallback, true);
assert.match(fallback.providerError, /built-in AI/i);
assert.equal(fallback.plan.groups.length > 0, true);

globalThis.chrome = {
  permissions: {
    async contains() {
      return false;
    }
  }
};

const missingNativePermission = await createGroupPlanWithFallback(
  tabs,
  {
    provider: "local-codex-cli",
    minimumGroupSize: 2
  },
  tabs
);

assert.equal(missingNativePermission.provider, "heuristic");
assert.equal(missingNativePermission.requestedProvider, "local-codex-cli");
assert.equal(missingNativePermission.usedFallback, true);
assert.equal(missingNativePermission.providerErrorKind, "missing-native-permission");
assert.equal(missingNativePermission.plan.groups.length > 0, true);

globalThis.chrome = {
  permissions: {
    async contains() {
      return false;
    }
  }
};

const missingPermission = await createGroupPlanWithFallback(
  tabs,
  {
    provider: "openai",
    openaiApiKey: "sk-test",
    openaiModel: "gpt-test",
    minimumGroupSize: 2
  },
  tabs
);

assert.equal(missingPermission.provider, "heuristic");
assert.equal(missingPermission.requestedProvider, "openai");
assert.equal(missingPermission.usedFallback, true);
assert.equal(missingPermission.providerErrorKind, "missing-host-permission");
assert.match(missingPermission.providerError, /host permission is missing/i);
assert.equal(missingPermission.plan.groups.length > 0, true);

globalThis.chrome = {
  permissions: {
    async contains() {
      return true;
    }
  }
};
globalThis.fetch = async (url, options) => {
  return await new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
};

const timedOut = await createGroupPlanWithFallback(
  tabs,
  {
    provider: "openai",
    openaiApiKey: "sk-test",
    openaiModel: "gpt-test",
    providerRequestTimeoutMs: 1,
    minimumGroupSize: 2
  },
  tabs
);

assert.equal(timedOut.provider, "heuristic");
assert.equal(timedOut.requestedProvider, "openai");
assert.equal(timedOut.usedFallback, true);
assert.equal(timedOut.providerErrorKind, "provider-timeout");
assert.match(timedOut.providerError, /timed out/i);
assert.equal(timedOut.plan.groups.length > 0, true);

globalThis.chrome = originalChrome;
globalThis.fetch = originalFetch;

console.log("Provider tests passed.");
