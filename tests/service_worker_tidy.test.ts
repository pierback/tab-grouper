import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createFakeChrome, importServiceWorker, sendRuntimeMessage, getStoredSnapshot, requireStoredSnapshot, stateTab, findStateTab, originalLanguageModel } from "./fixtures/service_worker.js";
import type { TestGlobal } from "./fixtures/service_worker.js";

afterEach(() => {
  (globalThis as typeof globalThis & TestGlobal).LanguageModel = originalLanguageModel;
});

await test("rejects messages without a valid window id", async () => {
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
});

await test("previews, tidies, and undoes within the requested window", async () => {
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
});

await test("collapses existing groups and restores them on undo", async () => {
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
  assert.equal(tidy.message, "Not enough tabs to group. Collapsed 1 existing group.");
  assert.equal(chrome.__state.groups.get(7)?.collapsed, true);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 16 });
  assert.equal(undo.ok, true);
  assert.equal(undo.undoneCount, 0);
  assert.match(undo.message, /Restored 1 group/);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, false);
  assert.equal(getStoredSnapshot(chrome, 16), undefined);
});

await test("restores collapsed groups even when newly grouped tabs close", async () => {
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
});

await test("revalidates tabs before applying the plan", async () => {
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
});

await test("prevents overlapping mutations in the same window", async () => {
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
});

await test("keeps undo available after a partial group update failure", async () => {
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
});

await test("restores original group membership on undo", async () => {
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
});

await test("assigns new tabs to an existing group and undoes the assignment", async () => {
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
});

await test("preserves manually regrouped tabs during undo", async () => {
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
});

await test("restores the original tab order on undo", async () => {
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
});

await test("preserves independent snapshots for concurrent windows", async () => {
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
});


await test("collapses only groups captured as expanded in the undo snapshot", async () => {
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Original", url: "https://example.com", windowId: 1, index: 0, groupId: 7 },
      { id: 3, title: "Collapsed", url: "https://example.org", windowId: 1, index: 1, groupId: 9 }
    ],
    groups: [
      { id: 7, title: "Original", color: "grey", collapsed: false, windowId: 1 },
      { id: 9, title: "Collapsed", color: "red", collapsed: true, windowId: 1 }
    ]
  });
  const save = chrome.storage.local.set;
  let changedGroups = false;
  chrome.storage.local.set = async (values) => {
    await save(values);
    if (!changedGroups && getStoredSnapshot(chrome, 1)?.state === "applying") {
      changedGroups = true;
      chrome.__state.tabs.push({
        id: 2, title: "Concurrent", url: "https://other.example.com",
        windowId: 1, index: 2, pinned: false, groupId: 8
      });
      chrome.__state.groups.set(8, { id: 8, title: "Concurrent", color: "blue", collapsed: false, windowId: 1 });
      chrome.__state.groups.get(9)!.collapsed = false;
    }
  };
  await importServiceWorker(chrome);
  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 1 });
  assert.equal(tidy.ok, true);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, true);
  assert.equal(chrome.__state.groups.get(8)?.collapsed, false);
  assert.equal(chrome.__state.groups.get(9)?.collapsed, false);
  assert.deepEqual(requireStoredSnapshot(chrome, 1).groupIdsCollapsedByTidy, [7]);
  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 1 });
  assert.equal(undo.ok, true);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, false);
  assert.equal(chrome.__state.groups.get(8)?.collapsed, false);
  assert.equal(chrome.__state.groups.get(9)?.collapsed, false);
});

await test("retains an undo snapshot when collapsing an existing group fails", async () => {
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "Existing", url: "https://example.com", windowId: 1, index: 0, groupId: 7 }
    ],
    groups: [{ id: 7, title: "Existing", color: "grey", collapsed: false, windowId: 1 }],
    failNextGroupUpdate: true
  });
  await importServiceWorker(chrome);
  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 1 });
  assert.equal(tidy.ok, false);
  assert.equal(tidy.undoAvailable, true);
  assert.match(tidy.detail, /Forced tab group update failure/);
  assert.equal(requireStoredSnapshot(chrome, 1).state, "failed");
  assert.deepEqual(requireStoredSnapshot(chrome, 1).changedTabIds, []);
  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 1 });
  assert.equal(undo.ok, true);
  assert.equal(chrome.__state.groups.get(7)?.collapsed, false);
  assert.equal(getStoredSnapshot(chrome, 1), undefined);
});
