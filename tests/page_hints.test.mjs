import assert from "node:assert/strict";
import {
  normalizePageHintParts,
  pageHintPermissionPattern,
  pageHintPermissionPatternsForTabs,
  shouldUsePageHints
} from "../lib/page_hints.js";

assert.equal(shouldUsePageHints({ includePageHints: true, provider: "local-codex-cli" }), true);
assert.equal(shouldUsePageHints({ includePageHints: true, provider: "heuristic" }), false);
assert.equal(shouldUsePageHints({ includePageHints: false, provider: "openai" }), false);

assert.equal(pageHintPermissionPattern("https://www.example.com/a"), "https://www.example.com/*");
assert.equal(pageHintPermissionPattern("http://127.0.0.1:3000/a"), "http://127.0.0.1/*");
assert.equal(pageHintPermissionPattern("chrome://extensions"), "");
assert.equal(pageHintPermissionPattern("not a url"), "");

assert.deepEqual(
  pageHintPermissionPatternsForTabs([
    { url: "https://example.com/a" },
    { url: "https://example.com/b" },
    { url: "http://localhost:3000/app" },
    { url: "chrome://settings" }
  ]),
  ["https://example.com/*", "http://localhost/*"]
);

const hint = normalizePageHintParts({
  title: "  Product   Roadmap  ",
  metaDescription: "A planning page for Q3 execution.",
  ogTitle: "Roadmap OG",
  headings: ["North Star", "Milestones", "Risks", "Ignored"]
});

assert.equal(
  hint,
  "Title: Product Roadmap / Description: A planning page for Q3 execution. / Open Graph: Roadmap OG / Headings: North Star | Milestones | Risks"
);

const longHint = normalizePageHintParts({
  title: "x".repeat(800),
  headings: ["y".repeat(800)]
});
assert.equal(longHint.length <= 600, true);
assert.equal(/[^\x20-\x7e]/.test(normalizePageHintParts({ title: "A\u0000B\nC" })), false);

console.log("Page hint tests passed.");
