import assert from "node:assert/strict";
import { normalizeGroupName, normalizeGroupPlan, pickColor, TAB_GROUP_PLAN_SCHEMA } from "../src/lib/schema.js";

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
assert.deepEqual(plan.assignments, []);

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

const assignmentPlan = normalizeGroupPlan(
  {
    groups: [
      { name: "New", color: "green", tabIds: [1, 2] }
    ],
    assignments: [
      { groupId: 7, tabIds: [3, 3, 999] },
      { groupId: 8, tabIds: [4] },
      { groupId: 404, tabIds: [4] },
      { groupId: 7, tabIds: [2, 4] }
    ]
  },
  availableTabs,
  { minimumGroupSize: 2 },
  [{ id: 7 }, { id: 8 }]
);

assert.deepEqual(assignmentPlan, {
  groups: [{ name: "New", color: "green", tabIds: [1, 2] }],
  assignments: [
    { groupId: 7, tabIds: [3] },
    { groupId: 8, tabIds: [4] }
  ]
});

assert.deepEqual(
  normalizeGroupPlan(
    {
      groups: [],
      assignments: [{ groupId: 7, tabIds: [1, 2] }]
    },
    [{ id: 1, groupId: 7 }, { id: 2, groupId: -1 }],
    { minimumGroupSize: 2 },
    [{ id: 7 }]
  ).assignments,
  [{ groupId: 7, tabIds: [2] }]
);

assert.equal(normalizeGroupName("", "Fallback"), "Fallback");
assert.equal(normalizeGroupName("a".repeat(40)).length, 32);
assert.equal(pickColor(0), "blue");

assertStrictObjectSchema(TAB_GROUP_PLAN_SCHEMA, "$");

// OpenAI's strict structured-output mode rejects any object schema where
// "required" does not list every key in "properties". This guards against a
// field being added to the schema without also adding it to "required" - that
// exact mismatch shipped silently in the native-host's copy of this schema
// once already, since no test exercises the real API's strict-mode validator.
interface StrictSchemaNode {
  type?: string;
  properties?: Record<string, StrictSchemaNode>;
  required?: string[];
  items?: StrictSchemaNode;
}

function assertStrictObjectSchema(node: StrictSchemaNode | undefined, path: string) {
  if (!node || node.type !== "object") {
    return;
  }
  const properties = node.properties || {};
  const required = new Set(node.required || []);
  for (const name of Object.keys(properties)) {
    assert.ok(required.has(name), `${path}.properties.${name} is not listed in required`);
  }
  for (const [name, value] of Object.entries(properties)) {
    assertStrictObjectSchema(value, `${path}.${name}`);
    if (value?.items) {
      assertStrictObjectSchema(value.items, `${path}.${name}[]`);
    }
  }
}

console.log("Schema tests passed.");
