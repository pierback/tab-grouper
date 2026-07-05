import assert from "node:assert/strict";
import { createTidySnapshot, createUndoPlan, isUsableSnapshot, uniqueIntegerIds } from "../lib/undo.js";

const tabs = [
  { id: 1, groupId: -1, windowId: 10, index: 0 },
  { id: 2, groupId: -1, windowId: 10, index: 1 },
  { id: 3, groupId: 7, windowId: 10, index: 2 }
];

const snapshot = createTidySnapshot({
  windowId: 10,
  tabs,
  groups: [{ id: 7, title: "Original", color: "blue", collapsed: true, windowId: 10 }],
  changedTabIds: [1, 2, 2, "bad"],
  appliedGroups: [{ id: 100, name: "Code", color: "green", count: 2 }],
  settings: { keepExistingGroups: true }
});

assert.equal(isUsableSnapshot(snapshot), true);
assert.deepEqual(snapshot.changedTabIds, [1, 2]);
assert.deepEqual(uniqueIntegerIds([1, "2", 2, 3.5, "x"]), [1, 2]);

assert.deepEqual(
  createUndoPlan(snapshot, [
    { id: 1, groupId: 100 },
    { id: 2, groupId: 100 },
    { id: 3, groupId: 7 }
  ]),
  {
    canUndo: true,
    tabIdsToUngroup: [1, 2],
    originalGroups: []
  }
);

assert.deepEqual(
  createUndoPlan(snapshot, [
    { id: 1, groupId: -1 },
    { id: 2, groupId: -1 }
  ]),
  {
    canUndo: false,
    tabIdsToUngroup: [],
    originalGroups: []
  }
);

assert.deepEqual(
  createUndoPlan(snapshot, [
    { id: 1, groupId: 200 },
    { id: 2, groupId: 100 }
  ]),
  {
    canUndo: true,
    tabIdsToUngroup: [2],
    originalGroups: []
  }
);

const regroupSnapshot = createTidySnapshot({
  windowId: 10,
  tabs: [
    { id: 1, groupId: 7, windowId: 10, index: 0 },
    { id: 2, groupId: -1, windowId: 10, index: 1 }
  ],
  groups: [{ id: 7, title: "Original", color: "purple", collapsed: false, windowId: 10 }],
  changedTabIds: [1, 2],
  appliedGroups: [{ id: 100, name: "Mixed", color: "orange", count: 2 }],
  settings: { keepExistingGroups: false }
});

assert.deepEqual(
  createUndoPlan(regroupSnapshot, [
    { id: 1, groupId: 100 },
    { id: 2, groupId: 100 }
  ]),
  {
    canUndo: true,
    tabIdsToUngroup: [1, 2],
    originalGroups: [
      { id: 7, title: "Original", color: "purple", collapsed: false, tabIds: [1] }
    ]
  }
);

assert.deepEqual(
  createUndoPlan(regroupSnapshot, [
    { id: 1, groupId: 200 },
    { id: 2, groupId: 100 }
  ]),
  {
    canUndo: true,
    tabIdsToUngroup: [2],
    originalGroups: []
  }
);

const assignmentSnapshot = createTidySnapshot({
  windowId: 10,
  tabs: [
    { id: 1, groupId: -1, windowId: 10, index: 0 },
    { id: 2, groupId: -1, windowId: 10, index: 1 }
  ],
  groups: [{ id: 7, title: "Original", color: "purple", collapsed: false, windowId: 10 }],
  changedTabIds: [1, 2],
  appliedGroups: [],
  appliedAssignments: [{ groupId: 7, tabIds: [1, 2], count: 2 }],
  settings: { keepExistingGroups: true }
});

assert.deepEqual(
  createUndoPlan(assignmentSnapshot, [
    { id: 1, groupId: 7 },
    { id: 2, groupId: 200 }
  ]),
  {
    canUndo: true,
    tabIdsToUngroup: [1],
    originalGroups: []
  }
);

assert.deepEqual(createUndoPlan(null, []), {
  canUndo: false,
  tabIdsToUngroup: [],
  originalGroups: []
});

console.log("Undo tests passed.");
