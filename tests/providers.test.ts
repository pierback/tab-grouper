import assert from "node:assert/strict";
import { estimateProviderUsageCost } from "../src/lib/cost_estimate.js";
import { createGroupPlanWithFallback } from "../src/lib/providers.js";
import type { ProviderError, TabGroupPlan } from "../src/lib/types.js";

interface OpenAIRequestBody {
  max_output_tokens: number;
  input: Array<{ content: Array<{ text: string }> }>;
  text: { format: { schema: { required: string[] } } };
}

interface AnthropicRequestBody {
  max_tokens: number;
}

function assertProviderError(error: unknown): ProviderError {
  assert.ok(error instanceof Error);
  return error as ProviderError;
}

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

const tabs = [
  { id: 1, title: "GitHub Issue", domain: "github.com" },
  { id: 2, title: "Pull Request", domain: "github.com" },
  { id: 3, title: "OpenAI Docs", domain: "developers.openai.com" },
  { id: 4, title: "Chrome Extensions", domain: "developer.chrome.com" }
];

assert.equal(estimateProviderUsageCost({ provider: "openai", openaiModel: "gpt-5.4-mini" }, null, null), undefined);
assert.equal(estimateProviderUsageCost({ provider: "openai", openaiModel: "gpt-5.4-mini" }, "100", "25"), undefined);
assert.equal(estimateProviderUsageCost({ provider: "openai", openaiModel: "gpt-5.4-mini" }, 100, 25), 0.0001875);

const heuristic = await createGroupPlanWithFallback(tabs, {
  provider: "heuristic",
  minimumGroupSize: 2
});

assert.equal(heuristic.provider, "heuristic");
assert.equal(heuristic.usedFallback, false);
assert.equal((heuristic.plan as TabGroupPlan).groups.length > 0, true);
assert.equal(typeof heuristic.durationMs, "number");

const fallback = await createGroupPlanWithFallback(tabs, {
  provider: "chrome-ai",
  minimumGroupSize: 2
});

assert.equal(fallback.provider, "heuristic");
assert.equal(fallback.requestedProvider, "chrome-ai");
assert.equal(fallback.usedFallback, true);
assert.match(fallback.providerError, /built-in AI/i);
assert.equal((fallback.plan as TabGroupPlan).groups.length > 0, true);
assert.equal(typeof fallback.durationMs, "number");

await assert.rejects(
  createGroupPlanWithFallback(tabs, {
    provider: "chrome-ai",
    allowHeuristicFallback: false,
    minimumGroupSize: 2
  }),
  (error) => {
    const providerError = assertProviderError(error);
    assert.equal(providerError.providerErrorKind, "provider-error");
    assert.match(providerError.message, /built-in AI/i);
    return true;
  }
);

globalThis.chrome = {
  permissions: {
    async contains() {
      return false;
    }
  }
} as unknown as typeof chrome;

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
assert.equal((missingNativePermission.plan as TabGroupPlan).groups.length > 0, true);

globalThis.chrome = {
  permissions: {
    async contains() {
      return false;
    }
  }
} as unknown as typeof chrome;

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
assert.equal((missingPermission.plan as TabGroupPlan).groups.length > 0, true);

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
    const providerError = assertProviderError(error);
    assert.equal(providerError.providerErrorKind, "missing-host-permission");
    assert.match(providerError.message, /host permission is missing/i);
    return true;
  }
);

