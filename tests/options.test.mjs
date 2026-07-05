import assert from "node:assert/strict";

async function importOptions({ permissionGrant = true, stored = {}, nativeStatus = null } = {}) {
  const elements = createFakeElements();
  const chrome = createFakeChrome({ permissionGrant, stored, nativeStatus });
  globalThis.chrome = chrome;
  globalThis.document = createFakeDocument(elements);
  globalThis.window = {
    setTimeout(callback) {
      callback();
      return 1;
    }
  };
  globalThis.FormData = class FakeFormData {
    constructor(form) {
      this.form = form;
    }

    get(name) {
      const input = this.form.elements[name];
      if (!input) {
        return null;
      }
      if (input.type === "checkbox") {
        return input.checked ? "on" : null;
      }
      return input.value;
    }
  };

  await import(`../options.js?test=${Date.now()}-${Math.random()}`);
  await Promise.resolve();
  return { elements, chrome };
}

function createFakeElements() {
  const form = createElement("settings-form", "form");
  form.elements = {};

  const elementById = {
    "settings-form": form,
    "save-status": createElement("save-status", "span"),
    provider: createElement("provider", "select"),
    includeFullUrls: createElement("includeFullUrls", "checkbox"),
    includePageHints: createElement("includePageHints", "checkbox"),
    "data-mode": createElement("data-mode", "strong"),
    "data-summary": createElement("data-summary", "p"),
    "test-native-bridge": createElement("test-native-bridge", "button"),
    "native-bridge-status": createElement("native-bridge-status", "span")
  };

  const fieldDefinitions = [
    ["provider", "select", "heuristic"],
    ["openaiApiKey", "text", ""],
    ["openaiModel", "text", "gpt-5.4-mini"],
    ["anthropicApiKey", "text", ""],
    ["anthropicModel", "text", "claude-sonnet-4-6-20260217"],
    ["includeFullUrls", "checkbox", false],
    ["includePageHints", "checkbox", false],
    ["allowHeuristicFallback", "checkbox", true],
    ["ignorePinnedTabs", "checkbox", true],
    ["keepExistingGroups", "checkbox", true],
    ["collapseGroups", "checkbox", false],
    ["minimumGroupSize", "number", "2"]
  ];

  for (const [id, type, value] of fieldDefinitions) {
    const element = elementById[id] || createElement(id, type);
    element.type = type;
    if (type === "checkbox") {
      element.checked = Boolean(value);
    } else {
      element.value = value;
    }
    elementById[id] = element;
    form.elements[id] = element;
  }

  elementById.__providerSections = [
    createProviderSection("local-cli"),
    createProviderSection("openai"),
    createProviderSection("anthropic")
  ];

  return elementById;
}

function createElement(id, type) {
  const listeners = new Map();
  const classNames = new Set();
  return {
    id,
    type,
    value: "",
    checked: false,
    textContent: "",
    hidden: false,
    dataset: {},
    addEventListener(event, callback) {
      listeners.set(event, callback);
    },
    async dispatch(event, payload = {}) {
      const callback = listeners.get(event);
      if (callback) {
        await callback({
          preventDefault() {},
          ...payload
        });
      }
    },
    classList: {
      toggle(name, enabled) {
        if (enabled) {
          classNames.add(name);
        } else {
          classNames.delete(name);
        }
      },
      contains(name) {
        return classNames.has(name);
      }
    }
  };
}

function createProviderSection(provider) {
  const element = createElement(`${provider}-section`, "section");
  element.dataset.providerSection = provider;
  return element;
}

function createFakeDocument(elements) {
  return {
    querySelector(selector) {
      if (!selector.startsWith("#")) {
        throw new Error(`Unsupported selector: ${selector}`);
      }
      return elements[selector.slice(1)];
    },
    querySelectorAll(selector) {
      if (selector === "[data-provider-section]") {
        return elements.__providerSections;
      }
      throw new Error(`Unsupported selector: ${selector}`);
    }
  };
}

function createFakeChrome({ permissionGrant, stored, nativeStatus }) {
  const state = {
    storage: { ...stored },
    permissionRequests: [],
    permissionRemovals: [],
    sentNativeMessages: [],
    nativePermissionGranted: false
  };
  return {
    __state: state,
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...state.storage };
        },
        async set(values) {
          Object.assign(state.storage, values);
        }
      }
    },
    permissions: {
      async request(request) {
        state.permissionRequests.push(request);
        if (permissionGrant && request.permissions?.includes("nativeMessaging")) {
          state.nativePermissionGranted = true;
        }
        return permissionGrant;
      },
      async contains(request) {
        if (request.permissions?.includes("nativeMessaging")) {
          return state.nativePermissionGranted;
        }
        return false;
      },
      async remove(request) {
        state.permissionRemovals.push(request);
        if (request.permissions?.includes("nativeMessaging")) {
          state.nativePermissionGranted = false;
        }
        return true;
      }
    },
    runtime: {
      lastError: null,
      connectNative() {
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
            state.sentNativeMessages.push(message);
            setTimeout(() => {
              for (const callback of messageListeners) {
                callback({
                  version: 1,
                  type: "TAB_GROUP_PLAN_RESPONSE",
                  requestId: message.requestId,
                  ok: true,
                  provider: "local-codex-cli",
                  status: nativeStatus || {
                    provider: "local-codex-cli",
                    configured: true,
                    executableAvailable: true,
                    authChecked: true,
                    authenticated: true,
                    lockExecutables: true
                  }
                });
              }
            }, 0);
          },
          disconnect() {
            for (const callback of disconnectListeners) {
              callback();
            }
          }
        };
      }
    }
  };
}

