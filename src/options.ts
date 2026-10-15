import { DEFAULT_SETTINGS, getSettings, normalizeSettings, saveSettings } from "./lib/settings.js";
import {
  checkNativeCliStatus,
  listNativeModels,
  signInSeparateCodexAccount,
  signOutSeparateCodexAccount
} from "./lib/native_cli_provider.js";
import type { NativeCliStatus } from "./lib/native_cli_provider.js";
import {
  formatCliAccountPlan,
  getAllProviderOrigins,
  getAllProviderPermissions,
  getFriendlyProviderErrorMessage,
  getLocalCliLabel,
  getProviderDataScope,
  getProviderOrigins,
  getProviderPermissions,
  isLocalCliProvider
} from "./lib/provider_metadata.js";
import { isGeckoExtensionRuntime } from "./lib/platform.js";
import { getZenFoldersApi, resolveGroupTarget } from "./lib/zen_folders.js";
import type { NativeModelInfo, PartialSettings, Provider, ProviderError, Settings } from "./lib/types.js";

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
const reasoningSelect = document.querySelector<HTMLSelectElement>("#reasoning")!;
const autoTidyEnabledInput = document.querySelector<HTMLInputElement>("#autoTidyEnabled")!;
const autoTidyIntervalInput = document.querySelector<HTMLInputElement>("#autoTidyIntervalMinutes")!;
const providerTimeoutInput = document.querySelector<HTMLInputElement>("#providerRequestTimeoutSeconds")!;
const groupTargetField = document.querySelector<HTMLElement>("#group-target-field");
const groupTargetSelect = document.querySelector<HTMLSelectElement>("#groupTarget");
const chromeAiProviderOption = document.querySelector<HTMLOptionElement>("#provider-chrome-ai");
const zenFoldersAvailable = getZenFoldersApi() !== null;
const cliAccount = document.querySelector<HTMLElement>("#cli-account");
const cliAccountTitle = document.querySelector<HTMLElement>("#cli-account-title");
const cliAccountDetail = document.querySelector<HTMLElement>("#cli-account-detail");
const cliSetup = document.querySelector<HTMLElement>("#cli-setup");
const cliSetupCommand = document.querySelector<HTMLElement>("#cli-setup-command");
const codexAccountRow = document.querySelector<HTMLElement>("#codex-account-row");
const codexAccountSelect = document.querySelector<HTMLSelectElement>("#codexAccount");
const cliSignInButton = document.querySelector<HTMLButtonElement>("#cli-sign-in");
const cliSignOutButton = document.querySelector<HTMLButtonElement>("#cli-sign-out");

type CliAccountState =
  | { kind: "checking" }
  | { kind: "signing-in" }
  | { kind: "needs-permission" }
  | { kind: "status"; status: NativeCliStatus }
  | { kind: "error"; error: unknown };

