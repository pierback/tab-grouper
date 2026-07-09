import { Cause, Effect, Exit, Option } from "effect";
import type {
  ExistingGroup,
  LocalCliProvider,
  PromptTabRecord,
  Provider,
  ProviderError,
  ProviderErrorKind,
  RawTabGroupPlan,
  Settings
} from "./types.js";

type NativeCliSettings = Partial<Settings>;

export const NATIVE_HOST_NAME = "com.fabianpieringer.tab_grouper";
const REQUEST_TYPE = "TAB_GROUP_PLAN_REQUEST";
const STATUS_REQUEST_TYPE = "NATIVE_HOST_STATUS_REQUEST";
const RESPONSE_TYPE = "TAB_GROUP_PLAN_RESPONSE";
const DEFAULT_TIMEOUT_MS = 15000;
const STATUS_TIMEOUT_MS = 3000;
const EXTENSION_TIMEOUT_MARGIN_MS = 2500;

interface NativePlanRequest {
  version: 1;
  type: typeof REQUEST_TYPE;
  requestId: string;
  provider: LocalCliProvider;
  timeoutMs: number;
  minimumGroupSize: number;
  includeFullUrls: boolean;
  includePageHints: boolean;
  existingGroups: ExistingGroup[];
  tabs: Array<{
    id?: number;
    title: string;
    domain: string;
    url?: string;
    pageHint?: string;
    context?: PromptTabRecord["context"];
  }>;
  model?: string;
}

interface NativeStatusRequest {
  version: 1;
  type: typeof STATUS_REQUEST_TYPE;
  requestId: string;
  provider: LocalCliProvider;
}

interface NativeResponse {
  type?: string;
  requestId?: string;
  ok?: boolean;
  error?: {
    kind?: ProviderErrorKind;
    message?: string;
  };
  plan?: RawTabGroupPlan;
  durationMs?: number;
  duration?: number;
  status?: NativeCliStatus;
}

interface NativeCliStatus {
  provider: Provider;
  configured: boolean;
  executableAvailable: boolean;
  authChecked: boolean;
  authenticated: boolean;
  lockExecutables: boolean;
}

export async function createPlanWithNativeCli(
  tabs: PromptTabRecord[],
  settings: NativeCliSettings,
  cliProvider: LocalCliProvider,
  existingGroups: ExistingGroup[] = []
): Promise<RawTabGroupPlan> {
  await ensureNativeMessagingPermission();

  const timeoutMs = getNativeRequestTimeoutMs(settings);
  const requestId = createRequestId();
  const request: NativePlanRequest = {
    version: 1,
    type: REQUEST_TYPE,
    requestId,
    provider: cliProvider,
    timeoutMs,
    minimumGroupSize: Number(settings.minimumGroupSize || 2),
    includeFullUrls: settings.includeFullUrls === true,
    includePageHints: settings.includePageHints === true,
    existingGroups: existingGroups.map((group) => ({
      id: group.id,
      title: group.title || "",
      color: group.color || "",
      tabIds: Array.isArray(group.tabIds) ? group.tabIds : []
    })),
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || "",
      domain: tab.domain || "unknown",
      url: settings.includeFullUrls ? tab.url || "" : undefined,
      pageHint: settings.includePageHints ? tab.pageHint || undefined : undefined,
      context: settings.includePageHints ? tab.context || undefined : undefined
    }))
  };
  const model = cliProvider === "codex" ? settings.codexCliModel : settings.claudeCliModel;
  if (model) {
    request.model = model;
  }

  const response = await sendNativeRequest(request, timeoutMs);
  const plan = response.plan || { groups: [] };
  const timing = omitUndefined({
    durationMs: response.durationMs ?? response.duration,
    inputTokens: response.plan?.usage?.inputTokens,
    outputTokens: response.plan?.usage?.outputTokens,
    costUsd: response.plan?.usage?.costUsd
  });
  return { ...plan, timing };
}

