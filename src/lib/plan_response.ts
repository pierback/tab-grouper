import { getProviderLabel } from "./provider_metadata.js";
import type {
  AppliedAssignment,
  CurrentWindowPlanResult,
  ExistingGroup,
  PlanGroup,
  Provider,
  ProviderResult,
  ProviderErrorKind,
  SkippedCounts
} from "./types.js";

interface PlanResponseExtras {
  preview?: boolean;
  undoAvailable?: boolean;
}

type PlanResponseProviderResult = Pick<ProviderResult, "usedFallback"> & Partial<{
  provider: Provider | string;
  requestedProvider: Provider | string;
  providerError: string;
  providerErrorKind: ProviderErrorKind | string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costBasis: ProviderResult["costBasis"];
}>;

type ResponsePlanGroup = Pick<PlanGroup, "name" | "tabIds"> & { color?: string };

interface PlanResponseInput {
  canApply: CurrentWindowPlanResult["canApply"];
  reason: CurrentWindowPlanResult["reason"] | string;
  skipped: SkippedCounts;
  plan: {
    groups: ResponsePlanGroup[];
    assignments?: CurrentWindowPlanResult["plan"]["assignments"];
  };
  providerResult: PlanResponseProviderResult;
  existingGroups?: Array<Pick<ExistingGroup, "id" | "title"> & Partial<ExistingGroup>>;
}

export function createPlanResponse(planResult: PlanResponseInput, extras: PlanResponseExtras = {}) {
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
    durationMs: planResult.providerResult.durationMs,
    inputTokens: planResult.providerResult.inputTokens,
    outputTokens: planResult.providerResult.outputTokens,
    costUsd: planResult.providerResult.costUsd,
    costBasis: planResult.providerResult.costBasis,
    undoAvailable: extras.undoAvailable ?? false,
    message: buildPlanMessage(planResult, extras),
    ...(extras.preview === undefined ? {} : { preview: extras.preview })
  };
}

export function buildExistingGroupTitleMap(existingGroups: Array<Pick<ExistingGroup, "id" | "title">> | Array<Pick<chrome.tabGroups.TabGroup, "id" | "title">>): Map<number, string> {
  const titleByGroupId = new Map<number, string>();
  for (const group of existingGroups || []) {
    if (!Number.isInteger(group?.id)) {
      continue;
    }
    const title = String(group.title || "").trim();
    titleByGroupId.set(group.id, title || `Group ${group.id}`);
  }
  return titleByGroupId;
}

export function buildTidySuccessMessage(
  appliedGroups: readonly unknown[],
  skipped: SkippedCounts,
  providerResult: PlanResponseProviderResult,
  appliedAssignments: Array<Pick<AppliedAssignment, "count"> & Partial<AppliedAssignment>> = []
): string {
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

export function buildPlanMessage(planResult: PlanResponseInput, extras: PlanResponseExtras = {}): string {
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

function buildChangeParts(createVerb: string, groupCount: number, assignmentCount: number): string[] {
  const parts: string[] = [];
  if (groupCount > 0) {
    parts.push(`${createVerb} ${groupCount} group${groupCount === 1 ? "" : "s"}.`);
  }
  if (assignmentCount > 0) {
    const prefix = createVerb === "Created" ? "Added" : createVerb.replace("create", "add");
    parts.push(`${prefix} ${assignmentCount} tab${assignmentCount === 1 ? "" : "s"} to existing groups.`);
  }
  return parts;
}

export function buildNoGroupsMessage(providerResult: PlanResponseProviderResult): string {
  if (providerResult.usedFallback) {
    return `${buildFallbackText(providerResult)} Local fallback found no useful groups.`;
  }
  return "No useful groups found.";
}

export function buildFallbackText(providerResult: PlanResponseProviderResult): string {
  const requestedProviderLabel = providerResult.requestedProvider
    ? getProviderLabel(providerResult.requestedProvider)
    : "the requested provider";
  const actualProviderLabel = getProviderLabel(providerResult.provider || "heuristic");
  const providerError = providerResult.providerError ? ` Provider error: ${providerResult.providerError}` : "";
  const prefix = `Used ${actualProviderLabel} instead of ${requestedProviderLabel}.`;
  const kind = providerResult.providerErrorKind as ProviderErrorKind | undefined;
  const detail = kind ? FALLBACK_DETAILS[kind] : undefined;

  return `${prefix}${detail ? ` ${detail}` : ""}${providerError}`;
}

export function buildSkippedText(skipped: SkippedCounts): string {
  const parts: string[] = [];
  if (skipped.alreadyGrouped > 0) {
    parts.push(`${skipped.alreadyGrouped} already grouped`);
  }
  if (skipped.pinned > 0) {
    parts.push(`${skipped.pinned} pinned`);
  }
  if (skipped.missingUrl > 0) {
    parts.push(`${skipped.missingUrl} without a URL`);
  }
  if (parts.length === 0) {
    return "";
  }
  return `Skipped ${parts.join(", ")}.`;
}

const FALLBACK_DETAILS: Partial<Record<ProviderErrorKind, string>> = {
  "missing-host-permission": "API host permission is missing.",
  "missing-api-key": "API key is missing.",
  "missing-model": "Provider model is missing.",
  "provider-timeout": "Provider timed out.",
  "missing-native-permission": "Native messaging permission is missing.",
  "native-host-not-found": "Local CLI bridge is not installed.",
  "native-host-forbidden": "Local CLI bridge is not allowed.",
  "native-host-protocol-error": "Local CLI bridge failed.",
  "native-host-config-error": "Local CLI bridge is not configured correctly.",
  "cli-timeout": "Local CLI timed out.",
  "cli-not-found": "Selected CLI is not installed.",
  "cli-auth-missing": "Selected CLI is not signed in.",
  "cli-error": "Selected CLI failed.",
  "malformed-output": "Local CLI returned invalid JSON."
};