const CLAUDE_MODEL_OPTIONS: NativeModelInfo[] = [
  { slug: "claude-fable-5", displayName: "Fable 5" },
  { slug: "claude-opus-4-8", displayName: "Opus 4.8" },
  { slug: "claude-sonnet-5", displayName: "Sonnet 5" },
  { slug: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" }
];
const CODEX_REASONING_LEVELS = ["low", "medium", "high", "xhigh"];
const CLAUDE_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"];

let savedSettings: Settings = DEFAULT_SETTINGS;
let draftSettings: Settings = DEFAULT_SETTINGS;
let codexModels: NativeModelInfo[] = [];
let localCliControlSequence = 0;
let bridgeCheck: { provider: Provider } | undefined;
let providerControlLocks = 0;
let saveQueue: Promise<unknown> = Promise.resolve();
let autoSaveTimer: number | undefined;
let cliAccountSequence = 0;

initOptions();

providerSelect.addEventListener("change", async () => {
  if (providerSelect.disabled) {
    providerSelect.value = draftSettings.provider;
    return;
  }
  const provider = providerSelect.value as Provider;
  draftSettings = normalizeSettings(readFormSettings());
  localCliControlSequence += 1;
  bridgeCheck = undefined;
  // Chrome grants require a user gesture. Keep selection locked through cleanup
  // so a later grant cannot race an earlier permission removal.
  const unlockProviderControls = lockProviderControls();
  setSaveStatus("Saving", false);
  let permissionError = "";
  let didSave = false;
  try {
    await ensureProviderPermission(provider);
    setLocalCliControlsDisabled(true);
    draftSettings = { ...draftSettings, provider };
    updateProviderSections(provider);
    updateDataScope();
    didSave = await persistCurrentForm();
  } catch (error) {
    permissionError = error instanceof Error ? error.message : String(error);
  } finally {
    providerSelect.value = draftSettings.provider;
    unlockProviderControls();
  }

  updateProviderSections(draftSettings.provider);
  updateDataScope();
  if (permissionError) {
    setSaveStatus(permissionError, true);
  } else if (didSave) {
    showSaveCompletion(savedSettings);
  }
  void autoCheckCliAccount(draftSettings.provider);
  await refreshLocalCliControls(draftSettings.provider, draftSettings);
});

modelSelect.addEventListener("change", () => {
  localCliControlSequence += 1;
  if (draftSettings.provider === "local-codex-cli") {
    populateReasoningSelect(draftSettings.provider, normalizeSettings(readFormSettings()));
  }
  void persistCurrentForm();
});

reasoningSelect.addEventListener("change", () => {
  localCliControlSequence += 1;
  void persistCurrentForm();
});

includeFullUrlsInput.addEventListener("change", () => {
  updateDataScope();
  void persistCurrentForm();
});

includePageHintsInput?.addEventListener("change", () => {
  updateDataScope();
  void persistCurrentForm();
});

codexAccountSelect?.addEventListener("change", async () => {
  await persistCurrentForm();
  void autoCheckCliAccount(draftSettings.provider);
  await refreshLocalCliControls(draftSettings.provider, draftSettings);
});

cliSignInButton?.addEventListener("click", async () => {
  await runSeparateAccountAction(signInSeparateCodexAccount, "signing-in");
});

cliSignOutButton?.addEventListener("click", async () => {
  await runSeparateAccountAction(signOutSeparateCodexAccount, "checking");
});

groupTargetSelect?.addEventListener("change", () => {
  void persistCurrentForm();
});

autoTidyEnabledInput.addEventListener("change", () => {
  updateAutoTidyControls();
  void persistCurrentForm();
});

for (const input of getImmediateSaveInputs()) {
  input.addEventListener("change", () => {
    void persistCurrentForm();
  });
}

for (const input of getDebouncedSaveInputs()) {
  input.addEventListener("input", () => {
    scheduleAutoSave();
  });
  input.addEventListener("change", () => {
    void persistCurrentForm();
  });
}

testNativeBridgeButton?.addEventListener("click", async () => {
  await testNativeBridge();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void persistCurrentForm();
});

async function initOptions() {
  const settings = await getSettings();
  savedSettings = settings;
  draftSettings = settings;
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
  if (groupTargetField) {
    groupTargetField.hidden = !zenFoldersAvailable;
  }
  if (groupTargetSelect) {
    groupTargetSelect.value = resolveGroupTarget(settings.groupTarget);
  }
  if (chromeAiProviderOption) {
    chromeAiProviderOption.hidden = isGeckoExtensionRuntime() && settings.provider !== "chrome-ai";
  }
  updateProviderSections(settings.provider);
  void autoCheckCliAccount(settings.provider);
  await refreshLocalCliControls(settings.provider, settings);
  updateDataScope();
  updateAutoTidyControls();
  showSaveCompletion(settings);
}

function scheduleAutoSave(): void {
  draftSettings = normalizeSettings(readFormSettings());
  if (autoSaveTimer !== undefined) {
    window.clearTimeout(autoSaveTimer);
  }
  setSaveStatus("Editing", false);
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = undefined;
    void persistCurrentForm();
  }, 350);
}

