import { DEFAULT_SETTINGS, getSettings, saveSettings } from "./lib/settings.js";
import { checkNativeCliStatus } from "./lib/native_cli_provider.js";
import {
  getAllProviderOrigins,
  getAllProviderPermissions,
  getProviderDataScope,
  getProviderOrigins,
  getProviderPermissions
} from "./lib/provider_metadata.js";

const form = document.querySelector("#settings-form");
const saveStatus = document.querySelector("#save-status");
const providerSelect = document.querySelector("#provider");
const includeFullUrlsInput = document.querySelector("#includeFullUrls");
const includePageHintsInput = document.querySelector("#includePageHints");
const dataMode = document.querySelector("#data-mode");
const dataSummary = document.querySelector("#data-summary");
const testNativeBridgeButton = document.querySelector("#test-native-bridge");
const nativeBridgeStatus = document.querySelector("#native-bridge-status");

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
    const settings = readFormSettings();
    await ensureProviderPermission(settings.provider);
    await saveSettings(settings);
    await removeUnusedProviderPermissions(settings.provider);
    updateDataScope(settings);
    setSaveStatus("Saved", false);
    window.setTimeout(() => {
      saveStatus.textContent = "";
    }, 1800);
  } catch (error) {
    setSaveStatus(error.message || String(error), true);
  }
});

async function initOptions() {
  const settings = await getSettings();
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
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

function updateProviderSections(provider) {
  for (const section of document.querySelectorAll("[data-provider-section]")) {
    section.hidden = section.dataset.providerSection !== provider &&
      !(section.dataset.providerSection === "local-cli" && isLocalCliProvider(provider));
  }
  setNativeBridgeStatus("", false);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function updateDataScope(settings = readCurrentScopeSettings()) {
  const scope = getProviderDataScope(settings);
  dataMode.textContent = scope.dataMode;
  dataSummary.textContent = scope.dataSummary;
}

function readFormSettings() {
  const formData = new FormData(form);
  return {
    provider: String(formData.get("provider") || DEFAULT_SETTINGS.provider),
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

function readCurrentScopeSettings() {
  return {
    provider: providerSelect.value || DEFAULT_SETTINGS.provider,
    includeFullUrls: includeFullUrlsInput.checked,
    includePageHints: includePageHintsInput ? includePageHintsInput.checked : false
  };
}

async function ensureProviderPermission(provider) {
  const origins = getProviderOrigins(provider);
  const permissions = getProviderPermissions(provider);
  if (origins.length === 0 && permissions.length === 0) {
    return;
  }

  if (!chrome.permissions?.request) {
    throw new Error("Chrome permission request API is unavailable.");
  }

  const request = {};
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
    const status = await checkNativeCliStatus(provider);
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
    setNativeBridgeStatus(nativeBridgeErrorMessage(error), true);
  } finally {
    testNativeBridgeButton.disabled = false;
  }
}

function nativeBridgeErrorMessage(error) {
  if (error?.providerErrorKind === "missing-native-permission") {
    return "Native Messaging permission is missing. Save this provider or grant permission.";
  }
  if (error?.providerErrorKind === "native-host-not-found") {
    return "Native bridge is not installed. Run npm run native:install.";
  }
  if (error?.providerErrorKind === "native-host-forbidden") {
    return "Native bridge is not allowed for this extension ID. Reinstall the native host.";
  }
  if (error?.providerErrorKind === "native-host-config-error") {
    return "Native bridge config is invalid. Reinstall the native host.";
  }
  return error?.message || "Native bridge check failed.";
}

function localCliLabel(provider) {
  if (provider === "local-codex-cli") {
    return "Codex CLI";
  }
  if (provider === "local-claude-cli") {
    return "Claude Code CLI";
  }
  return "Local CLI";
}

function isLocalCliProvider(provider) {
  return provider === "local-codex-cli" || provider === "local-claude-cli";
}

async function removeUnusedProviderPermissions(provider) {
  const neededOrigins = new Set(getProviderOrigins(provider));
  const neededPermissions = new Set(getProviderPermissions(provider));
  const removableOrigins = getAllProviderOrigins().filter((origin) => !neededOrigins.has(origin));
  const removablePermissions = getAllProviderPermissions().filter((permission) => !neededPermissions.has(permission));
  if ((removableOrigins.length === 0 && removablePermissions.length === 0) || !chrome.permissions?.remove) {
    return;
  }
  const request = {};
  if (removableOrigins.length > 0) {
    request.origins = removableOrigins;
  }
  if (removablePermissions.length > 0) {
    request.permissions = removablePermissions;
  }
  await chrome.permissions.remove(request);
}

function setSaveStatus(message, isError) {
  saveStatus.textContent = message;
  saveStatus.classList.toggle("error-text", Boolean(isError));
}

function setNativeBridgeStatus(message, isError) {
  if (!nativeBridgeStatus) {
    return;
  }
  nativeBridgeStatus.textContent = message;
  nativeBridgeStatus.classList.toggle("error-text", Boolean(isError));
}
