import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createFakeChrome, importServiceWorker, sendRuntimeMessage, findStateTab, latestScriptExecution, originalLanguageModel } from "./fixtures/service_worker.js";
import type { TestGlobal } from "./fixtures/service_worker.js";

afterEach(() => {
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = originalLanguageModel;
});

await test("caches page hints and invalidates changed tabs", async () => {
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 7, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 7, index: 1 }
    ],
    storage: {
      provider: "local-codex-cli",
      includePageHints: true
    },
    scriptingResult: {
      title: "Codex Repo",
      metaDescription: "Repository for Codex.",
      headings: ["Issues", "Pull Requests"]
    }
  });
  await importServiceWorker(chrome);

  const preview = await sendRuntimeMessage(chrome, {
    type: "PREVIEW_CURRENT_WINDOW",
    windowId: 7,
    grantedHintOrigins: ["https://github.com/*"]
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.usedFallback, true);
  assert.equal(chrome.__state.scriptExecutions.length, 2);
  assert.deepEqual(
    chrome.__state.scriptExecutions.map((execution) => execution.target.tabId),
    [1, 2]
  );
  const cachedPreview = await sendRuntimeMessage(chrome, {
    type: "PREVIEW_CURRENT_WINDOW",
    windowId: 7,
    grantedHintOrigins: ["https://github.com/*"]
  });
  assert.equal(cachedPreview.ok, true);
  assert.equal(chrome.__state.scriptExecutions.length, 2);

  findStateTab(chrome, 1).title = "Codex Issue Updated";
  const titleChangedPreview = await sendRuntimeMessage(chrome, {
    type: "PREVIEW_CURRENT_WINDOW",
    windowId: 7,
    grantedHintOrigins: ["https://github.com/*"]
  });
  assert.equal(titleChangedPreview.ok, true);
  assert.equal(chrome.__state.scriptExecutions.length, 3);
  assert.equal(latestScriptExecution(chrome).target.tabId, 1);

  findStateTab(chrome, 2).url = "https://github.com/openai/codex/pull/3";
  const urlChangedPreview = await sendRuntimeMessage(chrome, {
    type: "PREVIEW_CURRENT_WINDOW",
    windowId: 7,
    grantedHintOrigins: ["https://github.com/*"]
  });
  assert.equal(urlChangedPreview.ok, true);
  assert.equal(chrome.__state.scriptExecutions.length, 4);
  assert.equal(latestScriptExecution(chrome).target.tabId, 2);
  assert.deepEqual(chrome.__state.permissionRemovals, [
    { permissions: ["scripting"], origins: ["https://github.com/*"] },
    { permissions: ["scripting"], origins: ["https://github.com/*"] },
    { permissions: ["scripting"], origins: ["https://github.com/*"] },
    { permissions: ["scripting"], origins: ["https://github.com/*"] }
  ]);
});

await test("releases hint permissions when too few tabs remain", async () => {
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Only Tab", url: "https://example.com/one", windowId: 8, index: 0 }
    ],
    storage: {
      provider: "local-codex-cli",
      includePageHints: true
    }
  });
  await importServiceWorker(chrome);

  const preview = await sendRuntimeMessage(chrome, {
    type: "PREVIEW_CURRENT_WINDOW",
    windowId: 8,
    grantedHintOrigins: ["https://example.com/*"]
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.message, "Not enough tabs to group.");
  assert.equal(chrome.__state.scriptExecutions.length, 0);
  assert.deepEqual(chrome.__state.permissionRemovals, [
    { permissions: ["scripting"], origins: ["https://example.com/*"] }
  ]);
});

await test("reports fallback and preserves provider host permissions", async () => {
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "OpenAI Docs", url: "https://developers.openai.com/api", windowId: 3, index: 0 },
      { id: 2, title: "Chrome Extensions", url: "https://developer.chrome.com/docs/extensions", windowId: 3, index: 1 }
    ],
    storage: {
      provider: "openai",
      openaiApiKey: "sk-test",
      openaiModel: "gpt-test"
    },
    permissionContains: false
  });
  await importServiceWorker(chrome);

  const preview = await sendRuntimeMessage(chrome, {
    type: "PREVIEW_CURRENT_WINDOW",
    windowId: 3,
    grantedHintOrigins: ["https://api.openai.com/*", "https://developer.chrome.com/*"]
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.usedFallback, true);
  assert.equal(preview.providerErrorKind, "missing-host-permission");
  assert.match(preview.message, /API host permission is missing/);
  assert.deepEqual(preview.groups, [{ name: "Dev Docs", color: "blue", count: 2 }]);
  assert.deepEqual(chrome.__state.permissionRemovals, [
    { permissions: ["scripting"], origins: ["https://developer.chrome.com/*"] }
  ]);
});

await test("reports provider errors when fallback is disabled", async () => {
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "OpenAI Docs", url: "https://developers.openai.com/api", windowId: 8, index: 0 },
      { id: 2, title: "Chrome Extensions", url: "https://developer.chrome.com/docs/extensions", windowId: 8, index: 1 }
    ],
    storage: {
      provider: "openai",
      openaiApiKey: "sk-test",
      openaiModel: "gpt-test",
      allowHeuristicFallback: false
    },
    permissionContains: false
  });
  await importServiceWorker(chrome);

  const preview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 8 });
  assert.equal(preview.ok, false);
  assert.equal(preview.providerErrorKind, "missing-host-permission");
  assert.match(preview.providerError, /host permission is missing/i);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 8 });
  assert.equal(tidy.ok, false);
  assert.equal(tidy.providerErrorKind, "missing-host-permission");
  assert.match(tidy.providerError, /host permission is missing/i);
  assert.equal(chrome.__state.tabs.every((tab) => tab.groupId === -1), true);
});