{
  const { elements, chrome } = await importOptions();
  elements.provider.value = "heuristic";
  await elements["settings-form"].dispatch("submit");
  assert.equal(chrome.__state.permissionRequests.length, 0);
  assert.deepEqual(chrome.__state.permissionRemovals, [{ origins: ["https://api.openai.com/*", "https://api.anthropic.com/*"], permissions: ["nativeMessaging"] }]);
  assert.equal(chrome.__state.storage.provider, "heuristic");
  assert.equal(chrome.__state.storage.allowHeuristicFallback, true);
  assert.equal(elements["save-status"].classList.contains("error-text"), false);
}

{
  const { elements, chrome } = await importOptions();
  elements.provider.value = "openai";
  await elements["settings-form"].dispatch("submit");
  assert.deepEqual(chrome.__state.permissionRequests, [{ origins: ["https://api.openai.com/*"] }]);
  assert.deepEqual(chrome.__state.permissionRemovals, [{ origins: ["https://api.anthropic.com/*"], permissions: ["nativeMessaging"] }]);
  assert.equal(chrome.__state.storage.provider, "openai");
  assert.equal(chrome.__state.storage.allowHeuristicFallback, true);
}

{
  const { elements, chrome } = await importOptions();
  elements.provider.value = "local-codex-cli";
  elements.allowHeuristicFallback.checked = false;
  await elements["settings-form"].dispatch("submit");
  assert.deepEqual(chrome.__state.permissionRequests, [{ permissions: ["nativeMessaging"] }]);
  assert.deepEqual(chrome.__state.permissionRemovals, [{ origins: ["https://api.openai.com/*", "https://api.anthropic.com/*"] }]);
  assert.equal(chrome.__state.storage.provider, "local-codex-cli");
  assert.equal(chrome.__state.storage.allowHeuristicFallback, false);
}

{
  const { elements, chrome } = await importOptions();
  elements.provider.value = "local-codex-cli";
  await elements.provider.dispatch("change");
  await elements["test-native-bridge"].dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(chrome.__state.permissionRequests, [{ permissions: ["nativeMessaging"] }]);
  assert.equal(chrome.__state.sentNativeMessages[0].type, "NATIVE_HOST_STATUS_REQUEST");
  assert.equal(chrome.__state.sentNativeMessages[0].provider, "codex");
  assert.equal(elements["native-bridge-status"].textContent, "Codex CLI bridge is ready.");
  assert.equal(elements["native-bridge-status"].classList.contains("error-text"), false);
}

{
  const { elements } = await importOptions({
    nativeStatus: {
      provider: "local-claude-cli",
      configured: false,
      executableAvailable: false,
      authChecked: false,
      authenticated: false,
      lockExecutables: true
    }
  });
  elements.provider.value = "local-claude-cli";
  await elements.provider.dispatch("change");
  await elements["test-native-bridge"].dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements["native-bridge-status"].textContent, "Claude Code CLI path is not configured. Reinstall the native host.");
  assert.equal(elements["native-bridge-status"].classList.contains("error-text"), true);
}

{
  const { elements } = await importOptions({
    nativeStatus: {
      provider: "local-codex-cli",
      configured: true,
      executableAvailable: true,
      authChecked: true,
      authenticated: false,
      lockExecutables: true
    }
  });
  elements.provider.value = "local-codex-cli";
  await elements.provider.dispatch("change");
  await elements["test-native-bridge"].dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements["native-bridge-status"].textContent, "Codex CLI is installed but not signed in.");
  assert.equal(elements["native-bridge-status"].classList.contains("error-text"), true);
}

{
  const { elements, chrome } = await importOptions({ permissionGrant: false });
  elements.provider.value = "local-claude-cli";
  await elements["settings-form"].dispatch("submit");
  assert.deepEqual(chrome.__state.permissionRequests, [{ permissions: ["nativeMessaging"] }]);
  assert.equal(chrome.__state.storage.provider, undefined);
  assert.equal(elements["save-status"].classList.contains("error-text"), true);
}

console.log("Options tests passed.");
