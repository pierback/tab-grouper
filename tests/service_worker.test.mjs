import assert from "node:assert/strict";
import { LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY } from "../lib/undo.js";

async function importServiceWorker(chrome) {
  globalThis.chrome = chrome;
  await import(`../service_worker.js?test=${Date.now()}-${Math.random()}`);
}

async function sendRuntimeMessage(chrome, message) {
  assert.equal(typeof chrome.__listener, "function", "service worker listener was not registered");
  return await new Promise((resolve, reject) => {
    let settled = false;
    const sendResponse = (response) => {
      settled = true;
      resolve(response);
    };
    const keepAlive = chrome.__listener(message, {}, sendResponse);
    if (!keepAlive && !settled) {
      reject(new Error(`Message was not handled: ${message.type}`));
    }
  });
}

function createFakeChrome({
  tabs,
  groups = [],
  storage = {},
  permissionContains = true,
  failNextGroupUpdate = false,
  onTabsQuery,
  groupDelayMs = 0,
  scriptingResult = null
}) {
  const state = {
    tabs: tabs.map((tab) => ({ pinned: false, groupId: -1, ...tab })),
    groups: new Map(groups.map((group) => [group.id, { collapsed: false, ...group }])),
    storage: { ...storage },
    nextGroupId: 100,
    failNextGroupUpdate,
    queryCount: 0,
    scriptExecutions: [],
    permissionRemovals: []
  };

  const chrome = {
    __state: state,
    __listener: null,
    runtime: {
      onMessage: {
        addListener(listener) {
          chrome.__listener = listener;
        }
      }
    },
    permissions: {
      async contains() {
        return permissionContains;
      },
      async remove(request) {
        state.permissionRemovals.push(request);
        return true;
      }
    },
    storage: {
      local: {
        async get(defaults) {
          if (typeof defaults === "string") {
            return { [defaults]: state.storage[defaults] };
          }
          const result = { ...defaults };
          for (const key of Object.keys(defaults || {})) {
            if (Object.hasOwn(state.storage, key)) {
              result[key] = state.storage[key];
            }
          }
          return result;
        },
        async set(values) {
          Object.assign(state.storage, values);
        },
        async remove(key) {
          delete state.storage[key];
        }
      }
    },
    tabs: {
      async query(queryInfo) {
        state.queryCount += 1;
        if (onTabsQuery) {
          await onTabsQuery({ queryInfo, state, queryCount: state.queryCount });
        }
        return state.tabs
          .filter((tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId)
          .map((tab) => ({ ...tab }));
      },
      async group(options) {
        if (groupDelayMs > 0) {
          await delay(groupDelayMs);
        }
        const tabIds = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
        const groupId = Number.isInteger(options.groupId) ? options.groupId : state.nextGroupId++;
        if (!state.groups.has(groupId)) {
          state.groups.set(groupId, {
            id: groupId,
            title: "",
            color: "grey",
            collapsed: false,
            windowId: findTab(tabIds[0]).windowId
          });
        }
        for (const tabId of tabIds) {
          findTab(tabId).groupId = groupId;
        }
        cleanupEmptyGroups();
        return groupId;
      },
      async ungroup(tabIds) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const tabId of ids) {
          findTab(tabId).groupId = -1;
        }
        cleanupEmptyGroups();
      }
    },
    tabGroups: {
      async query(queryInfo) {
        cleanupEmptyGroups();
        return Array.from(state.groups.values())
          .filter((group) => queryInfo.windowId === undefined || group.windowId === queryInfo.windowId)
          .map((group) => ({ ...group }));
      },
      async update(groupId, updates) {
        if (state.failNextGroupUpdate) {
          state.failNextGroupUpdate = false;
          throw new Error("Forced tab group update failure");
        }
        const group = state.groups.get(groupId);
        if (!group) {
          throw new Error(`Group does not exist: ${groupId}`);
        }
        Object.assign(group, updates);
        return { ...group };
      }
    },
    scripting: {
      async executeScript(request) {
        state.scriptExecutions.push(request);
        return [{ result: scriptingResult }];
      }
    }
  };

  function findTab(tabId) {
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new Error(`Tab does not exist: ${tabId}`);
    }
    return tab;
  }

  function cleanupEmptyGroups() {
    for (const groupId of Array.from(state.groups.keys())) {
      if (!state.tabs.some((tab) => tab.groupId === groupId)) {
        state.groups.delete(groupId);
      }
    }
  }

  return chrome;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getStoredSnapshot(chrome, windowId) {
  return chrome.__state.storage[LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY]?.[String(windowId)];
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 1, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 1, index: 1 }
    ]
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW" });
  assert.equal(tidy.ok, false);
  assert.match(tidy.error, /window id/i);
  assert.equal(chrome.__state.tabs.every((tab) => tab.groupId === -1), true);

  const preview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: "1" });
  assert.equal(preview.ok, false);
  assert.match(preview.error, /window id/i);

  const status = await sendRuntimeMessage(chrome, { type: "GET_STATUS", windowId: -1 });
  assert.equal(status.ok, false);
  assert.match(status.error, /window id/i);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 1, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 1, index: 1 },
      { id: 3, title: "Pinned", url: "https://github.com/openai/codex", windowId: 1, index: 2, pinned: true }
    ]
  });
  await importServiceWorker(chrome);

  const preview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 1 });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview, true);
  assert.deepEqual(preview.groups, [{ name: "Codex GitHub", color: "blue", count: 2 }]);
  assert.equal(chrome.__state.tabs.every((tab) => tab.groupId === -1), true);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 1 });
  assert.equal(tidy.ok, true);
  assert.equal(tidy.undoAvailable, true);
  assert.equal(tidy.groupedCount, 2);
  assert.equal(chrome.__state.tabs[0].groupId, chrome.__state.tabs[1].groupId);
  assert.notEqual(chrome.__state.tabs[0].groupId, -1);
  assert.equal(getStoredSnapshot(chrome, 1).changedTabIds.length, 2);

  const invalidUndo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY" });
  assert.equal(invalidUndo.ok, false);
  assert.match(invalidUndo.error, /window id/i);
  assert.equal(getStoredSnapshot(chrome, 1).changedTabIds.length, 2);
  assert.notEqual(chrome.__state.tabs[0].groupId, -1);

  const otherWindowStatus = await sendRuntimeMessage(chrome, { type: "GET_STATUS", windowId: 2 });
  assert.equal(otherWindowStatus.ok, true);
  assert.equal(otherWindowStatus.undoAvailable, false);

  const currentWindowStatus = await sendRuntimeMessage(chrome, { type: "GET_STATUS", windowId: 1 });
  assert.equal(currentWindowStatus.ok, true);
  assert.equal(currentWindowStatus.undoAvailable, true);

  const otherWindowUndo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 2 });
  assert.equal(otherWindowUndo.ok, true);
  assert.equal(otherWindowUndo.undoAvailable, false);
  assert.equal(getStoredSnapshot(chrome, 1).changedTabIds.length, 2);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 1 });
  assert.equal(undo.ok, true);
  assert.equal(undo.undoAvailable, false);
  assert.equal(chrome.__state.tabs.every((tab) => tab.groupId === -1), true);
  assert.equal(getStoredSnapshot(chrome, 1), undefined);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 5, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 5, index: 1 }
    ],
    onTabsQuery({ state, queryCount }) {
      if (queryCount === 2) {
        state.tabs.find((tab) => tab.id === 2).pinned = true;
      }
    }
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 5 });
  assert.equal(tidy.ok, true);
  assert.equal(tidy.undoAvailable, false);
  assert.equal(tidy.groupedCount, 0);
  assert.equal(tidy.message, "Tabs changed while tidying; no useful groups remain.");
  assert.equal(chrome.__state.tabs.every((tab) => tab.groupId === -1), true);
  assert.equal(getStoredSnapshot(chrome, 5), undefined);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 6, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 6, index: 1 }
    ],
    groupDelayMs: 20
  });
  await importServiceWorker(chrome);

  const [first, second] = await Promise.all([
    sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 6 }),
    sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 6 })
  ]);

  const results = [first, second];
  assert.equal(results.filter((result) => result.ok === true).length, 1);
  assert.equal(results.filter((result) => result.ok === false && /already running/.test(result.error)).length, 1);
  assert.notEqual(chrome.__state.tabs[0].groupId, -1);
}

