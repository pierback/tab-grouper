import assert from "node:assert/strict";
import { LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY } from "../src/lib/undo.js";

interface TestLanguageModel {
  availability(): Promise<string>;
  create(): Promise<{ prompt(text: string, options?: unknown): Promise<string> }>;
}

interface TestGlobal {
  LanguageModel?: TestLanguageModel;
}

interface RuntimeMessage {
  type: string;
  windowId?: unknown;
  grantedHintOrigins?: string[];
}

interface TestResponse {
  ok?: boolean;
  error: string;
  detail: string;
  preview?: boolean;
  undoAvailable?: boolean;
  groupedCount?: number;
  groups?: unknown[];
  assignments?: unknown[];
  durationMs?: number;
  usedFallback?: boolean;
  providerError: string;
  providerErrorKind?: string;
  message: string;
  [key: string]: unknown;
}

interface TestTab {
  id: number;
  title?: string;
  url?: string;
  windowId: number;
  index: number;
  pinned: boolean;
  groupId: number;
}

type InputTab = Partial<TestTab> & Pick<TestTab, "id" | "windowId" | "index">;

interface TestGroup {
  id: number;
  title: string;
  color: string;
  collapsed: boolean;
  windowId: number;
}

type InputGroup = Partial<TestGroup> & Pick<TestGroup, "id" | "title" | "color" | "windowId">;

interface TestSnapshot {
  changedTabIds: number[];
  state?: string;
}

interface TestStorage extends Record<string, unknown> {
  allowHeuristicFallback?: unknown;
  codexCliModel?: unknown;
  claudeCliModel?: unknown;
  [LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY]?: Record<string, TestSnapshot>;
}

interface ScriptExecution {
  target: { tabId?: number };
  [key: string]: unknown;
}

interface FakeChromeState {
  tabs: TestTab[];
  groups: Map<number, TestGroup>;
  storage: TestStorage;
  nextGroupId: number;
  failNextGroupUpdate: boolean;
  queryCount: number;
  scriptExecutions: ScriptExecution[];
  permissionRemovals: chrome.permissions.Permissions[];
  tabMoves: Array<{ tabId: number; windowId?: number; index?: number }>;
  alarms: Map<string, chrome.alarms.Alarm>;
  alarmCreates: Array<{ name: string; alarmInfo: chrome.alarms.AlarmCreateInfo }>;
  alarmClears: string[];
}

interface CreateFakeChromeConfig {
  tabs: InputTab[];
  groups?: InputGroup[];
  storage?: TestStorage;
  permissionContains?: boolean;
  failNextGroupUpdate?: boolean;
  onTabsQuery?: (context: { queryInfo: chrome.tabs.QueryInfo; state: FakeChromeState; queryCount: number }) => void | Promise<void>;
  groupDelayMs?: number;
  scriptingResult?: unknown;
}

interface FakeChrome {
  __state: FakeChromeState;
  __listener: ((message: RuntimeMessage, sender: Record<string, never>, sendResponse: (response: TestResponse) => void) => boolean | undefined) | null;
  __installedListener: (() => void) | null;
  __startupListener: (() => void) | null;
  __storageChangeListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | null;
  __alarmListener: ((alarm: chrome.alarms.Alarm) => void) | null;
  runtime: unknown;
  permissions: unknown;
  storage: unknown;
  tabs: unknown;
  tabGroups: unknown;
  scripting: unknown;
  windows: unknown;
  alarms: unknown;
}

const originalLanguageModel = (globalThis as typeof globalThis & TestGlobal).LanguageModel;

async function importServiceWorker(chrome: FakeChrome) {
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;
  await import(`../src/service_worker.js?test=${Date.now()}-${Math.random()}`);
}

