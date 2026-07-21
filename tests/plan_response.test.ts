import assert from "node:assert/strict";
import {
  buildFallbackText,
  buildNoGroupsMessage,
  buildPlanMessage,
  buildSkippedText,
  buildTidySuccessMessage,
  createPlanResponse
} from "../src/lib/plan_response.js";

const readyPlan = {
  canApply: true,
  reason: "ready",
  skipped: {
    pinned: 1,
    alreadyGrouped: 2,
    missingUrl: 0
  },
  plan: {
    groups: [
      { name: "Codex GitHub", color: "blue", tabIds: [1, 2] },
      { name: "Dev Docs", color: "red", tabIds: [3, 4, 5] }
    ],
    assignments: []
  },
  providerResult: {
    provider: "heuristic",
    usedFallback: false,
    providerError: "",
    durationMs: 123,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.0012
  }
};

assert.equal(buildSkippedText({ pinned: 0, alreadyGrouped: 0, missingUrl: 2 }), "Skipped 2 without a URL.");
assert.equal(buildSkippedText(readyPlan.skipped), "Skipped 2 already grouped, 1 pinned.");
assert.equal(buildPlanMessage(readyPlan, { preview: true }), "Would create 2 groups. Skipped 2 already grouped, 1 pinned.");
assert.equal(
  buildTidySuccessMessage(
    [
      { name: "Codex GitHub", count: 2 },
      { name: "Dev Docs", count: 3 }
    ],
    readyPlan.skipped,
    {
      provider: "heuristic",
      requestedProvider: "openai",
      usedFallback: true,
      providerError: "OpenAI API host permission is missing.",
      providerErrorKind: "missing-host-permission"
    }
  ),
  "Created 2 groups. Used Local heuristic instead of OpenAI API. API host permission is missing. Provider error: OpenAI API host permission is missing. Skipped 2 already grouped, 1 pinned."
);

assert.deepEqual(createPlanResponse(readyPlan, { preview: true }), {
  ok: true,
  groupedCount: 5,
  groups: [
    { name: "Codex GitHub", color: "blue", count: 2 },
    { name: "Dev Docs", color: "red", count: 3 }
  ],
  assignments: [],
  skipped: readyPlan.skipped,
  provider: "heuristic",
  requestedProvider: undefined,
  usedFallback: false,
  providerError: "",
  providerErrorKind: "",
  durationMs: 123,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.0012,
  undoAvailable: false,
  message: "Would create 2 groups. Skipped 2 already grouped, 1 pinned.",
  preview: true
});

assert.equal(
  buildNoGroupsMessage({ usedFallback: true }),
  "Used Local heuristic instead of the requested provider. Local fallback found no useful groups."
);
assert.equal(
  buildFallbackText({ provider: "heuristic", requestedProvider: "openai", usedFallback: true, providerError: "Add an OpenAI API key.", providerErrorKind: "missing-api-key" }),
  "Used Local heuristic instead of OpenAI API. API key is missing. Provider error: Add an OpenAI API key."
);
assert.equal(
  buildFallbackText({ provider: "heuristic", requestedProvider: "openai", usedFallback: true, providerError: "OpenAI request timed out.", providerErrorKind: "provider-timeout" }),
  "Used Local heuristic instead of OpenAI API. Provider timed out. Provider error: OpenAI request timed out."
);
assert.equal(
  buildFallbackText({ provider: "heuristic", requestedProvider: "local-codex-cli", usedFallback: true, providerError: "Bridge missing.", providerErrorKind: "native-host-not-found" }),
  "Used Local heuristic instead of Local Codex CLI. Local CLI bridge is not installed. Provider error: Bridge missing."
);
assert.equal(
  buildFallbackText({ provider: "heuristic", requestedProvider: "local-codex-cli", usedFallback: true, providerError: "Config invalid.", providerErrorKind: "native-host-config-error" }),
  "Used Local heuristic instead of Local Codex CLI. Local CLI bridge is not configured correctly. Provider error: Config invalid."
);
assert.equal(
  buildFallbackText({ provider: "heuristic", requestedProvider: "local-codex-cli", usedFallback: true, providerError: "Sign in required.", providerErrorKind: "cli-auth-missing" }),
  "Used Local heuristic instead of Local Codex CLI. Selected CLI is not signed in. Provider error: Sign in required."
);
assert.equal(
  buildFallbackText({ provider: "heuristic", requestedProvider: "local-codex-cli", usedFallback: true, providerError: "CLI exited 1.", providerErrorKind: "cli-error" }),
  "Used Local heuristic instead of Local Codex CLI. Selected CLI failed. Provider error: CLI exited 1."
);
assert.equal(
  buildFallbackText({ provider: "heuristic", requestedProvider: "local-codex-cli", usedFallback: true, providerError: "Could not parse JSON.", providerErrorKind: "malformed-output" }),
  "Used Local heuristic instead of Local Codex CLI. Local CLI returned invalid JSON. Provider error: Could not parse JSON."
);
assert.equal(
  buildPlanMessage({
    canApply: false,
    reason: "too-few-tabs",
    skipped: { pinned: 0, alreadyGrouped: 0, missingUrl: 0 },
    plan: { groups: [] },
    providerResult: { provider: "heuristic", usedFallback: false, providerError: "", providerErrorKind: "" }
  }),
  "Not enough tabs to group."
);

assert.equal(
  buildPlanMessage({
    canApply: true,
    reason: "ready",
    skipped: { pinned: 0, alreadyGrouped: 0, missingUrl: 0 },
    plan: {
      groups: [],
      assignments: [{ groupId: 7, tabIds: [1] }]
    },
    providerResult: { provider: "openai", usedFallback: false, providerError: "", providerErrorKind: "" }
  }, { preview: true }),
  "Would add 1 tab to existing groups."
);

assert.deepEqual(
  createPlanResponse({
    canApply: true,
    reason: "ready",
    skipped: { pinned: 0, alreadyGrouped: 0, missingUrl: 0 },
    existingGroups: [{ id: 7, title: "Berlin Trip", color: "cyan", tabIds: [4, 5] }],
    plan: {
      groups: [],
      assignments: [{ groupId: 7, tabIds: [1, 2] }]
    },
    providerResult: { provider: "openai", usedFallback: false, providerError: "", providerErrorKind: "" }
  }, { preview: true }).assignments,
  [{ groupId: 7, title: "Berlin Trip", count: 2 }]
);

assert.equal(
  buildTidySuccessMessage(
    [],
    { pinned: 0, alreadyGrouped: 0, missingUrl: 0 },
    { usedFallback: false },
    [{ groupId: 7, count: 3 }]
  ),
  "Added 3 tabs to existing groups."
);

assert.equal(
  buildPlanMessage({
    canApply: false,
    reason: "stale-plan",
    skipped: { pinned: 1, alreadyGrouped: 0, missingUrl: 0 },
    plan: { groups: [] },
    providerResult: { provider: "heuristic", usedFallback: false, providerError: "", providerErrorKind: "" }
  }),
  "Tabs changed while tidying; no useful groups remain."
);

console.log("Plan response tests passed.");
