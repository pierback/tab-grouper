import assert from "node:assert/strict";
import { normalizeGroupName, normalizeGroupPlan, pickColor } from "../lib/schema.js";

const availableTabs = [
  { id: 1 },
  { id: 2 },
  { id: 3 },
  { id: 4 }
];

const plan = normalizeGroupPlan(
  {
    groups: [
      { name: "  Work   Docs  ", color: "blue", tabIds: [1, 2, 999] },
      { name: "Duplicate", color: "not-a-color", tabIds: [2, 3] },
      { name: "Single", color: "green", tabIds: [4] }
    ]
  },
  availableTabs,
  { minimumGroupSize: 2 }
);

assert.deepEqual(plan.groups, [
  { name: "Work Docs", color: "blue", tabIds: [1, 2] }
]);

const singletonFirstPlan = normalizeGroupPlan(
  {
    groups: [
      { name: "Discard me", color: "green", tabIds: [4] },
      { name: "Use later", color: "cyan", tabIds: [3, 4] }
    ]
  },
  availableTabs,
  { minimumGroupSize: 2 }
);

assert.deepEqual(singletonFirstPlan.groups, [
  { name: "Use later", color: "cyan", tabIds: [3, 4] }
]);

assert.equal(normalizeGroupName("", "Fallback"), "Fallback");
assert.equal(normalizeGroupName("a".repeat(40)).length, 32);
assert.equal(pickColor(0), "blue");

console.log("Schema tests passed.");
