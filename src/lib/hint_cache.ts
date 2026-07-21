import type { EnrichedTab, PageContextInput } from "./types.js";

const HINT_CACHE_TTL_MS = 300000;

export interface HintCacheEntry {
  url?: string;
  title?: string;
  pageHint: string;
  context?: PageContextInput;
  capturedAt: number;
}

export interface PageHint {
  pageHint: string;
  context?: PageContextInput;
}

export function getCachedHint(cache: Map<number, HintCacheEntry> | undefined, tab: EnrichedTab): PageHint | undefined {
  const tabId = tab.id;
  if (typeof tabId !== "number") {
    return undefined;
  }
  const entry = cache?.get(tabId);
  if (!entry) {
    return undefined;
  }
  if (entry.url !== tab.url || entry.title !== tab.title) {
    cache?.delete(tabId);
    return undefined;
  }
  if (Date.now() - entry.capturedAt >= HINT_CACHE_TTL_MS) {
    cache?.delete(tabId);
    return undefined;
  }
  return {
    pageHint: entry.pageHint,
    context: entry.context
  };
}

export function setCachedHint(cache: Map<number, HintCacheEntry>, tab: EnrichedTab, hint: PageHint): void {
  const tabId = tab.id;
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    return;
  }
  cache.set(tabId, {
    url: tab.url,
    title: tab.title,
    pageHint: hint.pageHint,
    context: hint.context,
    capturedAt: Date.now()
  });
}
