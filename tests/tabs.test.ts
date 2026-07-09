import assert from "node:assert/strict";
import { getTabSkipReason, isGroupableTab, isTabGrouped, parseUrl, tabToPromptRecord } from "../src/lib/tabs.js";

const baseSettings = {
  includeFullUrls: false,
  ignorePinnedTabs: true,
  keepExistingGroups: true
};

assert.equal(isGroupableTab({ id: 1, url: "https://github.com/openai/codex", groupId: -1 }, baseSettings), true);
assert.equal(getTabSkipReason({ id: 1, url: "https://github.com", pinned: true, groupId: -1 }, baseSettings), "pinned");
assert.equal(getTabSkipReason({ id: 1, url: "", groupId: -1 }, baseSettings), "missing-url");
assert.equal(getTabSkipReason({ id: 1, url: "https://github.com", groupId: 42 }, baseSettings), "already-grouped");
assert.equal(isGroupableTab({ id: 1, url: "https://github.com", groupId: 42 }, { ...baseSettings, keepExistingGroups: false }), true);
assert.equal(isTabGrouped({ groupId: 42 }), true);
assert.equal(isTabGrouped({ groupId: -1 }), false);
assert.deepEqual(parseUrl("https://www.example.com/docs"), {
  hostname: "example.com",
  protocol: "https:",
  pathname: "/docs",
  port: ""
});

assert.deepEqual(
  tabToPromptRecord(
    { id: 7, title: "Issue", url: "https://github.com/openai/codex/issues/1" },
    baseSettings
  ),
  { id: 7, title: "Issue", domain: "github.com", url: undefined, pageHint: undefined, context: undefined }
);

assert.deepEqual(
  tabToPromptRecord(
    { id: 7, title: "Issue", url: "https://github.com/openai/codex/issues/1" },
    { ...baseSettings, includeFullUrls: true }
  ),
  { id: 7, title: "Issue", domain: "github.com", url: "https://github.com/openai/codex/issues/1", pageHint: undefined, context: undefined }
);

const context = {
  canonicalUrl: "https://github.com/openai/codex/issues/1",
  path: "/openai/codex/issues/1",
  siteName: "GitHub",
  metaDescription: "Issue discussion.",
  ogTitle: "Issue",
  ogDescription: "Issue discussion.",
  headings: ["Bug"],
  visibleText: "A reproducible issue.",
  source: "page",
  truncated: false
};

assert.deepEqual(
  tabToPromptRecord(
    { id: 7, title: "Issue", url: "https://github.com/openai/codex/issues/1", pageHint: "Title: Codex", context },
    { ...baseSettings, includePageHints: true }
  ),
  { id: 7, title: "Issue", domain: "github.com", url: undefined, pageHint: "Title: Codex", context }
);

{
  // A single oversized tab must not block the whole batch: the native host
  // rejects the entire request if any tab's title/domain/url/pageHint exceeds
  // its per-field cap, so the client must truncate to those same caps rather
  // than send the raw value through.
  const oversizedTitle = "x".repeat(400);
  const oversizedUrl = `https://example.com/${"y".repeat(1100)}`;
  const oversizedPageHint = "z".repeat(1500);
  const record = tabToPromptRecord(
    { id: 9, title: oversizedTitle, url: oversizedUrl, pageHint: oversizedPageHint },
    { ...baseSettings, includeFullUrls: true, includePageHints: true }
  );
  assert.equal(record.title.length, 300);
  assert.equal(record.url!.length, 1000);
  assert.equal(record.pageHint!.length, 1000);
}

console.log("Tab helper tests passed.");
