import type {
  AppliedAssignment,
  AppliedGroup,
  EnrichedTab,
  PartialSettings,
  Settings,
  TabGroupColor,
  TidySnapshot,
  TidySnapshotGroup,
  UndoPlan
} from "./types.js";

export const LAST_TIDY_SNAPSHOT_KEY = "lastTidySnapshot";
export const LAST_TIDY_SNAPSHOTS_BY_WINDOW_KEY = "lastTidySnapshotsByWindow";
export const NO_GROUP_ID = -1;

interface CreateTidySnapshotParams {
  windowId: number;
  tabs: EnrichedTab[];
  groups: Array<Partial<chrome.tabGroups.TabGroup> & { id?: number }>;
  changedTabIds: unknown[];
  appliedGroups: AppliedGroup[];
  appliedAssignments?: AppliedAssignment[];
  settings: Pick<Settings, "keepExistingGroups"> | PartialSettings;
}

export function createTidySnapshot({
  windowId,
  tabs,
  groups,
  changedTabIds,
  appliedGroups,
  appliedAssignments = [],
  settings
}: CreateTidySnapshotParams): TidySnapshot {
  const changedIds = uniqueIntegerIds(changedTabIds);
  return {
    version: 1,
    createdAt: Date.now(),
    windowId,
    keepExistingGroups: Boolean(settings.keepExistingGroups),
    tabs: tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => ({
        id: tab.id as number,
        groupId: typeof tab.groupId === "number" && Number.isInteger(tab.groupId) ? tab.groupId : NO_GROUP_ID,
        windowId: tab.windowId,
        index: tab.index
      })),
    groups: groups
      .filter((group) => Number.isInteger(group.id))
      .map((group) => ({
        id: group.id as number,
        title: group.title || "",
        color: (group.color || "grey") as TabGroupColor,
        collapsed: Boolean(group.collapsed),
        windowId: group.windowId
      })),
    changedTabIds: changedIds,
    appliedGroups: appliedGroups.map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color,
      count: group.count
    })),
    appliedAssignments: appliedAssignments.map((assignment) => ({
      groupId: assignment.groupId,
      tabIds: uniqueIntegerIds(assignment.tabIds),
      count: assignment.count
    }))
  };
}

export function createUndoPlan(snapshot: unknown, currentTabs: EnrichedTab[]): UndoPlan {
  if (!isUsableSnapshot(snapshot)) {
    return {
      canUndo: false,
      tabIdsToUngroup: [],
      originalGroups: [],
      tabMoves: []
    };
  }

  const currentTabById = new Map<number, EnrichedTab>(
    currentTabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => [tab.id as number, tab])
  );
  const snapshotTabById = new Map<number, TidySnapshot["tabs"][number]>(snapshot.tabs.map((tab) => [tab.id, tab]));
  const changedTabIds = uniqueIntegerIds(snapshot.changedTabIds)
    .filter((tabId) => currentTabById.has(tabId));
  const appliedGroupIds = createAppliedGroupIdSet(snapshot);
  const assignedGroupByTabId = createAssignedGroupByTabId(snapshot);
  const undoableChangedTabIds = changedTabIds.filter((tabId) => {
    const currentTab = currentTabById.get(tabId);
    if (!currentTab) {
      return false;
    }
    if (typeof currentTab.groupId !== "number" || !Number.isInteger(currentTab.groupId) || currentTab.groupId === NO_GROUP_ID) {
      return false;
    }
    return (appliedGroupIds.size === 0 && assignedGroupByTabId.size === 0) ||
      appliedGroupIds.has(currentTab.groupId) ||
      assignedGroupByTabId.get(tabId) === currentTab.groupId;
  });

  const tabIdsToUngroup = undoableChangedTabIds;
  const tabMoves = tabIdsToUngroup
    .map((tabId) => {
      const snapshotTab = snapshotTabById.get(tabId);
      const index = typeof snapshotTab?.index === "number" && Number.isInteger(snapshotTab.index)
        ? snapshotTab.index
        : null;
      return {
        tabId,
        index
      };
    })
    .filter((move): move is { tabId: number; index: number } => Number.isInteger(move.index))
    .sort((left, right) => left.index - right.index);

  if (snapshot.keepExistingGroups) {
    return {
      canUndo: tabIdsToUngroup.length > 0,
      tabIdsToUngroup,
      originalGroups: [],
      tabMoves
    };
  }

  const groupMetadataById = new Map<number, TidySnapshotGroup>(snapshot.groups.map((group) => [group.id, group]));
  const originalTabsByGroup = new Map<number, number[]>();
  const restorableTabIds = appliedGroupIds.size > 0 ? undoableChangedTabIds : changedTabIds;

  for (const tabId of restorableTabIds) {
    const snapshotTab = snapshotTabById.get(tabId);
    if (!snapshotTab || snapshotTab.groupId === NO_GROUP_ID) {
      continue;
    }
    if (!originalTabsByGroup.has(snapshotTab.groupId)) {
      originalTabsByGroup.set(snapshotTab.groupId, []);
    }
    originalTabsByGroup.get(snapshotTab.groupId)?.push(tabId);
  }

  const originalGroups = [];
  for (const [groupId, tabIds] of originalTabsByGroup.entries()) {
    const metadata = groupMetadataById.get(groupId);
    if (!metadata || tabIds.length === 0) {
      continue;
    }
    originalGroups.push({
      id: metadata.id,
      title: metadata.title,
      color: metadata.color,
      collapsed: metadata.collapsed,
      tabIds
    });
  }

  return {
    canUndo: tabIdsToUngroup.length > 0 || originalGroups.length > 0,
    tabIdsToUngroup,
    originalGroups,
    tabMoves
  };
}

export function isUsableSnapshot(snapshot: unknown): snapshot is TidySnapshot {
  const candidate = snapshot as Partial<TidySnapshot> | null | undefined;
  return Boolean(
    candidate &&
      candidate.version === 1 &&
      Number.isInteger(candidate.windowId) &&
      Array.isArray(candidate.tabs) &&
      Array.isArray(candidate.changedTabIds)
  );
}

export function uniqueIntegerIds(values: unknown[] | undefined): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const value of values || []) {
    const id = Number(value);
    if (!Number.isInteger(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function createAppliedGroupIdSet(snapshot: TidySnapshot): Set<number> {
  return new Set(
    (snapshot.appliedGroups || [])
      .map((group) => group.id)
      .filter((id) => Number.isInteger(id))
  );
}

function createAssignedGroupByTabId(snapshot: TidySnapshot): Map<number, number> {
  const assignedGroupByTabId = new Map<number, number>();
  for (const assignment of snapshot.appliedAssignments || []) {
    if (!Number.isInteger(assignment.groupId)) {
      continue;
    }
    for (const tabId of uniqueIntegerIds(assignment.tabIds)) {
      assignedGroupByTabId.set(tabId, assignment.groupId);
    }
  }
  return assignedGroupByTabId;
}
