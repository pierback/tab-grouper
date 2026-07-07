export const PLAN_CACHE_TTL_MS = 60000;

export function getCachedPlan(cache, windowId, keyInput, now = Date.now) {
  const entry = cache.get(windowId);
  if (!entry) {
    return null;
  }

  if (now() - entry.capturedAt > PLAN_CACHE_TTL_MS) {
    cache.delete(windowId);
    return null;
  }

  if (JSON.stringify(entry.key) !== JSON.stringify(keyInput)) {
    return null;
  }

  return entry.value;
}

export function setCachedPlan(cache, windowId, keyInput, value, now = Date.now) {
  cache.set(windowId, {
    key: keyInput,
    value,
    capturedAt: now()
  });
}

export function invalidatePlanCache(cache, windowId) {
  cache.delete(windowId);
}
