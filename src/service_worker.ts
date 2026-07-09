import { Cause, Duration, Effect, Exit, Option, Schedule } from "effect";
import { createGroupPlanWithFallback } from "./lib/providers.js";
import { getProviderOrigins } from "./lib/provider_metadata.js";
import { getCachedPlan, invalidatePlanCache, setCachedPlan } from "./lib/plan_cache.js";
import { getCachedHint, setCachedHint } from "./lib/hint_cache.js";
import {
  extractSuperficialPageHintParts,
  normalizePageContext,
  normalizePageHintParts,
  pageHintPermissionPattern,
  shouldUsePageHints
} from "./lib/page_hints.js";
import { buildExistingGroupTitleMap, buildTidySuccessMessage, createPlanResponse } from "./lib/plan_response.js";
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
import type { PageHint } from "./lib/hint_cache.js";
import type { PlanCacheEntry } from "./lib/plan_cache.js";
import type {
  AppliedAssignment,
  AppliedGroup,
  CurrentWindowPlanResult,
  ExistingGroup,
  ProviderError,
  ProviderResult,
  Settings,
  SkippedCounts,
  TidySnapshot
} from "./lib/types.js";

interface CachedPlan {
  plan: CurrentWindowPlanResult["plan"];
  providerResult: ProviderResult;
}

type StoredSnapshotsByWindow = Record<string, TidySnapshot>;

const activeTidiesByWindow = new Set<number>();
const planCache = new Map<number, PlanCacheEntry<CachedPlan>>();
const hintCache = new Map<number, import("./lib/hint_cache.js").HintCacheEntry>();
let snapshotMutationQueue: Promise<unknown> = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TIDY_CURRENT_WINDOW") {
    const windowId = readMessageWindowId(message);
    const grantedHintOrigins = readGrantedHintOrigins(message);
    if (typeof windowId !== "number" || !Number.isInteger(windowId)) {
      sendResponse(createInvalidWindowResponse());
      return false;
    }
    withWindowTidyLock(windowId, () => tidyCurrentWindow(windowId, grantedHintOrigins))
      .then(sendResponse)
      .catch((error) => sendResponse(createErrorResponse(error)));
    return true;
  }

  if (message?.type === "PREVIEW_CURRENT_WINDOW") {
    const windowId = readMessageWindowId(message);
    const grantedHintOrigins = readGrantedHintOrigins(message);
    if (typeof windowId !== "number" || !Number.isInteger(windowId)) {
      sendResponse(createInvalidWindowResponse());
      return false;
    }
    previewCurrentWindow(windowId, grantedHintOrigins)
      .then(sendResponse)
      .catch((error) => sendResponse(createErrorResponse(error)));
    return true;
  }

  if (message?.type === "UNDO_LAST_TIDY") {
    const windowId = readMessageWindowId(message);
    if (typeof windowId !== "number" || !Number.isInteger(windowId)) {
      sendResponse(createInvalidWindowResponse());
      return false;
    }
    undoLastTidy(windowId)
      .then(sendResponse)
      .catch((error) => sendResponse(createErrorResponse(error)));
    return true;
  }

  if (message?.type === "GET_STATUS") {
    const windowId = readMessageWindowId(message);
    if (typeof windowId !== "number" || !Number.isInteger(windowId)) {
      sendResponse(createInvalidWindowResponse());
      return false;
    }
    getStatus(windowId)
      .then(sendResponse)
      .catch((error) => sendResponse(createErrorResponse(error)));
    return true;
  }

  return false;
});

function readMessageWindowId(message: any): number | null {
  return Number.isInteger(message?.windowId) && message.windowId >= 0 ? message.windowId : null;
}

function createInvalidWindowResponse() {
  return {
    ok: false,
    error: "A valid Chrome window id is required."
  };
}

function readGrantedHintOrigins(message: any): string[] {
  if (!Array.isArray(message?.grantedHintOrigins)) {
    return [];
  }
  return Array.from(new Set<string>(message.grantedHintOrigins.filter((origin: unknown): origin is string => typeof origin === "string" && Boolean(origin))));
}