globalThis.chrome = {
  permissions: {
    async contains() {
      return true;
    }
  }
} as unknown as typeof chrome;
globalThis.fetch = (async (_url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
  return await new Promise((resolve, reject) => {
    options?.signal?.addEventListener("abort", () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
}) as typeof fetch;

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: TimerHandler) => originalSetTimeout(callback, 0)) as typeof globalThis.setTimeout;

const timedOut = await createGroupPlanWithFallback(
  tabs,
  {
    provider: "openai",
    openaiApiKey: "sk-test",
    openaiModel: "gpt-test",
    providerRequestTimeoutSeconds: 10,
    minimumGroupSize: 2
  },
  tabs
);
globalThis.setTimeout = originalSetTimeout;

assert.equal(timedOut.provider, "heuristic");
assert.equal(timedOut.requestedProvider, "openai");
assert.equal(timedOut.usedFallback, true);
assert.equal(timedOut.providerErrorKind, "provider-timeout");
assert.match(timedOut.providerError, /timed out/i);
assert.equal((timedOut.plan as TabGroupPlan).groups.length > 0, true);

let openAIRequestBody: OpenAIRequestBody | null = null;
globalThis.fetch = (async (_url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
  openAIRequestBody = JSON.parse(String(options?.body)) as OpenAIRequestBody;
  return {
    ok: true,
    async json() {
      return {
        usage: {
          input_tokens: 123,
          output_tokens: 45
        },
        output_text: JSON.stringify({
          groups: [],
          assignments: [{ groupId: 7, tabIds: [1, 2] }]
        })
      };
    }
  } as unknown as Response;
}) as typeof fetch;

const assignedPlan = await createGroupPlanWithFallback(
  tabs,
  {
    provider: "openai",
    openaiApiKey: "sk-test",
    openaiModel: "gpt-5.4-mini",
    minimumGroupSize: 2
  },
  tabs,
  [{ id: 7, title: "Berlin Trip", color: "cyan", tabIds: [9] }]
);

assert.equal(assignedPlan.provider, "openai");
assert.deepEqual(assignedPlan.plan.assignments, [{ groupId: 7, tabIds: [1, 2] }]);
assert.equal(typeof assignedPlan.durationMs, "number");
assert.equal(assignedPlan.inputTokens, 123);
assert.equal(assignedPlan.outputTokens, 45);
assert.equal(assignedPlan.costUsd, 0.00029475);
assert.equal(assignedPlan.costBasis, "api-estimate");
assert.equal(openAIRequestBody!.max_output_tokens, 6000);
const systemPrompt = openAIRequestBody!.input[0]!.content[0]!.text;
const userPrompt = openAIRequestBody!.input[1]!.content[0]!.text;
assert.match(systemPrompt, /existingGroups are current Chrome tab groups/);
assert.match(systemPrompt, /prefer assignments to a fitting existing group/i);
assert.match(systemPrompt, /\{"assignments":\[\{"groupId":3,"tabIds":\[7,8\]\}\]\}/);
assert.deepEqual(openAIRequestBody!.text.format.schema.required, ["groups", "assignments"]);
assert.match(systemPrompt, /intent or task first/);
assert.match(systemPrompt, /short concrete noun phrases/);
assert.match(systemPrompt, /never generic labels/);
assert.match(userPrompt, /Add ungrouped tabs to matching existingGroups/);
assert.match(userPrompt, /"title": "Berlin Trip"/);

let anthropicRequestBody: AnthropicRequestBody | null = null;
globalThis.fetch = (async (_url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
  anthropicRequestBody = JSON.parse(String(options?.body)) as AnthropicRequestBody;
  return {
    ok: true,
    async json() {
      return {
        usage: {
          input_tokens: 234,
          output_tokens: 56
        },
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
  } as unknown as Response;
}) as typeof fetch;

const anthropicPlan = await createGroupPlanWithFallback(
  tabs,
  {
    provider: "anthropic",
    anthropicApiKey: "sk-ant-test",
    anthropicModel: "claude-sonnet-4-6-20260217",
    minimumGroupSize: 2
  },
  tabs,
  [{ id: 7, title: "Berlin Trip", color: "cyan", tabIds: [9] }]
);

assert.equal(anthropicPlan.provider, "anthropic");
assert.deepEqual(anthropicPlan.plan.assignments, [{ groupId: 7, tabIds: [1, 2] }]);
assert.equal(typeof anthropicPlan.durationMs, "number");
assert.equal(anthropicPlan.inputTokens, 234);
assert.equal(anthropicPlan.outputTokens, 56);
assert.equal(anthropicPlan.costUsd, 0.001542);
assert.equal(anthropicPlan.costBasis, "api-estimate");
assert.equal(anthropicRequestBody!.max_tokens, 6000);

globalThis.chrome = originalChrome;
globalThis.fetch = originalFetch;

console.log("Provider tests passed.");
