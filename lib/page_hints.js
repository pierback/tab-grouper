const PAGE_HINT_MAX_LENGTH = 600;
const PAGE_HINT_PART_MAX_LENGTH = 160;
const MAX_HEADINGS = 5;
const CONTEXT_STRING_MAX_LENGTH = 300;
const CONTEXT_VISIBLE_TEXT_MAX_LENGTH = 600;
const CONTEXT_MAX_BYTES = 2000;

export function shouldUsePageHints(settings) {
  return settings?.includePageHints === true && settings.provider !== "heuristic";
}

export function pageHintPermissionPatternsForTabs(tabs) {
  return Array.from(new Set(
    tabs
      .map((tab) => pageHintPermissionPattern(tab.url))
      .filter(Boolean)
  ));
}

export function pageHintPermissionPattern(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return "";
  }
}

export function normalizePageHintParts(parts) {
  if (!parts || typeof parts !== "object") {
    return "";
  }

  const fragments = [];
  addFragment(fragments, "Title", parts.title);
  addFragment(fragments, "Canonical", parts.canonicalUrl);
  addFragment(fragments, "Site", parts.siteName);
  addFragment(fragments, "Path", parts.path);
  addFragment(fragments, "Description", firstNonEmpty(parts.metaDescription, parts.ogDescription));
  addFragment(fragments, "Open Graph", parts.ogTitle);

  const headings = Array.isArray(parts.headings)
    ? parts.headings.map((heading) => cleanText(heading, PAGE_HINT_PART_MAX_LENGTH)).filter(Boolean)
    : [];
  if (headings.length > 0) {
    addFragment(fragments, "Headings", headings.slice(0, MAX_HEADINGS).join(" | "));
  }

  addFragment(fragments, "Visible Text", parts.visibleText);
  return cleanText(fragments.join(" / "), PAGE_HINT_MAX_LENGTH);
}

export function normalizePageContext(parts) {
  if (!parts || typeof parts !== "object") {
    return undefined;
  }

  let truncated = false;
  const cleanContextText = (value, maxLength) => {
    const text = cleanText(value, maxLength);
    const fullText = cleanText(value, Number.MAX_SAFE_INTEGER);
    if (fullText.length > text.length) {
      truncated = true;
    }
    return text;
  };
  const rawHeadings = Array.isArray(parts.headings) ? parts.headings : [];
  if (rawHeadings.length > MAX_HEADINGS) {
    truncated = true;
  }

  const context = {
    canonicalUrl: cleanContextText(parts.canonicalUrl, CONTEXT_STRING_MAX_LENGTH),
    path: cleanContextText(parts.path, CONTEXT_STRING_MAX_LENGTH),
    siteName: cleanContextText(parts.siteName, CONTEXT_STRING_MAX_LENGTH),
    metaDescription: cleanContextText(parts.metaDescription, CONTEXT_STRING_MAX_LENGTH),
    ogTitle: cleanContextText(parts.ogTitle, CONTEXT_STRING_MAX_LENGTH),
    ogDescription: cleanContextText(parts.ogDescription, CONTEXT_STRING_MAX_LENGTH),
    headings: rawHeadings
      .map((heading) => cleanContextText(heading, PAGE_HINT_PART_MAX_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_HEADINGS),
    visibleText: cleanContextText(parts.visibleText, CONTEXT_VISIBLE_TEXT_MAX_LENGTH),
    source: "page",
    truncated
  };

  return fitContextToByteBudget(context);
}

export function extractSuperficialPageHintParts() {
  const maxPartLength = 160;
  const maxVisibleTextLength = 600;
  const maxHeadings = 5;
  const clean = (value) => String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxPartLength);
  const cleanVisibleText = (value) => String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxVisibleTextLength);
  const readMeta = (selector) => clean(document.querySelector(selector)?.getAttribute("content"));
  const readVisibleText = () => {
    const container = document.querySelector("main") ||
      document.querySelector("article") ||
      document.querySelector("[role=\"main\"]") ||
      document.body;
    return cleanVisibleText(container?.innerText);
  };
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

function addFragment(fragments, label, value) {
  const text = cleanText(value, PAGE_HINT_PART_MAX_LENGTH);
  if (text) {
    fragments.push(`${label}: ${text}`);
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => cleanText(value, PAGE_HINT_PART_MAX_LENGTH)) || "";
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function fitContextToByteBudget(context) {
  let fitted = { ...context, headings: [...context.headings] };
  if (serializedByteLength(fitted) <= CONTEXT_MAX_BYTES) {
    return fitted;
  }

  fitted = { ...fitted, visibleText: "", truncated: true };
  while (serializedByteLength(fitted) > CONTEXT_MAX_BYTES && fitted.headings.length > 0) {
    fitted.headings = fitted.headings.slice(0, -1);
  }
  const stringFields = ["ogDescription", "ogTitle", "metaDescription", "siteName", "path", "canonicalUrl"];
  while (serializedByteLength(fitted) > CONTEXT_MAX_BYTES) {
    const field = stringFields.find((candidate) => fitted[candidate].length > 0);
    if (!field) {
      break;
    }
    fitted[field] = fitted[field].slice(0, -1);
  }
  return fitted;
}

function serializedByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