async function sendRuntimeMessage(chrome: FakeChrome, message: RuntimeMessage): Promise<TestResponse> {
  assert.equal(typeof chrome.__listener, "function", "service worker listener was not registered");
  const listener = chrome.__listener;
  assert.ok(listener);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const sendResponse = (response: TestResponse) => {
      settled = true;
      resolve(response);
    };
    const keepAlive = listener(message, {}, sendResponse);
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
}: CreateFakeChromeConfig): FakeChrome {
  const state = {
    tabs: tabs.map((tab) => ({ pinned: false, groupId: -1, ...tab })),
    groups: new Map(groups.map((group) => [group.id, { collapsed: false, ...group }])),
    storage: { ...storage },
    nextGroupId: 100,
    failNextGroupUpdate,
    queryCount: 0,
    scriptExecutions: [],
    permissionRemovals: [],
    tabMoves: [],
    alarms: new Map(),
    alarmCreates: [],
    alarmClears: []
  } as FakeChromeState;

  const chrome = {
    __state: state,
    __listener: null,
    __installedListener: null,
    __startupListener: null,
    __storageChangeListener: null,
    __alarmListener: null,
    runtime: {
      onMessage: {
        addListener(listener: NonNullable<FakeChrome["__listener"]>) {
          chrome.__listener = listener;
        }
      },
      onInstalled: {
        addListener(listener: () => void) {
          chrome.__installedListener = listener;
        }
      },
      onStartup: {
        addListener(listener: () => void) {
          chrome.__startupListener = listener;
        }
      }
    },
    permissions: {
      async contains() {
        return permissionContains;
      },
      async remove(request: chrome.permissions.Permissions) {
        state.permissionRemovals.push(request);
        return true;
      }
    },
    storage: {
      local: {
        async get(defaults: string | Record<string, unknown>) {
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
        async set(values: Record<string, unknown>) {
          Object.assign(state.storage, values);
        },
        async remove(key: string) {
          delete state.storage[key];
        }
      },
      onChanged: {
        addListener(listener: NonNullable<FakeChrome["__storageChangeListener"]>) {
          chrome.__storageChangeListener = listener;
        }
      }
    },
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo) {
        state.queryCount += 1;
        if (onTabsQuery) {
          await onTabsQuery({ queryInfo, state, queryCount: state.queryCount });
        }
        return state.tabs
          .filter((tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId)
          .map((tab) => ({ ...tab }));
      },
      async group(options: { tabIds: number | number[]; groupId?: number }) {
        if (groupDelayMs > 0) {
          await delay(groupDelayMs);
        }
        const tabIds = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
        const groupId = typeof options.groupId === "number" && Number.isInteger(options.groupId) ? options.groupId : state.nextGroupId++;
        if (!state.groups.has(groupId)) {
          state.groups.set(groupId, {
            id: groupId,
            title: "",
            color: "grey",
            collapsed: false,
            windowId: findTab(tabIds[0]!).windowId
          });
        }
        for (const tabId of tabIds) {
          findTab(tabId).groupId = groupId;
        }
        cleanupEmptyGroups();
        return groupId;
      },
      async ungroup(tabIds: number | number[]) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const tabId of ids) {
          findTab(tabId).groupId = -1;
        }
        cleanupEmptyGroups();
      },
      async move(tabIds: number | number[], moveProperties: { windowId?: number; index: number }) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const tabId of ids) {
          const tab = findTab(tabId);
          if (typeof moveProperties.windowId === "number" && Number.isInteger(moveProperties.windowId)) {
            tab.windowId = moveProperties.windowId;
          }
          const fromIndex = state.tabs.indexOf(tab);
          state.tabs.splice(fromIndex, 1);
          const targetTabs = state.tabs.filter((candidate) => candidate.windowId === tab.windowId);
          const targetIndex = Math.max(0, Math.min(moveProperties.index, targetTabs.length));
          const beforeTab = targetTabs[targetIndex];
          const insertIndex = beforeTab ? state.tabs.indexOf(beforeTab) : findWindowAppendIndex(tab.windowId);
          state.tabs.splice(insertIndex, 0, tab);
          state.tabMoves.push({ tabId, ...moveProperties });
          updateTabIndexes();
        }
      }
    },
    tabGroups: {
      async query(queryInfo: chrome.tabGroups.QueryInfo) {
        cleanupEmptyGroups();
        return Array.from(state.groups.values())
          .filter((group) => queryInfo.windowId === undefined || group.windowId === queryInfo.windowId)
          .map((group) => ({ ...group }));
      },
      async update(groupId: number, updates: Partial<TestGroup>) {
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
      async executeScript(request: ScriptExecution) {
        state.scriptExecutions.push(request);
        return [{ result: scriptingResult }];
      }
    },
    windows: {
      onRemoved: {
        addListener() {}
      },
      async getAll() {
        return Array.from(new Set(state.tabs.map((tab) => tab.windowId))).map((id) => ({ id, type: "normal" }));
      }
    },
    alarms: {
      onAlarm: {
        addListener(listener: NonNullable<FakeChrome["__alarmListener"]>) {
          chrome.__alarmListener = listener;
        }
      },
      async get(name: string) {
        return state.alarms.get(name);
      },
      async clear(name: string) {
        state.alarmClears.push(name);
        return state.alarms.delete(name);
      },
      async create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) {
        state.alarmCreates.push({ name, alarmInfo });
        state.alarms.set(name, {
          name,
          scheduledTime: Date.now(),
          periodInMinutes: alarmInfo.periodInMinutes,
          persistAcrossSessions: true
        });
      }
    }
  } as unknown as FakeChrome;

  function findTab(tabId: number) {
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

  function findWindowAppendIndex(windowId: number) {
    let index = state.tabs.length;
    for (let candidateIndex = state.tabs.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      if (state.tabs[candidateIndex]!.windowId === windowId) {
        index = candidateIndex + 1;
        break;
      }
    }
    return index;
  }

  function updateTabIndexes() {
    const nextIndexByWindow = new Map();
    for (const tab of state.tabs) {
      const nextIndex = nextIndexByWindow.get(tab.windowId) || 0;
      tab.index = nextIndex;
      nextIndexByWindow.set(tab.windowId, nextIndex + 1);
    }
  }

  return chrome;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForState(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(0);
  }
  assert.fail("Timed out waiting for service worker state.");
}

