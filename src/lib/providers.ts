import { TAB_GROUP_PLAN_SCHEMA } from "./schema.js";
import { groupTabsHeuristically } from "./heuristics.js";
import { getProviderLabel, getProviderOrigins } from "./provider_metadata.js";
import { createProviderError, omitUndefined } from "./provider_result.js";
import { createPlanWithNativeCli } from "./native_cli_provider.js";
import type {
  ExistingGroup,
  LocalTabRecord,
  Provider,
  ProviderError,
  ProviderErrorKind,
  ProviderResult,
  PromptTabRecord,
  RawTabGroupPlan,
  Settings,
  TabGroupPlan
} from "./types.js";

const SYSTEM_PROMPT = [
  "You group browser tabs into practical tab groups.",
  "Use only the tab IDs provided by the user.",
  "Group by user intent or task first; use domain only as a fallback.",
  "existingGroups are current Chrome tab groups; prefer assignments to a fitting existing group over creating a near-duplicate.",
  "Assignments use {\"assignments\":[{\"groupId\":3,\"tabIds\":[7,8]}]}.",
  "Always include both top-level arrays: groups and assignments. Use an empty array when there are no entries.",
  "Prefer a few useful groups over many tiny groups.",
  "Leave unrelated single tabs ungrouped by omitting them.",
  "Group names should be short concrete noun phrases, never generic labels like Misc, Other, General, or Stuff.",
  "Allowed colors are grey, blue, red, yellow, green, pink, purple, cyan, and orange."
].join(" ");

const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 12000;

type JsonObject = Record<string, any>;
type ProviderSettings = Pick<Settings, "provider"> & Partial<Settings>;

export async function createGroupPlan(
  tabs: PromptTabRecord[] | LocalTabRecord[],
  settings: ProviderSettings,
  existingGroups: ExistingGroup[] = []
): Promise<RawTabGroupPlan | TabGroupPlan> {
  if (settings.provider === "heuristic") {
    return groupTabsHeuristically(tabs as LocalTabRecord[], settings);
  }

  if (settings.provider === "chrome-ai") {
    return createPlanWithChromeAI(tabs, settings, existingGroups);
  }

  if (settings.provider === "local-codex-cli") {
    return createPlanWithNativeCli(tabs, settings, "codex", existingGroups);
  }

  if (settings.provider === "local-claude-cli") {
    return createPlanWithNativeCli(tabs, settings, "claude", existingGroups);
  }

  if (settings.provider === "openai") {
    return createPlanWithOpenAI(tabs, settings, existingGroups);
  }

  if (settings.provider === "anthropic") {
    return createPlanWithAnthropic(tabs, settings, existingGroups);
  }

  throw new Error(`Unknown provider: ${settings.provider}`);
}

export async function createGroupPlanWithFallback(
  tabs: PromptTabRecord[],
  settings: ProviderSettings,
  localTabs: LocalTabRecord[] = tabs as unknown as LocalTabRecord[],
  existingGroups: ExistingGroup[] = []
): Promise<ProviderResult> {
  if (settings.provider === "heuristic") {
    const plan = groupTabsHeuristically(localTabs, settings);
    return {
      plan,
      provider: "heuristic",
      usedFallback: false,
      providerError: "",
      providerErrorKind: "",
      ...timingFieldsFromPlan(plan)
    };
  }

  try {
    const plan = await createGroupPlan(tabs, settings, existingGroups);
    return {
      plan,
      provider: settings.provider,
      usedFallback: false,
      providerError: "",
      providerErrorKind: "",
      ...timingFieldsFromPlan(plan)
    };
  } catch (error) {
    const providerError = normalizeProviderError(error);
    if (settings.allowHeuristicFallback === false) {
      throw createProviderError(providerError.kind, providerError.message);
    }
    const plan = groupTabsHeuristically(localTabs, settings);
    return {
      plan,
      provider: "heuristic",
      requestedProvider: settings.provider,
      usedFallback: true,
      providerError: providerError.message,
      providerErrorKind: providerError.kind,
      ...timingFieldsFromPlan(plan)
    };
  }
}

