import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, normalizeSettings, publicSettingsSummary, saveSettings, getSettings } from "../src/lib/settings.js";
import type { Settings } from "../src/lib/types.js";

interface TestStorageState extends Partial<Record<keyof Settings, unknown>> {
  codexCliModel?: string;
  [key: string]: unknown;
}

const normalized = normalizeSettings({
  provider: "bad-provider",
  openaiApiKey: 123,
  openaiModel: "",
  anthropicApiKey: "  sk-ant-test  ",
  anthropicModel: "x".repeat(120),
  codexCliModel: " codex-model ",
  claudeCliModel: "",
  includeFullUrls: "true",
  includePageHints: "true",
  allowHeuristicFallback: false,
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
assert.equal(normalized.codexCliModel, "codex-model");
assert.equal(normalized.claudeCliModel, "");
assert.equal(normalized.includeFullUrls, false);
assert.equal(normalized.includePageHints, false);
assert.equal(normalized.allowHeuristicFallback, false);
assert.equal(normalized.ignorePinnedTabs, true);
assert.equal(normalized.keepExistingGroups, true);
assert.equal(normalized.collapseGroups, false);
assert.equal(normalized.minimumGroupSize, 2);

assert.deepEqual(
  publicSettingsSummary({
    provider: "anthropic",
    includeFullUrls: true,
    includePageHints: true,
    allowHeuristicFallback: false,
    ignorePinnedTabs: false,
    keepExistingGroups: false,
    collapseGroups: true,
    minimumGroupSize: 99
  }),
  {
    provider: "anthropic",
    openaiModel: DEFAULT_SETTINGS.openaiModel,
    anthropicModel: DEFAULT_SETTINGS.anthropicModel,
    codexCliModel: "",
    claudeCliModel: "",
    includeFullUrls: true,
    includePageHints: true,
    allowHeuristicFallback: false,
    ignorePinnedTabs: false,
    keepExistingGroups: false,
    collapseGroups: true,
    minimumGroupSize: 10
  }
);

const storageState: TestStorageState = {};
const fakeChrome = {
  storage: {
    local: {
      async get(defaults: Record<string, unknown>) {
        return {
          ...defaults,
          ...storageState
        };
      },
      async set(values: Record<string, unknown>) {
        Object.assign(storageState, values);
      }
    }
  }
};
globalThis.chrome = fakeChrome as unknown as typeof chrome;

Object.assign(storageState, {
  provider: "not-real",
  minimumGroupSize: -5,
  includeFullUrls: "yes"
});

assert.equal((await getSettings()).provider, "heuristic");
assert.equal((await getSettings()).minimumGroupSize, 2);
assert.equal((await getSettings()).includeFullUrls, false);
assert.equal((await getSettings()).allowHeuristicFallback, true);
assert.equal((await getSettings()).codexCliModel, "");

await saveSettings({
  provider: "local-codex-cli",
  minimumGroupSize: 20,
  includeFullUrls: "yes",
  includePageHints: true,
  allowHeuristicFallback: false,
  openaiApiKey: " key ",
  codexCliModel: "x".repeat(120),
  claudeCliModel: " "
});

assert.equal(storageState.provider, "local-codex-cli");
assert.equal(storageState.minimumGroupSize, 10);
assert.equal(storageState.includeFullUrls, false);
assert.equal(storageState.includePageHints, true);
assert.equal(storageState.allowHeuristicFallback, false);
assert.equal(storageState.openaiApiKey, "key");
assert.equal(storageState.codexCliModel!.length, 80);
assert.equal(storageState.claudeCliModel, "");

console.log("Settings tests passed.");
