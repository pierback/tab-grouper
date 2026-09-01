import { getAllProviderOrigins, getFriendlyProviderErrorMessage, getProviderLabel } from "./lib/provider_metadata.js";
import { pageHintPermissionPatternsForTabs, shouldUsePageHints } from "./lib/page_hints.js";
import { normalizeSettings } from "./lib/settings.js";
import { isGroupableTab } from "./lib/tabs.js";
import type { PopupResponse, ProviderError, Settings } from "./lib/types.js";

const tidyButton = document.querySelector<HTMLButtonElement>("#tidy-button")!;
const result = document.querySelector<HTMLElement>("#result")!;
const providerLabel = document.querySelector<HTMLElement>("#provider-label")!;
const providerMeta = document.querySelector<HTMLElement>("#provider-meta")!;
const tabCount = document.querySelector<HTMLElement>("#tab-count")!;
const autoTidyStatus = document.querySelector<HTMLElement>("#auto-tidy-status")!;
const optionsButton = document.querySelector<HTMLButtonElement>("#open-options")!;
const previewButton = document.querySelector<HTMLButtonElement>("#preview-button")!;
const undoButton = document.querySelector<HTMLButtonElement>("#undo-button")!;

interface RunProgressController {
  setMessage(message: string): void;
  stop(): number;
}

let activeRunProgress: RunProgressController | undefined;

initPopup();

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

tidyButton.addEventListener("click", async () => {
  setBusy(true, "tidy");
  const progress = startRunProgress("Tidying current window");

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

    renderResult(response, progress.stop());
    updateUndoButton(Boolean(response.undoAvailable));
  } catch (error) {
    renderError(getFriendlyProviderErrorMessage(error), progress.stop());
  } finally {
    progress.stop();
    setBusy(false);
  }
});

