export const NATIVE_HOST_NAME = "com.fabianpieringer.tab_grouper";
const REQUEST_TYPE = "TAB_GROUP_PLAN_REQUEST";
const STATUS_REQUEST_TYPE = "NATIVE_HOST_STATUS_REQUEST";
const RESPONSE_TYPE = "TAB_GROUP_PLAN_RESPONSE";
const DEFAULT_TIMEOUT_MS = 15000;
const STATUS_TIMEOUT_MS = 3000;
const EXTENSION_TIMEOUT_MARGIN_MS = 2500;

export async function createPlanWithNativeCli(tabs, settings, cliProvider) {
  await ensureNativeMessagingPermission();

  const timeoutMs = getNativeRequestTimeoutMs(settings);
  const requestId = createRequestId();
  const request = {
    version: 1,
    type: REQUEST_TYPE,
    requestId,
    provider: cliProvider,
    timeoutMs,
    minimumGroupSize: Number(settings.minimumGroupSize || 2),
    includeFullUrls: settings.includeFullUrls === true,
    includePageHints: settings.includePageHints === true,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || "",
      domain: tab.domain || "unknown",
      url: settings.includeFullUrls ? tab.url || "" : undefined,
      pageHint: settings.includePageHints ? tab.pageHint || undefined : undefined,
      context: settings.includePageHints ? tab.context || undefined : undefined
    }))
  };

  const response = await sendNativeRequest(request, timeoutMs);
  return response.plan || { groups: [] };
}

export async function checkNativeCliStatus(provider) {
  const cliProvider = normalizeCliProvider(provider);
  await ensureNativeMessagingPermission();
  const request = {
    version: 1,
    type: STATUS_REQUEST_TYPE,
    requestId: createRequestId(),
    provider: cliProvider
  };
  const response = await sendNativeRequest(request, STATUS_TIMEOUT_MS);
  return response.status || {
    provider: `local-${cliProvider}-cli`,
    configured: false,
    executableAvailable: false,
    authChecked: false,
    authenticated: false,
    lockExecutables: false
  };
}

function sendNativeRequest(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port;
    const timeoutId = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        port?.disconnect();
      } catch {
        // Ignore disconnect failures during timeout cleanup.
      }
      reject(providerError("provider-timeout", "Local CLI provider timed out."));
    }, timeoutMs + EXTENSION_TIMEOUT_MARGIN_MS);

    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeoutId);
      callback(value);
    };

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      globalThis.clearTimeout(timeoutId);
      reject(classifyNativeError(error));
      return;
    }

    port.onMessage.addListener((response) => {
      if (!response || response.requestId !== request.requestId || response.type !== RESPONSE_TYPE) {
        settle(reject, providerError("native-host-protocol-error", "Local CLI bridge returned an unexpected response."));
        return;
      }
      if (!response.ok) {
        settle(reject, providerError(response.error?.kind || "native-host-protocol-error", response.error?.message || "Local CLI bridge failed."));
        return;
      }
      settle(resolve, response);
    });

    port.onDisconnect.addListener(() => {
      if (settled) {
        return;
      }
      settle(reject, classifyNativeError(chrome.runtime.lastError));
    });

    try {
      port.postMessage(request);
    } catch (error) {
      settle(reject, classifyNativeError(error));
    }
  });
}

function normalizeCliProvider(provider) {
  if (provider === "local-codex-cli" || provider === "codex") {
    return "codex";
  }
  if (provider === "local-claude-cli" || provider === "claude") {
    return "claude";
  }
  throw providerError("native-host-protocol-error", `Unsupported local CLI provider: ${provider}`);
}

async function ensureNativeMessagingPermission() {
  if (!globalThis.chrome?.permissions?.contains) {
    throw providerError("missing-native-permission", "Native messaging permission is unavailable. Re-save the provider in options.");
  }

  const hasPermission = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  if (!hasPermission) {
    throw providerError("missing-native-permission", "Native messaging permission is missing. Re-save the provider in options.");
  }
}

function classifyNativeError(error) {
  const message = error?.message || String(error || "Local CLI bridge disconnected.");
  if (/host.*not found|specified native messaging host not found/i.test(message)) {
    return providerError("native-host-not-found", "Tab Grouper native bridge is not installed.");
  }
  if (/forbidden|not allowed|access/i.test(message)) {
    return providerError("native-host-forbidden", "Tab Grouper native bridge is not allowed for this extension.");
  }
  return providerError("native-host-protocol-error", message);
}

function providerError(kind, message) {
  const error = new Error(message);
  error.providerErrorKind = kind;
  return error;
}

function getNativeRequestTimeoutMs(settings) {
  const rawTimeoutMs = Number(settings.providerRequestTimeoutMs);
  if (!Number.isFinite(rawTimeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.min(30000, Math.trunc(rawTimeoutMs)));
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `native-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
