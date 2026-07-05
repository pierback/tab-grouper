import { getProviderLabel } from "./lib/provider_metadata.js";
import { pageHintPermissionPatternsForTabs, shouldUsePageHints } from "./lib/page_hints.js";

const tidyButton = document.querySelector("#tidy-button");
const result = document.querySelector("#result");
const providerLabel = document.querySelector("#provider-label");
const tabCount = document.querySelector("#tab-count");
const optionsButton = document.querySelector("#open-options");
const previewButton = document.querySelector("#preview-button");
const undoButton = document.querySelector("#undo-button");

initPopup();

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

tidyButton.addEventListener("click", async () => {
  setBusy(true, "tidy");
  renderMessage("Tidying current window...");

  try {
    const currentWindow = await chrome.windows.getCurrent();
    await preparePageHintPermissions(currentWindow.id);
    const response = await chrome.runtime.sendMessage({
      type: "TIDY_CURRENT_WINDOW",
      windowId: currentWindow.id
    });

    if (!response?.ok) {
      updateUndoButton(Boolean(response?.undoAvailable));
      throw new Error(response?.error || "Unable to tidy tabs.");
    }

    renderResult(response);
    updateUndoButton(Boolean(response.undoAvailable));
  } catch (error) {
    renderError(error.message || String(error));
  } finally {
    setBusy(false);
  }
});

previewButton.addEventListener("click", async () => {
  setBusy(true, "preview");
  renderMessage("Planning current window...");

  try {
    const currentWindow = await chrome.windows.getCurrent();
    await preparePageHintPermissions(currentWindow.id);
    const response = await chrome.runtime.sendMessage({
      type: "PREVIEW_CURRENT_WINDOW",
      windowId: currentWindow.id
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unable to preview tabs.");
    }

    renderResult(response);
  } catch (error) {
    renderError(error.message || String(error));
  } finally {
    setBusy(false);
  }
});

undoButton.addEventListener("click", async () => {
  setBusy(true, "undo");
  renderMessage("Undoing last tidy...");

  try {
    const currentWindow = await chrome.windows.getCurrent();
    const response = await chrome.runtime.sendMessage({
      type: "UNDO_LAST_TIDY",
      windowId: currentWindow.id
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to undo last tidy.");
    }
    updateUndoButton(Boolean(response.undoAvailable));
    renderMessage(response.message || "Undone.");
  } catch (error) {
    renderError(error.message || String(error));
  } finally {
    setBusy(false);
  }
});

async function preparePageHintPermissions(windowId) {
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS", windowId });
  if (!shouldUsePageHints(status?.settings) || !chrome.permissions?.request) {
    return;
  }

  const tabs = await chrome.tabs.query({ windowId });
  const origins = pageHintPermissionPatternsForTabs(tabs);
  if (origins.length === 0) {
    return;
  }

  const granted = await chrome.permissions.request({
    permissions: ["scripting"],
    origins
  });
  if (!granted) {
    renderMessage("Tidying current window without page hints...");
  }
}

async function initPopup() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const [status, tabs] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_STATUS", windowId: currentWindow.id }),
      chrome.tabs.query({ windowId: currentWindow.id })
    ]);

    providerLabel.textContent = getProviderLabel(status?.settings?.provider || "unknown");
    tabCount.textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
    updateUndoButton(Boolean(status?.undoAvailable));
  } catch (error) {
    providerLabel.textContent = "Unavailable";
    tabCount.textContent = "-";
    renderError(error.message || String(error));
  }
}

function setBusy(isBusy, action = "tidy") {
  tidyButton.disabled = isBusy;
  previewButton.disabled = isBusy;
  undoButton.disabled = isBusy;
  tidyButton.textContent = isBusy && action === "tidy" ? "Tidying..." : "Tidy tabs";
  previewButton.textContent = isBusy && action === "preview" ? "Planning..." : "Preview plan";
  undoButton.textContent = isBusy && action === "undo" ? "Undoing..." : "Undo last tidy";
}

function renderResult(response) {
  if (!response.groups?.length) {
    renderMessage(response.message || "No groups created.");
    return;
  }

  result.className = "result";
  result.innerHTML = "";
  const title = document.createElement("p");
  title.className = "result-title";
  title.textContent = response.message;
  result.append(title);

  const list = document.createElement("ul");
  list.className = "group-list";
  for (const group of response.groups) {
    const item = document.createElement("li");
    item.innerHTML = `<span class="swatch swatch-${group.color}"></span><span>${escapeHtml(group.name)}</span><strong>${group.count}</strong>`;
    list.append(item);
  }
  result.append(list);
}

function updateUndoButton(isAvailable) {
  undoButton.hidden = !isAvailable;
}

function renderMessage(message) {
  result.className = "result";
  result.textContent = message;
}

function renderError(message) {
  result.className = "result error";
  result.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