function createErrorResponse(error: unknown) {
  const providerError = error as ProviderError | undefined;
  const message = providerError?.message || String(error);
  return {
    ok: false,
    error: message,
    providerError: message,
    providerErrorKind: providerError?.providerErrorKind || ""
  };
}

async function tidyCurrentWindow(windowId: number, grantedHintOrigins: string[] = []) {
  let planResult = await buildCurrentWindowPlan(windowId, grantedHintOrigins);
  if (planResult.canApply) {
    planResult = await revalidatePlanBeforeApply(planResult, windowId);
  }
  if (!planResult.canApply) {
    await clearLastTidySnapshot(windowId);
    return createPlanResponse(planResult, { undoAvailable: false });
  }

  const preTidyGroups = await chrome.tabGroups.query({ windowId });
  const titleByGroupId = buildExistingGroupTitleMap(preTidyGroups);
  const appliedGroups: AppliedGroup[] = [];
  const appliedAssignments: AppliedAssignment[] = [];
  const changedTabIds = [
    ...planResult.plan.groups.flatMap((group) => group.tabIds),
    ...planResult.plan.assignments.flatMap((assignment) => assignment.tabIds)
  ];
  const baseSnapshot = createTidySnapshot({
    windowId,
    tabs: planResult.tabs,
    groups: preTidyGroups,
    changedTabIds,
    appliedGroups,
    appliedAssignments,
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
      const groupId = await retryChromeTabMutation(() => chrome.tabs.group({ tabIds: group.tabIds as [number, ...number[]] }));
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

    for (const assignment of planResult.plan.assignments) {
      await retryChromeTabMutation(() => chrome.tabs.group({
        tabIds: assignment.tabIds as [number, ...number[]],
        groupId: assignment.groupId
      }));
      appliedAssignments.push({
        groupId: assignment.groupId,
        title: titleByGroupId.get(assignment.groupId) || `Group ${assignment.groupId}`,
        tabIds: assignment.tabIds,
        count: assignment.tabIds.length
      });
      await saveLastTidySnapshot({
        ...baseSnapshot,
        state: "applying",
        appliedGroups,
        appliedAssignments
      });
    }

    await saveLastTidySnapshot({
      ...baseSnapshot,
      state: "applied",
      appliedGroups,
      appliedAssignments
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    invalidatePlanCache(planCache, windowId);
    await saveLastTidySnapshot({
      ...baseSnapshot,
      state: "failed",
      appliedGroups,
      appliedAssignments,
      error: detail
    });
    return {
      ok: false,
      error: "Tidy failed after preparing undo. Undo is available.",
      detail,
      undoAvailable: true
    };
  }

  invalidatePlanCache(planCache, windowId);
  return {
    ok: true,
    groupedCount: appliedGroups.reduce((sum, group) => sum + group.count, 0) +
      appliedAssignments.reduce((sum, assignment) => sum + assignment.count, 0),
    groups: appliedGroups,
    assignments: appliedAssignments.map((assignment) => ({
      groupId: assignment.groupId,
      title: assignment.title,
      count: assignment.count
    })),
    skipped: planResult.skipped,
    provider: planResult.providerResult.provider,
    requestedProvider: planResult.providerResult.requestedProvider,
    usedFallback: planResult.providerResult.usedFallback,
    providerError: planResult.providerResult.providerError,
    providerErrorKind: planResult.providerResult.providerErrorKind,
    durationMs: planResult.providerResult.durationMs,
    inputTokens: planResult.providerResult.inputTokens,
    outputTokens: planResult.providerResult.outputTokens,
    costUsd: planResult.providerResult.costUsd,
    undoAvailable: true,
    message: buildTidySuccessMessage(appliedGroups, planResult.skipped, planResult.providerResult, appliedAssignments)
  };
}

async function withWindowTidyLock<T>(windowId: number, callback: () => Promise<T>): Promise<T | { ok: false; error: string }> {
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

async function previewCurrentWindow(windowId: number, grantedHintOrigins: string[] = []) {
  const planResult = await buildCurrentWindowPlan(windowId, grantedHintOrigins);
  return createPlanResponse(planResult, { preview: true });
}

async function buildCurrentWindowPlan(windowId: number, grantedHintOrigins: string[] = []): Promise<CurrentWindowPlanResult> {
  const settings = await getSettings();
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const skipped = countSkipReasons(tabs, settings);
    const groupableTabs = tabs.filter((tab) => isGroupableTab(tab, settings));
    const existingGroups = settings.provider === "heuristic"
      ? []
      : await getExistingGroupsForPrompt(windowId, tabs);

    const canAssignToExistingGroups = settings.provider !== "heuristic" && groupableTabs.length > 0 && existingGroups.length > 0;
    if (groupableTabs.length < Number(settings.minimumGroupSize || 2) && !canAssignToExistingGroups) {
      return {
        canApply: false,
        reason: "too-few-tabs",
        settings,
        tabs,
        groupableTabs,
        skipped,
        existingGroups,
        plan: { groups: [], assignments: [] },
        providerResult: {
          plan: { groups: [], assignments: [] },
          provider: settings.provider,
          usedFallback: false,
          providerError: "",
          providerErrorKind: ""
        }
      };
    }

    const cacheKeyInput = createPlanCacheKeyInput({
      windowId,
      settings,
      groupableTabs,
      existingGroups
    });
    const cachedPlan = getCachedPlan(planCache, windowId, cacheKeyInput);
    if (cachedPlan) {
      const hasChanges = cachedPlan.plan.groups.length > 0 || cachedPlan.plan.assignments.length > 0;
      return {
        canApply: hasChanges,
        reason: hasChanges ? "ready" : "no-groups",
        settings,
        tabs,
        groupableTabs,
        skipped,
        existingGroups,
        plan: cachedPlan.plan,
        providerResult: cachedPlan.providerResult
      };
    }

    const pageHintsByTabId = await collectPageHints(groupableTabs, settings);
    const promptTabs = groupableTabs.map((tab) => tabToPromptRecord({
      ...tab,
      pageHint: pageHintsByTabId.get(tab.id as number)?.pageHint || "",
      context: pageHintsByTabId.get(tab.id as number)?.context
    }, settings));
    const localTabs = groupableTabs.map((tab) => tabToLocalRecord(tab));
    const providerResult = await createGroupPlanWithFallback(promptTabs, settings, localTabs, existingGroups);
    const plan = normalizeGroupPlan(providerResult.plan, groupableTabs, settings, existingGroups);
    const hasChanges = plan.groups.length > 0 || plan.assignments.length > 0;
    setCachedPlan(planCache, windowId, cacheKeyInput, { plan, providerResult });

    return {
      canApply: hasChanges,
      reason: hasChanges ? "ready" : "no-groups",
      settings,
      tabs,
      groupableTabs,
      skipped,
      existingGroups,
      plan,
      providerResult
    };
  } finally {
    await cleanupGrantedHintPermissions(grantedHintOrigins, settings);
  }
}

function createPlanCacheKeyInput({
  windowId,
  settings,
  groupableTabs,
  existingGroups
}: {
  windowId: number;
  settings: Settings;
  groupableTabs: chrome.tabs.Tab[];
  existingGroups: ExistingGroup[];
}) {
  return {
    windowId,
    provider: settings.provider,
    minimumGroupSize: settings.minimumGroupSize,
    includeFullUrls: settings.includeFullUrls,
    includePageHints: settings.includePageHints,
    keepExistingGroups: settings.keepExistingGroups,
    ignorePinnedTabs: settings.ignorePinnedTabs,
    allowHeuristicFallback: settings.allowHeuristicFallback,
    openaiApiKey: settings.openaiApiKey,
    openaiModel: settings.openaiModel,
    anthropicApiKey: settings.anthropicApiKey,
    anthropicModel: settings.anthropicModel,
    codexCliModel: settings.codexCliModel,
    claudeCliModel: settings.claudeCliModel,
    groupableTabs: groupableTabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      index: tab.index
    })),
    existingGroups: existingGroups.map((group) => ({
      id: group.id,
      title: group.title,
      color: group.color,
      tabIds: [...group.tabIds]
    }))
  };
}

