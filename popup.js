import { getAllProviderOrigins, getFriendlyProviderErrorMessage, getProviderLabel } from "./lib/provider_metadata.js";
import { pageHintPermissionPatternsForTabs, shouldUsePageHints } from "./lib/page_hints.js";
import { normalizeSettings } from "./lib/settings.js";
import { isGroupableTab } from "./lib/tabs.js";

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
    const grantedHintOrigins = await preparePageHintPermissions(currentWindow.id);
    const response = await chrome.runtime.sendMessage({
      type: "TIDY_CURRENT_WINDOW",
      windowId: currentWindow.id,
      grantedHintOrigins
    });

    if (!response?.ok) {
      updateUndoButton(Boolean(response?.undoAvailable));
      throw createResponseError(response, "Unable to tidy tabs.");
    }

    renderResult(response);
    updateUndoButton(Boolean(response.undoAvailable));
  } catch (error) {
    renderError(getFriendlyProviderErrorMessage(error));
  } finally {
    setBusy(false);
  }
});

previewButton.addEventListener("click", async () => {
  setBusy(true, "preview");
  renderMessage("Planning current window...");

  try {
    const currentWindow = await chrome.windows.getCurrent();
    const grantedHintOrigins = await preparePageHintPermissions(currentWindow.id);
    const response = await chrome.runtime.sendMessage({
      type: "PREVIEW_CURRENT_WINDOW",
      windowId: currentWindow.id,
      grantedHintOrigins
    });

    if (!response?.ok) {
      throw createResponseError(response, "Unable to preview tabs.");
    }

    renderResult(response);
  } catch (error) {
    renderError(getFriendlyProviderErrorMessage(error));
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
      throw createResponseError(response, "Unable to undo last tidy.");
    }
    updateUndoButton(Boolean(response.undoAvailable));
    renderMessage(response.message || "Undone.");
  } catch (error) {
    renderError(getFriendlyProviderErrorMessage(error));
  } finally {
    setBusy(false);
  }
});

async function preparePageHintPermissions(windowId) {
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS", windowId });
  const settings = normalizeSettings(status?.settings);
  if (!shouldUsePageHints(settings) || !chrome.permissions?.request) {
    return [];
  }

  const tabs = await chrome.tabs.query({ windowId });
  const groupableTabs = tabs.filter((tab) => isGroupableTab(tab, settings));
  const providerOrigins = new Set(getAllProviderOrigins());
  const origins = pageHintPermissionPatternsForTabs(groupableTabs)
    .filter((origin) => !providerOrigins.has(origin));
  if (origins.length === 0) {
    return [];
  }

  const granted = await chrome.permissions.request({
    permissions: ["scripting"],
    origins
  });
  if (!granted) {
    renderMessage("Tidying current window without page hints...");
    return [];
  }
  return origins;
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
  result.className = "result";
  result.innerHTML = "";
  const title = document.createElement("p");
  title.className = "result-title";
  title.textContent = response.message || "No groups created.";
  result.append(title);
  appendProviderMetrics(response);
  appendProviderDetails(response);

  if (!response.groups?.length && !response.assignments?.length) {
    return;
  }

  const list = document.createElement("ul");
  list.className = "group-list";
  for (const group of response.groups || []) {
    const item = document.createElement("li");
    item.innerHTML = `<span class="swatch swatch-${group.color}"></span><span>${escapeHtml(group.name)}</span><strong>${group.count}</strong>`;
    list.append(item);
  }
  for (const assignment of response.assignments || []) {
    const item = document.createElement("li");
    item.innerHTML = `<span class="assignment-marker">+${assignment.count}</span><span>-&gt; ${escapeHtml(assignment.title || `Group ${assignment.groupId}`)}</span>`;
    list.append(item);
  }
  result.append(list);
}

function appendProviderMetrics(response) {
  const metricsText = buildProviderMetricsText(response);
  if (!metricsText) {
    return;
  }
  const metrics = document.createElement("p");
  metrics.className = "provider-details";
  metrics.textContent = metricsText;
  result.append(metrics);
}

function buildProviderMetricsText(response) {
  const durationMs = Number(response.durationMs);
  if (!Number.isFinite(durationMs)) {
    return "";
  }

  const parts = [
    getProviderLabel(response.provider || "heuristic"),
    `${(durationMs / 1000).toFixed(1)}s`
  ];
  const inputTokens = Number(response.inputTokens);
  const outputTokens = Number(response.outputTokens);
  if (Number.isFinite(inputTokens) || Number.isFinite(outputTokens)) {
    parts.push(`~${(Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0)} tokens`);
  }
  const costUsd = Number(response.costUsd);
  if (Number.isFinite(costUsd)) {
    parts.push(`$${costUsd.toFixed(4)}`);
  }
  return parts.join(" · ");
}

function appendProviderDetails(response) {
  const detailsHtml = buildProviderDetailsHtml(response);
  if (!detailsHtml) {
    return;
  }
  const details = document.createElement("p");
  details.className = "provider-details";
  details.innerHTML = detailsHtml;
  result.append(details);
}

function buildProviderDetailsHtml(response) {
  if (response.usedFallback) {
    const requestedProvider = getProviderLabel(response.requestedProvider || response.provider);
    const actualProvider = getProviderLabel(response.provider || "heuristic");
    const providerError = response.providerError || "No provider error message was returned.";
    return [
      `Requested provider: <strong>${escapeHtml(requestedProvider)}</strong>.`,
      `Actual provider: <strong>${escapeHtml(actualProvider)}</strong>.`,
      `Provider error: ${escapeHtml(providerError)}`
    ].join(" ");
  }

  if (response.provider && response.provider !== "heuristic") {
    return `AI provider: <strong>${escapeHtml(getProviderLabel(response.provider))}</strong>.`;
  }

  return "";
}

function updateUndoButton(isAvailable) {
  undoButton.hidden = !isAvailable;
}

function createResponseError(response, fallbackMessage) {
  const error = new Error(response?.error || fallbackMessage);
  error.providerErrorKind = response?.providerErrorKind || "";
  return error;
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
