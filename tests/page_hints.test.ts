import assert from "node:assert/strict";
import {
  extractSuperficialPageHintParts,
  normalizePageContext,
  normalizePageHintParts,
  pageHintPermissionPattern,
  pageHintPermissionPatternsForTabs,
  shouldUsePageHints
} from "../src/lib/page_hints.js";

interface MockElement {
  innerText?: string;
  textContent?: string;
  getAttribute?(name: string): string | null;
}

interface MockDocument {
  readyState: DocumentReadyState;
  title: string;
  body: { innerText: string };
  querySelector(selector: string): MockElement | null;
  querySelectorAll(selector: string): MockElement[];
}

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
  canonicalUrl: "https://example.com/roadmap",
  siteName: "Example",
  path: "/roadmap",
  metaDescription: "A planning page for Q3 execution.",
  ogTitle: "Roadmap OG",
  headings: ["North Star", "Milestones", "Risks", "Ignored"]
});

assert.equal(
  hint,
  "Title: Product Roadmap / Canonical: https://example.com/roadmap / Site: Example / Path: /roadmap / Description: A planning page for Q3 execution. / Open Graph: Roadmap OG / Headings: North Star | Milestones | Risks | Ignored"
);

const longHint = normalizePageHintParts({
  title: "x".repeat(800),
  headings: ["y".repeat(800)]
});
assert.equal(longHint.length <= 600, true);
assert.equal(/[^\x20-\x7e]/.test(normalizePageHintParts({ title: "A\u0000B\nC" })), false);

assert.deepEqual(
  normalizePageContext({
    canonicalUrl: "https://example.com/docs",
    path: "/docs",
    siteName: "Example Docs",
    metaDescription: "Reference material.",
    ogTitle: "Docs",
    ogDescription: "Full API docs.",
    headings: ["Overview", "Install", "Use", "Debug", "Deploy", "Ignored"],
    visibleText: "This is visible page text."
  }),
  {
    canonicalUrl: "https://example.com/docs",
    path: "/docs",
    siteName: "Example Docs",
    metaDescription: "Reference material.",
    ogTitle: "Docs",
    ogDescription: "Full API docs.",
    headings: ["Overview", "Install", "Use", "Debug", "Deploy"],
    visibleText: "This is visible page text.",
    source: "page",
    truncated: true
  }
);

const oversizedContext = normalizePageContext({
  canonicalUrl: "c".repeat(300),
  path: "p".repeat(300),
  siteName: "s".repeat(300),
  metaDescription: "m".repeat(300),
  ogTitle: "t".repeat(300),
  ogDescription: "o".repeat(300),
  headings: Array.from({ length: 5 }, () => "h".repeat(160)),
  visibleText: "v".repeat(600)
});
assert.equal(new TextEncoder().encode(JSON.stringify(oversizedContext)).length <= 2000, true);
assert.equal(oversizedContext!.visibleText, "");
assert.deepEqual(oversizedContext!.headings, []);
assert.equal(oversizedContext!.truncated, true);

const multibyteContext = normalizePageContext({
  headings: ["😀".repeat(50)],
  visibleText: "語".repeat(300)
});
const multibyteHeading = multibyteContext!.headings[0];
if (multibyteHeading === undefined) {
  throw new Error("Expected normalized multibyte heading.");
}
assert.equal(new TextEncoder().encode(multibyteContext!.visibleText).length <= 600, true);
assert.equal(Array.from(multibyteContext!.visibleText).join(""), multibyteContext!.visibleText);
assert.equal(new TextEncoder().encode(multibyteHeading).length <= 160, true);
assert.equal(Array.from(multibyteHeading).join(""), multibyteHeading);
assert.equal(multibyteContext!.truncated, true);

const originalDocument = globalThis.document;
const originalLocation = globalThis.location;
const originalRequestIdleCallback = globalThis.requestIdleCallback;
globalThis.location = { pathname: "/products/roadmap" } as unknown as Location;
globalThis.requestIdleCallback = ((callback: IdleRequestCallback) => {
  callback({ didTimeout: false, timeRemaining: () => 0 });
  return 1;
}) as typeof requestIdleCallback;
const completeDocument: MockDocument = {
  readyState: "complete",
  title: " Roadmap\n ",
  body: { innerText: "Body fallback text" },
  querySelector(selector: string) {
    const matches: Record<string, MockElement> = {
      'link[rel="canonical" i]': { getAttribute: () => "https://example.com/products/roadmap" },
      'meta[property="og:site_name" i]': { getAttribute: () => "Example" },
      'meta[name="description" i]': { getAttribute: () => "A planning page." },
      'meta[property="og:title" i]': { getAttribute: () => "Roadmap OG" },
      'meta[property="og:description" i]': { getAttribute: () => "Planning details." },
      main: { innerText: "Main\nvisible\ttext" }
    };
    return matches[selector] || null;
  },
  querySelectorAll() {
    return [
      { textContent: "H1" },
      { textContent: "H2" },
      { textContent: "H3" },
      { textContent: "H4" },
      { textContent: "H5" },
      { textContent: "H6" }
    ];
  }
};
globalThis.document = completeDocument as unknown as Document;
assert.deepEqual(await extractSuperficialPageHintParts(), {
  title: "Roadmap",
  canonicalUrl: "https://example.com/products/roadmap",
  path: "/products/roadmap",
  siteName: "Example",
  metaDescription: "A planning page.",
  ogTitle: "Roadmap OG",
  ogDescription: "Planning details.",
  headings: ["H1", "H2", "H3", "H4", "H5"],
  visibleText: "Main visible text"
});

const delayedDocument: MockDocument = {
  readyState: "loading",
  title: "Loading",
  body: { innerText: "Hydrated text" },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  }
};
globalThis.document = delayedDocument as unknown as Document;
setTimeout(() => {
  delayedDocument.readyState = "complete";
  delayedDocument.title = "Hydrated";
}, 0);
assert.deepEqual(await extractSuperficialPageHintParts(), {
  title: "Hydrated",
  canonicalUrl: "",
  path: "/products/roadmap",
  siteName: "",
  metaDescription: "",
  ogTitle: "",
  ogDescription: "",
  headings: [],
  visibleText: "Hydrated text"
});
globalThis.document = originalDocument;
globalThis.location = originalLocation;
globalThis.requestIdleCallback = originalRequestIdleCallback;

console.log("Page hint tests passed.");
