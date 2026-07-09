import type { ExistingGroup, PartialSettings, RawTabGroupPlan, TabGroupPlan } from "./types.js";

export const TAB_GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
] as const;

export type TabGroupColor = typeof TAB_GROUP_COLORS[number];

type AvailableTab = Pick<chrome.tabs.Tab, "id"> & Partial<Pick<chrome.tabs.Tab, "groupId">>;

export const TAB_GROUP_PLAN_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 32
          },
          color: {
            type: "string",
            enum: TAB_GROUP_COLORS
          },
          tabIds: {
            type: "array",
            minItems: 1,
            maxItems: 300,
            items: {
              type: "integer"
            }
          }
        },
        required: ["name", "color", "tabIds"],
        additionalProperties: false
      }
    },
    assignments: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          groupId: {
            type: "integer"
          },
          tabIds: {
            type: "array",
            minItems: 1,
            maxItems: 300,
            items: {
              type: "integer"
            }
          }
        },
        required: ["groupId", "tabIds"],
        additionalProperties: false
      }
    }
  },
  required: ["groups", "assignments"],
  additionalProperties: false
};

export function normalizeGroupPlan(
  plan: RawTabGroupPlan | TabGroupPlan | null | undefined,
  availableTabs: AvailableTab[],
  settings: PartialSettings = {},
  existingGroups: Array<Pick<ExistingGroup, "id">> = []
): TabGroupPlan {
  const minGroupSize = Number(settings.minimumGroupSize || 2);
  const availableIds = new Set(
    availableTabs
      .map((tab) => tab.id)
      .filter((id) => Number.isInteger(id))
  );
  const existingGroupIds = new Set(
    existingGroups
      .map((group) => group.id)
      .filter((id) => Number.isInteger(id))
  );
  const assignmentAvailableIds = new Set(
    availableTabs
      .filter((tab) => !Number.isInteger(tab.groupId) || tab.groupId === -1)
      .map((tab) => tab.id)
      .filter((id) => Number.isInteger(id))
  );
  const usedIds = new Set<number>();
  const groups: TabGroupPlan["groups"] = [];
  const assignments: TabGroupPlan["assignments"] = [];

  if (!plan || !Array.isArray(plan.groups)) {
    return { groups, assignments };
  }

  for (const rawGroup of plan.groups) {
    if (!rawGroup || typeof rawGroup !== "object" || !Array.isArray(rawGroup.tabIds)) {
      continue;
    }

    const tabIds: number[] = [];
    const groupSeenIds = new Set<number>();
    for (const rawId of rawGroup.tabIds) {
      const tabId = Number(rawId);
      if (!Number.isInteger(tabId) || !availableIds.has(tabId) || usedIds.has(tabId) || groupSeenIds.has(tabId)) {
        continue;
      }
      groupSeenIds.add(tabId);
      tabIds.push(tabId);
    }

    if (tabIds.length < minGroupSize) {
      continue;
    }

    for (const tabId of tabIds) {
      usedIds.add(tabId);
    }

    const fallbackName = `Group ${groups.length + 1}`;
    groups.push({
      name: normalizeGroupName(rawGroup.name, fallbackName),
      color: isTabGroupColor(rawGroup.color) ? rawGroup.color : pickColor(groups.length),
      tabIds
    });
  }

  if (Array.isArray(plan.assignments)) {
    for (const rawAssignment of plan.assignments) {
      if (!rawAssignment || typeof rawAssignment !== "object") {
        continue;
      }
      const groupId = Number(rawAssignment?.groupId);
      if (!Number.isInteger(groupId) || !existingGroupIds.has(groupId) || !Array.isArray(rawAssignment.tabIds)) {
        continue;
      }

      const tabIds: number[] = [];
      const assignmentSeenIds = new Set<number>();
      for (const rawId of rawAssignment.tabIds) {
        const tabId = Number(rawId);
        if (!Number.isInteger(tabId) || !assignmentAvailableIds.has(tabId) || usedIds.has(tabId) || assignmentSeenIds.has(tabId)) {
          continue;
        }
        assignmentSeenIds.add(tabId);
        tabIds.push(tabId);
      }

      if (tabIds.length === 0) {
        continue;
      }

      for (const tabId of tabIds) {
        usedIds.add(tabId);
      }

      assignments.push({ groupId, tabIds });
    }
  }

  return { groups, assignments };
}

export function normalizeGroupName(value: unknown, fallbackName = "Group"): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return fallbackName;
  }
  return text.slice(0, 32);
}

export function pickColor(index: number): TabGroupColor {
  const usableColors = TAB_GROUP_COLORS.filter((color) => color !== "grey");
  return usableColors[index % usableColors.length] as TabGroupColor;
}

function isTabGroupColor(value: unknown): value is TabGroupColor {
  return typeof value === "string" && (TAB_GROUP_COLORS as readonly string[]).includes(value);
}
