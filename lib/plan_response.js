import { getProviderLabel } from "./provider_metadata.js";

export function createPlanResponse(planResult, extras = {}) {
  const groups = planResult.plan.groups.map((group) => ({
    name: group.name,
    color: group.color,
    count: group.tabIds.length
  }));
  const titleByGroupId = buildExistingGroupTitleMap(planResult.existingGroups || []);
  const assignments = (planResult.plan.assignments || []).map((assignment) => ({
    groupId: assignment.groupId,
    title: titleByGroupId.get(assignment.groupId) || `Group ${assignment.groupId}`,
    count: assignment.tabIds.length
  }));

  return {
    ok: true,
    groupedCount: groups.reduce((sum, group) => sum + group.count, 0) +
      assignments.reduce((sum, assignment) => sum + assignment.count, 0),
    groups,
    assignments,
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

export function buildExistingGroupTitleMap(existingGroups) {
  const titleByGroupId = new Map();
  for (const group of existingGroups || []) {
    if (!Number.isInteger(group?.id)) {
      continue;
    }
    const title = String(group.title || "").trim();
    titleByGroupId.set(group.id, title || `Group ${group.id}`);
  }
  return titleByGroupId;
}

export function buildTidySuccessMessage(appliedGroups, skipped, providerResult, appliedAssignments = []) {
  const parts = buildChangeParts(
    "Created",
    appliedGroups.length,
    appliedAssignments.reduce((sum, assignment) => sum + assignment.count, 0)
  );
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

  const assignmentCount = (planResult.plan.assignments || [])
    .reduce((sum, assignment) => sum + assignment.tabIds.length, 0);
  const parts = buildChangeParts(
    extras.preview ? "Would create" : "Ready to create",
    planResult.plan.groups.length,
    assignmentCount
  );
  if (planResult.providerResult.usedFallback) {
    parts.push(buildFallbackText(planResult.providerResult));
  }
  const skippedText = buildSkippedText(planResult.skipped);
  if (skippedText) {
    parts.push(skippedText);
  }
  return parts.join(" ");
}

function buildChangeParts(createVerb, groupCount, assignmentCount) {
  const parts = [];
  if (groupCount > 0) {
    parts.push(`${createVerb} ${groupCount} group${groupCount === 1 ? "" : "s"}.`);
  }
  if (assignmentCount > 0) {
    const prefix = createVerb === "Created" ? "Added" : createVerb.replace("create", "add");
    parts.push(`${prefix} ${assignmentCount} tab${assignmentCount === 1 ? "" : "s"} to existing groups.`);
  }
  return parts;
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
