const HINT_CACHE_TTL_MS = 300000;

export function getCachedHint(cache, tab) {
  const entry = cache?.get(tab?.id);
  if (!entry) {
    return undefined;
  }
  if (entry.url !== tab.url || entry.title !== tab.title) {
    return undefined;
  }
  if (Date.now() - entry.capturedAt >= HINT_CACHE_TTL_MS) {
    return undefined;
  }
  return {
    pageHint: entry.pageHint,
    context: entry.context
  };
}

export function setCachedHint(cache, tab, hint) {
  cache.set(tab.id, {
    url: tab.url,
    title: tab.title,
    pageHint: hint.pageHint,
    context: hint.context,
    capturedAt: Date.now()
  });
}
