import type { TabGroupColor } from "./schema.js";

export type Provider =
  | "heuristic"
  | "local-codex-cli"
  | "local-claude-cli"
  | "chrome-ai"
  | "openai"
  | "anthropic";

export type LocalCliProvider = "codex" | "claude";

export interface NativeModelInfo {
  slug: string;
  displayName: string;
}

export interface Settings {
  provider: Provider;
  openaiApiKey: string;
  openaiModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  codexCliModel: string;
  claudeCliModel: string;
  includeFullUrls: boolean;
  includePageHints: boolean;
  allowHeuristicFallback: boolean;
  ignorePinnedTabs: boolean;
  keepExistingGroups: boolean;
  collapseGroups: boolean;
  minimumGroupSize: number;
  providerRequestTimeoutMs?: number;
}

export type PartialSettings = Partial<Settings> | Record<string, unknown>;

export interface PlanGroup {
  name: string;
  color: TabGroupColor;
  tabIds: number[];
}

export interface PlanAssignment {
  groupId: number;
  tabIds: number[];
}

export interface PlanTiming {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface TabGroupPlan {
  groups: PlanGroup[];
  assignments: PlanAssignment[];
  timing?: PlanTiming;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

export interface RawTabGroupPlan {
  groups?: unknown;
  assignments?: unknown;
  timing?: PlanTiming;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
  [key: string]: unknown;
}

export type ProviderErrorKind =
  | ""
  | "provider-error"
  | "provider-timeout"
  | "missing-host-permission"
  | "missing-api-key"
  | "missing-model"
  | "missing-native-permission"
  | "native-host-not-found"
  | "native-host-forbidden"
  | "native-host-protocol-error"
  | "native-host-config-error"
  | "cli-timeout"
  | "cli-not-found"
  | "cli-auth-missing"
  | "cli-error"
  | "malformed-output";

export interface ProviderError extends Error {
  providerErrorKind?: ProviderErrorKind;
}

export interface ProviderResult {
  plan: RawTabGroupPlan | TabGroupPlan;
  provider: Provider;
  requestedProvider?: Provider;
  usedFallback: boolean;
  providerError: string;
  providerErrorKind: ProviderErrorKind;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface SkippedCounts {
  pinned: number;
  alreadyGrouped: number;
  missingUrl: number;
}

export interface ExistingGroup {
  id: number;
  title: string;
  color: string;
  tabIds: number[];
}

export interface AppliedGroup {
  id: number;
  name: string;
  color: TabGroupColor;
  count: number;
}

export interface AppliedAssignment {
  groupId: number;
  title?: string;
  tabIds: number[];
  count: number;
}

export interface CurrentWindowPlanResult {
  canApply: boolean;
  reason: "too-few-tabs" | "ready" | "no-groups" | "stale-plan";
  settings: Settings;
  tabs: chrome.tabs.Tab[];
  groupableTabs: chrome.tabs.Tab[];
  skipped: SkippedCounts;
  existingGroups: ExistingGroup[];
  plan: TabGroupPlan;
  providerResult: ProviderResult;
}

export interface TidySnapshotTab {
  id: number;
  groupId: number;
  windowId?: number;
  index?: number;
}

export interface TidySnapshotGroup {
  id: number;
  title: string;
  color: TabGroupColor;
  collapsed: boolean;
  windowId?: number;
}

export interface TidySnapshot {
  version: 1;
  createdAt: number;
  windowId: number;
  keepExistingGroups: boolean;
  tabs: TidySnapshotTab[];
  groups: TidySnapshotGroup[];
  changedTabIds: number[];
  appliedGroups: AppliedGroup[];
  appliedAssignments: AppliedAssignment[];
  state?: "applying" | "applied" | "failed";
  plannedGroups?: PlanGroup[];
  error?: string;
}

export interface UndoPlan {
  canUndo: boolean;
  tabIdsToUngroup: number[];
  originalGroups: Array<TidySnapshotGroup & { tabIds: number[] }>;
  tabMoves: Array<{ tabId: number; index: number }>;
}

export interface LocalTabRecord {
  id?: number;
  title: string;
  domain: string;
  url?: string;
  index?: number;
}

export interface PageContext {
  canonicalUrl: string;
  path: string;
  siteName: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  headings: string[];
  visibleText: string;
  source: "page";
  truncated: boolean;
}

export type PageContextInput = Partial<Omit<PageContext, "source">> & { source?: string };

export interface PromptTabRecord {
  id?: number;
  title: string;
  domain: string;
  url?: string;
  pageHint?: string;
  context?: PageContextInput;
}

export type EnrichedTab = Partial<chrome.tabs.Tab> & {
  id?: number;
  title?: string;
  url?: string;
  groupId?: number;
  index?: number;
  windowId?: number;
  pinned?: boolean;
  pageHint?: string;
  context?: PageContextInput;
};

export interface RenderedGroup {
  name: string;
  color: string;
  count: number;
}

export interface RenderedAssignment {
  groupId: number;
  title?: string;
  count: number;
}

/** The message-passing response shape service_worker.ts sends back to popup.ts
 *  for TIDY_CURRENT_WINDOW/PREVIEW_CURRENT_WINDOW/UNDO_LAST_TIDY, covering both
 *  the success and failure shapes (see createPlanResponse in plan_response.ts
 *  and tidyCurrentWindow's returns in service_worker.ts). */
export interface PopupResponse {
  ok: boolean;
  error?: string;
  detail?: string;
  message?: string;
  groupedCount?: number;
  groups?: RenderedGroup[];
  assignments?: RenderedAssignment[];
  skipped?: SkippedCounts;
  provider?: Provider | string;
  requestedProvider?: Provider | string;
  usedFallback?: boolean;
  providerError?: string;
  providerErrorKind?: ProviderErrorKind | string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  undoAvailable?: boolean;
}

export type { TabGroupColor } from "./schema.js";
