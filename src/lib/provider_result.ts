import type { ProviderError, ProviderErrorKind } from "./types.js";

export function createProviderError(kind: ProviderErrorKind, message: string): ProviderError {
  const error: ProviderError = new Error(message);
  error.providerErrorKind = kind;

  return error;
}

export function omitUndefined<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}
