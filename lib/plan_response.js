export function createPlanResponse(planResult, extras = {}) {
  const groups = planResult.plan.groups.map((group) => ({
    name: group.name,
    color: group.color,
    count: group.tabIds.length
  }));
  const assignments = (planResult.plan.assignments || []).map((assignment) => ({
    groupId: assignment.groupId,
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
  if (providerResult.providerErrorKind === "missing-host-permission") {
    return "Used local fallback because API host permission is missing.";
  }
  if (providerResult.providerErrorKind === "missing-api-key") {
    return "Used local fallback because the API key is missing.";
  }
  if (providerResult.providerErrorKind === "missing-model") {
    return "Used local fallback because the provider model is missing.";
  }
  if (providerResult.providerErrorKind === "provider-timeout") {
    return "Used local fallback because the provider timed out.";
  }
  if (providerResult.providerErrorKind === "missing-native-permission") {
    return "Used local fallback because native messaging permission is missing.";
  }
  if (providerResult.providerErrorKind === "native-host-not-found") {
    return "Used local fallback because the local CLI bridge is not installed.";
  }
  if (providerResult.providerErrorKind === "native-host-forbidden") {
    return "Used local fallback because the local CLI bridge is not allowed.";
  }
  if (providerResult.providerErrorKind === "native-host-protocol-error") {
    return "Used local fallback because the local CLI bridge failed.";
  }
  if (providerResult.providerErrorKind === "native-host-config-error") {
    return "Used local fallback because the local CLI bridge is not configured correctly.";
  }
  if (providerResult.providerErrorKind === "cli-timeout") {
    return "Used local fallback because the local CLI timed out.";
  }
  if (providerResult.providerErrorKind === "cli-not-found") {
    return "Used local fallback because the selected CLI is not installed.";
  }
  if (providerResult.providerErrorKind === "cli-auth-missing") {
    return "Used local fallback because the selected CLI is not signed in.";
  }
  if (providerResult.providerErrorKind === "cli-error") {
    return "Used local fallback because the selected CLI failed.";
  }
  if (providerResult.providerErrorKind === "malformed-output") {
    return "Used local fallback because the local CLI returned invalid JSON.";
  }
  return "Used local fallback.";
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
