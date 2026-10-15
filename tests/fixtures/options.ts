import assert from "node:assert/strict";

interface FakeEvent {
  preventDefault(): void;
  [key: string]: unknown;
}

interface FakeElement {
  id: string;
  type: string;
  value: string;
  checked: boolean;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  children: FakeElement[];
  dataset: { providerSection?: string };
  elements?: Record<string, FakeElement>;
  appendChild(child: FakeElement): FakeElement;
  replaceChildren(...children: FakeElement[]): void;
  addEventListener(event: string, callback: (event: FakeEvent) => void | Promise<void>): void;
  dispatch(event: string, payload?: Record<string, unknown>): Promise<void>;
  classList: {
    toggle(name: string, enabled: boolean): void;
    contains(name: string): boolean;
  };
}

interface FakeElements {
  "settings-form": FakeElement;
  "save-status": FakeElement;
  provider: FakeElement;
  openaiApiKey: FakeElement;
  openaiModel: FakeElement;
  anthropicApiKey: FakeElement;
  anthropicModel: FakeElement;
  model: FakeElement;
  reasoning: FakeElement;
  includeFullUrls: FakeElement;
  includePageHints: FakeElement;
  allowHeuristicFallback: FakeElement;
  ignorePinnedTabs: FakeElement;
  keepExistingGroups: FakeElement;
  minimumGroupSize: FakeElement;
  autoTidyEnabled: FakeElement;
  autoTidyIntervalMinutes: FakeElement;
  providerRequestTimeoutSeconds: FakeElement;
  "data-mode": FakeElement;
  "data-summary": FakeElement;
  "test-native-bridge": FakeElement;
  "native-bridge-status": FakeElement;
  __providerSections: FakeElement[];
}

interface NativeStatus {
  provider: string;
  configured: boolean;
  executableAvailable: boolean;
  authChecked: boolean;
  authenticated: boolean;
  lockExecutables: boolean;
}

interface NativeMessage {
  version: number;
  requestId: string;
  type: string;
  provider?: string;
}

interface ImportOptionsConfig {
  permissionGrant?: boolean;
  nativePermissionGranted?: boolean;
  stored?: Record<string, unknown>;
  nativeStatus?: NativeStatus | null;
  nativeModels?: Array<{
    slug: string;
    displayName: string;
    supportedReasoningLevels?: string[];
    defaultReasoningLevel?: string;
  }>;
  deferPermissionRequests?: boolean;
  deferNativeModelResponses?: boolean;
  deferNativeStatusResponses?: boolean;
  deferStorageWrites?: boolean;
}

async function importOptions({
  permissionGrant = true,
  nativePermissionGranted = false,
  stored = {},
  nativeStatus = null,
  nativeModels = [],
  deferPermissionRequests = false,
  deferNativeModelResponses = false,
  deferNativeStatusResponses = false,
  deferStorageWrites = false
}: ImportOptionsConfig = {}) {
  const elements = createFakeElements();
  const fakeChrome = createFakeChrome({
    permissionGrant,
    nativePermissionGranted,
    stored,
    nativeStatus,
    nativeModels,
    deferPermissionRequests,
    deferNativeModelResponses,
    deferNativeStatusResponses,
    deferStorageWrites
  });
  globalThis.chrome = fakeChrome as unknown as typeof globalThis.chrome;
  globalThis.document = createFakeDocument(elements) as unknown as Document;
  globalThis.window = {
    setTimeout(callback: TimerHandler) {
      if (typeof callback === "function") {
        callback();
      }
      return 1;
    },
    clearTimeout() {
    }
  } as unknown as Window & typeof globalThis;
  globalThis.FormData = class FakeFormData {
    private form: FakeElement;

    constructor(form: FakeElement) {
      this.form = form;
    }

    get(name: string) {
      const input = this.form.elements![name];
      if (!input || input.disabled) {
        return null;
      }
      if (input.type === "checkbox") {
        return input.checked ? "on" : null;
      }
      return input.value;
    }
  } as unknown as typeof FormData;

  await import(`../../src/options.js?test=${Date.now()}-${Math.random()}`);
  await waitUntil(() => elements["save-status"].textContent === "Saved");
  return { elements, chrome: fakeChrome };
}

