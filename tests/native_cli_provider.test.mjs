import assert from "node:assert/strict";
import { checkNativeCliStatus, createPlanWithNativeCli, NATIVE_HOST_NAME } from "../lib/native_cli_provider.js";

function createChrome({ hasPermission = true, nativeResponse, disconnectError = null, postMessageError = null } = {}) {
  const state = {
    sentMessages: [],
    hostNames: []
  };
  const chrome = {
    __state: state,
    permissions: {
      async contains(request) {
        assert.deepEqual(request, { permissions: ["nativeMessaging"] });
        return hasPermission;
      }
    },
    runtime: {
      lastError: null,
      connectNative(hostName) {
        state.hostNames.push(hostName);
        const messageListeners = [];
        const disconnectListeners = [];
        return {
          onMessage: {
            addListener(callback) {
              messageListeners.push(callback);
            }
          },
          onDisconnect: {
            addListener(callback) {
              disconnectListeners.push(callback);
            }
          },
          postMessage(message) {
            if (postMessageError) {
              throw new Error(postMessageError);
            }
            state.sentMessages.push(message);
            setTimeout(() => {
              if (disconnectError) {
                chrome.runtime.lastError = { message: disconnectError };
                for (const callback of disconnectListeners) {
                  callback();
                }
                return;
              }
              for (const callback of messageListeners) {
                callback(nativeResponse(message));
              }
            }, 0);
          },
          disconnect() {}
        };
      }
    }
  };
  return chrome;
}

const tabs = [
  {
    id: 1,
    title: "Issue",
    domain: "github.com",
    url: "https://github.com/openai/codex/issues/1",
    pageHint: "Title: Issue",
    context: {
      canonicalUrl: "https://github.com/openai/codex/issues/1",
      path: "/openai/codex/issues/1",
      siteName: "GitHub",
      metaDescription: "Issue discussion.",
      ogTitle: "Issue",
      ogDescription: "Issue discussion.",
      headings: ["Bug"],
      visibleText: "A reproducible issue.",
      source: "page",
      truncated: false
    }
  },
  { id: 2, title: "PR", domain: "github.com", url: "https://github.com/openai/codex/pull/2" }
];

{
  const timeoutDelays = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    timeoutDelays.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  };
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 1,
        type: "TAB_GROUP_PLAN_RESPONSE",
        requestId: message.requestId,
        ok: true,
        provider: "local-codex-cli",
        plan: {
          groups: [{ name: "Codex GitHub", color: "blue", tabIds: [1, 2] }]
        }
      };
    }
  });
  globalThis.chrome = chrome;

  try {
    const plan = await createPlanWithNativeCli(tabs, {
      minimumGroupSize: 2,
      includeFullUrls: false,
      includePageHints: false,
      providerRequestTimeoutMs: 4000
    }, "codex");

    assert.deepEqual(plan.groups, [{ name: "Codex GitHub", color: "blue", tabIds: [1, 2] }]);
    assert.deepEqual(chrome.__state.hostNames, [NATIVE_HOST_NAME]);
    assert.equal(chrome.__state.sentMessages[0].provider, "codex");
    assert.equal(chrome.__state.sentMessages[0].timeoutMs, 4000);
    assert.equal(chrome.__state.sentMessages[0].tabs[0].url, undefined);
    assert.equal(chrome.__state.sentMessages[0].tabs[0].pageHint, undefined);
    assert.equal(chrome.__state.sentMessages[0].tabs[0].context, undefined);
    assert.ok(timeoutDelays.includes(6500));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 1,
        type: "TAB_GROUP_PLAN_RESPONSE",
        requestId: message.requestId,
        ok: true,
        provider: "local-codex-cli",
        plan: {
          groups: [{ name: "Codex GitHub", color: "blue", tabIds: [1, 2] }]
        }
      };
    }
  });
  globalThis.chrome = chrome;

  await createPlanWithNativeCli(tabs, {
    minimumGroupSize: 2,
    includeFullUrls: false,
    includePageHints: true
  }, "codex");

  assert.equal(chrome.__state.sentMessages[0].tabs[0].pageHint, "Title: Issue");
  assert.deepEqual(chrome.__state.sentMessages[0].tabs[0].context, tabs[0].context);
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 1,
        type: "TAB_GROUP_PLAN_RESPONSE",
        requestId: message.requestId,
        ok: true,
        provider: "local-codex-cli",
        plan: {
          groups: [{ name: "Codex GitHub", color: "blue", tabIds: [1, 2] }]
        }
      };
    }
  });
  globalThis.chrome = chrome;

  const plan = await createPlanWithNativeCli(tabs, {
    minimumGroupSize: 2,
    includeFullUrls: false,
    includePageHints: false
  }, "codex", [
    { id: 7, title: "Codex", color: "purple", tabIds: [9] }
  ]);

  assert.deepEqual(plan.groups, [{ name: "Codex GitHub", color: "blue", tabIds: [1, 2] }]);
  assert.deepEqual(chrome.__state.hostNames, [NATIVE_HOST_NAME]);
  assert.equal(chrome.__state.sentMessages[0].provider, "codex");
  assert.equal(chrome.__state.sentMessages[0].tabs[0].url, undefined);
  assert.deepEqual(chrome.__state.sentMessages[0].existingGroups, [
    { id: 7, title: "Codex", color: "purple", tabIds: [9] }
  ]);
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 1,
        type: "TAB_GROUP_PLAN_RESPONSE",
        requestId: message.requestId,
        ok: true,
        provider: "local-codex-cli",
        status: {
          provider: "local-codex-cli",
          configured: true,
          executableAvailable: true,
          authChecked: true,
          authenticated: true,
          lockExecutables: true
        }
      };
    }
  });
  globalThis.chrome = chrome;

  const status = await checkNativeCliStatus("local-codex-cli");
  assert.equal(status.configured, true);
  assert.equal(status.executableAvailable, true);
  assert.equal(chrome.__state.sentMessages[0].type, "NATIVE_HOST_STATUS_REQUEST");
  assert.equal(chrome.__state.sentMessages[0].provider, "codex");
}

{
  const chrome = createChrome({ hasPermission: false });
  globalThis.chrome = chrome;
  await assert.rejects(
    createPlanWithNativeCli(tabs, { minimumGroupSize: 2 }, "claude"),
    (error) => error.providerErrorKind === "missing-native-permission"
  );
  assert.deepEqual(chrome.__state.hostNames, []);
}

{
  let scheduledTimeout = false;
  let clearedTimeout = false;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    scheduledTimeout = true;
    return originalSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (timeoutId) => {
    clearedTimeout = true;
    return originalClearTimeout(timeoutId);
  };
  const chrome = createChrome({
    postMessageError: "Message is too large."
  });
  globalThis.chrome = chrome;
  try {
    await assert.rejects(
      createPlanWithNativeCli(tabs, { minimumGroupSize: 2 }, "codex"),
      (error) => error.providerErrorKind === "native-host-protocol-error"
    );
    assert.equal(scheduledTimeout, true);
    assert.equal(clearedTimeout, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

{
  const chrome = createChrome({
    disconnectError: "Specified native messaging host not found."
  });
  globalThis.chrome = chrome;
  await assert.rejects(
    createPlanWithNativeCli(tabs, { minimumGroupSize: 2 }, "codex"),
    (error) => error.providerErrorKind === "native-host-not-found"
  );
}

console.log("Native CLI provider tests passed.");