previewButton.addEventListener("click", async () => {
  setBusy(true, "preview");
  const progress = startRunProgress("Planning current window");

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

    renderResult(response, progress.stop());
  } catch (error) {
    renderError(getFriendlyProviderErrorMessage(error), progress.stop());
  } finally {
    progress.stop();
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

async function preparePageHintPermissions(windowId: number | undefined): Promise<string[]> {
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS", windowId });
  const settings = normalizeSettings(status?.settings);
  if (!shouldUsePageHints(settings) || !chrome.permissions?.request) {
    return [];
  }

  const tabs = await chrome.tabs.query({ windowId });
  const groupableTabs = tabs.filter((tab) => isGroupableTab(tab, settings));
  const providerOrigins = new Set<string>(getAllProviderOrigins());
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
    activeRunProgress?.setMessage("Continuing without page hints");
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

    const settings = normalizeSettings(status?.settings);
    providerLabel.textContent = getProviderLabel(settings.provider);
    providerMeta.textContent = getProviderConfiguration(settings);
    tabCount.textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
    autoTidyStatus.textContent = settings.autoTidyEnabled
      ? `Every ${formatMinuteInterval(settings.autoTidyIntervalMinutes)}`
      : "Off";
    updateUndoButton(Boolean(status?.undoAvailable));
  } catch (error) {
    providerLabel.textContent = "Unavailable";
    providerMeta.textContent = "";
    tabCount.textContent = "-";
    autoTidyStatus.textContent = "-";
    renderError(error instanceof Error ? error.message : String(error));
  }
}

function setBusy(isBusy: boolean, action = "tidy"): void {
  tidyButton.disabled = isBusy;
  previewButton.disabled = isBusy;
  undoButton.disabled = isBusy;
  tidyButton.textContent = isBusy && action === "tidy" ? "Tidying..." : "Tidy tabs";
  previewButton.textContent = isBusy && action === "preview" ? "Planning..." : "Preview plan";
  undoButton.textContent = isBusy && action === "undo" ? "Undoing..." : "Undo last tidy";
}

function renderResult(response: PopupResponse, elapsedMs: number): void {
  result.className = "result";
  result.replaceChildren();
  const title = document.createElement("p");
  title.className = "result-title";
  title.textContent = response.message || "No groups created.";
  result.append(title);
  appendRunStats(response, elapsedMs);
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

function appendRunStats(response: PopupResponse, elapsedMs: number): void {
  const stats = document.createElement("div");
  stats.className = "run-stats";

  const providerDuration = finiteNonNegativeNumber(response.durationMs);
  stats.append(createRunStat(
    "Elapsed",
    formatDuration(elapsedMs),
    providerDuration === undefined ? "Wall clock" : `${formatDuration(providerDuration)} provider`
  ));

  const inputTokens = finiteNonNegativeNumber(response.inputTokens);
  const outputTokens = finiteNonNegativeNumber(response.outputTokens);
  const hasTokens = inputTokens !== undefined || outputTokens !== undefined;
  stats.append(createRunStat(
    "Tokens",
    hasTokens ? formatInteger((inputTokens || 0) + (outputTokens || 0)) : "—",
    hasTokens ? `${formatInteger(inputTokens || 0)} in · ${formatInteger(outputTokens || 0)} out` : "Not reported"
  ));

  const costUsd = finiteNonNegativeNumber(response.costUsd);
  const isEstimate = response.costBasis === "api-estimate";
  stats.append(createRunStat(
    isEstimate ? "Est. cost" : "Cost",
    costUsd === undefined ? "—" : `${isEstimate ? "~" : ""}${formatUsd(costUsd)}`,
    costUsd === undefined ? "Not available" : isEstimate ? "API equivalent" : "Provider reported"
  ));

  result.append(stats);
}

function createRunStat(label: string, value: string, detail: string): HTMLElement {
  const stat = document.createElement("div");
  stat.className = "run-stat";
  const statLabel = document.createElement("span");
  statLabel.className = "run-stat-label";
  statLabel.textContent = label;
  const statValue = document.createElement("strong");
  statValue.className = "run-stat-value";
  statValue.textContent = value;
  const statDetail = document.createElement("span");
  statDetail.className = "run-stat-detail";
  statDetail.textContent = detail;
  stat.append(statLabel, statValue, statDetail);
  return stat;
}

function appendProviderDetails(response: PopupResponse): void {
  const detailsHtml = buildProviderDetailsHtml(response);
  if (!detailsHtml) {
    return;
  }
  const details = document.createElement("p");
  details.className = "provider-details";
  details.innerHTML = detailsHtml;
  result.append(details);
}

function buildProviderDetailsHtml(response: PopupResponse): string {
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

function updateUndoButton(isAvailable: boolean): void {
  undoButton.hidden = !isAvailable;
}

function createResponseError(response: PopupResponse | undefined, fallbackMessage: string): ProviderError {
  const error: ProviderError = new Error(response?.error || fallbackMessage);
  error.providerErrorKind = (response?.providerErrorKind || "") as ProviderError["providerErrorKind"];
  return error;
}

function renderMessage(message: string): void {
  result.className = "result";
  result.textContent = message;
}

function renderError(message: string, elapsedMs?: number): void {
  result.className = "result error";
  result.replaceChildren();
  const errorMessage = document.createElement("p");
  errorMessage.className = "error-message";
  errorMessage.textContent = message;
  result.append(errorMessage);
  if (elapsedMs !== undefined) {
    appendRunStats({ ok: false }, elapsedMs);
  }
}

function startRunProgress(message: string): RunProgressController {
  const startedAt = nowMs();
  let stoppedAt: number | undefined;
  result.className = "result running";
  result.replaceChildren();

  const progress = document.createElement("div");
  progress.className = "run-progress";
  const copy = document.createElement("span");
  copy.className = "run-progress-copy";
  copy.textContent = message;
  const clock = document.createElement("strong");
  clock.className = "run-clock";
  clock.textContent = formatDuration(0);
  clock.setAttribute("aria-hidden", "true");
  progress.append(copy, clock);
  result.append(progress);

  const timer = globalThis.setInterval(() => {
    clock.textContent = formatDuration(nowMs() - startedAt);
  }, 100);

  const controller: RunProgressController = {
    setMessage(nextMessage) {
      copy.textContent = nextMessage;
    },
    stop() {
      if (stoppedAt === undefined) {
        stoppedAt = nowMs();
        globalThis.clearInterval(timer);
        if (activeRunProgress === controller) {
          activeRunProgress = undefined;
        }
      }
      return Math.max(0, stoppedAt - startedAt);
    }
  };
  activeRunProgress?.stop();
  activeRunProgress = controller;
  return controller;
}

function getProviderConfiguration(settings: Settings): string {
  switch (settings.provider) {
    case "local-codex-cli":
      return `${settings.codexCliModel || "CLI default model"} · ${formatReasoning(settings.codexReasoningEffort)}`;
    case "local-claude-cli":
      return `${settings.claudeCliModel || "CLI default model"} · ${formatReasoning(settings.claudeReasoningEffort)}`;
    case "openai":
      return `${settings.openaiModel} · Default reasoning`;
    case "anthropic":
      return `${settings.anthropicModel} · Default reasoning`;
    case "chrome-ai":
      return "Browser model · Default reasoning";
    default:
      return "No model · No reasoning";
  }
}

function formatReasoning(reasoning: string): string {
  if (!reasoning) {
    return "Default reasoning";
  }
  return `${reasoning.charAt(0).toUpperCase()}${reasoning.slice(1)} reasoning`;
}

function formatMinuteInterval(minutes: number): string {
  if (minutes === 60) {
    return "hour";
  }
  if (minutes > 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hours`;
  }
  return `${minutes} min`;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds < 0.05) {
    return "<0.1s";
  }
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatUsd(value: number): string {
  if (value === 0) {
    return "$0.0000";
  }
  if (value < 0.0001) {
    return `$${value.toFixed(6)}`;
  }
  if (value < 1) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
