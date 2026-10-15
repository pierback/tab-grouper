"use strict";

/* global ExtensionAPI, ChromeUtils */

// Privileged bridge to Zen's sidebar folders. Only folder creation and removal
// need chrome privileges; everything else goes through tabs/tabGroups.
const { ExtensionParent } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionParent.sys.mjs"
);
const { ExtensionUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
);
const { ExtensionError } = ExtensionUtils;

this.zenFolders = class extends ExtensionAPI {
  getAPI(context) {
    const {
      tabTracker,
      windowTracker,
      getExtTabGroupIdForInternalTabGroupId,
      getInternalTabGroupIdForExtTabGroupId,
    } = ExtensionParent.apiManager.global;

    const surfaceErrors = fn => async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof ExtensionError) {
          throw error;
        }
        throw new ExtensionError(String(error));
      }
    };

    const trackedTabIds = folder =>
      folder.tabs
        .filter(tab => !tab.hasAttribute("zen-empty-tab"))
        .map(tab => tabTracker.getId(tab));

    const findFolder = folderId => {
      const internalId = getInternalTabGroupIdForExtTabGroupId(folderId);
      if (!internalId) {
        return null;
      }
      for (const window of windowTracker.browserWindows()) {
        const folder = window.gBrowser.tabGroups.find(
          group => group.id === internalId && group.isZenFolder
        );
        if (folder) {
          return folder;
        }
      }
      return null;
    };

    return {
      zenFolders: {
        create: surfaceErrors(async (tabIds, options = {}) => {
          const tabs = tabIds.map(id => tabTracker.getTab(id));
          const window = tabs[0].documentGlobal;
          if (tabs.some(tab => tab.documentGlobal !== window)) {
            throw new ExtensionError("All tabs must be in the same window.");
          }
          if (!window.gZenFolders) {
            throw new ExtensionError("Zen folders are not available in this window.");
          }
          const workspaceIds = new Set(
            tabs.map(tab => tab.getAttribute("zen-workspace-id"))
          );
          if (workspaceIds.size > 1) {
            throw new ExtensionError("All tabs must be in the same Zen workspace.");
          }
          const [workspaceId] = workspaceIds;
          const folder = window.gZenFolders.createFolder(tabs, {
            label: options.label,
            collapsed: options.collapsed,
            workspaceId: workspaceId || undefined,
          });
          return {
            id: getExtTabGroupIdForInternalTabGroupId(folder.id),
            label: folder.label ?? "",
            collapsed: !!folder.collapsed,
            workspaceId: folder.getAttribute("zen-workspace-id") ?? undefined,
            windowId: windowTracker.getId(window),
            tabIds: trackedTabIds(folder),
          };
        }),

        removeIfEmpty: surfaceErrors(async folderId => {
          const folder = findFolder(folderId);
          if (
            !folder ||
            !folder.allItemsRecursive.every(item =>
              item.hasAttribute("zen-empty-tab")
            )
          ) {
            return false;
          }
          await folder.delete();
          return true;
        }),
      },
    };
  }
};
