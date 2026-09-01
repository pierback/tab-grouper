import assert from "node:assert/strict";

interface FakeElement {
  id: string;
  tagName: string;
  className: string;
  disabled: boolean;
  hidden: boolean;
  innerHTML: string;
  textContent: string;
  children: FakeElement[];
  attributes: Record<string, string>;
  addEventListener(event: string, callback: () => void | Promise<void>): void;
  dispatch(event: string): Promise<void>;
  append(...children: FakeElement[]): void;
  replaceChildren(...children: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
}

interface FakeElements {
  "tidy-button": FakeElement;
  result: FakeElement;
  "provider-label": FakeElement;
  "provider-meta": FakeElement;
  "tab-count": FakeElement;
  "auto-tidy-status": FakeElement;
  "open-options": FakeElement;
  "preview-button": FakeElement;
  "undo-button": FakeElement;
}

interface PopupMessage {
  type: string;
  windowId?: number;
  grantedHintOrigins?: string[];
}

interface PopupResponse {
  ok: boolean;
  [key: string]: unknown;
}

interface ImportPopupConfig {
  currentWindowId?: number;
  undoAvailable?: boolean;
  settings?: Record<string, unknown>;
  tabs?: Array<Partial<chrome.tabs.Tab> & { id: number; windowId: number }> | null;
  tidyResponse?: PopupResponse | null;
  previewResponse?: PopupResponse | null;
}

async function importPopup({
  currentWindowId = 42,
  undoAvailable = true,
  settings = { provider: "heuristic" },
  tabs = null,
  tidyResponse = null,
  previewResponse = null
}: ImportPopupConfig = {}) {
  const elements = createFakeElements();
  const fakeChrome = createFakeChrome({ currentWindowId, undoAvailable, settings, tabs, tidyResponse, previewResponse });
  globalThis.chrome = fakeChrome as unknown as typeof globalThis.chrome;
  globalThis.document = createFakeDocument(elements) as unknown as Document;

  await import(`../src/popup.js?test=${Date.now()}-${Math.random()}`);
  await flushAsyncWork();
  return { elements, chrome: fakeChrome };
}

function createFakeElements(): FakeElements {
  const ids = [
    "tidy-button",
    "result",
    "provider-label",
    "provider-meta",
    "tab-count",
    "auto-tidy-status",
    "open-options",
    "preview-button",
    "undo-button"
  ];
  return Object.fromEntries(ids.map((id) => [id, createElement(id, "div")])) as unknown as FakeElements;
}

function createElement(id: string, tagName: string): FakeElement {
  const listeners = new Map<string, () => void | Promise<void>>();
  return {
    id,
    tagName,
    className: "",
    disabled: false,
    hidden: false,
    innerHTML: "",
    textContent: "",
    children: [] as FakeElement[],
    attributes: {},
    addEventListener(event: string, callback: () => void | Promise<void>) {
      listeners.set(event, callback);
    },
    async dispatch(event: string) {
      const callback = listeners.get(event);
      if (callback) {
        await callback();
      }
    },
    append(...children: FakeElement[]) {
      this.children.push(...children);
    },
    replaceChildren(...children: FakeElement[]) {
      this.children = children;
      this.textContent = "";
      this.innerHTML = "";
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    }
  };
}

function createFakeDocument(elements: FakeElements) {
  return {
    querySelector(selector: string) {
      if (!selector.startsWith("#")) {
        throw new Error(`Unsupported selector: ${selector}`);
      }
      return (elements as unknown as Record<string, FakeElement>)[selector.slice(1)];
    },
    createElement(tagName: string) {
      return createElement(tagName, tagName);
    }
  };
}

function createFakeChrome({ currentWindowId, undoAvailable, settings, tabs, tidyResponse, previewResponse }: Required<ImportPopupConfig>) {
  const state = {
    messages: [] as PopupMessage[],
    tabQueries: [] as chrome.tabs.QueryInfo[],
    permissionRequests: [] as chrome.permissions.Permissions[],
    optionsOpened: false
  };
  const windowTabs = tabs || [
    { id: 1, windowId: currentWindowId },
    { id: 2, windowId: currentWindowId },
    { id: 3, windowId: currentWindowId }
  ];

  return {
    __state: state,
    windows: {
      async getCurrent() {
        return { id: currentWindowId };
      }
    },
    runtime: {
      async sendMessage(message: PopupMessage) {
        state.messages.push(message);
        if (message.type === "GET_STATUS") {
          return {
            ok: true,
            settings,
            undoAvailable
          };
        }
        if (message.type === "TIDY_CURRENT_WINDOW") {
          return tidyResponse || {
            ok: true,
            undoAvailable: true,
            groups: [{ name: "Codex GitHub", color: "blue", count: 2 }],
            message: "Created 1 group."
          };
        }
        if (message.type === "PREVIEW_CURRENT_WINDOW") {
          return previewResponse || {
            ok: true,
            undoAvailable: false,
            groups: [{ name: "Dev Docs", color: "green", count: 2 }],
            message: "Would create 1 group."
          };
        }
        if (message.type === "UNDO_LAST_TIDY") {
          return {
            ok: true,
            undoAvailable: false,
            message: "Undid 2 tabs."
          };
        }
        throw new Error(`Unexpected message: ${message.type}`);
      },
      openOptionsPage() {
        state.optionsOpened = true;
      }
    },
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo) {
        state.tabQueries.push(queryInfo);
        return windowTabs as chrome.tabs.Tab[];
      }
    },
    permissions: {
      async request(request: chrome.permissions.Permissions) {
        state.permissionRequests.push(request);
        return true;
      }
    }
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

{
  const { elements, chrome } = await importPopup({ currentWindowId: 42, undoAvailable: true });

  assert.deepEqual(chrome.__state.messages[0], { type: "GET_STATUS", windowId: 42 });
  assert.deepEqual(chrome.__state.tabQueries[0], { windowId: 42 });
  assert.equal(elements["provider-label"].textContent, "Local heuristic");
  assert.equal(elements["provider-meta"].textContent, "No model · No reasoning");
  assert.equal(elements["tab-count"].textContent, "3 tabs");
  assert.equal(elements["auto-tidy-status"].textContent, "Off");
  assert.equal(elements["undo-button"].hidden, false);

  await elements["tidy-button"].dispatch("click");
  assert.deepEqual(chrome.__state.messages.at(-1), {
    type: "TIDY_CURRENT_WINDOW",
    windowId: 42,
    grantedHintOrigins: []
  });
  assert.equal(elements["tidy-button"].disabled, false);
  assert.equal(elements.result.children.length, 3);
  assert.equal(elements["undo-button"].hidden, false);

  await elements["preview-button"].dispatch("click");
  assert.deepEqual(chrome.__state.messages.at(-1), {
    type: "PREVIEW_CURRENT_WINDOW",
    windowId: 42,
    grantedHintOrigins: []
  });

  await elements["undo-button"].dispatch("click");
  assert.deepEqual(chrome.__state.messages.at(-1), { type: "UNDO_LAST_TIDY", windowId: 42 });
  assert.equal(elements["undo-button"].hidden, true);
  assert.equal(elements.result.textContent, "Undid 2 tabs.");

  await elements["open-options"].dispatch("click");
  assert.equal(chrome.__state.optionsOpened, true);
}

{
  const { elements, chrome } = await importPopup({
    currentWindowId: 43,
    settings: {
      provider: "local-codex-cli",
      includePageHints: true
    },
    tabs: [
      { id: 1, windowId: 43, url: "https://example.com/a" },
      { id: 2, windowId: 43, url: "https://example.com/b" },
      { id: 3, windowId: 43, url: "https://api.openai.com/v1/responses" },
      { id: 6, windowId: 43, url: "https://api.anthropic.com/v1/messages" },
      { id: 7, windowId: 43, url: "chrome://settings" },
      { id: 4, windowId: 43, url: "https://pinned.example/a", pinned: true },
      { id: 5, windowId: 43, url: "https://grouped.example/a", groupId: 9 }
    ]
  });

  await elements["tidy-button"].dispatch("click");
  assert.deepEqual(chrome.__state.permissionRequests, [
    { permissions: ["scripting"], origins: ["https://example.com/*"] }
  ]);
  assert.deepEqual(chrome.__state.messages.at(-1), {
    type: "TIDY_CURRENT_WINDOW",
    windowId: 43,
    grantedHintOrigins: ["https://example.com/*"]
  });
}

{
  const { elements } = await importPopup({
    previewResponse: {
      ok: true,
      undoAvailable: false,
      groups: [],
      assignments: [{ groupId: 7, title: "Berlin <Trip>", count: 2 }],
      message: "Would add 2 tabs to existing groups."
    }
  });

  await elements["preview-button"].dispatch("click");
  assert.equal(elements.result.children.length, 3);
  assert.match(elements.result.children[2]!.children[0]!.innerHTML, /\+2/);
  assert.match(elements.result.children[2]!.children[0]!.innerHTML, /-&gt; Berlin &lt;Trip&gt;/);
}

{
  const { elements } = await importPopup({
    previewResponse: {
      ok: true,
      undoAvailable: false,
      groups: [{ name: "<Unsafe Group>", color: "green", count: 2 }],
      message: "Would create 1 group.",
      provider: "heuristic",
      requestedProvider: "local-codex-cli",
      usedFallback: true,
      providerError: "Bridge <failed> & stopped"
    }
  });

  await elements["preview-button"].dispatch("click");
  assert.match(elements.result.children[2]!.innerHTML, /Requested provider: <strong>Local Codex CLI<\/strong>/);
  assert.match(elements.result.children[2]!.innerHTML, /Actual provider: <strong>Local heuristic<\/strong>/);
  assert.match(elements.result.children[2]!.innerHTML, /Provider error: Bridge &lt;failed&gt; &amp; stopped/);
  assert.match(elements.result.children[3]!.children[0]!.innerHTML, /&lt;Unsafe Group&gt;/);
}

{
  const { elements } = await importPopup({
    previewResponse: {
      ok: true,
      undoAvailable: false,
      groups: [{ name: "Dev Docs", color: "green", count: 2 }],
      message: "Would create 1 group.",
      provider: "openai",
      usedFallback: false,
      providerError: ""
    }
  });

  await elements["preview-button"].dispatch("click");
  assert.equal(elements.result.children[2]!.innerHTML, "AI provider: <strong>OpenAI API</strong>.");
}

{
  const { elements } = await importPopup({
    previewResponse: {
      ok: true,
      undoAvailable: false,
      groups: [{ name: "Dev Docs", color: "green", count: 2 }],
      message: "Would create 1 group.",
      provider: "local-claude-cli",
      usedFallback: false,
      providerError: "",
      durationMs: 1250,
      inputTokens: 100,
      outputTokens: 23,
      costUsd: 0.004321,
      costBasis: "reported"
    }
  });

  await elements["preview-button"].dispatch("click");
  const stats = elements.result.children[1]!;
  assert.equal(stats.className, "run-stats");
  assert.equal(stats.children[0]!.children[2]!.textContent, "1.3s provider");
  assert.equal(stats.children[1]!.children[1]!.textContent, "123");
  assert.equal(stats.children[1]!.children[2]!.textContent, "100 in · 23 out");
  assert.equal(stats.children[2]!.children[1]!.textContent, "$0.0043");
  assert.equal(stats.children[2]!.children[2]!.textContent, "Provider reported");
  assert.equal(elements.result.children[2]!.innerHTML, "AI provider: <strong>Local Claude Code CLI</strong>.");
}

{
  const { elements } = await importPopup({
    previewResponse: {
      ok: true,
      undoAvailable: false,
      groups: [],
      message: "No changes needed.",
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      costBasis: "reported"
    }
  });

  await elements["preview-button"].dispatch("click");
  const stats = elements.result.children[1]!;
  assert.equal(stats.children[0]!.children[2]!.textContent, "Wall clock");
  assert.equal(stats.children[1]!.children[1]!.textContent, "—");
  assert.equal(stats.children[1]!.children[2]!.textContent, "Not reported");
  assert.equal(stats.children[2]!.children[1]!.textContent, "—");
  assert.equal(stats.children[2]!.children[2]!.textContent, "Not available");
}

{
  const { elements } = await importPopup({
    tidyResponse: {
      ok: false,
      error: "Tab Grouper native bridge is not allowed for this extension.",
      providerErrorKind: "native-host-forbidden"
    }
  });

  await elements["tidy-button"].dispatch("click");
  assert.equal(
    elements.result.children[0]!.textContent,
    "Native bridge is not allowed for this extension ID. Reinstall the native host."
  );
}

{
  const { elements } = await importPopup({
    settings: {
      provider: "local-codex-cli",
      codexCliModel: "gpt-5.5-codex",
      codexReasoningEffort: "high",
      autoTidyEnabled: true,
      autoTidyIntervalMinutes: 30
    }
  });

  assert.equal(elements["provider-label"].textContent, "Local Codex CLI");
  assert.equal(elements["provider-meta"].textContent, "gpt-5.5-codex · High reasoning");
  assert.equal(elements["auto-tidy-status"].textContent, "Every 30 min");
}

console.log("Popup tests passed.");
