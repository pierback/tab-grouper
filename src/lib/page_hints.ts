import type { EnrichedTab, PageContext, PartialSettings } from "./types.js";

const PAGE_HINT_MAX_LENGTH = 600;
const PAGE_HINT_PART_MAX_LENGTH = 160;
const MAX_HEADINGS = 5;
const CONTEXT_STRING_MAX_LENGTH = 300;
const CONTEXT_VISIBLE_TEXT_MAX_LENGTH = 600;
const CONTEXT_MAX_BYTES = 2000;

interface PageHintParts {
  title?: unknown;
  canonicalUrl?: unknown;
  siteName?: unknown;
  path?: unknown;
  metaDescription?: unknown;
  ogDescription?: unknown;
  ogTitle?: unknown;
  headings?: unknown;
  visibleText?: unknown;
}

export function shouldUsePageHints(settings: PartialSettings): boolean {
  return settings?.includePageHints === true && settings.provider !== "heuristic";
}

export function pageHintPermissionPatternsForTabs(tabs: EnrichedTab[]): string[] {
  return Array.from(new Set(
    tabs
      .map((tab) => pageHintPermissionPattern(tab.url))
      .filter(Boolean)
  ));
}

export function pageHintPermissionPattern(rawUrl: string | undefined): string {
  try {
    const url = new URL(rawUrl || "");
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return "";
  }
}

export function normalizePageHintParts(parts: unknown): string {
  if (!parts || typeof parts !== "object") {
    return "";
  }
  const hintParts = parts as PageHintParts;

  const fragments: string[] = [];
  addFragment(fragments, "Title", hintParts.title);
  addFragment(fragments, "Canonical", hintParts.canonicalUrl);
  addFragment(fragments, "Site", hintParts.siteName);
  addFragment(fragments, "Path", hintParts.path);
  addFragment(fragments, "Description", firstNonEmpty(hintParts.metaDescription, hintParts.ogDescription));
  addFragment(fragments, "Open Graph", hintParts.ogTitle);

  const headings = Array.isArray(hintParts.headings)
    ? hintParts.headings.map((heading) => cleanText(heading, PAGE_HINT_PART_MAX_LENGTH)).filter(Boolean)
    : [];
  if (headings.length > 0) {
    addFragment(fragments, "Headings", headings.slice(0, MAX_HEADINGS).join(" | "));
  }

  addFragment(fragments, "Visible Text", hintParts.visibleText);
  return cleanText(fragments.join(" / "), PAGE_HINT_MAX_LENGTH);
}

export function normalizePageContext(parts: unknown): PageContext | undefined {
  if (!parts || typeof parts !== "object") {
    return undefined;
  }
  const hintParts = parts as PageHintParts;

  let truncated = false;
  const cleanContextText = (value: unknown, maxLength: number): string => {
    const text = cleanText(value, maxLength);
    const fullText = cleanText(value, Number.MAX_SAFE_INTEGER);
    if (fullText.length > text.length) {
      truncated = true;
    }
    return text;
  };
  const rawHeadings = Array.isArray(hintParts.headings) ? hintParts.headings : [];
  if (rawHeadings.length > MAX_HEADINGS) {
    truncated = true;
  }

  const context: PageContext = {
    canonicalUrl: cleanContextText(hintParts.canonicalUrl, CONTEXT_STRING_MAX_LENGTH),
    path: cleanContextText(hintParts.path, CONTEXT_STRING_MAX_LENGTH),
    siteName: cleanContextText(hintParts.siteName, CONTEXT_STRING_MAX_LENGTH),
    metaDescription: cleanContextText(hintParts.metaDescription, CONTEXT_STRING_MAX_LENGTH),
    ogTitle: cleanContextText(hintParts.ogTitle, CONTEXT_STRING_MAX_LENGTH),
    ogDescription: cleanContextText(hintParts.ogDescription, CONTEXT_STRING_MAX_LENGTH),
    headings: rawHeadings
      .map((heading) => cleanContextText(heading, PAGE_HINT_PART_MAX_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_HEADINGS),
    visibleText: cleanContextText(hintParts.visibleText, CONTEXT_VISIBLE_TEXT_MAX_LENGTH),
    source: "page",
    truncated
  };

  return fitContextToByteBudget(context);
}

export async function extractSuperficialPageHintParts(): Promise<{
  title: string;
  canonicalUrl: string;
  path: string;
  siteName: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  headings: string[];
  visibleText: string;
}> {
  const maxPartLength = 160;
  const maxVisibleTextLength = 600;
  const maxHeadings = 5;
  const waitForComplete = async () => {
    if (document.readyState === "complete") {
      return;
    }
    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      const poll = () => {
        if (document.readyState === "complete" || Date.now() - startedAt >= 800) {
          resolve();
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  };
  const waitForSettle = async () => {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      if (typeof requestIdleCallback === "function") {
        const timeoutId = setTimeout(finish, 200);
        requestIdleCallback(() => {
          clearTimeout(timeoutId);
          finish();
        }, { timeout: 200 });
        return;
      }
      setTimeout(finish, 200);
    });
  };
  const clean = (value: unknown): string => String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxPartLength);
  const cleanVisibleText = (value: unknown): string => String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxVisibleTextLength);
  const readMeta = (selector: string): string => clean(document.querySelector(selector)?.getAttribute("content"));
  const readVisibleText = () => {
    const container = document.querySelector("main") ||
      document.querySelector("article") ||
      document.querySelector("[role=\"main\"]") ||
      document.body;
    return cleanVisibleText(container?.innerText);
  };
  await waitForComplete();
  await waitForSettle();
  return {
    title: clean(document.title),
    canonicalUrl: clean(document.querySelector('link[rel="canonical" i]')?.getAttribute("href")),
    path: clean(location.pathname),
    siteName: readMeta('meta[property="og:site_name" i]'),
    metaDescription: readMeta('meta[name="description" i]'),
    ogTitle: readMeta('meta[property="og:title" i]'),
    ogDescription: readMeta('meta[property="og:description" i]'),
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .slice(0, maxHeadings)
      .map((heading) => clean(heading.textContent))
      .filter(Boolean),
    visibleText: readVisibleText()
  };
}

function addFragment(fragments: string[], label: string, value: unknown): void {
  const text = cleanText(value, PAGE_HINT_PART_MAX_LENGTH);
  if (text) {
    fragments.push(`${label}: ${text}`);
  }
}

function firstNonEmpty(...values: unknown[]): unknown {
  return values.find((value) => cleanText(value, PAGE_HINT_PART_MAX_LENGTH)) || "";
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function fitContextToByteBudget(context: PageContext): PageContext {
  let fitted = { ...context, headings: [...context.headings] };
  if (serializedByteLength(fitted) <= CONTEXT_MAX_BYTES) {
    return fitted;
  }

  fitted = { ...fitted, visibleText: "", truncated: true };
  while (serializedByteLength(fitted) > CONTEXT_MAX_BYTES && fitted.headings.length > 0) {
    fitted.headings = fitted.headings.slice(0, -1);
  }
  const stringFields = ["ogDescription", "ogTitle", "metaDescription", "siteName", "path", "canonicalUrl"] as const;
  while (serializedByteLength(fitted) > CONTEXT_MAX_BYTES) {
    const field = stringFields.find((candidate) => fitted[candidate].length > 0);
    if (!field) {
      break;
    }
    fitted[field] = fitted[field].slice(0, -1);
  }
  return fitted;
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
