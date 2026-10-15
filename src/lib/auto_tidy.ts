import { getSettings } from "./settings.js";

export const AUTO_TIDY_ALARM_NAME = "tab-grouper:auto-tidy";

export function createAutoTidyScheduler(tidyWindow: (windowId: number) => Promise<unknown>) {
  let alarmQueue: Promise<void> = Promise.resolve();
  let runningBatch: Promise<void> | undefined;

  function syncAlarm(): Promise<void> {
    // Read settings when the queued operation starts, never when it is enqueued.
    const update = alarmQueue.then(reconcileAlarm);
    alarmQueue = update.catch(() => {});
    return update;
  }

  async function reconcileAlarm(): Promise<void> {
    if (!chrome.alarms) {
      return;
    }
    const settings = await getSettings();
    if (!settings.autoTidyEnabled) {
      await chrome.alarms.clear(AUTO_TIDY_ALARM_NAME);
      return;
    }

    const intervalMinutes = settings.autoTidyIntervalMinutes;
    const currentAlarm = await chrome.alarms.get(AUTO_TIDY_ALARM_NAME);
    if (currentAlarm?.periodInMinutes === intervalMinutes) {
      return;
    }
    await chrome.alarms.clear(AUTO_TIDY_ALARM_NAME);
    await chrome.alarms.create(AUTO_TIDY_ALARM_NAME, {
      delayInMinutes: intervalMinutes,
      periodInMinutes: intervalMinutes
    });
  }

  async function tidyNormalWindows(): Promise<void> {
    if (!(await getSettings()).autoTidyEnabled) {
      await syncAlarm();
      return;
    }
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    for (const { id } of windows) {
      if (typeof id !== "number" || !Number.isInteger(id)) {
        continue;
      }
      if (!(await getSettings()).autoTidyEnabled) {
        return;
      }
      try {
        await tidyWindow(id);
      } catch {
        // A failed window must not prevent later windows from being tidied.
      }
    }
  }

  function run(): Promise<void> {
    runningBatch ??= tidyNormalWindows().finally(() => { runningBatch = undefined; });
    return runningBatch;
  }

  return { syncAlarm, run };
}
