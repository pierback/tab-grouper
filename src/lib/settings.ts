import type { PartialSettings, Provider, Settings } from "./types.js";
import {
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_SECONDS,
  normalizeProviderRequestTimeoutSeconds
} from "./provider_timeout.js";

export const DEFAULT_SETTINGS = {
  provider: "heuristic",
  openaiApiKey: "",
  openaiModel: "gpt-5.4-mini",
  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-4-6-20260217",
  codexCliModel: "",
  claudeCliModel: "",
  codexReasoningEffort: "",
  claudeReasoningEffort: "",
  includeFullUrls: false,
  includePageHints: false,
  allowHeuristicFallback: true,
  ignorePinnedTabs: true,
  keepExistingGroups: true,
  minimumGroupSize: 2,
  autoTidyEnabled: false,
  autoTidyIntervalMinutes: 30,
  providerRequestTimeoutSeconds: DEFAULT_PROVIDER_REQUEST_TIMEOUT_SECONDS
} as const satisfies Settings;

export const ALLOWED_PROVIDERS = new Set<Provider>([
  "heuristic",
  "local-codex-cli",
  "local-claude-cli",
  "chrome-ai",
  "openai",
  "anthropic"
]);

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    ...stored
  });
}

export async function saveSettings(nextSettings: PartialSettings): Promise<void> {
  await chrome.storage.local.set(normalizeSettings({
    ...DEFAULT_SETTINGS,
    ...nextSettings
  }));
}

export function publicSettingsSummary(settings: PartialSettings) {
  const normalizedSettings = normalizeSettings(settings);
  return {
    provider: normalizedSettings.provider,
    openaiModel: normalizedSettings.openaiModel,
    anthropicModel: normalizedSettings.anthropicModel,
    codexCliModel: normalizedSettings.codexCliModel,
    claudeCliModel: normalizedSettings.claudeCliModel,
    codexReasoningEffort: normalizedSettings.codexReasoningEffort,
    claudeReasoningEffort: normalizedSettings.claudeReasoningEffort,
    includeFullUrls: normalizedSettings.includeFullUrls,
    includePageHints: normalizedSettings.includePageHints,
    allowHeuristicFallback: normalizedSettings.allowHeuristicFallback,
    ignorePinnedTabs: normalizedSettings.ignorePinnedTabs,
    keepExistingGroups: normalizedSettings.keepExistingGroups,
    minimumGroupSize: normalizedSettings.minimumGroupSize,
    autoTidyEnabled: normalizedSettings.autoTidyEnabled,
    autoTidyIntervalMinutes: normalizedSettings.autoTidyIntervalMinutes,
    providerRequestTimeoutSeconds: normalizedSettings.providerRequestTimeoutSeconds
  };
}

export function normalizeSettings(rawSettings: PartialSettings = {}): Settings {
  const raw = {
    ...DEFAULT_SETTINGS,
    ...rawSettings
  };

  return {
    provider: ALLOWED_PROVIDERS.has(raw.provider) ? raw.provider : DEFAULT_SETTINGS.provider,
    openaiApiKey: normalizeSecret(raw.openaiApiKey),
    openaiModel: normalizeText(raw.openaiModel, DEFAULT_SETTINGS.openaiModel, 80),
    anthropicApiKey: normalizeSecret(raw.anthropicApiKey),
    anthropicModel: normalizeText(raw.anthropicModel, DEFAULT_SETTINGS.anthropicModel, 80),
    codexCliModel: normalizeText(raw.codexCliModel, "", 80),
    claudeCliModel: normalizeText(raw.claudeCliModel, "", 80),
    codexReasoningEffort: normalizeText(raw.codexReasoningEffort, "", 16),
    claudeReasoningEffort: normalizeText(raw.claudeReasoningEffort, "", 16),
    includeFullUrls: raw.includeFullUrls === true,
    includePageHints: raw.includePageHints === true,
    allowHeuristicFallback: raw.allowHeuristicFallback !== false,
    ignorePinnedTabs: raw.ignorePinnedTabs !== false,
    keepExistingGroups: raw.keepExistingGroups !== false,
    minimumGroupSize: clampNumber(raw.minimumGroupSize, 2, 10, DEFAULT_SETTINGS.minimumGroupSize),
    autoTidyEnabled: raw.autoTidyEnabled === true,
    autoTidyIntervalMinutes: clampNumber(raw.autoTidyIntervalMinutes, 1, 1440, DEFAULT_SETTINGS.autoTidyIntervalMinutes),
    providerRequestTimeoutSeconds: normalizeProviderRequestTimeoutSeconds(raw.providerRequestTimeoutSeconds)
  };
}

function normalizeSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const text = value.trim();
  return text ? text.slice(0, maxLength) : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
