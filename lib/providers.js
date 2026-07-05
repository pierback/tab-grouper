import { TAB_GROUP_PLAN_SCHEMA } from "./schema.js";
import { groupTabsHeuristically } from "./heuristics.js";
import { getProviderLabel, getProviderOrigins } from "./provider_metadata.js";
import { createPlanWithNativeCli } from "./native_cli_provider.js";

const SYSTEM_PROMPT = [
  "You group browser tabs into practical tab groups.",
  "Use only the tab IDs provided by the user.",
  "Prefer a few useful groups over many tiny groups.",
  "Leave unrelated single tabs ungrouped by omitting them.",
  "Group names should be short, concrete, and readable in a browser tab strip.",
  "Allowed colors are grey, blue, red, yellow, green, pink, purple, cyan, and orange."
].join(" ");

const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 12000;

export async function createGroupPlan(tabs, settings, existingGroups = []) {
  if (settings.provider === "heuristic") {
    return groupTabsHeuristically(tabs, settings);
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

export async function createGroupPlanWithFallback(tabs, settings, localTabs = tabs, existingGroups = []) {
  if (settings.provider === "heuristic") {
    return {
      plan: groupTabsHeuristically(localTabs, settings),
      provider: "heuristic",
      usedFallback: false,
      providerError: "",
      providerErrorKind: ""
    };
  }

  try {
    return {
      plan: await createGroupPlan(tabs, settings, existingGroups),
      provider: settings.provider,
      usedFallback: false,
      providerError: "",
      providerErrorKind: ""
    };
  } catch (error) {
    const providerError = normalizeProviderError(error);
    return {
      plan: groupTabsHeuristically(localTabs, settings),
      provider: "heuristic",
      requestedProvider: settings.provider,
      usedFallback: true,
      providerError: providerError.message,
      providerErrorKind: providerError.kind
    };
  }
}

async function createPlanWithChromeAI(tabs, settings, existingGroups) {
  const timeoutMs = getProviderRequestTimeoutMs(settings);
  const LanguageModel = globalThis.LanguageModel;
  if (!LanguageModel) {
    throw new Error("Chrome built-in AI is not available in this browser.");
  }

  const availability = await withProviderTimeout(
    "Chrome built-in AI",
    () => LanguageModel.availability(),
    timeoutMs
  );
  if (availability === "unavailable") {
    throw new Error("Chrome built-in AI model is unavailable on this device.");
  }

  const session = await withProviderTimeout(
    "Chrome built-in AI",
    () => LanguageModel.create(),
    timeoutMs
  );
  const result = await withProviderTimeout(
    "Chrome built-in AI",
    () => session.prompt(`${SYSTEM_PROMPT}\n\n${buildUserPrompt(tabs, existingGroups)}`, {
      responseConstraint: TAB_GROUP_PLAN_SCHEMA
    }),
    timeoutMs
  );

  return parseJsonText(result, "Chrome built-in AI returned invalid JSON.");
}

async function createPlanWithOpenAI(tabs, settings, existingGroups) {
  if (!settings.openaiApiKey) {
    throw providerConfigurationError("missing-api-key", "Add an OpenAI API key in the extension options.");
  }
  if (!settings.openaiModel) {
    throw providerConfigurationError("missing-model", "Choose an OpenAI model in the extension options.");
  }
  await ensureProviderHostPermission("openai");

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
      max_output_tokens: 1200,
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

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readProviderError(json, `OpenAI request failed with ${response.status}.`));
  }

  return parseJsonText(extractOpenAIText(json), "OpenAI returned invalid JSON.");
}

async function createPlanWithAnthropic(tabs, settings, existingGroups) {
  if (!settings.anthropicApiKey) {
    throw providerConfigurationError("missing-api-key", "Add an Anthropic API key in the extension options.");
  }
  if (!settings.anthropicModel) {
    throw providerConfigurationError("missing-model", "Choose an Anthropic model in the extension options.");
  }
  await ensureProviderHostPermission("anthropic");

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
      max_tokens: 1200,
      system: `${SYSTEM_PROMPT} Return only JSON with this shape: ${JSON.stringify(TAB_GROUP_PLAN_SCHEMA)}`,
      messages: [
        {
          role: "user",
          content: buildUserPrompt(tabs, existingGroups)
        }
      ]
    })
  }, getProviderRequestTimeoutMs(settings));

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readProviderError(json, `Anthropic request failed with ${response.status}.`));
  }

  return parseJsonText(extractAnthropicText(json), "Anthropic returned invalid JSON.");
}

function buildUserPrompt(tabs, existingGroups = []) {
  return [
    "Group these browser tabs.",
    "Return JSON only.",
    JSON.stringify({ tabs, existingGroups }, null, 2)
  ].join("\n\n");
}

function extractOpenAIText(responseJson) {
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

function extractAnthropicText(responseJson) {
  return (responseJson?.content || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function parseJsonText(text, errorMessage) {
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

function readProviderError(json, fallback) {
  if (typeof json?.error?.message === "string") {
    return json.error.message;
  }
  if (typeof json?.message === "string") {
    return json.message;
  }
  return fallback;
}

async function fetchWithProviderTimeout(providerLabel, url, options, timeoutMs) {
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

async function withProviderTimeout(providerLabel, callback, timeoutMs) {
  let timeoutId;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(providerTimeoutError(providerLabel, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([callback(), timeoutPromise]);
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function getProviderRequestTimeoutMs(settings) {
  const rawTimeoutMs = Number(settings.providerRequestTimeoutMs);
  if (!Number.isFinite(rawTimeoutMs)) {
    return DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  }
  return Math.max(100, Math.min(30000, Math.trunc(rawTimeoutMs)));
}

function providerTimeoutError(providerLabel, timeoutMs) {
  return providerConfigurationError(
    "provider-timeout",
    `${providerLabel} request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
  );
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

async function ensureProviderHostPermission(provider) {
  const origins = getProviderOrigins(provider);
  if (origins.length === 0) {
    return;
  }

  if (!globalThis.chrome?.permissions?.contains) {
    throw providerConfigurationError(
      "missing-host-permission",
      `${getProviderLabel(provider)} host permission is unavailable. Re-save the provider in options.`
    );
  }

  const isGranted = await chrome.permissions.contains({ origins });
  if (!isGranted) {
    throw providerConfigurationError(
      "missing-host-permission",
      `${getProviderLabel(provider)} host permission is missing. Re-save the provider in options.`
    );
  }
}

function providerConfigurationError(kind, message) {
  const error = new Error(message);
  error.providerErrorKind = kind;
  return error;
}

function normalizeProviderError(error) {
  return {
    kind: error?.providerErrorKind || "provider-error",
    message: error?.message || String(error)
  };
}