await test("invalidates cached fallback after fallback is disabled", async () => {
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "OpenAI Docs", url: "https://developers.openai.com/api", windowId: 9, index: 0 },
      { id: 2, title: "Chrome Extensions", url: "https://developer.chrome.com/docs/extensions", windowId: 9, index: 1 }
    ],
    storage: {
      provider: "openai",
      openaiApiKey: "sk-test",
      openaiModel: "gpt-test",
      allowHeuristicFallback: true
    },
    permissionContains: false
  });
  await importServiceWorker(chrome);

  const preview = await sendRuntimeMessage(chrome, {
    type: "PREVIEW_CURRENT_WINDOW",
    windowId: 9,
    grantedHintOrigins: ["https://api.openai.com/*", "https://developer.chrome.com/*"]
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.usedFallback, true);

  chrome.__state.storage.allowHeuristicFallback = false;

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 9 });
  assert.equal(tidy.ok, false, "toggling allowHeuristicFallback off must not reuse a plan cached from before the toggle");
  assert.equal(tidy.providerErrorKind, "missing-host-permission");
  assert.equal(chrome.__state.tabs.every((tab) => tab.groupId === -1), true);
});

await test("reuses preview plans and invalidates them after undo", async () => {
  let promptCount = 0;
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = {
    async availability() {
      return "available";
    },
    async create() {
      return {
        async prompt() {
          promptCount += 1;
          return JSON.stringify({
            groups: [{ name: "Dev Docs", color: "blue", tabIds: [1, 2] }],
            assignments: []
          });
        }
      };
    }
  };

  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "OpenAI Docs", url: "https://developers.openai.com/api", windowId: 13, index: 0 },
      { id: 2, title: "Chrome Extensions", url: "https://developer.chrome.com/docs/extensions", windowId: 13, index: 1 }
    ],
    storage: { provider: "chrome-ai" }
  });
  await importServiceWorker(chrome);

  const preview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 13 });
  assert.equal(preview.ok, true);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 13 });
  assert.equal(tidy.ok, true);
  assert.equal(promptCount, 1);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 13 });
  assert.equal(undo.ok, true);
  chrome.__state.tabs.push({
    id: 3,
    title: "Extensions API",
    url: "https://developer.chrome.com/docs/extensions/reference",
    windowId: 13,
    index: 2,
    pinned: false,
    groupId: -1
  });

  const changedPreview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 13 });
  assert.equal(changedPreview.ok, true);
  assert.equal(promptCount, 2);
});

await test("rebuilds a cached plan when the tab set changes", async () => {
  let promptCount = 0;
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = {
    async availability() {
      return "available";
    },
    async create() {
      return {
        async prompt() {
          promptCount += 1;
          return JSON.stringify({
            groups: [{ name: "Dev Docs", color: "blue", tabIds: [1, 2] }],
            assignments: []
          });
        }
      };
    }
  };

  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "OpenAI Docs", url: "https://developers.openai.com/api", windowId: 14, index: 0 },
      { id: 2, title: "Chrome Extensions", url: "https://developer.chrome.com/docs/extensions", windowId: 14, index: 1 }
    ],
    storage: { provider: "chrome-ai" }
  });
  await importServiceWorker(chrome);

  const preview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 14 });
  assert.equal(preview.ok, true);
  chrome.__state.tabs.push({
    id: 3,
    title: "Extensions API",
    url: "https://developer.chrome.com/docs/extensions/reference",
    windowId: 14,
    index: 2,
    pinned: false,
    groupId: -1
  });

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 14 });
  assert.equal(tidy.ok, true);
  assert.equal(promptCount, 2);
});

await test("invalidates cached plans after model or timeout changes", async () => {
  let promptCount = 0;
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = {
    async availability() {
      return "available";
    },
    async create() {
      return {
        async prompt() {
          promptCount += 1;
          return JSON.stringify({
            groups: [{ name: "Dev Docs", color: "blue", tabIds: [1, 2] }],
            assignments: []
          });
        }
      };
    }
  };

  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "OpenAI Docs", url: "https://developers.openai.com/api", windowId: 15, index: 0 },
      { id: 2, title: "Chrome Extensions", url: "https://developer.chrome.com/docs/extensions", windowId: 15, index: 1 }
    ],
    storage: {
      provider: "chrome-ai",
      codexCliModel: "codex-a",
      codexReasoningEffort: "medium",
      claudeCliModel: "claude-a",
      providerRequestTimeoutSeconds: 120
    }
  });
  await importServiceWorker(chrome);

  const firstPreview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 15 });
  assert.equal(firstPreview.ok, true);

  chrome.__state.storage.codexCliModel = "codex-b";
  const codexChangedPreview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 15 });
  assert.equal(codexChangedPreview.ok, true);

  chrome.__state.storage.claudeCliModel = "claude-b";
  const claudeChangedPreview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 15 });
  assert.equal(claudeChangedPreview.ok, true);

  chrome.__state.storage.codexReasoningEffort = "high";
  const reasoningChangedPreview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 15 });
  assert.equal(reasoningChangedPreview.ok, true);

  chrome.__state.storage.providerRequestTimeoutSeconds = 240;
  const timeoutChangedPreview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 15 });
  assert.equal(timeoutChangedPreview.ok, true);
  assert.equal(promptCount, 5);
});
