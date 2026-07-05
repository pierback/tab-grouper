import { getProviderLabel } from "./provider_metadata.js";

export function createPlanResponse(planResult, extras = {}) {
  const groups = planResult.plan.groups.map((group) => ({
    name: group.name,
    color: group.color,
    count: group.tabIds.length
  }));

  return {
    ok: true,
    groupedCount: groups.reduce((sum, group) => sum + group.count, 0),
    groups,
    skipped: planResult.skipped,
    provider: planResult.providerResult.provider,
    requestedProvider: planResult.providerResult.requestedProvider,
    usedFallback: planResult.providerResult.usedFallback,
    providerError: planResult.providerResult.providerError,
    providerErrorKind: planResult.providerResult.providerErrorKind || "",
    undoAvailable: false,
    message: buildPlanMessage(planResult, extras),
    ...extras
  };
}

export function buildTidySuccessMessage(appliedGroups, skipped, providerResult) {
  const parts = [
    `Created ${appliedGroups.length} group${appliedGroups.length === 1 ? "" : "s"}.`
  ];
  if (providerResult.usedFallback) {
    parts.push(buildFallbackText(providerResult));
  }
  const skippedText = buildSkippedText(skipped);
  if (skippedText) {
    parts.push(skippedText);
  }
  return parts.join(" ");
}

export function buildPlanMessage(planResult, extras = {}) {
  if (planResult.reason === "too-few-tabs") {
    return "Not enough tabs to group.";
  }

  if (planResult.reason === "stale-plan") {
    return "Tabs changed while tidying; no useful groups remain.";
  }

  if (!planResult.canApply) {
    return buildNoGroupsMessage(planResult.providerResult);
  }

  const parts = [
    `${extras.preview ? "Would create" : "Ready to create"} ${planResult.plan.groups.length} group${planResult.plan.groups.length === 1 ? "" : "s"}.`
  ];
  if (planResult.providerResult.usedFallback) {
    parts.push(buildFallbackText(planResult.providerResult));
  }
  const skippedText = buildSkippedText(planResult.skipped);
  if (skippedText) {
    parts.push(skippedText);
  }
  return parts.join(" ");
}

export function buildNoGroupsMessage(providerResult) {
  if (providerResult.usedFallback) {
    return `${buildFallbackText(providerResult)} Local fallback found no useful groups.`;
  }
  return "No useful groups found.";
}

export function buildFallbackText(providerResult) {
  const requestedProviderLabel = providerResult.requestedProvider
    ? getProviderLabel(providerResult.requestedProvider)
    : "the requested provider";
  const actualProviderLabel = getProviderLabel(providerResult.provider || "heuristic");
  const providerError = providerResult.providerError ? ` Provider error: ${providerResult.providerError}` : "";
  const prefix = `Used ${actualProviderLabel} instead of ${requestedProviderLabel}.`;
  if (providerResult.providerErrorKind === "missing-host-permission") {
    return `${prefix} API host permission is missing.${providerError}`;
  }
  if (providerResult.providerErrorKind === "missing-api-key") {
    return `${prefix} API key is missing.${providerError}`;
  }
  if (providerResult.providerErrorKind === "missing-model") {
    return `${prefix} Provider model is missing.${providerError}`;
  }
  if (providerResult.providerErrorKind === "provider-timeout") {
    return `${prefix} Provider timed out.${providerError}`;
  }
  if (providerResult.providerErrorKind === "missing-native-permission") {
    return `${prefix} Native messaging permission is missing.${providerError}`;
  }
  if (providerResult.providerErrorKind === "native-host-not-found") {
    return `${prefix} Local CLI bridge is not installed.${providerError}`;
  }
  if (providerResult.providerErrorKind === "native-host-forbidden") {
    return `${prefix} Local CLI bridge is not allowed.${providerError}`;
  }
  if (providerResult.providerErrorKind === "native-host-protocol-error") {
    return `${prefix} Local CLI bridge failed.${providerError}`;
  }
  if (providerResult.providerErrorKind === "native-host-config-error") {
    return `${prefix} Local CLI bridge is not configured correctly.${providerError}`;
  }
  if (providerResult.providerErrorKind === "cli-timeout") {
    return `${prefix} Local CLI timed out.${providerError}`;
  }
  if (providerResult.providerErrorKind === "cli-not-found") {
    return `${prefix} Selected CLI is not installed.${providerError}`;
  }
  if (providerResult.providerErrorKind === "cli-auth-missing") {
    return `${prefix} Selected CLI is not signed in.${providerError}`;
  }
  if (providerResult.providerErrorKind === "cli-error") {
    return `${prefix} Selected CLI failed.${providerError}`;
  }
  if (providerResult.providerErrorKind === "malformed-output") {
    return `${prefix} Local CLI returned invalid JSON.${providerError}`;
  }
  return `${prefix}${providerError}`;
}

export function buildSkippedText(skipped) {
  const parts = [];
  if (skipped.alreadyGrouped > 0) {
    parts.push(`${skipped.alreadyGrouped} already grouped`);
  }
  if (skipped.pinned > 0) {
    parts.push(`${skipped.pinned} pinned`);
  }
  if (parts.length === 0) {
    return "";
  }
  return `Skipped ${parts.join(", ")}.`;
}
