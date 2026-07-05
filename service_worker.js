import { createGroupPlanWithFallback } from "./lib/providers.js";
import {
  extractSuperficialPageHintParts,
  normalizePageContext,
  normalizePageHintParts,
  pageHintPermissionPattern,
  shouldUsePageHints
} from "./lib/page_hints.js";
import { buildTidySuccessMessage, createPlanResponse } from "./lib/plan_response.js";
import { normalizeGroupPlan } from "./lib/schema.js";
import { getSettings, publicSettingsSummary } from "./lib/settings.js";
import { getTabSkipReason, isGroupableTab, tabToLocalRecord, tabToPromptRecord } from "./lib/tabs.js";
import {
  LAST_TIDY_SNAPSHOT_KEY,
  LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY,
  createTidySnapshot,
  createUndoPlan,
  isUsableSnapshot
} from "./lib/undo.js";

const activeTidiesByWindow = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TIDY_CURRENT_WINDOW") {
    const windowId = readMessageWindowId(message);
    if (!Number.isInteger(windowId)) {
      sendResponse(createInvalidWindowResponse());
      return false;
    }
    withWindowTidyLock(windowId, () => tidyCurrentWindow(windowId))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "PREVIEW_CURRENT_WINDOW") {
    const windowId = readMessageWindowId(message);
    if (!Number.isInteger(windowId)) {
      sendResponse(createInvalidWindowResponse());
      return false;
    }
    previewCurrentWindow(windowId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "UNDO_LAST_TIDY") {
    const windowId = readMessageWindowId(message);
    if (!Number.isInteger(windowId)) {
      sendResponse(createInvalidWindowResponse());
      return false;
    }
    undoLastTidy(windowId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "GET_STATUS") {
    const windowId = readMessageWindowId(message);
    if (!Number.isInteger(windowId)) {
      sendResponse(createInvalidWindowResponse());
      return false;
    }
    getStatus(windowId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

function readMessageWindowId(message) {
  return Number.isInteger(message?.windowId) && message.windowId >= 0 ? message.windowId : null;
}

function createInvalidWindowResponse() {
  return {
    ok: false,
    error: "A valid Chrome window id is required."
  };
}

async function tidyCurrentWindow(windowId) {
  let planResult = await buildCurrentWindowPlan(windowId);
  if (planResult.canApply) {
    planResult = await revalidatePlanBeforeApply(planResult, windowId);
  }
  if (!planResult.canApply) {
    await clearLastTidySnapshot(windowId);
    return createPlanResponse(planResult, { undoAvailable: false });
  }

  const preTidyGroups = await chrome.tabGroups.query({ windowId });
  const appliedGroups = [];
  const changedTabIds = planResult.plan.groups.flatMap((group) => group.tabIds);
  const baseSnapshot = createTidySnapshot({
    windowId,
    tabs: planResult.tabs,
    groups: preTidyGroups,
    changedTabIds,
    appliedGroups,
    settings: planResult.settings
  });
  await saveLastTidySnapshot({
    ...baseSnapshot,
    state: "applying",
    plannedGroups: planResult.plan.groups.map((group) => ({
      name: group.name,
      color: group.color,
      tabIds: group.tabIds
    }))
  });

  try {
    for (const group of planResult.plan.groups) {
      const groupId = await retryChromeTabMutation(() => chrome.tabs.group({ tabIds: group.tabIds }));
      appliedGroups.push({
        id: groupId,
        name: group.name,
        color: group.color,
        count: group.tabIds.length
      });
      await saveLastTidySnapshot({
        ...baseSnapshot,
        state: "applying",
        appliedGroups
      });
      await retryChromeTabMutation(() =>
        chrome.tabGroups.update(groupId, {
          title: group.name,
          color: group.color,
          collapsed: Boolean(planResult.settings.collapseGroups)
        })
      );
    }

    await saveLastTidySnapshot({
      ...baseSnapshot,
      state: "applied",
      appliedGroups
    });
  } catch (error) {
    await saveLastTidySnapshot({
      ...baseSnapshot,
      state: "failed",
      appliedGroups,
      error: error.message || String(error)
    });
    return {
      ok: false,
      error: "Tidy failed after preparing undo. Undo is available.",
      detail: error.message || String(error),
      undoAvailable: true
    };
  }

  return {
    ok: true,
    groupedCount: appliedGroups.reduce((sum, group) => sum + group.count, 0),
    groups: appliedGroups,
    skipped: planResult.skipped,
    provider: planResult.providerResult.provider,
    requestedProvider: planResult.providerResult.requestedProvider,
    usedFallback: planResult.providerResult.usedFallback,
    providerError: planResult.providerResult.providerError,
    providerErrorKind: planResult.providerResult.providerErrorKind,
    undoAvailable: true,
    message: buildTidySuccessMessage(appliedGroups, planResult.skipped, planResult.providerResult)
  };
}

async function withWindowTidyLock(windowId, callback) {
  if (activeTidiesByWindow.has(windowId)) {
    return {
      ok: false,
      error: "A tidy operation is already running for this window."
    };
  }

  activeTidiesByWindow.add(windowId);
  try {
    return await callback();
  } finally {
    activeTidiesByWindow.delete(windowId);
  }
}

async function previewCurrentWindow(windowId) {
  const planResult = await buildCurrentWindowPlan(windowId);
  return createPlanResponse(planResult, { preview: true });
}

async function buildCurrentWindowPlan(windowId) {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({ windowId });
  const skipped = countSkipReasons(tabs, settings);
  const groupableTabs = tabs.filter((tab) => isGroupableTab(tab, settings));

  if (groupableTabs.length < Number(settings.minimumGroupSize || 2)) {
    return {
      canApply: false,
      reason: "too-few-tabs",
      settings,
      tabs,
      groupableTabs,
      skipped,
      plan: { groups: [] },
      providerResult: {
        provider: settings.provider,
        usedFallback: false,
        providerError: "",
        providerErrorKind: ""
      }
    };
  }

  const pageHintsByTabId = await collectPageHints(groupableTabs, settings);
  const promptTabs = groupableTabs.map((tab) => tabToPromptRecord({
    ...tab,
    pageHint: pageHintsByTabId.get(tab.id)?.pageHint || "",
    context: pageHintsByTabId.get(tab.id)?.context
  }, settings));
  const localTabs = groupableTabs.map((tab) => tabToLocalRecord(tab));
  const providerResult = await createGroupPlanWithFallback(promptTabs, settings, localTabs);
  const plan = normalizeGroupPlan(providerResult.plan, groupableTabs, settings);

  return {
    canApply: plan.groups.length > 0,
    reason: plan.groups.length > 0 ? "ready" : "no-groups",
    settings,
    tabs,
    groupableTabs,
    skipped,
    plan,
    providerResult
  };
}

async function collectPageHints(tabs, settings) {
  const hintsByTabId = new Map();
  if (!shouldUsePageHints(settings) || !chrome.scripting?.executeScript) {
    return hintsByTabId;
  }

  const usedOrigins = new Set();
  let nextTabIndex = 0;
  const workerCount = Math.min(8, tabs.length);

  async function collectNextHint() {
    while (nextTabIndex < tabs.length) {
      const tab = tabs[nextTabIndex];
      nextTabIndex += 1;

      if (!Number.isInteger(tab.id)) {
        continue;
      }
      const origin = pageHintPermissionPattern(tab.url);
      if (!origin) {
        continue;
      }
      const hasPermission = await chrome.permissions.contains({
        permissions: ["scripting"],
        origins: [origin]
      }).catch(() => false);
      if (!hasPermission) {
        continue;
      }
      usedOrigins.add(origin);

      try {
        const results = await chrome.scripting.executeScript({
          target: {
            tabId: tab.id,
            allFrames: false
          },
          func: extractSuperficialPageHintParts
        });
        const parts = results?.[0]?.result;
        const pageHint = normalizePageHintParts(parts);
        const context = normalizePageContext(parts);
        if (pageHint || context) {
          hintsByTabId.set(tab.id, { pageHint, context });
        }
      } catch {
        // Pages such as browser internals, PDFs, and restricted frames can reject injection.
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => collectNextHint()));

  if (usedOrigins.size > 0) {
    await chrome.permissions.remove({
      permissions: ["scripting"],
      origins: Array.from(usedOrigins)
    }).catch(() => {});
  }

  return hintsByTabId;
}

async function revalidatePlanBeforeApply(planResult, windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const skipped = countSkipReasons(tabs, planResult.settings);
  const groupableTabs = tabs.filter((tab) => isGroupableTab(tab, planResult.settings));
  const plan = normalizeGroupPlan(planResult.plan, groupableTabs, planResult.settings);

  return {
    ...planResult,
    canApply: plan.groups.length > 0,
    reason: plan.groups.length > 0 ? "ready" : "stale-plan",
    tabs,
    groupableTabs,
    skipped,
    plan
  };
}

async function undoLastTidy(windowId) {
  const snapshot = await getLastTidySnapshot(windowId);
  if (!snapshot) {
    return {
      ok: true,
      undoneCount: 0,
      undoAvailable: false,
      message: "Nothing to undo."
    };
  }

  const currentTabs = await chrome.tabs.query({ windowId: snapshot.windowId });
  const undoPlan = createUndoPlan(snapshot, currentTabs);
  if (!undoPlan.canUndo) {
    await clearLastTidySnapshot(snapshot.windowId);
    return {
      ok: true,
      undoneCount: 0,
      undoAvailable: false,
      message: "Nothing to undo."
    };
  }

  if (undoPlan.tabIdsToUngroup.length > 0) {
    await retryChromeTabMutation(() => chrome.tabs.ungroup(undoPlan.tabIdsToUngroup));
  }

  const survivingGroupIds = await getExistingGroupIds(snapshot.windowId);
  for (const originalGroup of undoPlan.originalGroups) {
    if (survivingGroupIds.has(originalGroup.id)) {
      await retryChromeTabMutation(() =>
        chrome.tabs.group({ tabIds: originalGroup.tabIds, groupId: originalGroup.id })
      );
    } else {
      const restoredGroupId = await retryChromeTabMutation(() =>
        chrome.tabs.group({ tabIds: originalGroup.tabIds })
      );
      await retryChromeTabMutation(() =>
        chrome.tabGroups.update(restoredGroupId, {
          title: originalGroup.title,
          color: originalGroup.color,
          collapsed: originalGroup.collapsed
        })
      );
    }
  }

  await clearLastTidySnapshot(snapshot.windowId);

  return {
    ok: true,
    undoneCount: undoPlan.tabIdsToUngroup.length,
    undoAvailable: false,
    message: `Undid ${undoPlan.tabIdsToUngroup.length} tab${undoPlan.tabIdsToUngroup.length === 1 ? "" : "s"}.`
  };
}

async function getStatus(windowId) {
  const [settings, snapshot] = await Promise.all([getSettings(), getLastTidySnapshot(windowId)]);
  return {
    ok: true,
    settings: publicSettingsSummary(settings),
    undoAvailable: Boolean(snapshot),
    lastTidyAt: snapshot?.createdAt || null
  };
}

async function getLastTidySnapshot(windowId) {
  const snapshotsByWindow = await getStoredSnapshotsByWindow();
  const snapshot = getSnapshotFromMap(snapshotsByWindow, windowId);
  if (snapshot) {
    return snapshot;
  }

  const legacyStored = await chrome.storage.local.get(LAST_TIDY_SNAPSHOT_KEY);
  const legacySnapshot = legacyStored[LAST_TIDY_SNAPSHOT_KEY];
  if (!isUsableSnapshot(legacySnapshot)) {
    return null;
  }

  if (Number.isInteger(windowId) && legacySnapshot.windowId !== windowId) {
    return null;
  }

  return legacySnapshot;
}

async function getExistingGroupIds(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  return new Set(groups.map((group) => group.id));
}

async function saveLastTidySnapshot(snapshot) {
  const snapshotsByWindow = await getStoredSnapshotsByWindow();
  await chrome.storage.local.set({
    [LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY]: {
      ...snapshotsByWindow,
      [String(snapshot.windowId)]: snapshot
    }
  });
  await chrome.storage.local.remove(LAST_TIDY_SNAPSHOT_KEY);
}

async function clearLastTidySnapshot(windowId) {
  if (!Number.isInteger(windowId)) {
    await chrome.storage.local.remove(LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY);
    await chrome.storage.local.remove(LAST_TIDY_SNAPSHOT_KEY);
    return;
  }

  const snapshotsByWindow = await getStoredSnapshotsByWindow();
  const nextSnapshots = { ...snapshotsByWindow };
  delete nextSnapshots[String(windowId)];
  await chrome.storage.local.set({ [LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY]: nextSnapshots });

  const legacyStored = await chrome.storage.local.get(LAST_TIDY_SNAPSHOT_KEY);
  const legacySnapshot = legacyStored[LAST_TIDY_SNAPSHOT_KEY];
  if (!isUsableSnapshot(legacySnapshot) || legacySnapshot.windowId === windowId) {
    await chrome.storage.local.remove(LAST_TIDY_SNAPSHOT_KEY);
  }
}

async function getStoredSnapshotsByWindow() {
  const stored = await chrome.storage.local.get({ [LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY]: {} });
  const snapshots = stored[LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY];
  if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots)) {
    return {};
  }
  return snapshots;
}

function getSnapshotFromMap(snapshotsByWindow, windowId) {
  if (Number.isInteger(windowId)) {
    const snapshot = snapshotsByWindow[String(windowId)];
    return isUsableSnapshot(snapshot) ? snapshot : null;
  }

  return Object.values(snapshotsByWindow)
    .filter((snapshot) => isUsableSnapshot(snapshot))
    .sort((left, right) => right.createdAt - left.createdAt)[0] || null;
}

function countSkipReasons(tabs, settings) {
  const counts = {
    pinned: 0,
    alreadyGrouped: 0,
    missingUrl: 0
  };

  for (const tab of tabs) {
    const reason = getTabSkipReason(tab, settings);
    if (reason === "pinned") {
      counts.pinned += 1;
    } else if (reason === "already-grouped") {
      counts.alreadyGrouped += 1;
    } else if (reason === "missing-url") {
      counts.missingUrl += 1;
    }
  }

  return counts;
}

async function retryChromeTabMutation(callback, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (!String(error?.message || error).includes("Tabs cannot be edited right now")) {
        throw error;
      }
      await delay(50 * (attempt + 1));
    }
  }
  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
