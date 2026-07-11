import assert from "node:assert/strict";
import { checkNativeCliStatus, createPlanWithNativeCli, listNativeModels, NATIVE_HOST_NAME } from "../src/lib/native_cli_provider.js";
import type { ProviderError } from "../src/lib/types.js";

interface NativeRequest {
  version: number;
  requestId: string;
  type: string;
  provider?: string;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: string;
  tabs: Array<{ url?: string; pageHint?: string; context?: unknown }>;
  existingGroups?: unknown[];
}

interface NativeResponse {
  version: number;
  type: string;
  requestId: string;
  ok: boolean;
  provider: string;
  plan?: {
    groups: Array<{ name: string; color: string; tabIds: number[] }>;
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  };
  durationMs?: number;
  status?: Record<string, unknown>;
  models?: Array<{
    slug: string;
    displayName: string;
    supportedReasoningLevels?: string[];
    defaultReasoningLevel?: string;
  }>;
  error?: {
    kind?: string;
    message?: string;
  };
}

interface CreateChromeConfig {
  hasPermission?: boolean;
  nativeResponse?: (message: NativeRequest) => NativeResponse;
  disconnectError?: string | null;
  postMessageError?: string | null;
}

function providerError(error: unknown): ProviderError {
  assert.ok(error instanceof Error);
  return error as ProviderError;
}

function createChrome({ hasPermission = true, nativeResponse, disconnectError = null, postMessageError = null }: CreateChromeConfig = {}) {
  const state = {
    sentMessages: [] as NativeRequest[],
    hostNames: [] as string[]
  };
  const chrome = {
    __state: state,
    permissions: {
      async contains(request: chrome.permissions.Permissions) {
        assert.deepEqual(request, { permissions: ["nativeMessaging"] });
        return hasPermission;
      }
    },
    runtime: {
      lastError: null as { message: string } | null,
      connectNative(hostName: string) {
        state.hostNames.push(hostName);
        const messageListeners: Array<(response: NativeResponse) => void> = [];
        const disconnectListeners: Array<() => void> = [];
        return {
          onMessage: {
            addListener(callback: (response: NativeResponse) => void) {
              messageListeners.push(callback);
            }
          },
          onDisconnect: {
            addListener(callback: () => void) {
              disconnectListeners.push(callback);
            }
          },
          postMessage(message: NativeRequest) {
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
              assert.ok(nativeResponse);
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
  const timeoutDelays: Array<number | undefined> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    timeoutDelays.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 2,
        type: "TAB_GROUP_PLAN_RESPONSE",
        requestId: message.requestId,
        ok: true,
        provider: "local-codex-cli",
        durationMs: 321,
        plan: {
          groups: [{ name: "Codex GitHub", color: "blue", tabIds: [1, 2] }],
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0123 }
        }
      };
    }
  });
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;

  try {
    const plan = await createPlanWithNativeCli(tabs, {
      minimumGroupSize: 2,
      includeFullUrls: false,
      includePageHints: false,
      providerRequestTimeoutMs: 4000
    }, "codex");

    assert.deepEqual(plan.groups, [{ name: "Codex GitHub", color: "blue", tabIds: [1, 2] }]);
    assert.deepEqual(plan.timing, { durationMs: 321, inputTokens: 10, outputTokens: 5, costUsd: 0.0123 });
    assert.deepEqual(chrome.__state.hostNames, [NATIVE_HOST_NAME]);
    assert.equal(chrome.__state.sentMessages[0]!.version, 2);
    assert.equal(chrome.__state.sentMessages[0]!.provider, "codex");
    assert.equal(Object.hasOwn(chrome.__state.sentMessages[0]!, "model"), false);
    assert.equal(Object.hasOwn(chrome.__state.sentMessages[0]!, "reasoningEffort"), false);
    assert.equal(chrome.__state.sentMessages[0]!.timeoutMs, 4000);
    assert.equal(chrome.__state.sentMessages[0]!.tabs[0]!.url, undefined);
    assert.equal(chrome.__state.sentMessages[0]!.tabs[0]!.pageHint, undefined);
    assert.equal(chrome.__state.sentMessages[0]!.tabs[0]!.context, undefined);
    assert.ok(timeoutDelays.includes(6500));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 2,
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
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;

  await createPlanWithNativeCli(tabs, {
    minimumGroupSize: 2,
    includeFullUrls: false,
    includePageHints: true
  }, "codex");

  assert.equal(chrome.__state.sentMessages[0]!.tabs[0]!.pageHint, "Title: Issue");
  assert.deepEqual(chrome.__state.sentMessages[0]!.tabs[0]!.context, tabs[0]!.context);
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 2,
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
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;

  await createPlanWithNativeCli(tabs, {
    minimumGroupSize: 2,
    includeFullUrls: false,
    includePageHints: false,
    codexCliModel: "gpt-5.5-codex",
    codexReasoningEffort: "high"
  }, "codex");

  assert.equal(chrome.__state.sentMessages[0]!.model, "gpt-5.5-codex");
  assert.equal(chrome.__state.sentMessages[0]!.reasoningEffort, "high");
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 2,
        type: "TAB_GROUP_PLAN_RESPONSE",
        requestId: message.requestId,
        ok: true,
        provider: "local-claude-cli",
        plan: {
          groups: [{ name: "Claude GitHub", color: "purple", tabIds: [1, 2] }]
        }
      };
    }
  });
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;

  await createPlanWithNativeCli(tabs, {
    minimumGroupSize: 2,
    includeFullUrls: false,
    includePageHints: false,
    claudeCliModel: "claude-opus-test",
    claudeReasoningEffort: "max"
  }, "claude");

  assert.equal(chrome.__state.sentMessages[0]!.model, "claude-opus-test");
  assert.equal(chrome.__state.sentMessages[0]!.reasoningEffort, "max");
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 2,
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
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;

  const plan = await createPlanWithNativeCli(tabs, {
    minimumGroupSize: 2,
    includeFullUrls: false,
    includePageHints: false
  }, "codex", [
    { id: 7, title: "Codex", color: "purple", tabIds: [9] }
  ]);

  assert.deepEqual(plan.groups, [{ name: "Codex GitHub", color: "blue", tabIds: [1, 2] }]);
  assert.deepEqual(chrome.__state.hostNames, [NATIVE_HOST_NAME]);
  assert.equal(chrome.__state.sentMessages[0]!.provider, "codex");
  assert.equal(chrome.__state.sentMessages[0]!.tabs[0]!.url, undefined);
  assert.deepEqual(chrome.__state.sentMessages[0]!.existingGroups, [
    { id: 7, title: "Codex", color: "purple", tabIds: [9] }
  ]);
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 2,
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
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;

  const status = await checkNativeCliStatus("local-codex-cli");
  assert.equal(status.configured, true);
  assert.equal(status.executableAvailable, true);
  assert.equal(chrome.__state.sentMessages[0]!.type, "NATIVE_HOST_STATUS_REQUEST");
  assert.equal(chrome.__state.sentMessages[0]!.version, 2);
  assert.equal(chrome.__state.sentMessages[0]!.provider, "codex");
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 2,
        type: "TAB_GROUP_PLAN_RESPONSE",
        requestId: message.requestId,
        ok: true,
        provider: "local-codex-cli",
        models: [
          { slug: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "xhigh" },
          { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" }
        ]
      };
    }
  });
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;

  const models = await listNativeModels("local-codex-cli");
  assert.deepEqual(models, [
    { slug: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "xhigh" },
    { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium" }
  ]);
  assert.equal(chrome.__state.sentMessages[0]!.type, "NATIVE_HOST_LIST_MODELS_REQUEST");
  assert.equal(chrome.__state.sentMessages[0]!.version, 2);
  assert.equal(chrome.__state.sentMessages[0]!.provider, "codex");
}