async function persistCurrentForm(): Promise<boolean> {
  if (autoSaveTimer !== undefined) {
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = undefined;
  }

  const settings = normalizeSettings(readFormSettings());
  draftSettings = settings;
  setSaveStatus("Saving", false);
  // A retry after a failed provider save can also remove permissions. Its lock
  // must survive other overlapping saves and the original provider handler.
  const unlockProviderControls = settings.provider !== savedSettings.provider ? lockProviderControls() : undefined;
  let didSave = false;

  try {
    const write = saveQueue.then(async () => {
      const previousProvider = savedSettings.provider;
      await saveSettings(settings);
      savedSettings = settings;
      if (previousProvider !== settings.provider) {
        await removeUnusedProviderPermissions(settings.provider);
      }
    });
    saveQueue = write.catch(() => {});
    await write;
    didSave = true;
    return true;
  } catch (error) {
    if (settings === draftSettings) {
      setSaveStatus(error instanceof Error ? error.message : String(error), true);
    }
    return false;
  } finally {
    unlockProviderControls?.();
    if (didSave) {
      showSaveCompletion(settings);
    }
  }
}

function showSaveCompletion(settings: Settings): void {
  if (settings === draftSettings && (providerControlLocks === 0 || bridgeCheck !== undefined)) {
    updateDataScope();
    setSaveStatus("Saved", false);
  }
}

function getImmediateSaveInputs(): HTMLInputElement[] {
  return [
    document.querySelector<HTMLInputElement>("#allowHeuristicFallback")!,
    document.querySelector<HTMLInputElement>("#ignorePinnedTabs")!,
    document.querySelector<HTMLInputElement>("#keepExistingGroups")!
  ];
}

function getDebouncedSaveInputs(): HTMLInputElement[] {
  return [
    document.querySelector<HTMLInputElement>("#openaiApiKey")!,
    document.querySelector<HTMLInputElement>("#openaiModel")!,
    document.querySelector<HTMLInputElement>("#anthropicApiKey")!,
    document.querySelector<HTMLInputElement>("#anthropicModel")!,
    document.querySelector<HTMLInputElement>("#minimumGroupSize")!,
    autoTidyIntervalInput,
    providerTimeoutInput
  ];
}

function updateAutoTidyControls(): void {
  autoTidyIntervalInput.disabled = !autoTidyEnabledInput.checked;
}

function lockProviderControls(): () => void {
  providerControlLocks += 1;
  updateProviderControls();
  return () => {
    providerControlLocks -= 1;
    updateProviderControls();
  };
}

function updateProviderControls(): void {
  providerSelect.disabled = providerControlLocks > 0;
  testNativeBridgeButton.disabled = providerControlLocks > 0 || bridgeCheck !== undefined;
}

function updateProviderSections(provider: string): void {
  if (codexAccountRow) {
    codexAccountRow.hidden = provider !== "local-codex-cli";
  }
  for (const section of document.querySelectorAll("[data-provider-section]")) {
    const providerSection = section as HTMLElement;
    providerSection.hidden = providerSection.dataset.providerSection !== provider &&
      !(providerSection.dataset.providerSection === "local-cli" && isLocalCliProvider(provider));
  }
  setNativeBridgeStatus("", false);
}

function updateDataScope(settings = readCurrentScopeSettings()): void {
  const scope = getProviderDataScope(settings);
  dataMode.textContent = scope.dataMode;
  dataSummary.textContent = scope.dataSummary;
}