{
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

  const preview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 7 });
  assert.equal(preview.ok, true);
  assert.equal(preview.usedFallback, true);
  assert.equal(chrome.__state.scriptExecutions.length, 2);
  assert.deepEqual(
    chrome.__state.scriptExecutions.map((execution) => execution.target.tabId),
    [1, 2]
  );
  assert.deepEqual(chrome.__state.permissionRemovals, [
    { permissions: ["scripting"], origins: ["https://github.com/*"] }
  ]);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 4, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 4, index: 1 }
    ],
    failNextGroupUpdate: true
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 4 });
  assert.equal(tidy.ok, false);
  assert.equal(tidy.undoAvailable, true);
  assert.match(tidy.detail, /Forced tab group update failure/);
  assert.equal(getStoredSnapshot(chrome, 4).state, "failed");
  assert.equal(chrome.__state.tabs[0].groupId, chrome.__state.tabs[1].groupId);
  assert.notEqual(chrome.__state.tabs[0].groupId, -1);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 4 });
  assert.equal(undo.ok, true);
  assert.equal(chrome.__state.tabs[0].groupId, -1);
  assert.equal(chrome.__state.tabs[1].groupId, -1);
  assert.equal(getStoredSnapshot(chrome, 4), undefined);
}

{
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

  const preview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 3 });
  assert.equal(preview.ok, true);
  assert.equal(preview.usedFallback, true);
  assert.equal(preview.providerErrorKind, "missing-host-permission");
  assert.match(preview.message, /API host permission is missing/);
  assert.deepEqual(preview.groups, [{ name: "Dev Docs", color: "blue", count: 2 }]);
}