function getStoredSnapshot(chrome: FakeChrome, windowId: number): TestSnapshot | undefined {
  return chrome.__state.storage[LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY]?.[String(windowId)];
}

function requireStoredSnapshot(chrome: FakeChrome, windowId: number): TestSnapshot {
  const snapshot = getStoredSnapshot(chrome, windowId);
  assert.ok(snapshot);
  return snapshot;
}

function stateTab(chrome: FakeChrome, index: number): TestTab {
  const tab = chrome.__state.tabs[index];
  assert.ok(tab);
  return tab;
}

function findStateTab(chrome: FakeChrome, id: number): TestTab {
  const tab = chrome.__state.tabs.find((candidate) => candidate.id === id);
  assert.ok(tab);
  return tab;
}

function latestScriptExecution(chrome: FakeChrome): ScriptExecution {
  const execution = chrome.__state.scriptExecutions.at(-1);
  assert.ok(execution);
  return execution;
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
  assert.equal(typeof preview.durationMs, "number");
  assert.equal(chrome.__state.tabs.every((tab) => tab.groupId === -1), true);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 1 });
  assert.equal(tidy.ok, true);
  assert.equal(tidy.undoAvailable, true);
  assert.equal(tidy.groupedCount, 2);
  assert.equal(typeof tidy.durationMs, "number");
  assert.equal(stateTab(chrome, 0).groupId, stateTab(chrome, 1).groupId);
  assert.notEqual(stateTab(chrome, 0).groupId, -1);
  assert.equal(chrome.__state.groups.get(stateTab(chrome, 0).groupId)?.collapsed, true);
  assert.equal(requireStoredSnapshot(chrome, 1).changedTabIds.length, 2);

  const snapshotBeforeNoOp = requireStoredSnapshot(chrome, 1);
  const noOpTidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 1 });
  assert.equal(noOpTidy.ok, true);
  assert.equal(noOpTidy.undoAvailable, true);
  assert.deepEqual(requireStoredSnapshot(chrome, 1), snapshotBeforeNoOp);

  const invalidUndo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY" });
  assert.equal(invalidUndo.ok, false);
  assert.match(invalidUndo.error, /window id/i);
  assert.equal(requireStoredSnapshot(chrome, 1).changedTabIds.length, 2);
  assert.notEqual(stateTab(chrome, 0).groupId, -1);

  const otherWindowStatus = await sendRuntimeMessage(chrome, { type: "GET_STATUS", windowId: 2 });
  assert.equal(otherWindowStatus.ok, true);
  assert.equal(otherWindowStatus.undoAvailable, false);

  const currentWindowStatus = await sendRuntimeMessage(chrome, { type: "GET_STATUS", windowId: 1 });
  assert.equal(currentWindowStatus.ok, true);
  assert.equal(currentWindowStatus.undoAvailable, true);

  const otherWindowUndo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 2 });
  assert.equal(otherWindowUndo.ok, true);
  assert.equal(otherWindowUndo.undoAvailable, false);
  assert.equal(requireStoredSnapshot(chrome, 1).changedTabIds.length, 2);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 1 });
  assert.equal(undo.ok, true);
  assert.equal(undo.undoAvailable, false);
  assert.equal(chrome.__state.tabs.every((tab) => tab.groupId === -1), true);
  assert.equal(getStoredSnapshot(chrome, 1), undefined);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Existing One", url: "https://example.com/one", windowId: 16, index: 0, groupId: 7 },
      { id: 2, title: "Existing Two", url: "https://example.com/two", windowId: 16, index: 1, groupId: 7 }
    ],
    groups: [{ id: 7, title: "Existing", color: "grey", collapsed: false, windowId: 16 }]
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 16 });
  assert.equal(tidy.ok, true);
  assert.equal(tidy.groupedCount, 0);
  assert.equal(tidy.undoAvailable, true);
  assert.deepEqual(requireStoredSnapshot(chrome, 16).changedTabIds, []);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, true);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 16 });
  assert.equal(undo.ok, true);
  assert.equal(undo.undoneCount, 0);
  assert.match(undo.message, /Restored 1 group/);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, false);
  assert.equal(getStoredSnapshot(chrome, 16), undefined);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 17, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 17, index: 1 },
      { id: 3, title: "Existing One", url: "https://example.com/one", windowId: 17, index: 2, groupId: 7 },
      { id: 4, title: "Existing Two", url: "https://example.com/two", windowId: 17, index: 3, groupId: 7 }
    ],
    groups: [{ id: 7, title: "Existing", color: "grey", collapsed: false, windowId: 17 }]
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 17 });
  assert.equal(tidy.ok, true);
  assert.equal(tidy.groupedCount, 2);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, true);

  chrome.__state.tabs = chrome.__state.tabs.filter((tab) => ![1, 2].includes(tab.id));

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 17 });
  assert.equal(undo.ok, true);
  assert.equal(undo.undoneCount, 0);
  assert.match(undo.message, /Restored 1 group/);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, false);
  assert.equal(getStoredSnapshot(chrome, 17), undefined);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 5, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 5, index: 1 }
    ],
    onTabsQuery({ state, queryCount }) {
      if (queryCount === 2) {
        const tab = state.tabs.find((candidate) => candidate.id === 2);
        assert.ok(tab);
        tab.pinned = true;
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
  assert.notEqual(stateTab(chrome, 0).groupId, -1);
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
}

{
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
  assert.equal(requireStoredSnapshot(chrome, 4).state, "failed");
  assert.equal(stateTab(chrome, 0).groupId, stateTab(chrome, 1).groupId);
  assert.notEqual(stateTab(chrome, 0).groupId, -1);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 4 });
  assert.equal(undo.ok, true);
  assert.equal(stateTab(chrome, 0).groupId, -1);
  assert.equal(stateTab(chrome, 1).groupId, -1);
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
  assert.notEqual(findStateTab(chrome, 1).groupId, 7);
  assert.equal(findStateTab(chrome, 3).groupId, 7);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 2 });
  assert.equal(undo.ok, true);
  assert.equal(findStateTab(chrome, 1).groupId, 7);
  assert.equal(findStateTab(chrome, 2).groupId, -1);
  assert.equal(findStateTab(chrome, 3).groupId, 7);
  assert.equal(Array.from(chrome.__state.groups.values()).filter((group) => group.title === "Original").length, 1);
}

