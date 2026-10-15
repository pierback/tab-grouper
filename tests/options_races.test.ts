import assert from "node:assert/strict";
import { test } from "node:test";
import { importOptions, waitUntil } from "./fixtures/options.js";

await test("shows saved reasoning after model discovery and resets it for an incompatible model choice", async () => {
  const { elements, chrome } = await importOptions({
    stored: {
      provider: "local-claude-cli",
      codexCliModel: "gpt-5.4-mini",
      codexReasoningEffort: "xhigh"
    },
    nativeModels: [
      { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", supportedReasoningLevels: ["low", "medium", "high"] },
      { slug: "gpt-5.4-nano", displayName: "GPT-5.4-Nano", supportedReasoningLevels: ["low"] }
    ]
  });
  elements.provider.value = "local-codex-cli";
  await elements.provider.dispatch("change");
  assert.equal(chrome.__state.storage.codexReasoningEffort, "xhigh");
  assert.equal(elements.reasoning.value, "xhigh");
  assert.ok(elements.reasoning.children.some((option) => option.value === "xhigh" && option.textContent === "xhigh (saved)"));

  elements.model.value = "gpt-5.4-nano";
  await elements.model.dispatch("change");
  await waitUntil(() => chrome.__state.storage.codexCliModel === "gpt-5.4-nano");
  assert.equal(elements.reasoning.value, "");
  assert.equal(chrome.__state.storage.codexReasoningEffort, "");
});


await test("keeps provider controls locked across retries after a failed provider write", async () => {
  const { elements, chrome } = await importOptions({ deferStorageWrites: true });
  const save = chrome.storage.local.set;
  let failNextWrite = true;
  chrome.storage.local.set = async (values) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("Storage temporarily unavailable");
    }
    await save(values);
  };
  elements.provider.value = "openai";
  await elements.provider.dispatch("change");
  assert.equal(elements["save-status"].textContent, "Storage temporarily unavailable");

  elements.includeFullUrls.checked = true;
  await elements.includeFullUrls.dispatch("change");
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);
  elements.minimumGroupSize.value = "4";
  await elements.minimumGroupSize.dispatch("change");
  assert.equal(elements.provider.disabled, true);
  assert.equal(elements["test-native-bridge"].disabled, true);
  elements.provider.value = "local-claude-cli";
  await elements.provider.dispatch("change");
  assert.equal(chrome.__state.permissionRequests.length, 1);

  chrome.__state.pendingStorageWrites.shift()!();
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);
  assert.equal(elements.provider.disabled, true);
  chrome.__state.pendingStorageWrites.shift()!();
  await waitUntil(() => !elements.provider.disabled);
  assert.equal(elements["save-status"].textContent, "Saved");
  assert.equal(chrome.__state.storage.minimumGroupSize, 4);

  elements.provider.value = "local-claude-cli";
  const change = elements.provider.dispatch("change");
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);
  chrome.__state.pendingStorageWrites.shift()!();
  await change;
  assert.equal(chrome.__state.storage.provider, "local-claude-cli");
  assert.equal(chrome.__state.nativePermissionGranted, true);
});

await test("reports an unrelated save as complete during a bridge permission check", async () => {
  const { elements, chrome } = await importOptions({
    deferPermissionRequests: true,
    stored: { provider: "local-claude-cli" }
  });
  const bridge = elements["test-native-bridge"].dispatch("click");
  await waitUntil(() => chrome.__state.pendingPermissionRequests.length === 1);
  elements.minimumGroupSize.value = "4";
  await elements.minimumGroupSize.dispatch("change");
  await waitUntil(() => chrome.__state.storage.minimumGroupSize === 4);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements["save-status"].textContent, "Saved");
  chrome.__state.pendingPermissionRequests.shift()!();
  await bridge;
  assert.equal(elements["save-status"].textContent, "Saved");
});


await test("keeps provider-specific models intact while permission is pending", async () => {
  const { elements, chrome } = await importOptions({
    nativePermissionGranted: true,
    deferPermissionRequests: true,
    stored: {
      provider: "local-codex-cli",
      codexCliModel: "gpt-5.4-mini",
      codexReasoningEffort: "high",
      claudeCliModel: "claude-sonnet-5",
      claudeReasoningEffort: "max"
    }
  });
  elements.provider.value = "local-claude-cli";
  const change = elements.provider.dispatch("change");
  elements.includeFullUrls.checked = true;
  await elements.includeFullUrls.dispatch("change");
  await waitUntil(() => chrome.__state.storage.includeFullUrls === true);
  const pending = { ...chrome.__state.storage };
  chrome.__state.pendingPermissionRequests.shift()!();
  await change;

  assert.equal(pending.provider, "local-codex-cli");
  assert.equal(pending.codexCliModel, "gpt-5.4-mini");
  assert.equal(pending.codexReasoningEffort, "high");
  assert.equal(chrome.__state.storage.provider, "local-claude-cli");
  assert.equal(chrome.__state.storage.codexCliModel, "gpt-5.4-mini");
  assert.equal(chrome.__state.storage.claudeCliModel, "claude-sonnet-5");
  assert.equal(chrome.__state.storage.claudeReasoningEffort, "max");
});