async function collectPageHints(tabs: chrome.tabs.Tab[], settings: Settings): Promise<Map<number, PageHint>> {
  const hintsByTabId = new Map<number, PageHint>();
  if (!shouldUsePageHints(settings) || !chrome.scripting?.executeScript) {
    return hintsByTabId;
  }

  let nextTabIndex = 0;
  const workerCount = Math.min(8, tabs.length);

  async function collectNextHint() {
    while (nextTabIndex < tabs.length) {
      const tab = tabs[nextTabIndex];
      nextTabIndex += 1;
      if (!tab) {
        continue;
      }

      if (typeof tab.id !== "number" || !Number.isInteger(tab.id)) {
        continue;
      }
      const cachedHint = getCachedHint(hintCache, tab);
      if (cachedHint) {
        // Cache hits skip permission checks because no page injection occurs.
        hintsByTabId.set(tab.id, cachedHint);
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
          const hint = { pageHint, context };
          hintsByTabId.set(tab.id, hint);
          setCachedHint(hintCache, tab, hint);
        }
      } catch {
        // Pages such as browser internals, PDFs, and restricted frames can reject injection.
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => collectNextHint()));

  return hintsByTabId;
}

async function cleanupGrantedHintPermissions(grantedHintOrigins: string[], settings: Settings): Promise<void> {
  if (!chrome.permissions?.remove || grantedHintOrigins.length === 0) {
    return;
  }
  const providerOrigins = new Set(getProviderOrigins(settings.provider));
  const origins = grantedHintOrigins.filter((origin) => !providerOrigins.has(origin));
  const request: chrome.permissions.Permissions = {
    permissions: ["scripting"]
  };
  if (origins.length > 0) {
    request.origins = origins;
  }
  await chrome.permissions.remove(request).catch(() => {});
}