{
  let promptText = "";
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = {
    async availability() {
      return "available";
    },
    async create() {
      return {
        async prompt(text: string) {
          promptText = text;
          return JSON.stringify({
            groups: [],
            assignments: [{ groupId: 7, tabIds: [2] }]
          });
        }
      };
    }
  };

  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Existing Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 8, index: 0, groupId: 7 },
      { id: 2, title: "New Codex Issue", url: "https://github.com/openai/codex/issues/2", windowId: 8, index: 1, groupId: -1 }
    ],
    groups: [{ id: 7, title: "Codex Issues", color: "blue", collapsed: false, windowId: 8 }],
    storage: { provider: "chrome-ai" }
  });
  await importServiceWorker(chrome);

  const preview = await sendRuntimeMessage(chrome, { type: "PREVIEW_CURRENT_WINDOW", windowId: 8 });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview, true);
  assert.deepEqual(preview.groups, []);
  assert.deepEqual(preview.assignments, [{ groupId: 7, title: "Codex Issues", count: 1 }]);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 8 });
  assert.equal(tidy.ok, true);
  assert.equal(tidy.groupedCount, 1);
  assert.deepEqual(tidy.groups, []);
  assert.deepEqual(tidy.assignments, [{ groupId: 7, title: "Codex Issues", count: 1 }]);
  assert.match(tidy.message, /Added 1 tab to existing groups/);
  assert.match(promptText, /"existingGroups"/);
  assert.equal(findStateTab(chrome, 2).groupId, 7);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, true);
  assert.deepEqual(requireStoredSnapshot(chrome, 8).changedTabIds, [2]);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 8 });
  assert.equal(undo.ok, true);
  assert.equal(findStateTab(chrome, 1).groupId, 7);
  assert.equal(findStateTab(chrome, 2).groupId, -1);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, false);
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = originalLanguageModel;
}