async function createPlanWithChromeAI(tabs: PromptTabRecord[], settings: ProviderSettings, existingGroups: ExistingGroup[]): Promise<RawTabGroupPlan> {
  const timeoutMs = getProviderRequestTimeoutMs(settings);
  const LanguageModelCtor = (globalThis as typeof globalThis & { LanguageModel?: typeof LanguageModel }).LanguageModel;
  if (!LanguageModelCtor) {
    throw new Error("Chrome built-in AI is not available in this browser.");
  }

  const availability = await withProviderTimeout(
    "Chrome built-in AI",
    () => LanguageModelCtor.availability(),
    timeoutMs
  );
  if (availability === "unavailable") {
    throw new Error("Chrome built-in AI model is unavailable on this device.");
  }

  const session = await withProviderTimeout(
    "Chrome built-in AI",
    () => LanguageModelCtor.create(),
    timeoutMs
  );
  const start = Date.now();
  const result = await withProviderTimeout(
    "Chrome built-in AI",
    () => session.prompt(`${SYSTEM_PROMPT}\n\n${buildUserPrompt(tabs, existingGroups)}`, {
      responseConstraint: TAB_GROUP_PLAN_SCHEMA
    }),
    timeoutMs
  );
  const durationMs = Date.now() - start;

  const plan = parseJsonText(result, "Chrome built-in AI returned invalid JSON.");
  plan.timing = {
    durationMs,
    ...readChromeAIUsage(session)
  };
  return plan;
}

async function createPlanWithOpenAI(tabs: PromptTabRecord[], settings: ProviderSettings, existingGroups: ExistingGroup[]): Promise<RawTabGroupPlan> {
  if (!settings.openaiApiKey) {
    throw createProviderError("missing-api-key", "Add an OpenAI API key in the extension options.");
  }
  if (!settings.openaiModel) {
    throw createProviderError("missing-model", "Choose an OpenAI model in the extension options.");
  }
  await ensureProviderHostPermission("openai");

  const start = Date.now();
  const response = await fetchWithProviderTimeout("OpenAI", "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.openaiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: SYSTEM_PROMPT
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildUserPrompt(tabs, existingGroups)
            }
          ]
        }
      ],
      max_output_tokens: 6000,
      text: {
        format: {
          type: "json_schema",
          name: "tab_group_plan",
          strict: true,
          schema: TAB_GROUP_PLAN_SCHEMA
        }
      }
    })
  }, getProviderRequestTimeoutMs(settings));

  const durationMs = Date.now() - start;
  const json = await response.json().catch(() => null) as JsonObject | null;
  if (!response.ok) {
    throw new Error(readProviderError(json, `OpenAI request failed with ${response.status}.`));
  }

  const plan = parseJsonText(extractOpenAIText(json), "OpenAI returned invalid JSON.");
  plan.timing = {
    durationMs,
    inputTokens: json?.usage?.input_tokens,
    outputTokens: json?.usage?.output_tokens
  };
  return plan;
}

async function createPlanWithAnthropic(tabs: PromptTabRecord[], settings: ProviderSettings, existingGroups: ExistingGroup[]): Promise<RawTabGroupPlan> {
  if (!settings.anthropicApiKey) {
    throw createProviderError("missing-api-key", "Add an Anthropic API key in the extension options.");
  }
  if (!settings.anthropicModel) {
    throw createProviderError("missing-model", "Choose an Anthropic model in the extension options.");
  }
  await ensureProviderHostPermission("anthropic");

  const start = Date.now();
  const response = await fetchWithProviderTimeout("Anthropic", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": settings.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.anthropicModel,
      max_tokens: 6000,
      system: `${SYSTEM_PROMPT} Return only JSON with this shape: ${JSON.stringify(TAB_GROUP_PLAN_SCHEMA)}`,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(tabs, existingGroups)
        }
      ]
    })
  }, getProviderRequestTimeoutMs(settings));

  const durationMs = Date.now() - start;
  const json = await response.json().catch(() => null) as JsonObject | null;
  if (!response.ok) {
    throw new Error(readProviderError(json, `Anthropic request failed with ${response.status}.`));
  }

  const plan = parseJsonText(extractAnthropicText(json), "Anthropic returned invalid JSON.");
  plan.timing = {
    durationMs,
    inputTokens: json?.usage?.input_tokens,
    outputTokens: json?.usage?.output_tokens
  };
  return plan;
}