async function revalidatePlanBeforeApply(planResult: CurrentWindowPlanResult, windowId: number): Promise<CurrentWindowPlanResult> {
  const tabs = await chrome.tabs.query({ windowId });
  const skipped = countSkipReasons(tabs, planResult.settings);
  const groupableTabs = tabs.filter((tab) => isGroupableTab(tab, planResult.settings));
  const existingGroups = planResult.settings.provider === "heuristic"
    ? []
    : await getExistingGroupsForPrompt(windowId, tabs);
  const plan = normalizeGroupPlan(planResult.plan, groupableTabs, planResult.settings, existingGroups);
  const hasChanges = plan.groups.length > 0 || plan.assignments.length > 0;

  return {
    ...planResult,
    canApply: hasChanges,
    reason: hasChanges ? "ready" : "stale-plan",
    tabs,
    groupableTabs,
    skipped,
    existingGroups,
    plan
  };
}

async function getExistingGroupsForPrompt(windowId: number, tabs: chrome.tabs.Tab[]): Promise<ExistingGroup[]> {
  const groups = await chrome.tabGroups.query({ windowId });
  const tabIdsByGroupId = new Map<number, number[]>();
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id) || !Number.isInteger(tab.groupId) || tab.groupId === -1) {
      continue;
    }
    if (!tabIdsByGroupId.has(tab.groupId)) {
      tabIdsByGroupId.set(tab.groupId, []);
    }
    tabIdsByGroupId.get(tab.groupId)?.push(tab.id as number);
  }

  return groups
    .filter((group) => Number.isInteger(group.id))
    .map((group) => ({
      id: group.id,
      title: group.title || "",
      color: group.color || "",
      tabIds: tabIdsByGroupId.get(group.id) || []
    }));
}

