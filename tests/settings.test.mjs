import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, normalizeSettings, publicSettingsSummary, saveSettings, getSettings } from "../lib/settings.js";

const normalized = normalizeSettings({
  provider: "bad-provider",
  openaiApiKey: 123,
  openaiModel: "",
  anthropicApiKey: "  sk-ant-test  ",
  anthropicModel: "x".repeat(120),
  includeFullUrls: "true",
  includePageHints: "true",
  ignorePinnedTabs: "false",
  keepExistingGroups: "false",
  collapseGroups: "true",
  minimumGroupSize: 1
});

assert.equal(normalized.provider, "heuristic");
assert.equal(normalized.openaiApiKey, "");
assert.equal(normalized.openaiModel, DEFAULT_SETTINGS.openaiModel);
assert.equal(normalized.anthropicApiKey, "sk-ant-test");
assert.equal(normalized.anthropicModel.length, 80);
assert.equal(normalized.includeFullUrls, false);
assert.equal(normalized.includePageHints, false);
assert.equal(normalized.ignorePinnedTabs, true);
assert.equal(normalized.keepExistingGroups, true);
assert.equal(normalized.collapseGroups, false);
assert.equal(normalized.minimumGroupSize, 2);

assert.deepEqual(
  publicSettingsSummary({
    provider: "anthropic",
    includeFullUrls: true,
    includePageHints: true,
    ignorePinnedTabs: false,
    keepExistingGroups: false,
    collapseGroups: true,
    minimumGroupSize: 99
  }),
  {
    provider: "anthropic",
    openaiModel: DEFAULT_SETTINGS.openaiModel,
    anthropicModel: DEFAULT_SETTINGS.anthropicModel,
    includeFullUrls: true,
    includePageHints: true,
    ignorePinnedTabs: false,
    keepExistingGroups: false,
    collapseGroups: true,
    minimumGroupSize: 10
  }
);

const storageState = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(defaults) {
        return {
          ...defaults,
          ...storageState
        };
      },
      async set(values) {
        Object.assign(storageState, values);
      }
    }
  }
};

Object.assign(storageState, {
  provider: "not-real",
  minimumGroupSize: -5,
  includeFullUrls: "yes"
});

assert.equal((await getSettings()).provider, "heuristic");
assert.equal((await getSettings()).minimumGroupSize, 2);
assert.equal((await getSettings()).includeFullUrls, false);

await saveSettings({
  provider: "local-codex-cli",
  minimumGroupSize: 20,
  includeFullUrls: "yes",
  includePageHints: true,
  openaiApiKey: " key "
});

assert.equal(storageState.provider, "local-codex-cli");
assert.equal(storageState.minimumGroupSize, 10);
assert.equal(storageState.includeFullUrls, false);
assert.equal(storageState.includePageHints, true);
assert.equal(storageState.openaiApiKey, "key");

console.log("Settings tests passed.");
