const PAGE_HINT_MAX_LENGTH = 600;
const PAGE_HINT_PART_MAX_LENGTH = 160;
const MAX_HEADINGS = 3;

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
  addFragment(fragments, "Description", firstNonEmpty(parts.metaDescription, parts.ogDescription));
  addFragment(fragments, "Open Graph", parts.ogTitle);

  const headings = Array.isArray(parts.headings)
    ? parts.headings.map((heading) => cleanText(heading, PAGE_HINT_PART_MAX_LENGTH)).filter(Boolean)
    : [];
  if (headings.length > 0) {
    addFragment(fragments, "Headings", headings.slice(0, MAX_HEADINGS).join(" | "));
  }

  return cleanText(fragments.join(" / "), PAGE_HINT_MAX_LENGTH);
}

export function extractSuperficialPageHintParts() {
  const maxPartLength = 160;
  const maxHeadings = 3;
  const clean = (value) => String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxPartLength);
  const readMeta = (selector) => clean(document.querySelector(selector)?.getAttribute("content"));
  return {
    title: clean(document.title),
    metaDescription: readMeta('meta[name="description" i]'),
    ogTitle: readMeta('meta[property="og:title" i]'),
    ogDescription: readMeta('meta[property="og:description" i]'),
    headings: Array.from(document.querySelectorAll("h1, h2"))
      .slice(0, maxHeadings)
      .map((heading) => clean(heading.textContent))
      .filter(Boolean)
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