{
  const chrome = createChrome({
    nativeResponse(message) {
      return {
        version: 1,
        type: "TAB_GROUP_PLAN_RESPONSE",
        requestId: message.requestId,
        ok: false,
        provider: "local-codex-cli",
        error: {
          kind: "native-host-protocol-error",
          message: "unsupported protocol version"
        }
      };
    }
  });
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;

  await assert.rejects(
    checkNativeCliStatus("local-codex-cli"),
    (error) => {
      const mismatch = providerError(error);
      assert.equal(mismatch.providerErrorKind, "native-host-protocol-error");
      assert.equal(mismatch.message, "Native bridge is outdated. Reinstall it with nub run native:install.");
      return true;
    }
  );
}

{
  const chrome = createChrome({ hasPermission: false });
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;
  await assert.rejects(
    createPlanWithNativeCli(tabs, { minimumGroupSize: 2 }, "claude"),
    (error) => providerError(error).providerErrorKind === "missing-native-permission"
  );
  assert.deepEqual(chrome.__state.hostNames, []);
}

{
  let scheduledTimeout = false;
  let clearedTimeout = false;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    scheduledTimeout = true;
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timeoutId: ReturnType<typeof setTimeout>) => {
    clearedTimeout = true;
    return originalClearTimeout(timeoutId);
  }) as typeof clearTimeout;
  const chrome = createChrome({
    postMessageError: "Message is too large."
  });
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;
  try {
    await assert.rejects(
      createPlanWithNativeCli(tabs, { minimumGroupSize: 2 }, "codex"),
      (error) => providerError(error).providerErrorKind === "native-host-protocol-error"
    );
    // Effect's timeout race never schedules its own timer at all when the raced
    // effect (the postMessage throw here) already settled synchronously - there
    // is nothing to leak, which is a stronger guarantee than the old
    // always-schedule-then-clear implementation this test originally covered.
    assert.equal(scheduledTimeout, false);
    assert.equal(clearedTimeout, false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

{
  const chrome = createChrome({
    disconnectError: "Specified native messaging host not found."
  });
  globalThis.chrome = chrome as unknown as typeof globalThis.chrome;
  await assert.rejects(
    createPlanWithNativeCli(tabs, { minimumGroupSize: 2 }, "codex"),
    (error) => providerError(error).providerErrorKind === "native-host-not-found"
  );
}

console.log("Native CLI provider tests passed.");
