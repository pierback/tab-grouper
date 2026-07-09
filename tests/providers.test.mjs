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

await assert.rejects(
  createGroupPlanWithFallback(tabs, {
    provider: "chrome-ai",
    allowHeuristicFallback: false,
    minimumGroupSize: 2
  }),
  (error) => {
    assert.equal(error.providerErrorKind, "provider-error");
    assert.match(error.message, /built-in AI/i);
    return true;
  }
);

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

await assert.rejects(
  createGroupPlanWithFallback(
    tabs,
    {
      provider: "openai",
      openaiApiKey: "sk-test",
      openaiModel: "gpt-test",
      allowHeuristicFallback: false,
      minimumGroupSize: 2
    },
    tabs
  ),
  (error) => {
    assert.equal(error.providerErrorKind, "missing-host-permission");
    assert.match(error.message, /host permission is missing/i);
    return true;
  }
);

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

let openAIRequestBody = null;
globalThis.fetch = async (url, options) => {
  openAIRequestBody = JSON.parse(options.body);
  return {
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({
          groups: [],
          assignments: [{ groupId: 7, tabIds: [1, 2] }]
        })
      };
    }
  };
};

const assignedPlan = await createGroupPlanWithFallback(
  tabs,
  {
    provider: "openai",
    openaiApiKey: "sk-test",
    openaiModel: "gpt-test",
    minimumGroupSize: 2
  },
  tabs,
  [{ id: 7, title: "Berlin Trip", color: "cyan", tabIds: [9] }]
);

assert.equal(assignedPlan.provider, "openai");
assert.deepEqual(assignedPlan.plan.assignments, [{ groupId: 7, tabIds: [1, 2] }]);
assert.equal(openAIRequestBody.max_output_tokens, 6000);
const systemPrompt = openAIRequestBody.input[0].content[0].text;
const userPrompt = openAIRequestBody.input[1].content[0].text;
assert.match(systemPrompt, /existingGroups are current Chrome tab groups/);
assert.match(systemPrompt, /prefer assignments to a fitting existing group/i);
assert.match(systemPrompt, /\{"assignments":\[\{"groupId":3,"tabIds":\[7,8\]\}\]\}/);
assert.deepEqual(openAIRequestBody.text.format.schema.required, ["groups", "assignments"]);
assert.match(systemPrompt, /intent or task first/);
assert.match(systemPrompt, /short concrete noun phrases/);
assert.match(systemPrompt, /never generic labels/);
assert.match(userPrompt, /Add ungrouped tabs to matching existingGroups/);
assert.match(userPrompt, /"title": "Berlin Trip"/);

let anthropicRequestBody = null;
globalThis.fetch = async (url, options) => {
  anthropicRequestBody = JSON.parse(options.body);
  return {
    ok: true,
    async json() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              groups: [],
              assignments: [{ groupId: 7, tabIds: [1, 2] }]
            })
          }
        ]
      };
    }
  };
};

const anthropicPlan = await createGroupPlanWithFallback(
  tabs,
  {
    provider: "anthropic",
    anthropicApiKey: "sk-ant-test",
    anthropicModel: "claude-test",
    minimumGroupSize: 2
  },
  tabs,
  [{ id: 7, title: "Berlin Trip", color: "cyan", tabIds: [9] }]
);

assert.equal(anthropicPlan.provider, "anthropic");
assert.deepEqual(anthropicPlan.plan.assignments, [{ groupId: 7, tabIds: [1, 2] }]);
assert.equal(anthropicRequestBody.max_tokens, 6000);

globalThis.chrome = originalChrome;
globalThis.fetch = originalFetch;

console.log("Provider tests passed.");