function readFormSettings(): PartialSettings {
  const provider = draftSettings.provider;
  const formData = new FormData(form);
  const storedLocalCliModel = provider === "local-codex-cli" ? draftSettings.codexCliModel : draftSettings.claudeCliModel;
  const storedLocalCliReasoningEffort = provider === "local-codex-cli" ? draftSettings.codexReasoningEffort : draftSettings.claudeReasoningEffort;
  const localCliModel = modelSelect.disabled ? storedLocalCliModel : String(modelSelect.value || "").trim();
  const localCliReasoningEffort = reasoningSelect.disabled ? storedLocalCliReasoningEffort : String(reasoningSelect.value || "").trim();
  return {
    provider,
    openaiApiKey: String(formData.get("openaiApiKey") || ""),
    openaiModel: String(formData.get("openaiModel") || DEFAULT_SETTINGS.openaiModel).trim(),
    anthropicApiKey: String(formData.get("anthropicApiKey") || ""),
    anthropicModel: String(formData.get("anthropicModel") || DEFAULT_SETTINGS.anthropicModel).trim(),
    codexCliModel: provider === "local-codex-cli" ? localCliModel : draftSettings.codexCliModel,
    claudeCliModel: provider === "local-claude-cli" ? localCliModel : draftSettings.claudeCliModel,
    codexReasoningEffort: provider === "local-codex-cli" ? localCliReasoningEffort : draftSettings.codexReasoningEffort,
    claudeReasoningEffort: provider === "local-claude-cli" ? localCliReasoningEffort : draftSettings.claudeReasoningEffort,
    includeFullUrls: formData.get("includeFullUrls") === "on",
    includePageHints: includePageHintsInput ? formData.get("includePageHints") === "on" : false,
    allowHeuristicFallback: formData.get("allowHeuristicFallback") === "on",
    ignorePinnedTabs: formData.get("ignorePinnedTabs") === "on",
    keepExistingGroups: formData.get("keepExistingGroups") === "on",
    minimumGroupSize: Number(formData.get("minimumGroupSize")),
    autoTidyEnabled: autoTidyEnabledInput.checked,
    autoTidyIntervalMinutes: Number(autoTidyIntervalInput.value),
    providerRequestTimeoutSeconds: Number(providerTimeoutInput.value),
    groupTarget: zenFoldersAvailable && groupTargetSelect ? groupTargetSelect.value : draftSettings.groupTarget,
    codexAccount: codexAccountSelect ? codexAccountSelect.value : draftSettings.codexAccount
  };
}

async function refreshLocalCliControls(provider: Provider, settings: Settings): Promise<boolean> {
  const sequence = ++localCliControlSequence;
  if (!isLocalCliProvider(provider)) {
    codexModels = [];
    replaceModelOptions("Use CLI default", [], "");
    replaceReasoningOptions("", [], "");
    setLocalCliControlsDisabled(false);
    return true;
  }

  if (provider === "local-claude-cli") {
    codexModels = [];
    replaceModelOptions("Use claude CLI's own default", CLAUDE_MODEL_OPTIONS, settings.claudeCliModel);
    populateReasoningSelect(provider, settings);
    setLocalCliControlsDisabled(false);
    return true;
  }

  codexModels = [];
  replaceModelOptions("Use codex CLI's own default", [], settings.codexCliModel, "Loading Codex models...");
  replaceReasoningOptions("", [], "");
  setLocalCliControlsDisabled(true);
  setNativeBridgeStatus("Loading Codex models...", false);
  if (!(await hasNativeMessagingPermission())) {
    if (sequence !== localCliControlSequence) {
      return false;
    }
    commitCodexControls([], settings, "Test the bridge to grant access and load Codex models.", false);
    return false;
  }

  try {
    const models = await listNativeModels("codex", settings.codexAccount);
    if (sequence !== localCliControlSequence) {
      return false;
    }
    commitCodexControls(models, settings, "", false);
    return true;
  } catch (error) {
    if (sequence !== localCliControlSequence) {
      return false;
    }
    commitCodexControls([], settings, getFriendlyProviderErrorMessage(error), true);
    return false;
  }
}

