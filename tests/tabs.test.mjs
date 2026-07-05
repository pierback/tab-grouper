import assert from "node:assert/strict";
import { getTabSkipReason, isGroupableTab, isTabGrouped, parseUrl, tabToPromptRecord } from "../lib/tabs.js";

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
  { id: 7, title: "Issue", domain: "github.com", url: undefined, pageHint: undefined }
);

assert.deepEqual(
  tabToPromptRecord(
    { id: 7, title: "Issue", url: "https://github.com/openai/codex/issues/1" },
    { ...baseSettings, includeFullUrls: true }
  ),
  { id: 7, title: "Issue", domain: "github.com", url: "https://github.com/openai/codex/issues/1", pageHint: undefined }
);

assert.deepEqual(
  tabToPromptRecord(
    { id: 7, title: "Issue", url: "https://github.com/openai/codex/issues/1", pageHint: "Title: Codex" },
    { ...baseSettings, includePageHints: true }
  ),
  { id: 7, title: "Issue", domain: "github.com", url: undefined, pageHint: "Title: Codex" }
);

console.log("Tab helper tests passed.");
