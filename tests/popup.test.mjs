import assert from "node:assert/strict";

async function importPopup({
  currentWindowId = 42,
  undoAvailable = true,
  settings = { provider: "heuristic" },
  tabs = null,
  tidyResponse = null,
  previewResponse = null
} = {}) {
  const elements = createFakeElements();
  const chrome = createFakeChrome({ currentWindowId, undoAvailable, settings, tabs, tidyResponse, previewResponse });
  globalThis.chrome = chrome;
  globalThis.document = createFakeDocument(elements);

  await import(`../popup.js?test=${Date.now()}-${Math.random()}`);
  await flushAsyncWork();
  return { elements, chrome };
}

function createFakeElements() {
  const ids = [
    "tidy-button",
    "result",
    "provider-label",
    "tab-count",
    "open-options",
    "preview-button",
    "undo-button"
  ];
  return Object.fromEntries(ids.map((id) => [id, createElement(id, "div")]));
}

function createElement(id, tagName) {
  const listeners = new Map();
  return {
    id,
    tagName,
    className: "",
    disabled: false,
    hidden: false,
    innerHTML: "",
    textContent: "",
    children: [],
    addEventListener(event, callback) {
      listeners.set(event, callback);
    },
    async dispatch(event) {
      const callback = listeners.get(event);
      if (callback) {
        await callback();
      }
    },
    append(...children) {
      this.children.push(...children);
    }
  };
}

function createFakeDocument(elements) {
  return {
    querySelector(selector) {
      if (!selector.startsWith("#")) {
        throw new Error(`Unsupported selector: ${selector}`);
      }
      return elements[selector.slice(1)];
    },
    createElement(tagName) {
      return createElement(tagName, tagName);
    }
  };
}

function createFakeChrome({ currentWindowId, undoAvailable, settings, tabs, tidyResponse, previewResponse }) {
  const state = {
    messages: [],
    tabQueries: [],
    permissionRequests: [],
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
      async sendMessage(message) {
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
      async query(queryInfo) {
        state.tabQueries.push(queryInfo);
        return windowTabs;
      }
    },
    permissions: {
      async request(request) {
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
  assert.equal(elements["tab-count"].textContent, "3 tabs");
  assert.equal(elements["undo-button"].hidden, false);

  await elements["tidy-button"].dispatch("click");
  assert.deepEqual(chrome.__state.messages.at(-1), {
    type: "TIDY_CURRENT_WINDOW",
    windowId: 42,
    grantedHintOrigins: []
  });
  assert.equal(elements["tidy-button"].disabled, false);
  assert.equal(elements.result.children.length, 2);
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
  assert.equal(elements.result.children.length, 2);
  assert.match(elements.result.children[1].children[0].innerHTML, /\+2/);
  assert.match(elements.result.children[1].children[0].innerHTML, /-&gt; Berlin &lt;Trip&gt;/);
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
  assert.match(elements.result.children[1].innerHTML, /Requested provider: <strong>Local Codex CLI<\/strong>/);
  assert.match(elements.result.children[1].innerHTML, /Actual provider: <strong>Local heuristic<\/strong>/);
  assert.match(elements.result.children[1].innerHTML, /Provider error: Bridge &lt;failed&gt; &amp; stopped/);
  assert.match(elements.result.children[2].children[0].innerHTML, /&lt;Unsafe Group&gt;/);
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
  assert.equal(elements.result.children[1].innerHTML, "AI provider: <strong>OpenAI API</strong>.");
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
      costUsd: 0.004321
    }
  });

  await elements["preview-button"].dispatch("click");
  assert.equal(elements.result.children[1].textContent, "Local Claude Code CLI · 1.3s · ~123 tokens · $0.0043");
  assert.equal(elements.result.children[1].innerHTML, "");
  assert.equal(elements.result.children[2].innerHTML, "AI provider: <strong>Local Claude Code CLI</strong>.");
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
    elements.result.textContent,
    "Native bridge is not allowed for this extension ID. Reinstall the native host."
  );
}

console.log("Popup tests passed.");