function commitCodexControls(models: NativeModelInfo[], settings: Settings, status: string, isError: boolean): void {
  codexModels = models;
  replaceModelOptions("Use codex CLI's own default", models, settings.codexCliModel);
  populateReasoningSelect("local-codex-cli", settings);
  if (settings.codexReasoningEffort && reasoningSelect.value !== settings.codexReasoningEffort) {
    reasoningSelect.appendChild(createOption(settings.codexReasoningEffort, `${settings.codexReasoningEffort} (saved)`));
    reasoningSelect.value = settings.codexReasoningEffort;
  }
  setLocalCliControlsDisabled(false);
  setNativeBridgeStatus(status, isError);
}

function setLocalCliControlsDisabled(disabled: boolean): void {
  modelSelect.disabled = disabled;
  reasoningSelect.disabled = disabled;
}

function replaceModelOptions(defaultLabel: string, models: NativeModelInfo[], selectedValue: string, loadingLabel = ""): void {
  modelSelect.replaceChildren();
  modelSelect.appendChild(createOption("", defaultLabel));
  if (loadingLabel) {
    const loadingOption = createOption("", loadingLabel);
    loadingOption.disabled = true;
    modelSelect.appendChild(loadingOption);
  }
  for (const model of models) {
    modelSelect.appendChild(createOption(model.slug, model.displayName || model.slug));
  }

  const allowedValues = new Set(models.map((model) => model.slug));
  if (selectedValue && !allowedValues.has(selectedValue)) {
    modelSelect.appendChild(createOption(selectedValue, `${selectedValue} (saved)`));
    allowedValues.add(selectedValue);
  }
  modelSelect.value = selectedValue && allowedValues.has(selectedValue) ? selectedValue : "";
}

function populateReasoningSelect(provider: string, settings: Settings): void {
  if (provider === "local-claude-cli") {
    replaceReasoningOptions("Use claude CLI's default", CLAUDE_REASONING_LEVELS, settings.claudeReasoningEffort);
    return;
  }

  if (provider !== "local-codex-cli") {
    replaceReasoningOptions("", [], "");
    return;
  }

  const selectedModel = modelSelect.value
    ? codexModels.find((model) => model.slug === modelSelect.value)
    : undefined;
  const modelLevels = selectedModel?.supportedReasoningLevels?.filter((level) => level.trim() !== "");
  const levels = modelLevels && modelLevels.length > 0 ? modelLevels : CODEX_REASONING_LEVELS;
  const defaultLevel = selectedModel?.defaultReasoningLevel || "";
  const defaultLabel = defaultLevel ? `Use codex CLI's default (${defaultLevel})` : "Use codex CLI's default";
  replaceReasoningOptions(defaultLabel, levels, settings.codexReasoningEffort);
}

function replaceReasoningOptions(defaultLabel: string, levels: string[], selectedValue: string): void {
  reasoningSelect.replaceChildren();
  if (!defaultLabel) {
    reasoningSelect.value = "";
    return;
  }
  reasoningSelect.appendChild(createOption("", defaultLabel));
  for (const level of levels) {
    reasoningSelect.appendChild(createOption(level, level));
  }

  const allowedValues = new Set(levels);
  reasoningSelect.value = selectedValue && allowedValues.has(selectedValue) ? selectedValue : "";
}

function createOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function readCurrentScopeSettings(): Pick<Settings, "provider" | "includeFullUrls" | "includePageHints"> {
  return {
    provider: draftSettings.provider,
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
  if (testNativeBridgeButton.disabled) {
    return;
  }
  const provider = draftSettings.provider;
  if (!isLocalCliProvider(provider)) {
    setNativeBridgeStatus("Choose a local CLI provider first.", true);
    return;
  }

  const check = { provider };
  bridgeCheck = check;
  const isCurrent = () => bridgeCheck === check;
  updateProviderControls();
  setNativeBridgeStatus("Checking...", false);
  const accountSequence = ++cliAccountSequence;
  renderCliAccount(provider, { kind: "checking" });
  try {
    const unlockProviderControls = lockProviderControls();
    try {
      await ensureProviderPermission(provider);
    } finally {
      unlockProviderControls();
    }
    if (!isCurrent()) {
      return;
    }
    const status = await checkNativeCliStatus(provider, draftSettings.codexAccount);
    if (!isCurrent()) {
      return;
    }
    if (accountSequence === cliAccountSequence) {
      renderCliAccount(provider, { kind: "status", status });
    }
    if (status.configured && status.executableAvailable && status.authenticated) {
      if (provider === "local-codex-cli") {
        const modelsLoaded = await refreshLocalCliControls(provider, draftSettings);
        if (!modelsLoaded || !isCurrent()) {
          return;
        }
      }
      setNativeBridgeStatus(`${getLocalCliLabel(provider)} bridge is ready.`, false);
      return;
    }
    if (!status.configured) {
      setNativeBridgeStatus(`${getLocalCliLabel(provider)} path is not configured. Reinstall the native host.`, true);
      return;
    }
    if (!status.executableAvailable) {
      setNativeBridgeStatus(`${getLocalCliLabel(provider)} path is configured but not executable. Reinstall the native host.`, true);
      return;
    }
    if (status.authChecked && !status.authenticated) {
      setNativeBridgeStatus(`${getLocalCliLabel(provider)} is installed but not signed in.`, true);
      return;
    }
    if (!status.authChecked) {
      setNativeBridgeStatus(`${getLocalCliLabel(provider)} path is ready, but sign-in could not be verified.`, true);
      return;
    }
    setNativeBridgeStatus(`${getLocalCliLabel(provider)} bridge is not ready.`, true);
  } catch (error) {
    if (isCurrent()) {
      setNativeBridgeStatus(getFriendlyProviderErrorMessage(error), true);
    }
    if (accountSequence === cliAccountSequence) {
      renderCliAccount(provider, { kind: "error", error });
    }
  } finally {
    if (isCurrent()) {
      bridgeCheck = undefined;
      updateProviderControls();
    }
  }
}

async function autoCheckCliAccount(provider: Provider): Promise<void> {
  if (!cliAccount || !isLocalCliProvider(provider) || bridgeCheck !== undefined) {
    return;
  }
  const sequence = ++cliAccountSequence;
  if (!(await hasNativeMessagingPermission())) {
    if (sequence === cliAccountSequence) {
      renderCliAccount(provider, { kind: "needs-permission" });
    }
    return;
  }
  renderCliAccount(provider, { kind: "checking" });
  try {
    const status = await checkNativeCliStatus(provider, draftSettings.codexAccount);
    if (sequence === cliAccountSequence) {
      renderCliAccount(provider, { kind: "status", status });
    }
  } catch (error) {
    if (sequence === cliAccountSequence) {
      renderCliAccount(provider, { kind: "error", error });
    }
  }
}

async function runSeparateAccountAction(action: () => Promise<NativeCliStatus>, pendingKind: "signing-in" | "checking"): Promise<void> {
  const provider = draftSettings.provider;
  const sequence = ++cliAccountSequence;
  renderCliAccount(provider, { kind: pendingKind });
  try {
    const status = await action();
    if (sequence === cliAccountSequence) {
      renderCliAccount(provider, { kind: "status", status });
    }
    await refreshLocalCliControls(draftSettings.provider, draftSettings);
  } catch (error) {
    if (sequence === cliAccountSequence) {
      renderCliAccount(provider, { kind: "error", error });
    }
  }
}

function usesSeparateCodexAccount(provider: Provider): boolean {
  return provider === "local-codex-cli" && draftSettings.codexAccount === "separate";
}

function renderCliAccount(provider: Provider, state: CliAccountState): void {
  if (!cliAccount || !cliAccountTitle || !cliAccountDetail) {
    return;
  }
  const label = getLocalCliLabel(provider);
  const separate = usesSeparateCodexAccount(provider);
  const view = describeCliAccount(provider, separate ? "Tab Grouper account" : label, state, separate);
  const busy = state.kind === "checking" || state.kind === "signing-in";
  const signedIn = state.kind === "status" && state.status.authenticated;
  if (cliSignInButton) {
    cliSignInButton.hidden = !separate || busy || view.showSetup;
    cliSignInButton.textContent = signedIn ? "Switch account" : "Sign in";
  }
  if (cliSignOutButton) {
    cliSignOutButton.hidden = !separate || busy || !signedIn;
  }
  cliAccount.dataset.state = view.state;
  cliAccountTitle.textContent = view.title;
  cliAccountDetail.textContent = view.detail;
  if (cliSetup && cliSetupCommand) {
    cliSetup.hidden = !view.showSetup;
    cliSetupCommand.textContent = getNativeInstallCommand();
  }
}

function describeCliAccount(provider: Provider, label: string, state: CliAccountState, separate: boolean) {
  switch (state.kind) {
    case "checking":
      return { state: "checking", title: `Checking ${label}…`, detail: "", showSetup: false };
    case "signing-in":
      return { state: "checking", title: "Waiting for sign-in…", detail: "Finish signing in with the ChatGPT account you want in the browser tab that just opened.", showSetup: false };
    case "needs-permission":
      return { state: "idle", title: "Not connected yet", detail: "Check the connection to allow the browser to talk to the local bridge.", showSetup: false };
    case "error": {
      const providerError = state.error as ProviderError | undefined;
      const kind = providerError?.providerErrorKind;
      const notInstalled = kind === "native-host-not-found" || kind === "native-host-forbidden";
      const outdated = kind === "native-host-protocol-error" && /outdated|does not match/i.test(providerError?.message || "");
      return {
        state: "error",
        title: notInstalled ? "Local bridge not installed" : outdated ? "Local bridge needs an update" : "Bridge check failed",
        detail: notInstalled ? `Needed to reach the ${label}.` : outdated ? "Reinstall it to use this version of Tab Grouper." : getFriendlyProviderErrorMessage(state.error),
        showSetup: notInstalled || outdated || kind === "native-host-config-error"
      };
    }
    case "status": {
      const { status } = state;
      if (!status.configured || !status.executableAvailable) {
        return { state: "error", title: `${label} not found`, detail: "Install the CLI, then reinstall the bridge so it picks up the path.", showSetup: true };
      }
      if (!status.authChecked) {
        return { state: "warning", title: `${label} found`, detail: "Sign-in could not be verified.", showSetup: false };
      }
      if (!status.authenticated && separate) {
        return { state: "warning", title: "Tab Grouper account not signed in", detail: "Sign in with the ChatGPT account Tab Grouper should use. Your Codex CLI login stays as it is.", showSetup: false };
      }
      if (!status.authenticated) {
        const loginCommand = provider === "local-claude-cli" ? "claude auth login" : "codex login";
        return { state: "warning", title: `${label} is not signed in`, detail: `Run \`${loginCommand}\` in a terminal, then check again.`, showSetup: false };
      }
      const plan = formatCliAccountPlan(provider, status.account);
      const detail = [plan, status.account?.email].filter(Boolean).join(" · ");
      return {
        state: "ready",
        title: separate ? "Tab Grouper account connected" : `${label} connected`,
        detail: detail || "Signed in. Reinstall the bridge to see which plan is used.",
        showSetup: false
      };
    }
  }
}

function getNativeInstallCommand(): string {
  if (!isGeckoExtensionRuntime()) {
    return "nub run native:install";
  }
  return `nub run native:install --browser ${zenFoldersAvailable ? "zen" : "firefox"}`;
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