{
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
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = originalLanguageModel;
}

{
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
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = originalLanguageModel;
}

{
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
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = originalLanguageModel;
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
  assert.equal(stateTab(chrome, 0).groupId, 100);
  assert.equal(stateTab(chrome, 1).groupId, 100);

  stateTab(chrome, 0).groupId = 200;
  chrome.__state.groups.set(200, {
    id: 200,
    title: "Manual",
    color: "red",
    collapsed: false,
    windowId: 7
  });

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 7 });
  assert.equal(undo.ok, true);
  assert.equal(stateTab(chrome, 0).groupId, 200);
  assert.equal(stateTab(chrome, 1).groupId, -1);
  assert.equal(getStoredSnapshot(chrome, 7), undefined);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 10, index: 0 },
      { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 10, index: 1 },
      { id: 3, title: "Other", url: "https://example.com", windowId: 10, index: 2 }
    ]
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 10 });
  assert.equal(tidy.ok, true);
  chrome.__state.tabs.splice(0, 3, stateTab(chrome, 2), stateTab(chrome, 0), stateTab(chrome, 1));
  chrome.__state.tabs.forEach((tab, index) => {
    tab.index = index;
  });

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 10 });
  assert.equal(undo.ok, true);
  assert.deepEqual(chrome.__state.tabMoves, [
    { tabId: 1, windowId: 10, index: 0 },
    { tabId: 2, windowId: 10, index: 1 }
  ]);
  assert.deepEqual(chrome.__state.tabs.map((tab) => tab.id), [1, 2, 3]);
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Window 11 Issue", url: "https://github.com/openai/codex/issues/1", windowId: 11, index: 0 },
      { id: 2, title: "Window 11 PR", url: "https://github.com/openai/codex/pull/2", windowId: 11, index: 1 },
      { id: 3, title: "Window 12 Issue", url: "https://github.com/openai/codex/issues/3", windowId: 12, index: 0 },
      { id: 4, title: "Window 12 PR", url: "https://github.com/openai/codex/pull/4", windowId: 12, index: 1 }
    ]
  });
  await importServiceWorker(chrome);

  const [left, right] = await Promise.all([
    sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 11 }),
    sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 12 })
  ]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.ok(getStoredSnapshot(chrome, 11));
  assert.ok(getStoredSnapshot(chrome, 12));
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Window 21 Issue", url: "https://github.com/openai/codex/issues/1", windowId: 21, index: 0 },
      { id: 2, title: "Window 21 PR", url: "https://github.com/openai/codex/pull/2", windowId: 21, index: 1 },
      { id: 3, title: "Window 22 Issue", url: "https://github.com/openai/codex/issues/3", windowId: 22, index: 0 },
      { id: 4, title: "Window 22 PR", url: "https://github.com/openai/codex/pull/4", windowId: 22, index: 1 }
    ],
    storage: {
      autoTidyEnabled: true,
      autoTidyIntervalMinutes: 15
    }
  });
  await importServiceWorker(chrome);

  assert.ok(chrome.__installedListener);
  chrome.__installedListener();
  await waitForState(() => chrome.__state.alarmCreates.length === 1);
  assert.deepEqual(chrome.__state.alarmCreates[0], {
    name: "tab-grouper:auto-tidy",
    alarmInfo: { delayInMinutes: 15, periodInMinutes: 15 }
  });

  assert.ok(chrome.__alarmListener);
  chrome.__alarmListener({
    name: "tab-grouper:auto-tidy",
    scheduledTime: Date.now(),
    periodInMinutes: 15,
    persistAcrossSessions: true
  });
  await waitForState(() => Boolean(getStoredSnapshot(chrome, 21) && getStoredSnapshot(chrome, 22)));
  assert.notEqual(findStateTab(chrome, 1).groupId, -1);
  assert.notEqual(findStateTab(chrome, 3).groupId, -1);
  assert.equal(Array.from(chrome.__state.groups.values()).every((group) => group.collapsed), true);

  chrome.__state.storage.autoTidyIntervalMinutes = 45;
  assert.ok(chrome.__storageChangeListener);
  chrome.__storageChangeListener({ autoTidyIntervalMinutes: { oldValue: 15, newValue: 45 } }, "local");
  await waitForState(() => chrome.__state.alarmCreates.length === 2);
  assert.equal(chrome.__state.alarms.get("tab-grouper:auto-tidy")?.periodInMinutes, 45);

  chrome.__state.storage.autoTidyEnabled = false;
  chrome.__storageChangeListener({ autoTidyEnabled: { oldValue: true, newValue: false } }, "local");
  await waitForState(() => !chrome.__state.alarms.has("tab-grouper:auto-tidy"));
  assert.ok(chrome.__state.alarmClears.includes("tab-grouper:auto-tidy"));
}

