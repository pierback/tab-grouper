import { DEFAULT_SETTINGS, getSettings, normalizeSettings, saveSettings } from "./lib/settings.js";
import { checkNativeCliStatus } from "./lib/native_cli_provider.js";
import {
  getAllProviderOrigins,
  getAllProviderPermissions,
  getFriendlyProviderErrorMessage,
  getProviderDataScope,
  getProviderOrigins,
  getProviderPermissions
} from "./lib/provider_metadata.js";
import type { PartialSettings, Provider, Settings } from "./lib/types.js";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const saveStatus = document.querySelector<HTMLElement>("#save-status")!;
const providerSelect = document.querySelector<HTMLSelectElement>("#provider")!;
const includeFullUrlsInput = document.querySelector<HTMLInputElement>("#includeFullUrls")!;
const includePageHintsInput = document.querySelector<HTMLInputElement>("#includePageHints")!;
const dataMode = document.querySelector<HTMLElement>("#data-mode")!;
const dataSummary = document.querySelector<HTMLElement>("#data-summary")!;
const testNativeBridgeButton = document.querySelector<HTMLButtonElement>("#test-native-bridge")!;
const nativeBridgeStatus = document.querySelector<HTMLElement>("#native-bridge-status")!;

initOptions();

providerSelect.addEventListener("change", () => {
  updateProviderSections(providerSelect.value);
  updateDataScope();
});

includeFullUrlsInput.addEventListener("change", () => {
  updateDataScope();
});

includePageHintsInput?.addEventListener("change", () => {
  updateDataScope();
});

testNativeBridgeButton?.addEventListener("click", async () => {
  await testNativeBridge();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSaveStatus("Saving...", false);

  try {
    const settings = normalizeSettings(readFormSettings());
    await ensureProviderPermission(settings.provider);
    await saveSettings(settings);
    await removeUnusedProviderPermissions(settings.provider);
    updateDataScope(settings);
    setSaveStatus("Saved", false);
    window.setTimeout(() => {
      saveStatus.textContent = "";
    }, 1800);
  } catch (error) {
    setSaveStatus(error instanceof Error ? error.message : String(error), true);
  }
});

async function initOptions() {
  const settings = await getSettings();
  for (const [key, value] of Object.entries(settings)) {
    const input = ((form.elements as any)[key] || form.elements.namedItem?.(key)) as HTMLInputElement | HTMLSelectElement | null;
    if (!input) {
      continue;
    }
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = value;
    }
  }
  updateProviderSections(settings.provider);
  updateDataScope(settings);
}

