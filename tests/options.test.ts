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
      if (!input) {
        return null;
      }
      if (input.type === "checkbox") {
        return input.checked ? "on" : null;
      }
      return input.value;
    }
  } as unknown as typeof FormData;

  await import(`../src/options.js?test=${Date.now()}-${Math.random()}`);
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
  deferStorageWrites
}: Required<ImportOptionsConfig>) {
  const state = {
    storage: { ...stored },
    permissionRequests: [] as chrome.permissions.Permissions[],
    permissionRemovals: [] as chrome.permissions.Permissions[],
    sentNativeMessages: [] as NativeMessage[],
    pendingPermissionRequests: [] as Array<() => void>,
    pendingNativeModelResponses: [] as Array<() => void>,
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

{
  const { elements, chrome } = await importOptions();
  elements.provider.value = "heuristic";
  await elements["settings-form"].dispatch("submit");
  await waitUntil(() => chrome.__state.storage.provider === "heuristic");
  assert.equal(chrome.__state.permissionRequests.length, 0);
  assert.deepEqual(chrome.__state.permissionRemovals, []);
  assert.equal(chrome.__state.storage.provider, "heuristic");
  assert.equal(chrome.__state.storage.allowHeuristicFallback, true);
  assert.equal(elements["save-status"].classList.contains("error-text"), false);
}

{
  const { elements, chrome } = await importOptions();
  elements.provider.value = "openai";
  await elements.provider.dispatch("change");
  assert.deepEqual(chrome.__state.permissionRequests, [{ origins: ["https://api.openai.com/*"] }]);
  assert.deepEqual(chrome.__state.permissionRemovals, [{ origins: ["https://api.anthropic.com/*"], permissions: ["nativeMessaging"] }]);
  assert.equal(chrome.__state.storage.provider, "openai");
  assert.equal(chrome.__state.storage.allowHeuristicFallback, true);
}

{
  const { elements, chrome } = await importOptions();
  assert.equal(elements.autoTidyIntervalMinutes.disabled, true);

  elements.autoTidyEnabled.checked = true;
  await elements.autoTidyEnabled.dispatch("change");
  await waitUntil(() => chrome.__state.storage.autoTidyEnabled === true);
  assert.equal(elements.autoTidyIntervalMinutes.disabled, false);

  elements.autoTidyIntervalMinutes.value = "45";
  await elements.autoTidyIntervalMinutes.dispatch("input");
  await waitUntil(() => chrome.__state.storage.autoTidyIntervalMinutes === 45);

  elements.providerRequestTimeoutSeconds.value = "180";
  await elements.providerRequestTimeoutSeconds.dispatch("change");
  await waitUntil(() => chrome.__state.storage.providerRequestTimeoutSeconds === 180);
  await waitUntil(() => elements["save-status"].textContent === "Saved");
  assert.equal(elements["save-status"].textContent, "Saved");
}

{
  const { elements, chrome } = await importOptions();
  elements.provider.value = "local-codex-cli";
  await elements.provider.dispatch("change");
  elements.model.value = " gpt-5.5-codex ";
  await elements.model.dispatch("change");
  elements.reasoning.value = "high";
  await elements.reasoning.dispatch("change");
  elements.allowHeuristicFallback.checked = false;
  await elements.allowHeuristicFallback.dispatch("change");
  await waitUntil(() => chrome.__state.storage.allowHeuristicFallback === false);
  assert.deepEqual(chrome.__state.permissionRequests, [{ permissions: ["nativeMessaging"] }]);
  assert.deepEqual(chrome.__state.permissionRemovals, [{ origins: ["https://api.openai.com/*", "https://api.anthropic.com/*"] }]);
  assert.equal(chrome.__state.storage.provider, "local-codex-cli");
  assert.equal(chrome.__state.storage.codexCliModel, "gpt-5.5-codex");
  assert.equal(chrome.__state.storage.codexReasoningEffort, "high");
  assert.equal(chrome.__state.storage.claudeCliModel, "");
  assert.equal(chrome.__state.storage.claudeReasoningEffort, "");
  assert.equal(chrome.__state.storage.allowHeuristicFallback, false);
}

{
  const { elements } = await importOptions({
    stored: {
      provider: "local-claude-cli",
      codexCliModel: "codex-stored",
      claudeCliModel: "claude-sonnet-5",
      claudeReasoningEffort: "max"
    }
  });
  assert.equal(elements.model.value, "claude-sonnet-5");
  assert.deepEqual(elements.model.children.map((option) => [option.value, option.textContent]), [
    ["", "Use claude CLI's own default"],
    ["claude-fable-5", "Fable 5"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"]
  ]);
  assert.equal(elements.reasoning.value, "max");
  assert.deepEqual(elements.reasoning.children.map((option) => [option.value, option.textContent]), [
    ["", "Use claude CLI's default"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"]
  ]);
}

{
  const { elements, chrome } = await importOptions({
    nativePermissionGranted: true,
    stored: {
      provider: "local-codex-cli",
      codexCliModel: "gpt-5.4-mini",
      codexReasoningEffort: "high",
      claudeCliModel: "claude-opus-4-8"
    },
    nativeModels: [
      { slug: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "xhigh" },
      { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", supportedReasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium" }
    ]
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chrome.__state.sentNativeMessages[0]!.type, "NATIVE_HOST_LIST_MODELS_REQUEST");
  assert.equal(chrome.__state.sentNativeMessages[0]!.provider, "codex");
  assert.equal(elements.model.value, "gpt-5.4-mini");
  assert.deepEqual(elements.model.children.map((option) => [option.value, option.textContent]), [
    ["", "Use codex CLI's own default"],
    ["gpt-5.5", "GPT-5.5"],
    ["gpt-5.4-mini", "GPT-5.4-Mini"]
  ]);
  assert.equal(elements.reasoning.value, "high");
  assert.deepEqual(elements.reasoning.children.map((option) => [option.value, option.textContent]), [
    ["", "Use codex CLI's default (medium)"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"]
  ]);
}

{
  const { elements, chrome } = await importOptions({
    stored: {
      provider: "local-codex-cli",
      codexCliModel: "gpt-5.4-mini"
    },
    nativeModels: [
      { slug: "gpt-5.5", displayName: "GPT-5.5" },
      { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" }
    ]
  });
  await Promise.resolve();
  assert.deepEqual(chrome.__state.permissionRequests, []);
  assert.deepEqual(chrome.__state.sentNativeMessages, []);
  assert.equal(elements.model.value, "gpt-5.4-mini");
  assert.deepEqual(elements.model.children.map((option) => [option.value, option.textContent]), [
    ["", "Use codex CLI's own default"],
    ["gpt-5.4-mini", "gpt-5.4-mini (saved)"]
  ]);
  assert.equal(elements.reasoning.value, "");
  assert.deepEqual(elements.reasoning.children.map((option) => [option.value, option.textContent]), [
    ["", "Use codex CLI's default"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"]
  ]);
  assert.equal(elements["native-bridge-status"].textContent, "Test the bridge to grant access and load Codex models.");
  assert.equal(elements["native-bridge-status"].classList.contains("error-text"), false);

  await elements["test-native-bridge"].dispatch("click");
  assert.deepEqual(chrome.__state.permissionRequests, [{ permissions: ["nativeMessaging"] }]);
  const bridgeMessages = chrome.__state.sentNativeMessages as NativeMessage[];
  assert.deepEqual(bridgeMessages.map((message) => message.type), [
    "NATIVE_HOST_STATUS_REQUEST",
    "NATIVE_HOST_LIST_MODELS_REQUEST"
  ]);
  assert.deepEqual(elements.model.children.map((option) => [option.value, option.textContent]), [
    ["", "Use codex CLI's own default"],
    ["gpt-5.5", "GPT-5.5"],
    ["gpt-5.4-mini", "GPT-5.4-Mini"]
  ]);
  assert.equal(elements["native-bridge-status"].textContent, "Codex CLI bridge is ready.");
}

{
  const { elements, chrome } = await importOptions({
    nativeModels: [
      { slug: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningLevels: ["high", "xhigh"], defaultReasoningLevel: "xhigh" },
      { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", supportedReasoningLevels: ["low", "medium"], defaultReasoningLevel: "medium" }
    ]
  });
  elements.provider.value = "local-codex-cli";
  await elements.provider.dispatch("change");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(chrome.__state.permissionRequests, [{ permissions: ["nativeMessaging"] }]);
  assert.equal(chrome.__state.sentNativeMessages[0]!.type, "NATIVE_HOST_LIST_MODELS_REQUEST");
  assert.equal(chrome.__state.sentNativeMessages[0]!.provider, "codex");
  assert.equal(elements.model.value, "");
  assert.deepEqual(elements.model.children.map((option) => [option.value, option.textContent]), [
    ["", "Use codex CLI's own default"],
    ["gpt-5.5", "GPT-5.5"],
    ["gpt-5.4-mini", "GPT-5.4-Mini"]
  ]);
  assert.equal(elements.reasoning.value, "");
  assert.deepEqual(elements.reasoning.children.map((option) => [option.value, option.textContent]), [
    ["", "Use codex CLI's default"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"]
  ]);
  elements.model.value = "gpt-5.4-mini";
  await elements.model.dispatch("change");
  await waitUntil(() => chrome.__state.storage.codexCliModel === "gpt-5.4-mini");
  assert.deepEqual(elements.reasoning.children.map((option) => [option.value, option.textContent]), [
    ["", "Use codex CLI's default (medium)"],
    ["low", "low"],
    ["medium", "medium"]
  ]);
  assert.equal(elements["native-bridge-status"].textContent, "");
  assert.equal(elements["native-bridge-status"].classList.contains("error-text"), false);
}

{
  const { elements, chrome } = await importOptions({
    stored: {
      provider: "local-claude-cli",
      codexCliModel: "gpt-5.4-mini",
      codexReasoningEffort: "high",
      claudeReasoningEffort: "max"
    },
    nativeModels: [
      { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", supportedReasoningLevels: ["low", "medium", "high"] }
    ]
  });
  elements.provider.value = "local-codex-cli";
  await elements.provider.dispatch("change");
  assert.equal(chrome.__state.storage.codexCliModel, "gpt-5.4-mini");
  assert.equal(chrome.__state.storage.codexReasoningEffort, "high");
  assert.equal(elements["save-status"].textContent, "Saved");
}

{
  const { elements, chrome } = await importOptions({
    stored: {
      provider: "local-claude-cli",
      claudeReasoningEffort: "max"
    },
    nativeModels: [
      { slug: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "xhigh" }
    ],
    deferNativeModelResponses: true
  });
  elements.provider.value = "local-codex-cli";
  const codexChange = elements.provider.dispatch("change");
  await waitUntil(() => chrome.__state.pendingNativeModelResponses.length === 1);

  elements.provider.value = "local-claude-cli";
  await elements.provider.dispatch("change");
  assert.equal(elements.reasoning.value, "max");
  const claudeReasoningOptions = elements.reasoning.children.map((option) => [option.value, option.textContent]);

  chrome.__state.pendingNativeModelResponses.shift()!();
  await codexChange;
  assert.equal(elements.provider.value, "local-claude-cli");
  assert.equal(elements.reasoning.value, "max");
  assert.deepEqual(elements.reasoning.children.map((option) => [option.value, option.textContent]), claudeReasoningOptions);
  assert.equal(elements.reasoning.disabled, false);
}

{
  const { elements, chrome } = await importOptions({
    stored: {
      provider: "heuristic",
      minimumGroupSize: 2
    },
    deferStorageWrites: true
  });
  elements.minimumGroupSize.value = "3";
  await elements.minimumGroupSize.dispatch("input");
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);

  elements.minimumGroupSize.value = "4";
  await elements.minimumGroupSize.dispatch("change");
  chrome.__state.pendingStorageWrites.shift()!();
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);
  chrome.__state.pendingStorageWrites.shift()!();
  await waitUntil(() => chrome.__state.storage.minimumGroupSize === 4);
  assert.equal(elements.minimumGroupSize.value, "4");
  assert.equal(elements["save-status"].textContent, "Saved");
  assert.equal(elements["save-status"].classList.contains("error-text"), false);
}

{
  const { elements, chrome } = await importOptions({
    stored: {
      provider: "local-codex-cli",
      codexCliModel: "old-codex"
    },
    nativePermissionGranted: true,
    nativeModels: [
      { slug: "old-codex", displayName: "Old Codex" },
      { slug: "new-codex", displayName: "New Codex" }
    ],
    deferStorageWrites: true
  });

  elements.model.value = "new-codex";
  await elements.model.dispatch("change");
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);

  elements.provider.value = "heuristic";
  const providerChange = elements.provider.dispatch("change");
  chrome.__state.pendingStorageWrites.shift()!();
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);
  chrome.__state.pendingStorageWrites.shift()!();
  await providerChange;

  assert.equal(chrome.__state.storage.provider, "heuristic");
  assert.equal(chrome.__state.storage.codexCliModel, "new-codex");
}

{
  const { elements, chrome } = await importOptions({
    stored: {
      provider: "local-claude-cli",
      codexReasoningEffort: "xhigh",
      claudeReasoningEffort: "medium"
    }
  });
  elements.provider.value = "local-claude-cli";
  elements.reasoning.value = "max";
  await elements["settings-form"].dispatch("submit");
  await waitUntil(() => chrome.__state.storage.claudeReasoningEffort === "max");
  assert.equal(chrome.__state.storage.codexReasoningEffort, "xhigh");
  assert.equal(chrome.__state.storage.claudeReasoningEffort, "max");
}

{
  const { elements, chrome } = await importOptions();
  elements.provider.value = "local-codex-cli";
  await elements.provider.dispatch("change");
  await elements["test-native-bridge"].dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(chrome.__state.permissionRequests, [{ permissions: ["nativeMessaging"] }, { permissions: ["nativeMessaging"] }]);
  assert.equal(chrome.__state.sentNativeMessages[0]!.type, "NATIVE_HOST_LIST_MODELS_REQUEST");
  assert.equal(chrome.__state.sentNativeMessages[0]!.provider, "codex");
  assert.equal(chrome.__state.sentNativeMessages[1]!.type, "NATIVE_HOST_STATUS_REQUEST");
  assert.equal(chrome.__state.sentNativeMessages[1]!.provider, "codex");
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
  await elements.provider.dispatch("change");
  assert.deepEqual(chrome.__state.permissionRequests, [{ permissions: ["nativeMessaging"] }]);
  assert.equal(chrome.__state.storage.provider, undefined);
  assert.equal(elements.provider.value, "heuristic");
  assert.equal(elements["save-status"].classList.contains("error-text"), true);

  elements.minimumGroupSize.value = "3";
  await elements.minimumGroupSize.dispatch("change");
  await waitUntil(() => chrome.__state.storage.minimumGroupSize === 3);
  assert.equal(chrome.__state.storage.provider, "heuristic");
}

console.log("Options tests passed.");
