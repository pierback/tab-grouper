import assert from "node:assert/strict";
import { LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY } from "../../src/lib/undo.js";

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
  isZenFolder?: boolean;
}

type InputGroup = Partial<TestGroup> & Pick<TestGroup, "id" | "title" | "color" | "windowId">;

interface TestSnapshot {
  changedTabIds: number[];
  groupIdsCollapsedByTidy?: number[];
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
  onAlarmGet?: () => Promise<void>;
  groupDelayMs?: number;
  scriptingResult?: unknown;
  zenFolders?: boolean;
}

interface FakeZenFolders {
  create(tabIds: number[], options?: { label?: string; collapsed?: boolean }): Promise<{ id: number; label: string; collapsed: boolean; windowId: number; tabIds: number[] }>;
  removeIfEmpty(folderId: number): Promise<boolean>;
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
  storage: { local: { set(values: Record<string, unknown>): Promise<void> } };
  tabs: unknown;
  tabGroups: unknown;
  scripting: unknown;
  windows: unknown;
  alarms: unknown;
  __browser?: { zenFolders: FakeZenFolders };
}

type ExperimentGlobal = typeof globalThis & { browser?: { zenFolders: FakeZenFolders } };

const originalLanguageModel = (globalThis as typeof globalThis & TestGlobal).LanguageModel;

async function importServiceWorker(chrome: FakeChrome) {
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;
  (globalThis as ExperimentGlobal).browser = chrome.__browser;
  await import(`../../src/service_worker.js?test=${Date.now()}-${Math.random()}`);
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
  onAlarmGet,
  groupDelayMs = 0,
  scriptingResult = null,
  zenFolders = false
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
      async update(tabId: number, updateProperties: { pinned?: boolean }) {
        const tab = findTab(tabId);
        if (typeof updateProperties.pinned === "boolean") {
          tab.pinned = updateProperties.pinned;
        }
        return { ...tab };
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
        const alarm = state.alarms.get(name);
        await onAlarmGet?.();
        return alarm;
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

  if (zenFolders) {
    chrome.__browser = {
      zenFolders: {
        async create(tabIds, options = {}) {
          const id = state.nextGroupId++;
          const windowId = findTab(tabIds[0]!).windowId;
          state.groups.set(id, {
            id,
            title: options.label ?? "",
            color: "zen-workspace-color",
            collapsed: Boolean(options.collapsed),
            windowId,
            isZenFolder: true
          });
          for (const tabId of tabIds) {
            const tab = findTab(tabId);
            tab.groupId = id;
            tab.pinned = true;
          }
          return { id, label: options.label ?? "", collapsed: Boolean(options.collapsed), windowId, tabIds };
        },
        async removeIfEmpty(folderId) {
          if (!state.groups.has(folderId) || state.tabs.some((tab) => tab.groupId === folderId)) {
            return false;
          }
          state.groups.delete(folderId);
          return true;
        }
      }
    };
  }

  function findTab(tabId: number) {
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new Error(`Tab does not exist: ${tabId}`);
    }
    return tab;
  }

  function cleanupEmptyGroups() {
    for (const [groupId, group] of Array.from(state.groups.entries())) {
      // Zen folders keep a hidden placeholder tab and survive without real tabs.
      if (!group.isZenFolder && !state.tabs.some((tab) => tab.groupId === groupId)) {
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

export { createFakeChrome, importServiceWorker, sendRuntimeMessage, delay, waitForState, getStoredSnapshot, requireStoredSnapshot, stateTab, findStateTab, latestScriptExecution, originalLanguageModel };
export type { TestGlobal };