{
  const chrome = createFakeChrome({
    tabs: [
      { id: 201, title: "Window 41 Issue", url: "https://github.com/org/repo/issues/1", windowId: 41, index: 0 },
      { id: 202, title: "Window 41 PR", url: "https://github.com/org/repo/pull/2", windowId: 41, index: 1 },
      { id: 203, title: "Window 42 Issue", url: "https://github.com/org/repo/issues/3", windowId: 42, index: 0 },
      { id: 204, title: "Window 42 PR", url: "https://github.com/org/repo/pull/4", windowId: 42, index: 1 }
    ],
    storage: { autoTidyEnabled: true, autoTidyIntervalMinutes: 1 },
    groupDelayMs: 25
  });
  await importServiceWorker(chrome);

  assert.ok(chrome.__alarmListener);
  const alarm = {
    name: "tab-grouper:auto-tidy",
    scheduledTime: Date.now(),
    periodInMinutes: 1,
    persistAcrossSessions: true
  };
  chrome.__alarmListener(alarm);
  await waitForState(() => getStoredSnapshot(chrome, 41)?.state === "applying");

  chrome.__alarmListener(alarm);
  await delay(10);
  assert.equal(getStoredSnapshot(chrome, 42), undefined);

  await waitForState(() => getStoredSnapshot(chrome, 41)?.state === "applied");
  await waitForState(() => getStoredSnapshot(chrome, 42)?.state === "applied");
}

(globalThis as typeof globalThis & TestGlobal).LanguageModel = originalLanguageModel;

console.log("Service worker tests passed.");