function createFakeElements(): FakeElements {
  const form = createElement("settings-form", "form");
  form.elements = {};

  const elementById: Partial<Record<string, FakeElement>> = {
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

  const fieldDefinitions: Array<[string, string, string | boolean]> = [
    ["provider", "select", "heuristic"],
    ["openaiApiKey", "text", ""],
    ["openaiModel", "text", "gpt-5.4-mini"],
    ["anthropicApiKey", "text", ""],
    ["anthropicModel", "text", "claude-sonnet-4-6-20260217"],
    ["model", "select", ""],
    ["reasoning", "select", ""],
    ["includeFullUrls", "checkbox", false],
    ["includePageHints", "checkbox", false],
    ["allowHeuristicFallback", "checkbox", true],
    ["ignorePinnedTabs", "checkbox", true],
    ["keepExistingGroups", "checkbox", true],
    ["minimumGroupSize", "number", "2"],
    ["autoTidyEnabled", "checkbox", false],
    ["autoTidyIntervalMinutes", "number", "30"],
    ["providerRequestTimeoutSeconds", "number", "120"]
  ];

  for (const [id, type, value] of fieldDefinitions) {
    const element = elementById[id] || createElement(id, type);
    element.type = type;
    if (type === "checkbox") {
      element.checked = Boolean(value);
    } else {
      element.value = String(value);
    }
    elementById[id] = element;
    form.elements[id] = element;
  }

  (elementById as unknown as FakeElements).__providerSections = [
    createProviderSection("local-cli"),
    createProviderSection("openai"),
    createProviderSection("anthropic")
  ];

  return elementById as unknown as FakeElements;
}

function createElement(id: string, type: string): FakeElement {
  const listeners = new Map<string, (event: FakeEvent) => void | Promise<void>>();
  const classNames = new Set<string>();
  return {
    id,
    type,
    value: "",
    checked: false,
    textContent: "",
    hidden: false,
    disabled: false,
    children: [],
    dataset: {},
    appendChild(child: FakeElement) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...children: FakeElement[]) {
      this.children = children;
    },
    addEventListener(event: string, callback: (event: FakeEvent) => void | Promise<void>) {
      listeners.set(event, callback);
    },
    async dispatch(event: string, payload: Record<string, unknown> = {}) {
      const callback = listeners.get(event);
      if (callback) {
        await callback({
          preventDefault() {},
          ...payload
        });
      }
    },
    classList: {
      toggle(name: string, enabled: boolean) {
        if (enabled) {
          classNames.add(name);
        } else {
          classNames.delete(name);
        }
      },
      contains(name: string) {
        return classNames.has(name);
      }
    }
  };
}

function createProviderSection(provider: string) {
  const element = createElement(`${provider}-section`, "section");
  element.dataset.providerSection = provider;
  return element;
}

function createFakeDocument(elements: FakeElements) {
  return {
    querySelector(selector: string) {
      if (!selector.startsWith("#")) {
        throw new Error(`Unsupported selector: ${selector}`);
      }
      return (elements as unknown as Record<string, FakeElement>)[selector.slice(1)];
    },
    querySelectorAll(selector: string) {
      if (selector === "[data-provider-section]") {
        return elements.__providerSections;
      }
      throw new Error(`Unsupported selector: ${selector}`);
    },
    createElement(tagName: string) {
      return createElement(tagName, tagName);
    }
  };
}

function createFakeChrome({
  permissionGrant,
  nativePermissionGranted,
  stored,
  nativeStatus,
  nativeModels,
  deferPermissionRequests,
  deferNativeModelResponses,
  deferNativeStatusResponses,
  deferStorageWrites
}: Required<ImportOptionsConfig>) {
  const state = {
    storage: { ...stored },
    permissionRequests: [] as chrome.permissions.Permissions[],
    permissionRemovals: [] as chrome.permissions.Permissions[],
    sentNativeMessages: [] as NativeMessage[],
    pendingPermissionRequests: [] as Array<() => void>,
    pendingNativeModelResponses: [] as Array<() => void>,
    pendingNativeStatusResponses: [] as Array<() => void>,
    pendingStorageWrites: [] as Array<() => void>,
    nativePermissionGranted
  };
  return {
    __state: state,
    storage: {
      local: {
        async get(defaults: Record<string, unknown>) {
          return { ...defaults, ...state.storage };
        },
        async set(values: Record<string, unknown>) {
          if (deferStorageWrites) {
            await new Promise<void>((resolve) => state.pendingStorageWrites.push(resolve));
          }
          Object.assign(state.storage, values);
        }
      }
    },
    permissions: {
      async request(request: chrome.permissions.Permissions) {
        state.permissionRequests.push(request);
        if (deferPermissionRequests) {
          await new Promise<void>((resolve) => state.pendingPermissionRequests.push(resolve));
        }
        if (permissionGrant && request.permissions?.includes("nativeMessaging")) {
          state.nativePermissionGranted = true;
        }
        return permissionGrant;
      },
      async contains(request: chrome.permissions.Permissions) {
        if (request.permissions?.includes("nativeMessaging")) {
          return state.nativePermissionGranted;
        }
        return false;
      },
      async remove(request: chrome.permissions.Permissions) {
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
        const messageListeners: Array<(message: Record<string, unknown>) => void> = [];
        const disconnectListeners: Array<() => void> = [];
        return {
          onMessage: {
            addListener(callback: (message: Record<string, unknown>) => void) {
              messageListeners.push(callback);
            }
          },
          onDisconnect: {
            addListener(callback: () => void) {
              disconnectListeners.push(callback);
            }
          },
          postMessage(message: NativeMessage) {
            state.sentNativeMessages.push(message);
            const respond = () => {
              for (const callback of messageListeners) {
                if (message.type === "NATIVE_HOST_LIST_MODELS_REQUEST") {
                  callback({
                    version: 3,
                    type: "TAB_GROUP_PLAN_RESPONSE",
                    requestId: message.requestId,
                    ok: true,
                    provider: "local-codex-cli",
                    models: nativeModels
                  });
                  continue;
                }
                callback({
                  version: 3,
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
            };
            if (message.type === "NATIVE_HOST_LIST_MODELS_REQUEST" && deferNativeModelResponses) {
              state.pendingNativeModelResponses.push(respond);
              return;
            }
            if (message.type === "NATIVE_HOST_STATUS_REQUEST" && deferNativeStatusResponses) {
              state.pendingNativeStatusResponses.push(respond);
              return;
            }
            setTimeout(respond, 0);
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for test state.");
}

export { importOptions, waitUntil };
export type { NativeMessage };
