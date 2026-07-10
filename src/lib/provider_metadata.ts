import type { Provider, ProviderError, ProviderErrorKind, Settings } from "./types.js";

interface ProviderMetadata {
  label: string;
  dataMode: string;
  dataSummary: string;
  origins: string[];
  permissions: chrome.runtime.ManifestPermission[];
}

export const PROVIDER_METADATA = {
  heuristic: {
    label: "Local heuristic",
    dataMode: "On-device",
    dataSummary: "Tab titles and URLs stay in Chrome.",
    origins: [],
    permissions: []
  },
  "local-codex-cli": {
    label: "Local Codex CLI",
    dataMode: "Local CLI account",
    dataSummary: "Tab titles and domains are sent to the local Tab Grouper bridge, then to Codex through your signed-in Codex CLI account.",
    origins: [],
    permissions: ["nativeMessaging"]
  },
  "local-claude-cli": {
    label: "Local Claude Code CLI",
    dataMode: "Local CLI account",
    dataSummary: "Tab titles and domains are sent to the local Tab Grouper bridge, then to Claude through your signed-in Claude Code CLI account.",
    origins: [],
    permissions: ["nativeMessaging"]
  },
  "chrome-ai": {
    label: "Chrome built-in AI",
    dataMode: "On-device model",
    dataSummary: "Tab titles and URLs stay in Chrome's local AI runtime.",
    origins: [],
    permissions: []
  },
  openai: {
    label: "OpenAI API",
    dataMode: "Cloud AI",
    dataSummary: "Tab titles and domains are sent by default.",
    origins: ["https://api.openai.com/*"],
    permissions: []
  },
  anthropic: {
    label: "Anthropic API",
    dataMode: "Cloud AI",
    dataSummary: "Tab titles and domains are sent by default.",
    origins: ["https://api.anthropic.com/*"],
    permissions: []
  }
} as const satisfies Record<Provider, ProviderMetadata>;

export function getProviderLabel(provider: Provider | string | undefined): string {
  return isProvider(provider) ? PROVIDER_METADATA[provider].label : provider || "Unknown";
}

const FRIENDLY_ERROR_MESSAGES_BY_KIND: Partial<Record<ProviderErrorKind, string>> = {
  "missing-native-permission": "Native Messaging permission is missing. Save this provider or grant permission.",
  "native-host-not-found": "Native bridge is not installed. Run nub run native:install.",
  "native-host-forbidden": "Native bridge is not allowed for this extension ID. Reinstall the native host.",
  "native-host-config-error": "Native bridge config is invalid. Reinstall the native host."
};

export function getFriendlyProviderErrorMessage(error: unknown): string {
  const providerError = error as ProviderError | undefined;
  return FRIENDLY_ERROR_MESSAGES_BY_KIND[providerError?.providerErrorKind || ""] ||
    providerError?.message ||
    "Native bridge check failed.";
}

export function getProviderDataScope(settings: Pick<Settings, "provider"> & Partial<Pick<Settings, "includeFullUrls" | "includePageHints">>) {
  const metadata = PROVIDER_METADATA[settings.provider] || PROVIDER_METADATA.heuristic;
  if ((settings.provider === "openai" || settings.provider === "anthropic") && settings.includeFullUrls) {
    return {
      dataMode: metadata.dataMode,
      dataSummary: "Tab titles and full URLs are sent to the selected API provider."
    };
  }
  if ((settings.provider === "local-codex-cli" || settings.provider === "local-claude-cli") && settings.includeFullUrls) {
    return {
      dataMode: metadata.dataMode,
      dataSummary: "Tab titles and full URLs are sent to the local bridge, then to the selected local CLI account."
    };
  }
  if (settings.includePageHints) {
    return {
      dataMode: metadata.dataMode,
      dataSummary: `${metadata.dataSummary} Optional superficial page hints may be included when available.`
    };
  }
  return {
    dataMode: metadata.dataMode,
    dataSummary: metadata.dataSummary
  };
}

export function getProviderOrigins(provider: Provider | string | undefined): string[] {
  return isProvider(provider) ? [...PROVIDER_METADATA[provider].origins] : [];
}

export function getAllProviderOrigins() {
  return [...new Set(Object.values(PROVIDER_METADATA).flatMap((metadata) => metadata.origins))];
}

export function getProviderPermissions(provider: Provider | string | undefined): chrome.runtime.ManifestPermission[] {
  return isProvider(provider) ? [...PROVIDER_METADATA[provider].permissions] : [];
}

export function getAllProviderPermissions() {
  return [...new Set(Object.values(PROVIDER_METADATA).flatMap((metadata) => metadata.permissions))];
}

function isProvider(provider: Provider | string | undefined): provider is Provider {
  return typeof provider === "string" && provider in PROVIDER_METADATA;
}
