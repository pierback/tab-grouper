import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateProviderUsageCost } from "../src/lib/cost_estimate.js";

await test("does not assign a base model's price to unpriced variants", () => {
  for (const model of ["gpt-5.5-pro", "gpt-5.5-pro-2026-04-23", "gpt-5-chat-latest", "gpt-5.5-codex", "gpt-5.5-unknown"]) {
    assert.equal(estimateProviderUsageCost({ provider: "openai", openaiModel: model }, 1000, 1000), undefined, model);
  }
  assert.equal(estimateProviderUsageCost({ provider: "anthropic", anthropicModel: "claude-sonnet-5-unknown" }, 1000, 1000), undefined);
});

await test("recognizes exact model identities and provider-specific dated snapshots", () => {
  for (const model of ["gpt-5.5", "gpt-5.5-2026-04-23"]) {
    assert.equal(estimateProviderUsageCost({ provider: "openai", openaiModel: model }, 1000, 1000), 0.035);
  }
  assert.equal(estimateProviderUsageCost({ provider: "local-codex-cli", codexCliModel: "gpt-5.4-mini" }, 100, 25), 0.0001875);
  assert.equal(estimateProviderUsageCost({ provider: "local-claude-cli", claudeCliModel: "claude-haiku-4-5-20251001" }, 1000, 1000), 0.006);
  assert.equal(estimateProviderUsageCost({ provider: "openai", openaiModel: "gpt-5.5-20260423" }, 1000, 1000), undefined);
  assert.equal(estimateProviderUsageCost({ provider: "anthropic", anthropicModel: "claude-sonnet-5-2026-04-23" }, 1000, 1000), undefined);
});
