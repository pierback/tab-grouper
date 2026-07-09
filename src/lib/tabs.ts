import type { EnrichedTab, LocalTabRecord, PromptTabRecord, Settings } from "./types.js";

const TITLE_MAX_LENGTH = 300;
const DOMAIN_MAX_LENGTH = 120;
const URL_MAX_LENGTH = 1000;
const PAGE_HINT_MAX_LENGTH = 1000;

export interface ParsedUrl {
  hostname: string;
  protocol: string;
  pathname: string;
  port: string;
}

export type TabSkipReason = "invalid" | "pinned" | "missing-url" | "already-grouped" | null;

export function tabToPromptRecord(tab: EnrichedTab, settings: Partial<Pick<Settings, "includeFullUrls" | "includePageHints">>): PromptTabRecord {
  const urlInfo = parseUrl(tab.url);
  return {
    id: tab.id,
    title: truncate(tab.title || "Untitled", TITLE_MAX_LENGTH),
    domain: truncate(urlInfo.hostname || "unknown", DOMAIN_MAX_LENGTH),
    url: settings.includeFullUrls ? truncate(tab.url || "", URL_MAX_LENGTH) : undefined,
    pageHint: settings.includePageHints ? truncate(tab.pageHint, PAGE_HINT_MAX_LENGTH) || undefined : undefined,
    context: settings.includePageHints ? tab.context || undefined : undefined
  };
}

function truncate(value: unknown, maxLength: number): string {
  const text = String(value || "");
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function tabToLocalRecord(tab: EnrichedTab): LocalTabRecord {
  const urlInfo = parseUrl(tab.url);
  return {
    id: tab.id,
    title: tab.title || "Untitled",
    domain: urlInfo.hostname || "unknown",
    url: tab.url || "",
    index: typeof tab.index === "number" && Number.isInteger(tab.index) ? tab.index : 0
  };
}

export function isGroupableTab(tab: EnrichedTab | null | undefined, settings: Pick<Settings, "ignorePinnedTabs" | "keepExistingGroups">): boolean {
  return !getTabSkipReason(tab, settings);
}

export function getTabSkipReason(tab: EnrichedTab | null | undefined, settings: Pick<Settings, "ignorePinnedTabs" | "keepExistingGroups">): TabSkipReason {
  if (!tab || !Number.isInteger(tab.id)) {
    return "invalid";
  }
  if (settings.ignorePinnedTabs && tab.pinned) {
    return "pinned";
  }
  if (!tab.url) {
    return "missing-url";
  }
  if (settings.keepExistingGroups && isTabGrouped(tab)) {
    return "already-grouped";
  }
  return null;
}

export function isTabGrouped(tab: EnrichedTab | null | undefined): boolean {
  return Number.isInteger(tab?.groupId) && tab?.groupId !== -1;
}

export function parseUrl(rawUrl: string | undefined): ParsedUrl {
  try {
    const url = new URL(rawUrl || "");
    return {
      hostname: url.hostname.replace(/^www\./, ""),
      protocol: url.protocol,
      pathname: url.pathname,
      port: url.port
    };
  } catch {
    return {
      hostname: "",
      protocol: "",
      pathname: "",
      port: ""
    };
  }
}
