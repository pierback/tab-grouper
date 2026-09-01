import type { Provider, Settings } from "./types.js";

type CostSettings = Pick<Settings, "provider"> & Partial<Pick<
  Settings,
  "openaiModel" | "anthropicModel" | "codexCliModel" | "claudeCliModel"
>>;

interface ModelPrice {
  provider: "openai" | "anthropic";
  modelPrefix: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

// Standard API-equivalent text-token prices, verified 2026-08-12 from the
// providers' first-party pricing pages. Local subscription plans may bill
// differently, so callers surface these values explicitly as API estimates.
const MODEL_PRICES: ModelPrice[] = [
  { provider: "openai", modelPrefix: "gpt-5.4-mini", inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5 },
  { provider: "openai", modelPrefix: "gpt-5.4-nano", inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.25 },
  { provider: "openai", modelPrefix: "gpt-5.5", inputUsdPerMillion: 5, outputUsdPerMillion: 30 },
  { provider: "openai", modelPrefix: "gpt-5.4", inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 },
  { provider: "openai", modelPrefix: "gpt-5-mini", inputUsdPerMillion: 0.25, outputUsdPerMillion: 2 },
  { provider: "openai", modelPrefix: "gpt-5-nano", inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.4 },
  { provider: "openai", modelPrefix: "gpt-5", inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
  { provider: "anthropic", modelPrefix: "claude-fable-5", inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
  { provider: "anthropic", modelPrefix: "claude-opus-4-8", inputUsdPerMillion: 5, outputUsdPerMillion: 25 },
  { provider: "anthropic", modelPrefix: "claude-sonnet-5", inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  { provider: "anthropic", modelPrefix: "claude-sonnet-4-6", inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  { provider: "anthropic", modelPrefix: "claude-haiku-4-5", inputUsdPerMillion: 1, outputUsdPerMillion: 5 }
];

export function estimateProviderUsageCost(
  settings: CostSettings,
  inputTokens: unknown,
  outputTokens: unknown
): number | undefined {
  const input = finiteNonNegativeNumber(inputTokens);
  const output = finiteNonNegativeNumber(outputTokens);
  if (input === undefined && output === undefined) {
    return undefined;
  }

  const providerFamily = getPricingProvider(settings.provider);
  const model = getPricingModel(settings);
  if (!providerFamily || !model) {
    return undefined;
  }

  const price = MODEL_PRICES.find((candidate) =>
    candidate.provider === providerFamily && modelMatchesPrefix(model, candidate.modelPrefix)
  );
  if (!price) {
    return undefined;
  }

  return (((input || 0) * price.inputUsdPerMillion) + ((output || 0) * price.outputUsdPerMillion)) / 1_000_000;
}

function getPricingProvider(provider: Provider): ModelPrice["provider"] | undefined {
  if (provider === "openai" || provider === "local-codex-cli") {
    return "openai";
  }
  if (provider === "anthropic" || provider === "local-claude-cli") {
    return "anthropic";
  }
  return undefined;
}

function getPricingModel(settings: CostSettings): string {
  switch (settings.provider) {
    case "openai":
      return String(settings.openaiModel || "").trim().toLowerCase();
    case "anthropic":
      return String(settings.anthropicModel || "").trim().toLowerCase();
    case "local-codex-cli":
      return String(settings.codexCliModel || "").trim().toLowerCase();
    case "local-claude-cli":
      return String(settings.claudeCliModel || "").trim().toLowerCase();
    default:
      return "";
  }
}

function modelMatchesPrefix(model: string, prefix: string): boolean {
  return model === prefix || model.startsWith(`${prefix}-`);
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
