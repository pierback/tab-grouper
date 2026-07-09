import assert from "node:assert/strict";
import { getCachedHint, setCachedHint } from "../src/lib/hint_cache.js";

const originalDateNow = Date.now;
try {
  let now = 1000;
  Date.now = () => now;

  const cache = new Map();
  const tab = { id: 1, url: "https://example.com/app", title: "App" };
  const hint = {
    pageHint: "Title: App",
    context: { source: "page", visibleText: "Dashboard" }
  };

  setCachedHint(cache, tab, hint);
  assert.deepEqual(getCachedHint(cache, tab), hint);

  assert.equal(getCachedHint(cache, { ...tab, url: "https://example.com/other" }), undefined);
  assert.equal(getCachedHint(cache, { ...tab, title: "Other" }), undefined);

  now += 300000;
  assert.equal(getCachedHint(cache, tab), undefined);
} finally {
  Date.now = originalDateNow;
}

console.log("Hint cache tests passed.");
