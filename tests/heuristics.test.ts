import assert from "node:assert/strict";
import { groupTabsHeuristically } from "../src/lib/heuristics.js";

const settings = { minimumGroupSize: 2 };

const repoPlan = groupTabsHeuristically(
  [
    { id: 1, title: "Issue", domain: "github.com", url: "https://github.com/openai/codex/issues/1", index: 3 },
    { id: 2, title: "Pull Request", domain: "github.com", url: "https://github.com/openai/codex/pull/2", index: 4 },
    { id: 3, title: "Other Repo", domain: "github.com", url: "https://github.com/openai/openai-node", index: 5 }
  ],
  settings
);

assert.deepEqual(repoPlan.groups, [
  { name: "Codex GitHub", color: "blue", tabIds: [1, 2] }
]);
assert.equal(typeof repoPlan.timing.durationMs, "number");

const conservativePlan = groupTabsHeuristically(
  [
    { id: 1, title: "News", domain: "news.ycombinator.com", url: "https://news.ycombinator.com", index: 0 },
    { id: 2, title: "Search", domain: "google.com", url: "https://google.com", index: 1 }
  ],
  settings
);

assert.deepEqual(conservativePlan.groups, []);

const localPlan = groupTabsHeuristically(
  [
    { id: 1, title: "App", domain: "localhost", url: "http://localhost:3000/dashboard", index: 1 },
    { id: 2, title: "Settings", domain: "localhost", url: "http://localhost:3000/settings", index: 2 },
    { id: 3, title: "API", domain: "localhost", url: "http://localhost:8787", index: 0 },
    { id: 4, title: "API Logs", domain: "localhost", url: "http://localhost:8787/logs", index: 3 }
  ],
  settings
);

assert.deepEqual(localPlan.groups, [
  { name: "Local 8787", color: "blue", tabIds: [3, 4] },
  { name: "Local 3000", color: "red", tabIds: [1, 2] }
]);

const docsPlan = groupTabsHeuristically(
  [
    { id: 1, title: "OpenAI Responses", domain: "developers.openai.com", url: "", index: 0 },
    { id: 2, title: "Chrome Extensions", domain: "developer.chrome.com", url: "", index: 1 },
    { id: 3, title: "Anthropic Messages", domain: "docs.anthropic.com", url: "", index: 2 }
  ],
  settings
);

assert.deepEqual(docsPlan.groups, [
  { name: "Dev Docs", color: "blue", tabIds: [1, 2, 3] }
]);

const manyBucketTabs = Array.from({ length: 30 }, (_, index) => [
  { id: index * 2 + 1, title: "A", domain: `site-${index}.example.com`, url: `https://site-${index}.example.com/a`, index: index * 2 },
  { id: index * 2 + 2, title: "B", domain: `site-${index}.example.com`, url: `https://site-${index}.example.com/b`, index: index * 2 + 1 }
]).flat();
const manyBucketPlan = groupTabsHeuristically(manyBucketTabs, settings);

assert.equal(manyBucketPlan.groups.length, 30);

console.log("Heuristic tests passed.");
