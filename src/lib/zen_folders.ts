import type { GroupTarget } from "./types.js";

export interface ZenFolderCreateOptions {
  label?: string;
  collapsed?: boolean;
}

export interface ZenFolder {
  id: number;
  label: string;
  collapsed: boolean;
  workspaceId?: string;
  windowId: number;
  tabIds: number[];
}

// Provided by the zenFolders WebExtension Experiment, which only ships in the Zen build.
export interface ZenFoldersApi {
  create(tabIds: number[], options?: ZenFolderCreateOptions): Promise<ZenFolder>;
  removeIfEmpty(folderId: number): Promise<boolean>;
}

type ExperimentGlobal = typeof globalThis & {
  browser?: {
    zenFolders?: ZenFoldersApi;
  };
};

export function getZenFoldersApi(): ZenFoldersApi | null {
  return (globalThis as ExperimentGlobal).browser?.zenFolders ?? null;
}

// Zen disables Firefox's own tab groups, so folders are the default there.
export function resolveGroupTarget(groupTarget: GroupTarget): Exclude<GroupTarget, "auto"> {
  if (groupTarget !== "auto") {
    return groupTarget;
  }
  return getZenFoldersApi() ? "zen-folders" : "tab-groups";
}
