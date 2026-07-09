import assert from "node:assert/strict";
import {
  PLAN_CACHE_TTL_MS,
  getCachedPlan,
  invalidatePlanCache,
  setCachedPlan
} from "../src/lib/plan_cache.js";

const keyInput = {
  windowId: 1,
  provider: "chrome-ai",
  groupableTabs: [
    { id: 1, title: "One", url: "https://example.com/one", index: 0 },
    { id: 2, title: "Two", url: "https://example.com/two", index: 1 }
  ],
  existingGroups: [
    { id: 7, title: "Existing", color: "blue", tabIds: [1] }
  ]
};
const value = {
  plan: { groups: [{ name: "Example", color: "blue", tabIds: [1, 2] }], assignments: [] },
  providerResult: { provider: "chrome-ai", usedFallback: false, providerError: "", providerErrorKind: "" }
};

{
  const cache = new Map();
  setCachedPlan(cache, 1, keyInput, value, () => 1000);

  assert.equal(getCachedPlan(cache, 1, keyInput, () => 1000 + PLAN_CACHE_TTL_MS - 1), value);
}

{
  const cache = new Map();
  setCachedPlan(cache, 1, keyInput, value, () => 1000);

  const changedTitle = {
    ...keyInput,
    groupableTabs: [
      { ...keyInput.groupableTabs[0], title: "Changed" },
      keyInput.groupableTabs[1]
    ]
  };
  assert.equal(getCachedPlan(cache, 1, changedTitle, () => 1000), null);

  const changedTabIds = {
    ...keyInput,
    existingGroups: [
      { ...keyInput.existingGroups[0], tabIds: [1, 2] }
    ]
  };
  assert.equal(getCachedPlan(cache, 1, changedTabIds, () => 1000), null);
}

{
  const cache = new Map();
  setCachedPlan(cache, 1, keyInput, value, () => 1000);

  assert.equal(getCachedPlan(cache, 1, keyInput, () => 1000 + PLAN_CACHE_TTL_MS + 1), null);
  assert.equal(cache.has(1), false);
}

{
  const cache = new Map();
  setCachedPlan(cache, 1, keyInput, value, () => 1000);
  invalidatePlanCache(cache, 1);

  assert.equal(getCachedPlan(cache, 1, keyInput, () => 1000), null);
}

console.log("Plan cache tests passed.");