function timingFieldsFromPlan(plan: RawTabGroupPlan | TabGroupPlan) {
  const timing = plan?.timing || {};
  return omitUndefined({
    durationMs: timing.durationMs,
    inputTokens: timing.inputTokens,
    outputTokens: timing.outputTokens,
    costUsd: timing.costUsd
  });
}

function readChromeAIUsage(session: LanguageModel) {
  const usage = (session as LanguageModel & {
    usage?: JsonObject;
    lastUsage?: JsonObject;
    lastResponse?: { usage?: JsonObject };
  })?.usage || (session as any)?.lastUsage || (session as any)?.lastResponse?.usage;
  return omitUndefined({
    inputTokens: usage?.inputTokens ?? usage?.input_tokens,
    outputTokens: usage?.outputTokens ?? usage?.output_tokens
  });
}

function buildUserPrompt(tabs: PromptTabRecord[], existingGroups: ExistingGroup[] = []): string {
  return [
    "Plan groups for these browser tabs. Add ungrouped tabs to matching existingGroups when appropriate.",
    "Return JSON only.",
    JSON.stringify({ tabs, existingGroups }, null, 2)
  ].join("\n\n");
}

function extractOpenAIText(responseJson: JsonObject | null): string {
  if (typeof responseJson?.output_text === "string") {
    return responseJson.output_text;
  }

  const chunks = [];
  for (const item of responseJson?.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("");
}

function extractAnthropicText(responseJson: JsonObject | null): string {
  return (responseJson?.content || [])
    .filter((part: JsonObject) => part.type === "text" && typeof part.text === "string")
    .map((part: JsonObject) => part.text)
    .join("\n");
}

function parseJsonText(text: unknown, errorMessage: string): RawTabGroupPlan {
  const rawText = String(text || "").trim();
  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(errorMessage);
  }
}

function readProviderError(json: JsonObject | null, fallback: string): string {
  if (typeof json?.error?.message === "string") {
    return json.error.message;
  }
  if (typeof json?.message === "string") {
    return json.message;
  }
  return fallback;
}

async function fetchWithProviderTimeout(providerLabel: string, url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw providerTimeoutError(providerLabel, timeoutMs);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function withProviderTimeout<T>(providerLabel: string, callback: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((resolve, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(providerTimeoutError(providerLabel, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([callback(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

function getProviderRequestTimeoutMs(settings: Partial<Settings>): number {
  const rawTimeoutMs = Number(settings.providerRequestTimeoutMs);
  if (!Number.isFinite(rawTimeoutMs)) {
    return DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  }
  return Math.max(100, Math.min(30000, Math.trunc(rawTimeoutMs)));
}

function providerTimeoutError(providerLabel: string, timeoutMs: number) {
  return createProviderError(
    "provider-timeout",
    `${providerLabel} request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function ensureProviderHostPermission(provider: Provider): Promise<void> {
  const origins = getProviderOrigins(provider);
  if (origins.length === 0) {
    return;
  }

  if (!globalThis.chrome?.permissions?.contains) {
    throw createProviderError(
      "missing-host-permission",
      `${getProviderLabel(provider)} host permission is unavailable. Re-save the provider in options.`
    );
  }

  const isGranted = await chrome.permissions.contains({ origins });
  if (!isGranted) {
    throw createProviderError(
      "missing-host-permission",
      `${getProviderLabel(provider)} host permission is missing. Re-save the provider in options.`
    );
  }
}

function normalizeProviderError(error: unknown): { kind: ProviderErrorKind; message: string } {
  const providerError = error as ProviderError | undefined;
  return {
    kind: providerError?.providerErrorKind || "provider-error",
    message: providerError?.message || String(error)
  };
}