await test("serializes provider grants and cleanup through the settings write", async () => {
  const { elements, chrome } = await importOptions({ deferStorageWrites: true });
  elements.provider.value = "openai";
  const openaiChange = elements.provider.dispatch("change");
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);
  assert.equal(elements.provider.disabled, true);
  assert.equal(elements["test-native-bridge"].disabled, true);

  // Even a synthetic change must not start another grant during the transaction.
  elements.provider.value = "local-claude-cli";
  await elements.provider.dispatch("change");
  assert.equal(chrome.__state.permissionRequests.length, 1);
  chrome.__state.pendingStorageWrites.shift()!();
  await openaiChange;
  assert.equal(elements.provider.disabled, false);

  elements.provider.value = "local-claude-cli";
  const claudeChange = elements.provider.dispatch("change");
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);
  chrome.__state.pendingStorageWrites.shift()!();
  await claudeChange;
  assert.equal(chrome.__state.storage.provider, "local-claude-cli");
  assert.equal(chrome.__state.nativePermissionGranted, true);
  assert.equal(elements["save-status"].textContent, "Saved");
});

await test("preserves unrelated edits when a provider permission is denied", async () => {
  const { elements, chrome } = await importOptions({
    permissionGrant: false,
    deferPermissionRequests: true
  });
  elements.provider.value = "local-claude-cli";
  const change = elements.provider.dispatch("change");
  elements.minimumGroupSize.value = "4";
  await elements.minimumGroupSize.dispatch("change");
  await waitUntil(() => chrome.__state.storage.minimumGroupSize === 4);
  chrome.__state.pendingPermissionRequests.shift()!();
  await change;
  assert.equal(chrome.__state.storage.provider, "heuristic");
  assert.equal(elements.provider.value, "heuristic");
  assert.equal(elements.minimumGroupSize.value, "4");
  assert.equal(elements["save-status"].classList.contains("error-text"), true);
});

await test("does not mark debounced edits saved when an earlier write finishes", async () => {
  const { elements, chrome } = await importOptions({ deferStorageWrites: true });
  let savePendingInput: (() => void) | undefined;
  globalThis.window.setTimeout = ((callback: () => void) => {
    savePendingInput = callback;
    return 2;
  }) as typeof window.setTimeout;

  elements.minimumGroupSize.value = "3";
  await elements.minimumGroupSize.dispatch("change");
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);
  elements.minimumGroupSize.value = "4";
  await elements.minimumGroupSize.dispatch("input");
  chrome.__state.pendingStorageWrites.shift()!();
  await waitUntil(() => chrome.__state.storage.minimumGroupSize === 3);
  assert.equal(elements["save-status"].textContent, "Editing");

  assert.ok(savePendingInput);
  savePendingInput();
  await waitUntil(() => chrome.__state.pendingStorageWrites.length === 1);
  chrome.__state.pendingStorageWrites.shift()!();
  await waitUntil(() => elements["save-status"].textContent === "Saved");
  assert.equal(chrome.__state.storage.minimumGroupSize, 4);
});

await test("ignores bridge status from a provider that is no longer selected", async () => {
  const { elements, chrome } = await importOptions({
    nativePermissionGranted: true,
    deferNativeStatusResponses: true,
    stored: { provider: "local-codex-cli", claudeCliModel: "claude-sonnet-5" }
  });
  const bridgeCheck = elements["test-native-bridge"].dispatch("click");
  await waitUntil(() => chrome.__state.pendingNativeStatusResponses.length === 1);
  elements.provider.value = "local-claude-cli";
  await elements.provider.dispatch("change");
  chrome.__state.pendingNativeStatusResponses.shift()!();
  await bridgeCheck;
  assert.equal(elements.model.value, "claude-sonnet-5");
  assert.doesNotMatch(elements["native-bridge-status"].textContent, /Codex/);
});

await test("holds provider selection until permission cleanup completes", async () => {
  const { elements, chrome } = await importOptions();
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let cleaning = false;
  const removePermissions = chrome.permissions.remove;
  chrome.permissions.remove = async (request) => {
    cleaning = true;
    await cleanup;
    return removePermissions(request);
  };
  elements.provider.value = "openai";
  const change = elements.provider.dispatch("change");
  await waitUntil(() => cleaning);
  assert.equal(chrome.__state.storage.provider, "openai");
  assert.equal(elements.provider.disabled, true);
  assert.equal(elements["save-status"].textContent, "Saving");
  releaseCleanup();
  await change;
  assert.equal(elements.provider.disabled, false);
  assert.equal(elements["save-status"].textContent, "Saved");
});

await test("reports cleanup failure without rolling back the stored provider", async () => {
  const { elements, chrome } = await importOptions();
  chrome.permissions.remove = async () => { throw new Error("Permission cleanup failed"); };
  elements.provider.value = "openai";
  await elements.provider.dispatch("change");
  assert.equal(chrome.__state.storage.provider, "openai");
  assert.equal(elements.provider.value, "openai");
  assert.equal(elements.provider.disabled, false);
  assert.equal(elements["save-status"].textContent, "Permission cleanup failed");
  assert.equal(elements["save-status"].classList.contains("error-text"), true);
});

await test("does not overlap a bridge permission grant with a provider change", async () => {
  const { elements, chrome } = await importOptions({
    nativePermissionGranted: true,
    deferPermissionRequests: true,
    stored: { provider: "local-codex-cli" }
  });
  const bridge = elements["test-native-bridge"].dispatch("click");
  await waitUntil(() => chrome.__state.pendingPermissionRequests.length === 1);
  assert.equal(elements.provider.disabled, true);
  elements.provider.value = "openai";
  await elements.provider.dispatch("change");
  assert.equal(chrome.__state.permissionRequests.length, 1);
  chrome.__state.pendingPermissionRequests.shift()!();
  await bridge;
  assert.equal(elements.provider.disabled, false);

  elements.provider.value = "openai";
  const change = elements.provider.dispatch("change");
  chrome.__state.pendingPermissionRequests.shift()!();
  await change;
  assert.equal(chrome.__state.storage.provider, "openai");
  assert.equal(chrome.__state.nativePermissionGranted, false);
});
