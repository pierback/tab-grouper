import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createFakeChrome, importServiceWorker, sendRuntimeMessage, findStateTab } from "./fixtures/service_worker.js";

afterEach(() => {
  delete (globalThis as typeof globalThis & { browser?: unknown }).browser;
});

const codexTabs = [
  { id: 1, title: "Codex Issue", url: "https://github.com/openai/codex/issues/1", windowId: 1, index: 0 },
  { id: 2, title: "Codex PR", url: "https://github.com/openai/codex/pull/2", windowId: 1, index: 1 }
];

await test("tidies into collapsed Zen folders and undo unpins tabs and removes the folder", async () => {
  const chrome = createFakeChrome({
    tabs: codexTabs,
    storage: { groupTarget: "zen-folders" },
    zenFolders: true
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 1 });
  assert.equal(tidy.ok, true);
  assert.equal(tidy.groupedCount, 2);
  const folderId = findStateTab(chrome, 1).groupId;
  assert.equal(findStateTab(chrome, 2).groupId, folderId);
  assert.deepEqual(chrome.__state.groups.get(folderId), {
    id: folderId,
    title: "Codex GitHub",
    color: "zen-workspace-color",
    collapsed: true,
    windowId: 1,
    isZenFolder: true
  });
  assert.equal(findStateTab(chrome, 1).pinned, true);

  const undo = await sendRuntimeMessage(chrome, { type: "UNDO_LAST_TIDY", windowId: 1 });
  assert.equal(undo.ok, true);
  assert.equal(undo.undoneCount, 2);
  assert.equal(findStateTab(chrome, 1).groupId, -1);
  assert.equal(findStateTab(chrome, 1).pinned, false);
  assert.equal(findStateTab(chrome, 2).pinned, false);
  assert.equal(chrome.__state.groups.has(folderId), false);
});

await test("falls back to tab groups when the Zen folders experiment is unavailable", async () => {
  const chrome = createFakeChrome({
    tabs: codexTabs,
    storage: { groupTarget: "zen-folders" }
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 1 });
  assert.equal(tidy.ok, true);
  const group = chrome.__state.groups.get(findStateTab(chrome, 1).groupId);
  assert.equal(group?.isZenFolder, undefined);
  assert.equal(group?.color, "blue");
  assert.equal(findStateTab(chrome, 1).pinned, false);
});

await test("keeps creating tab groups in Zen unless folders are selected", async () => {
  const chrome = createFakeChrome({
    tabs: codexTabs,
    zenFolders: true
  });
  await importServiceWorker(chrome);

  const tidy = await sendRuntimeMessage(chrome, { type: "TIDY_CURRENT_WINDOW", windowId: 1 });
  assert.equal(tidy.ok, true);
  const group = chrome.__state.groups.get(findStateTab(chrome, 1).groupId);
  assert.equal(group?.isZenFolder, undefined);
  assert.equal(group?.title, "Codex GitHub");
  assert.equal(findStateTab(chrome, 1).pinned, false);
});
