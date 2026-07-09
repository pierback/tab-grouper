import type { PartialSettings, Provider, Settings } from "./types.js";

export const DEFAULT_SETTINGS = {
  provider: "heuristic",
  openaiApiKey: "",
  openaiModel: "gpt-5.4-mini",
  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-4-6-20260217",
  codexCliModel: "",
  claudeCliModel: "",
  includeFullUrls: false,
  includePageHints: false,
  allowHeuristicFallback: true,
  ignorePinnedTabs: true,
  keepExistingGroups: true,
  collapseGroups: false,
  minimumGroupSize: 2
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
    includeFullUrls: normalizedSettings.includeFullUrls,
    includePageHints: normalizedSettings.includePageHints,
    allowHeuristicFallback: normalizedSettings.allowHeuristicFallback,
    ignorePinnedTabs: normalizedSettings.ignorePinnedTabs,
    keepExistingGroups: normalizedSettings.keepExistingGroups,
    collapseGroups: normalizedSettings.collapseGroups,
    minimumGroupSize: normalizedSettings.minimumGroupSize
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
    includeFullUrls: raw.includeFullUrls === true,
    includePageHints: raw.includePageHints === true,
    allowHeuristicFallback: raw.allowHeuristicFallback !== false,
    ignorePinnedTabs: raw.ignorePinnedTabs !== false,
    keepExistingGroups: raw.keepExistingGroups !== false,
    collapseGroups: raw.collapseGroups === true,
    minimumGroupSize: clampNumber(raw.minimumGroupSize, 2, 10, DEFAULT_SETTINGS.minimumGroupSize)
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
