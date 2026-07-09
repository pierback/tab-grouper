import { DEFAULT_SETTINGS, getSettings, normalizeSettings, saveSettings } from "./lib/settings.js";
import { checkNativeCliStatus, listNativeModels } from "./lib/native_cli_provider.js";
import {
  getAllProviderOrigins,
  getAllProviderPermissions,
  getFriendlyProviderErrorMessage,
  getProviderDataScope,
  getProviderOrigins,
  getProviderPermissions
} from "./lib/provider_metadata.js";
import type { NativeModelInfo, PartialSettings, Provider, Settings } from "./lib/types.js";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const saveStatus = document.querySelector<HTMLElement>("#save-status")!;
const providerSelect = document.querySelector<HTMLSelectElement>("#provider")!;
const includeFullUrlsInput = document.querySelector<HTMLInputElement>("#includeFullUrls")!;
const includePageHintsInput = document.querySelector<HTMLInputElement>("#includePageHints")!;
const dataMode = document.querySelector<HTMLElement>("#data-mode")!;
const dataSummary = document.querySelector<HTMLElement>("#data-summary")!;
const testNativeBridgeButton = document.querySelector<HTMLButtonElement>("#test-native-bridge")!;
const nativeBridgeStatus = document.querySelector<HTMLElement>("#native-bridge-status")!;
const modelSelect = document.querySelector<HTMLSelectElement>("#model")!;

const CLAUDE_MODEL_OPTIONS: NativeModelInfo[] = [
  { slug: "claude-fable-5", displayName: "Fable 5" },
  { slug: "claude-opus-4-8", displayName: "Opus 4.8" },
  { slug: "claude-sonnet-5", displayName: "Sonnet 5" },
  { slug: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" }
];

let currentSettings: Settings = DEFAULT_SETTINGS;
let modelLoadSequence = 0;

initOptions();

providerSelect.addEventListener("change", async () => {
  const provider = providerSelect.value;
  updateProviderSections(provider);
  await populateModelSelect(provider, currentSettings, true);
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
    currentSettings = settings;
    await removeUnusedProviderPermissions(settings.provider);
    await populateModelSelect(settings.provider, settings, false);
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
  currentSettings = settings;
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
  await populateModelSelect(settings.provider, settings, false);
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
  const provider = String(formData.get("provider") || DEFAULT_SETTINGS.provider) as Provider;
  const localCliModel = String(modelSelect.value || "").trim();
  return {
    provider,
    openaiApiKey: String(formData.get("openaiApiKey") || ""),
    openaiModel: String(formData.get("openaiModel") || DEFAULT_SETTINGS.openaiModel).trim(),
    anthropicApiKey: String(formData.get("anthropicApiKey") || ""),
    anthropicModel: String(formData.get("anthropicModel") || DEFAULT_SETTINGS.anthropicModel).trim(),
    codexCliModel: provider === "local-codex-cli" ? localCliModel : currentSettings.codexCliModel,
    claudeCliModel: provider === "local-claude-cli" ? localCliModel : currentSettings.claudeCliModel,
    includeFullUrls: formData.get("includeFullUrls") === "on",
    includePageHints: includePageHintsInput ? formData.get("includePageHints") === "on" : false,
    allowHeuristicFallback: formData.get("allowHeuristicFallback") === "on",
    ignorePinnedTabs: formData.get("ignorePinnedTabs") === "on",
    keepExistingGroups: formData.get("keepExistingGroups") === "on",
    collapseGroups: formData.get("collapseGroups") === "on",
    minimumGroupSize: clampNumber(formData.get("minimumGroupSize"), 2, 10, 2)
  };
}

async function populateModelSelect(provider: string, settings: Settings, allowPermissionRequest = false): Promise<void> {
  const sequence = ++modelLoadSequence;
  if (!isLocalCliProvider(provider)) {
    replaceModelOptions("Use CLI default", [], "");
    modelSelect.disabled = false;
    return;
  }

  if (provider === "local-claude-cli") {
    replaceModelOptions("Use claude CLI's own default", CLAUDE_MODEL_OPTIONS, settings.claudeCliModel);
    modelSelect.disabled = false;
    return;
  }

  replaceModelOptions("Use codex CLI's own default", [], settings.codexCliModel, "Loading Codex models...");
  modelSelect.disabled = true;
  setNativeBridgeStatus("Loading Codex models...", false);
  if (allowPermissionRequest) {
    try {
      await ensureProviderPermission(provider);
      if (sequence !== modelLoadSequence) {
        return;
      }
    } catch {
      if (sequence === modelLoadSequence) {
        replaceModelOptions("Use codex CLI's own default", [], "");
        setNativeBridgeStatus("Grant native messaging access to load Codex models.", false);
        modelSelect.disabled = false;
      }
      return;
    }
  } else if (!(await hasNativeMessagingPermission())) {
    if (sequence !== modelLoadSequence) {
      return;
    }
    replaceModelOptions("Use codex CLI's own default", [], "");
    setNativeBridgeStatus("Select this provider again or Save to load Codex models.", false);
    modelSelect.disabled = false;
    return;
  }

  try {
    const models = await listNativeModels("codex");
    if (sequence !== modelLoadSequence) {
      return;
    }
    replaceModelOptions("Use codex CLI's own default", models, settings.codexCliModel);
    setNativeBridgeStatus("", false);
  } catch (error) {
    if (sequence !== modelLoadSequence) {
      return;
    }
    replaceModelOptions("Use codex CLI's own default", [], "");
    setNativeBridgeStatus(getFriendlyProviderErrorMessage(error), true);
  } finally {
    if (sequence === modelLoadSequence) {
      modelSelect.disabled = false;
    }
  }
}

function replaceModelOptions(defaultLabel: string, models: NativeModelInfo[], selectedValue: string, loadingLabel = ""): void {
  modelSelect.replaceChildren();
  modelSelect.appendChild(createModelOption("", defaultLabel));
  if (loadingLabel) {
    const loadingOption = createModelOption("", loadingLabel);
    loadingOption.disabled = true;
    modelSelect.appendChild(loadingOption);
  }
  for (const model of models) {
    modelSelect.appendChild(createModelOption(model.slug, model.displayName || model.slug));
  }

  const allowedValues = new Set(models.map((model) => model.slug));
  modelSelect.value = selectedValue && allowedValues.has(selectedValue) ? selectedValue : "";
}

function createModelOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
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

async function hasNativeMessagingPermission(): Promise<boolean> {
  if (!chrome.permissions?.contains) {
    return false;
  }
  return chrome.permissions.contains({ permissions: ["nativeMessaging"] });
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
