export const PLAN_CACHE_TTL_MS = 60000;

export interface PlanCacheEntry<TValue = unknown> {
  key: unknown;
  value: TValue;
  capturedAt: number;
}

export function getCachedPlan<TValue>(
  cache: Map<number, PlanCacheEntry<TValue>>,
  windowId: number,
  keyInput: unknown,
  now = Date.now
): TValue | null {
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

export function setCachedPlan<TValue>(
  cache: Map<number, PlanCacheEntry<TValue>>,
  windowId: number,
  keyInput: unknown,
  value: TValue,
  now = Date.now
): void {
  cache.set(windowId, {
    key: keyInput,
    value,
    capturedAt: now()
  });
}

export function invalidatePlanCache(cache: Map<number, PlanCacheEntry>, windowId: number): void {
  cache.delete(windowId);
}