async function undoLastTidy(windowId: number) {
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
    invalidatePlanCache(planCache, snapshot.windowId);
    return {
      ok: true,
      undoneCount: 0,
      undoAvailable: false,
      message: "Nothing to undo."
    };
  }

  if (undoPlan.tabIdsToUngroup.length > 0) {
    await retryChromeTabMutation(() => chrome.tabs.ungroup(undoPlan.tabIdsToUngroup as [number, ...number[]]));
  }

  const survivingGroupIds = await getExistingGroupIds(snapshot.windowId);
  for (const originalGroup of undoPlan.originalGroups) {
    if (survivingGroupIds.has(originalGroup.id)) {
      await retryChromeTabMutation(() =>
        chrome.tabs.group({ tabIds: originalGroup.tabIds as [number, ...number[]], groupId: originalGroup.id })
      );
    } else {
      const restoredGroupId = await retryChromeTabMutation(() =>
        chrome.tabs.group({ tabIds: originalGroup.tabIds as [number, ...number[]] })
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

  for (const move of undoPlan.tabMoves) {
    await retryChromeTabMutation(() =>
      chrome.tabs.move(move.tabId, {
        windowId: snapshot.windowId,
        index: move.index
      })
    );
  }

  await clearLastTidySnapshot(snapshot.windowId);
  invalidatePlanCache(planCache, snapshot.windowId);

  return {
    ok: true,
    undoneCount: undoPlan.tabIdsToUngroup.length,
    undoAvailable: false,
    message: `Undid ${undoPlan.tabIdsToUngroup.length} tab${undoPlan.tabIdsToUngroup.length === 1 ? "" : "s"}.`
  };
}

async function getStatus(windowId: number) {
  const [settings, snapshot] = await Promise.all([getSettings(), getLastTidySnapshot(windowId)]);
  return {
    ok: true,
    settings: publicSettingsSummary(settings),
    undoAvailable: Boolean(snapshot),
    lastTidyAt: snapshot?.createdAt || null
  };
}

async function getLastTidySnapshot(windowId: number | null): Promise<TidySnapshot | null> {
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

async function getExistingGroupIds(windowId: number): Promise<Set<number>> {
  const groups = await chrome.tabGroups.query({ windowId });
  return new Set(groups.map((group) => group.id));
}

async function saveLastTidySnapshot(snapshot: TidySnapshot): Promise<void> {
  await queueSnapshotMutation(async () => {
    const snapshotsByWindow = await getStoredSnapshotsByWindow();
    await chrome.storage.local.set({
      [LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY]: {
        ...snapshotsByWindow,
        [String(snapshot.windowId)]: snapshot
      }
    });
    await chrome.storage.local.remove(LAST_TIDY_SNAPSHOT_KEY);
  });
}

async function clearLastTidySnapshot(windowId: number | null): Promise<void> {
  await queueSnapshotMutation(async () => {
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
  });
}

async function queueSnapshotMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = snapshotMutationQueue.then(operation, operation);
  snapshotMutationQueue = run.catch(() => {});
  return run;
}

async function getStoredSnapshotsByWindow(): Promise<StoredSnapshotsByWindow> {
  const stored = await chrome.storage.local.get({ [LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY]: {} });
  const snapshots = stored[LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY];
  if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots)) {
    return {};
  }
  return snapshots as StoredSnapshotsByWindow;
}

function getSnapshotFromMap(snapshotsByWindow: StoredSnapshotsByWindow, windowId: number | null): TidySnapshot | null {
  if (Number.isInteger(windowId)) {
    const snapshot = snapshotsByWindow[String(windowId)];
    return isUsableSnapshot(snapshot) ? snapshot : null;
  }

  return Object.values(snapshotsByWindow)
    .filter((snapshot) => isUsableSnapshot(snapshot))
    .sort((left, right) => right.createdAt - left.createdAt)[0] || null;
}

function countSkipReasons(tabs: chrome.tabs.Tab[], settings: Settings): SkippedCounts {
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

function isRetryableTabMutationError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes("Tabs cannot be edited right now");
}

async function retryChromeTabMutation<T>(callback: () => Promise<T>, attempts = 5): Promise<T> {
  const attemptEffect = Effect.tryPromise({
    try: callback,
    catch: (error) => error
  });

  const retrySchedule = Schedule.recurs(Math.max(0, attempts - 1)).pipe(
    Schedule.while((metadata) => isRetryableTabMutationError(metadata.input)),
    Schedule.addDelay((attempt) => Effect.succeed(Duration.millis(50 * (attempt + 1))))
  );

  const exit = await Effect.runPromiseExit(Effect.retry(attemptEffect, retrySchedule));

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const originalError = Exit.findErrorOption(exit);
  if (Option.isSome(originalError)) {
    throw originalError.value;
  }
  throw Cause.squash(exit.cause);
}
