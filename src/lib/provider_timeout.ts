export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_SECONDS = 180;
export const MIN_PROVIDER_REQUEST_TIMEOUT_SECONDS = 180;
export const MAX_PROVIDER_REQUEST_TIMEOUT_SECONDS = 300;

export function normalizeProviderRequestTimeoutSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_PROVIDER_REQUEST_TIMEOUT_SECONDS;
  }
  return Math.max(
    MIN_PROVIDER_REQUEST_TIMEOUT_SECONDS,
    Math.min(MAX_PROVIDER_REQUEST_TIMEOUT_SECONDS, Math.trunc(seconds))
  );
}

export function getProviderRequestTimeoutMs(value: unknown): number {
  return normalizeProviderRequestTimeoutSeconds(value) * 1000;
}
