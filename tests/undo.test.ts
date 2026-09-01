import assert from "node:assert/strict";
import { createTidySnapshot, createUndoPlan, isUsableSnapshot, uniqueIntegerIds } from "../src/lib/undo.js";

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
assert.equal(isUsableSnapshot({ ...snapshot, version: 1 }), false);
assert.deepEqual(snapshot.changedTabIds, [1, 2]);
assert.deepEqual(snapshot.groupIdsCollapsedByTidy, []);
assert.deepEqual(uniqueIntegerIds([1, "2", 2, 3.5, "x"]), [1, 2]);

assert.deepEqual(
  createUndoPlan(snapshot, [
    { id: 1, groupId: 100 },
    { id: 2, groupId: 100 },
    { id: 3, groupId: 7 }
  ], [{ id: 7, collapsed: false }]),
  {
    canUndo: true,
    tabIdsToUngroup: [1, 2],
    originalGroups: [],
    groupCollapseUpdates: [],
    tabMoves: [
      { tabId: 1, index: 0 },
      { tabId: 2, index: 1 }
    ]
  }
);

assert.deepEqual(
  createUndoPlan(snapshot, [
    { id: 1, groupId: -1 },
    { id: 2, groupId: -1 }
  ], []),
  {
    canUndo: false,
    tabIdsToUngroup: [],
    originalGroups: [],
    groupCollapseUpdates: [],
    tabMoves: []
  }
);

assert.deepEqual(
  createUndoPlan(snapshot, [
    { id: 1, groupId: 200 },
    { id: 2, groupId: 100 }
  ], []),
  {
    canUndo: true,
    tabIdsToUngroup: [2],
    originalGroups: [],
    groupCollapseUpdates: [],
    tabMoves: [
      { tabId: 2, index: 1 }
    ]
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
  ], []),
  {
    canUndo: true,
    tabIdsToUngroup: [1, 2],
    originalGroups: [
      { id: 7, title: "Original", color: "purple", collapsed: false, tabIds: [1] }
    ],
    groupCollapseUpdates: [],
    tabMoves: [
      { tabId: 1, index: 0 },
      { tabId: 2, index: 1 }
    ]
  }
);

assert.deepEqual(
  createUndoPlan(regroupSnapshot, [
    { id: 1, groupId: 200 },
    { id: 2, groupId: 100 }
  ], []),
  {
    canUndo: true,
    tabIdsToUngroup: [2],
    originalGroups: [],
    groupCollapseUpdates: [],
    tabMoves: [
      { tabId: 2, index: 1 }
    ]
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
  ], [{ id: 7, collapsed: true }]),
  {
    canUndo: true,
    tabIdsToUngroup: [1],
    originalGroups: [],
    groupCollapseUpdates: [{ groupId: 7, collapsed: false }],
    tabMoves: [
      { tabId: 1, index: 0 }
    ]
  }
);

const collapseOnlySnapshot = createTidySnapshot({
  windowId: 10,
  tabs: [{ id: 3, groupId: 7, windowId: 10, index: 0 }],
  groups: [{ id: 7, title: "Original", color: "blue", collapsed: false, windowId: 10 }],
  changedTabIds: [],
  appliedGroups: [],
  settings: { keepExistingGroups: true }
});
assert.deepEqual(collapseOnlySnapshot.groupIdsCollapsedByTidy, [7]);

assert.deepEqual(
  createUndoPlan(
    collapseOnlySnapshot,
    [{ id: 3, groupId: 7 }],
    [{ id: 7, collapsed: true }]
  ),
  {
    canUndo: true,
    tabIdsToUngroup: [],
    originalGroups: [],
    groupCollapseUpdates: [{ groupId: 7, collapsed: false }],
    tabMoves: []
  }
);

assert.deepEqual(createUndoPlan(null, [], []), {
  canUndo: false,
  tabIdsToUngroup: [],
  originalGroups: [],
  groupCollapseUpdates: [],
  tabMoves: []
});

console.log("Undo tests passed.");
