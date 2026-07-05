import assert from "node:assert/strict";
import {
  buildFallbackText,
  buildNoGroupsMessage,
  buildPlanMessage,
  buildSkippedText,
  buildTidySuccessMessage,
  createPlanResponse
} from "../lib/plan_response.js";

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
    providerError: ""
  }
};

assert.equal(buildSkippedText({ pinned: 0, alreadyGrouped: 0, missingUrl: 2 }), "");
assert.equal(buildSkippedText(readyPlan.skipped), "Skipped 2 already grouped, 1 pinned.");
assert.equal(buildPlanMessage(readyPlan, { preview: true }), "Would create 2 groups. Skipped 2 already grouped, 1 pinned.");
assert.equal(
  buildTidySuccessMessage(
    [
      { name: "Codex GitHub", count: 2 },
      { name: "Dev Docs", count: 3 }
    ],
    readyPlan.skipped,
    { usedFallback: true, providerErrorKind: "missing-host-permission" }
  ),
  "Created 2 groups. Used local fallback because API host permission is missing. Skipped 2 already grouped, 1 pinned."
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
  undoAvailable: false,
  message: "Would create 2 groups. Skipped 2 already grouped, 1 pinned.",
  preview: true
});

assert.equal(
  buildNoGroupsMessage({ usedFallback: true }),
  "Used local fallback. Local fallback found no useful groups."
);
assert.equal(
  buildFallbackText({ usedFallback: true, providerErrorKind: "missing-api-key" }),
  "Used local fallback because the API key is missing."
);
assert.equal(
  buildFallbackText({ usedFallback: true, providerErrorKind: "provider-timeout" }),
  "Used local fallback because the provider timed out."
);
assert.equal(
  buildFallbackText({ usedFallback: true, providerErrorKind: "native-host-not-found" }),
  "Used local fallback because the local CLI bridge is not installed."
);
assert.equal(
  buildFallbackText({ usedFallback: true, providerErrorKind: "native-host-config-error" }),
  "Used local fallback because the local CLI bridge is not configured correctly."
);
assert.equal(
  buildFallbackText({ usedFallback: true, providerErrorKind: "cli-auth-missing" }),
  "Used local fallback because the selected CLI is not signed in."
);
assert.equal(
  buildFallbackText({ usedFallback: true, providerErrorKind: "cli-error" }),
  "Used local fallback because the selected CLI failed."
);
assert.equal(
  buildFallbackText({ usedFallback: true, providerErrorKind: "malformed-output" }),
  "Used local fallback because the local CLI returned invalid JSON."
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