function updateProviderSections(provider: string): void {
  for (const section of document.querySelectorAll("[data-provider-section]")) {
    const providerSection = section as HTMLElement;
    providerSection.hidden = providerSection.dataset.providerSection !== provider &&
      !(providerSection.dataset.providerSection === "local-cli" && isLocalCliProvider(provider));
  }
  setNativeBridgeStatus("", false);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function updateDataScope(settings = readCurrentScopeSettings()): void {
  const scope = getProviderDataScope(settings);
  dataMode.textContent = scope.dataMode;
  dataSummary.textContent = scope.dataSummary;
}

function readFormSettings(): PartialSettings {
  const formData = new FormData(form);
  return {
    provider: String(formData.get("provider") || DEFAULT_SETTINGS.provider) as Provider,
    openaiApiKey: String(formData.get("openaiApiKey") || ""),
    openaiModel: String(formData.get("openaiModel") || DEFAULT_SETTINGS.openaiModel).trim(),
    anthropicApiKey: String(formData.get("anthropicApiKey") || ""),
    anthropicModel: String(formData.get("anthropicModel") || DEFAULT_SETTINGS.anthropicModel).trim(),
    codexCliModel: String(formData.get("codexCliModel") || "").trim(),
    claudeCliModel: String(formData.get("claudeCliModel") || "").trim(),
    includeFullUrls: formData.get("includeFullUrls") === "on",
    includePageHints: includePageHintsInput ? formData.get("includePageHints") === "on" : false,
    allowHeuristicFallback: formData.get("allowHeuristicFallback") === "on",
    ignorePinnedTabs: formData.get("ignorePinnedTabs") === "on",
    keepExistingGroups: formData.get("keepExistingGroups") === "on",
    collapseGroups: formData.get("collapseGroups") === "on",
    minimumGroupSize: clampNumber(formData.get("minimumGroupSize"), 2, 10, 2)
  };
}

function readCurrentScopeSettings(): Pick<Settings, "provider" | "includeFullUrls" | "includePageHints"> {
  return {
    provider: (providerSelect.value || DEFAULT_SETTINGS.provider) as Provider,
    includeFullUrls: includeFullUrlsInput.checked,
    includePageHints: includePageHintsInput ? includePageHintsInput.checked : false
  };
}

async function ensureProviderPermission(provider: string): Promise<void> {
  const origins = getProviderOrigins(provider);
  const permissions = getProviderPermissions(provider);
  if (origins.length === 0 && permissions.length === 0) {
    return;
  }

  if (!chrome.permissions?.request) {
    throw new Error("Chrome permission request API is unavailable.");
  }

  const request: chrome.permissions.Permissions = {};
  if (origins.length > 0) {
    request.origins = origins;
  }
  if (permissions.length > 0) {
    request.permissions = permissions;
  }

  const granted = await chrome.permissions.request(request);
  if (!granted) {
    throw new Error("Provider permission was not granted. Choose Local heuristic or grant provider access.");
  }
}

async function testNativeBridge() {
  const provider = providerSelect.value || DEFAULT_SETTINGS.provider;
  if (!isLocalCliProvider(provider)) {
    setNativeBridgeStatus("Choose a local CLI provider first.", true);
    return;
  }

  testNativeBridgeButton.disabled = true;
  setNativeBridgeStatus("Checking...", false);
  try {
    await ensureProviderPermission(provider);
    const status = await checkNativeCliStatus(provider as Provider);
    if (status.configured && status.executableAvailable && status.authenticated) {
      setNativeBridgeStatus(`${localCliLabel(provider)} bridge is ready.`, false);
      return;
    }
    if (!status.configured) {
      setNativeBridgeStatus(`${localCliLabel(provider)} path is not configured. Reinstall the native host.`, true);
      return;
    }
    if (!status.executableAvailable) {
      setNativeBridgeStatus(`${localCliLabel(provider)} path is configured but not executable. Reinstall the native host.`, true);
      return;
    }
    if (status.authChecked && !status.authenticated) {
      setNativeBridgeStatus(`${localCliLabel(provider)} is installed but not signed in.`, true);
      return;
    }
    if (!status.authChecked) {
      setNativeBridgeStatus(`${localCliLabel(provider)} path is ready, but sign-in could not be verified.`, true);
      return;
    }
    setNativeBridgeStatus(`${localCliLabel(provider)} bridge is not ready.`, true);
  } catch (error) {
    setNativeBridgeStatus(getFriendlyProviderErrorMessage(error), true);
  } finally {
    testNativeBridgeButton.disabled = false;
  }
}

function localCliLabel(provider: string): string {
  if (provider === "local-codex-cli") {
    return "Codex CLI";
  }
  if (provider === "local-claude-cli") {
    return "Claude Code CLI";
  }
  return "Local CLI";
}

function isLocalCliProvider(provider: string): boolean {
  return provider === "local-codex-cli" || provider === "local-claude-cli";
}

async function removeUnusedProviderPermissions(provider: string): Promise<void> {
  const neededOrigins = new Set(getProviderOrigins(provider));
  const neededPermissions = new Set(getProviderPermissions(provider));
  const removableOrigins = getAllProviderOrigins().filter((origin) => !neededOrigins.has(origin));
  const removablePermissions = getAllProviderPermissions().filter((permission) => !neededPermissions.has(permission));
  if ((removableOrigins.length === 0 && removablePermissions.length === 0) || !chrome.permissions?.remove) {
    return;
  }
  const request: chrome.permissions.Permissions = {};
  if (removableOrigins.length > 0) {
    request.origins = removableOrigins;
  }
  if (removablePermissions.length > 0) {
    request.permissions = removablePermissions;
  }
  await chrome.permissions.remove(request);
}

function setSaveStatus(message: string, isError: boolean): void {
  saveStatus.textContent = message;
  saveStatus.classList.toggle("error-text", Boolean(isError));
}

function setNativeBridgeStatus(message: string, isError: boolean): void {
  if (!nativeBridgeStatus) {
    return;
  }
  nativeBridgeStatus.textContent = message;
  nativeBridgeStatus.classList.toggle("error-text", Boolean(isError));
}
