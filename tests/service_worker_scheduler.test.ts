import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeChrome, importServiceWorker, delay, waitForState, getStoredSnapshot, findStateTab } from "./fixtures/service_worker.js";

await test("schedules automatic tidy and applies setting changes", async () => {
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
});

await test("ignores overlapping alarm ticks while a batch runs", async () => {
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
});

await test("keeps the latest interval when alarm reads finish out of order", async () => {
  let releaseFirstRead!: () => void;
  const firstRead = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  let reads = 0;
  const chrome = createFakeChrome({
    tabs: [],
    storage: { autoTidyEnabled: true, autoTidyIntervalMinutes: 15 },
    async onAlarmGet() {
      reads += 1;
      if (reads === 1) await firstRead;
    }
  });
  await importServiceWorker(chrome);
  chrome.__installedListener!();
  await waitForState(() => reads === 1);
  chrome.__state.storage.autoTidyIntervalMinutes = 45;
  chrome.__storageChangeListener!({ autoTidyIntervalMinutes: { oldValue: 15, newValue: 45 } }, "local");
  await delay(0);
  releaseFirstRead();
  await waitForState(() => chrome.__state.alarmCreates.length === 2);
  assert.equal(chrome.__state.alarms.get("tab-grouper:auto-tidy")?.periodInMinutes, 45);
});

await test("does not recreate an alarm after automatic tidy is disabled", async () => {
  let releaseRead!: () => void;
  const blockedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  let reading = false;
  const chrome = createFakeChrome({
    tabs: [],
    storage: { autoTidyEnabled: true, autoTidyIntervalMinutes: 15 },
    async onAlarmGet() {
      reading = true;
      await blockedRead;
    }
  });
  await importServiceWorker(chrome);
  chrome.__installedListener!();
  await waitForState(() => reading);
  chrome.__state.storage.autoTidyEnabled = false;
  chrome.__storageChangeListener!({ autoTidyEnabled: { oldValue: true, newValue: false } }, "local");
  await delay(0);
  releaseRead();
  await waitForState(() => chrome.__state.alarmClears.length === 2);
  await delay(0);
  assert.equal(chrome.__state.alarms.has("tab-grouper:auto-tidy"), false);
});

await test("stops before the next window when automatic tidy is disabled", async () => {
  let releaseWindow!: () => void;
  const blockedWindow = new Promise<void>((resolve) => { releaseWindow = resolve; });
  let started = false;
  const queriedWindows: number[] = [];
  const chrome = createFakeChrome({
    tabs: [
      { id: 1, title: "First issue", url: "https://github.com/org/repo/issues/1", windowId: 21, index: 0 },
      { id: 2, title: "First PR", url: "https://github.com/org/repo/pull/2", windowId: 21, index: 1 },
      { id: 3, title: "Second issue", url: "https://github.com/org/repo/issues/3", windowId: 22, index: 0 },
      { id: 4, title: "Second PR", url: "https://github.com/org/repo/pull/4", windowId: 22, index: 1 }
    ],
    storage: { autoTidyEnabled: true },
    async onTabsQuery({ queryInfo }) {
      if (queryInfo.windowId !== undefined) queriedWindows.push(queryInfo.windowId);
      if (!started) {
        started = true;
        await blockedWindow;
      }
    }
  });
  await importServiceWorker(chrome);
  chrome.__alarmListener!({ name: "tab-grouper:auto-tidy", scheduledTime: 0, persistAcrossSessions: true });
  await waitForState(() => started);
  chrome.__state.storage.autoTidyEnabled = false;
  chrome.__storageChangeListener!({ autoTidyEnabled: { oldValue: true, newValue: false } }, "local");
  await waitForState(() => chrome.__state.alarmClears.length > 0);
  releaseWindow();
  await waitForState(() => getStoredSnapshot(chrome, 21)?.state === "applied");
  await delay(0);
  assert.equal(queriedWindows.includes(22), false);
  assert.equal(getStoredSnapshot(chrome, 22), undefined);
  assert.equal(findStateTab(chrome, 3).groupId, -1);
});