export async function checkNativeCliStatus(provider: Provider | LocalCliProvider): Promise<NativeCliStatus> {
  const cliProvider = normalizeCliProvider(provider);
  await ensureNativeMessagingPermission();
  const request: NativeStatusRequest = {
    version: 1,
    type: STATUS_REQUEST_TYPE,
    requestId: createRequestId(),
    provider: cliProvider
  };
  const response = await sendNativeRequest(request, STATUS_TIMEOUT_MS);
  return response.status || {
    provider: `local-${cliProvider}-cli`,
    configured: false,
    executableAvailable: false,
    authChecked: false,
    authenticated: false,
    lockExecutables: false
  };
}

function sendNativeRequest(request: NativePlanRequest | NativeStatusRequest, timeoutMs: number): Promise<NativeResponse> {
  const portEffect = Effect.callback<NativeResponse, ProviderError>((resume) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      resume(Effect.fail(classifyNativeError(error)));
      return;
    }

    port.onMessage.addListener((response) => {
      if (!response || response.requestId !== request.requestId || response.type !== RESPONSE_TYPE) {
        resume(Effect.fail(providerError("native-host-protocol-error", "Local CLI bridge returned an unexpected response.")));
        return;
      }
      if (!response.ok) {
        resume(Effect.fail(providerError(response.error?.kind || "native-host-protocol-error", response.error?.message || "Local CLI bridge failed.")));
        return;
      }
      resume(Effect.succeed(response));
    });

    port.onDisconnect.addListener(() => {
      resume(Effect.fail(classifyNativeError(chrome.runtime.lastError)));
    });

    try {
      port.postMessage(request);
    } catch (error) {
      resume(Effect.fail(classifyNativeError(error)));
      return;
    }

    // Runs only if the fiber is interrupted (i.e. when the timeout below fires) -
    // never on a normal resume() completion. Verified empirically before wiring
    // this in: disconnect() fires exactly once per timeout and zero times on
    // every other exit path.
    return Effect.sync(() => {
      try {
        port.disconnect();
      } catch {
        // Ignore disconnect failures during interruption cleanup.
      }
    });
  });

  const withTimeout = portEffect.pipe(
    Effect.timeout(timeoutMs + EXTENSION_TIMEOUT_MARGIN_MS),
    Effect.mapError((error) =>
      Cause.isTimeoutError(error) ? providerError("provider-timeout", "Local CLI provider timed out.") : error
    )
  );

  return Effect.runPromiseExit(withTimeout).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    const originalError = Exit.findErrorOption(exit);
    if (Option.isSome(originalError)) {
      throw originalError.value;
    }
    throw Cause.squash(exit.cause);
  });
}

function normalizeCliProvider(provider: Provider | LocalCliProvider): LocalCliProvider {
  if (provider === "local-codex-cli" || provider === "codex") {
    return "codex";
  }
  if (provider === "local-claude-cli" || provider === "claude") {
    return "claude";
  }
  throw providerError("native-host-protocol-error", `Unsupported local CLI provider: ${provider}`);
}

async function ensureNativeMessagingPermission() {
  if (!globalThis.chrome?.permissions?.contains) {
    throw providerError("missing-native-permission", "Native messaging permission is unavailable. Re-save the provider in options.");
  }

  const hasPermission = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  if (!hasPermission) {
    throw providerError("missing-native-permission", "Native messaging permission is missing. Re-save the provider in options.");
  }
}

function classifyNativeError(error: unknown): ProviderError {
  const message = readErrorMessage(error, "Local CLI bridge disconnected.");
  if (/host.*not found|specified native messaging host not found/i.test(message)) {
    return providerError("native-host-not-found", "Tab Grouper native bridge is not installed.");
  }
  if (/forbidden|not allowed|access/i.test(message)) {
    return providerError("native-host-forbidden", "Tab Grouper native bridge is not allowed for this extension.");
  }
  return providerError("native-host-protocol-error", message);
}

function readErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error || fallback);
}

function providerError(kind: ProviderErrorKind, message: string): ProviderError {
  const error: ProviderError = new Error(message);
  error.providerErrorKind = kind;
  return error;
}

function getNativeRequestTimeoutMs(settings: NativeCliSettings): number {
  const rawTimeoutMs = Number(settings.providerRequestTimeoutMs);
  if (!Number.isFinite(rawTimeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.min(30000, Math.trunc(rawTimeoutMs)));
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `native-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function omitUndefined<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}