{
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
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 2, index: 0, groupId: 7 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 2, index: 1, groupId: -1 },
      { id: 3, title: "Existing Group", url: "https://example.com", windowId: 2, index: 2, groupId: 7 }
    ],
    groups: [{ id: 7, title: "Original", color: "purple", collapsed: true, windowId: 2 }],
    storage: { keepExistingGroups: false }
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 2 });
  assert.equal(tidy.ok, true);
  assert.equal(tidy.groupedCount, 2);
  assert.notEqual(chrome.__state.tabs.find((tab) => tab.id === 1).groupId, 7);
  assert.equal(chrome.__state.tabs.find((tab) => tab.id === 3).groupId, 7);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 2 });
  assert.equal(undo.ok, true);
  assert.equal(chrome.__state.tabs.find((tab) => tab.id === 1).groupId, 7);
  assert.equal(chrome.__state.tabs.find((tab) => tab.id === 2).groupId, -1);
  assert.equal(chrome.__state.tabs.find((tab) => tab.id === 3).groupId, 7);
  assert.equal(Array.from(chrome.__state.groups.values()).filter((group) => group.title === "Original").length, 1);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 7, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 7, index: 1 }
    ]
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 7 });
  assert.equal(tidy.ok, true);
  assert.equal(tidy.groupedCount, 2);
  assert.equal(chrome.__state.tabs[0].groupId, 100);
  assert.equal(chrome.__state.tabs[1].groupId, 100);

  chrome.__state.tabs[0].groupId = 200;
  chrome.__state.groups.set(200, {
    id: 200,
    title: "Manual",
    color: "red",
    collapsed: false,
    windowId: 7
  });

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 7 });
  assert.equal(undo.ok, true);
  assert.equal(chrome.__state.tabs[0].groupId, 200);
  assert.equal(chrome.__state.tabs[1].groupId, -1);
  assert.equal(getStoredSnapshot(chrome, 7), undefined);
}

console.log("Service worker tests passed.");
