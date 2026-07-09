import { normalizeGroupName, pickColor } from "./schema.js";
import { parseUrl } from "./tabs.js";
import type { LocalTabRecord, PartialSettings, PlanTiming, TabGroupPlan } from "./types.js";

const CATEGORY_RULES = [
  {
    key: "ai-chats",
    name: "AI Chats",
    domains: ["chatgpt.com", "claude.ai", "gemini.google.com", "perplexity.ai", "poe.com"]
  },
  {
    key: "dev-docs",
    name: "Dev Docs",
    domains: ["developer.chrome.com", "developers.openai.com", "docs.anthropic.com", "developer.mozilla.org", "web.dev", "nodejs.org", "npmjs.com"]
  },
  {
    key: "work-chat",
    name: "Work Chat",
    domains: ["slack.com", "discord.com", "teams.microsoft.com"]
  },
  {
    key: "media",
    name: "Media",
    domains: ["youtube.com", "spotify.com", "netflix.com", "twitch.tv", "vimeo.com"]
  },
  {
    key: "shopping",
    name: "Shopping",
    domains: ["amazon.", "ebay.", "etsy.com", "shopify.com"]
  },
  {
    key: "travel",
    name: "Travel",
    domains: ["airbnb.", "booking.com", "maps.google.com", "flights.google.com", "tripadvisor."]
  },
  {
    key: "finance",
    name: "Finance",
    domains: ["stripe.com", "paypal.com", "wise.com", "xero.com", "quickbooks.intuit.com"]
  }
];

const EXACT_DOMAIN_LABELS = new Map([
  ["docs.google.com", "Google Docs"],
  ["drive.google.com", "Google Drive"],
  ["mail.google.com", "Gmail"],
  ["calendar.google.com", "Calendar"],
  ["sheets.google.com", "Google Sheets"],
  ["slides.google.com", "Google Slides"],
  ["linear.app", "Linear"],
  ["notion.so", "Notion"],
  ["stackoverflow.com", "Stack Overflow"],
  ["gitlab.com", "GitLab"],
  ["bitbucket.org", "Bitbucket"]
]);

interface Classification {
  key: string;
  name: string;
}

interface Bucket {
  name: string;
  tabIds: number[];
  firstIndex: number;
}

export function groupTabsHeuristically(tabs: LocalTabRecord[], settings: PartialSettings = {}): TabGroupPlan & { timing: PlanTiming } {
  const start = Date.now();
  const buckets = new Map<string, Bucket>();

  for (const tab of tabs) {
    const classification = classifyTab(tab);
    const tabId = tab.id;
    if (!classification || typeof tabId !== "number" || !Number.isInteger(tabId)) {
      continue;
    }

    if (!buckets.has(classification.key)) {
      buckets.set(classification.key, {
        name: classification.name,
        tabIds: [],
        firstIndex: typeof tab.index === "number" && Number.isInteger(tab.index) ? tab.index : Number.MAX_SAFE_INTEGER
      });
    }

    const bucket = buckets.get(classification.key);
    if (!bucket) {
      continue;
    }
    bucket.tabIds.push(tabId);
    if (typeof tab.index === "number" && Number.isInteger(tab.index)) {
      bucket.firstIndex = Math.min(bucket.firstIndex, tab.index);
    }
  }

  const minGroupSize = Number(settings.minimumGroupSize || 2);
  const groups = Array.from(buckets.values())
    .filter((bucket) => bucket.tabIds.length >= minGroupSize)
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .slice(0, 40)
    .map((bucket, index) => ({
      name: normalizeGroupName(bucket.name, `Group ${index + 1}`),
      color: pickColor(index),
      tabIds: bucket.tabIds
    }));

  return { groups, assignments: [], timing: { durationMs: Date.now() - start } };
}

function classifyTab(tab: LocalTabRecord): Classification | null {
  const urlInfo = parseUrl(tab.url || "");
  const domain = urlInfo.hostname || tab.domain || "Other";
  const normalizedDomain = String(domain).toLowerCase();
  if (!normalizedDomain || normalizedDomain === "unknown") {
    return null;
  }

  const localGroup = classifyLocalDevelopment(normalizedDomain, urlInfo);
  if (localGroup) {
    return localGroup;
  }

  const githubGroup = classifyGitHub(normalizedDomain, urlInfo);
  if (githubGroup) {
    return githubGroup;
  }

  const exactLabel = EXACT_DOMAIN_LABELS.get(normalizedDomain);
  if (exactLabel) {
    return {
      key: `domain:${normalizedDomain}`,
      name: exactLabel
    };
  }

  for (const rule of CATEGORY_RULES) {
    if (rule.domains.some((needle) => domainMatches(normalizedDomain, needle))) {
      return {
        key: rule.key,
        name: rule.name
      };
    }
  }

  return {
    key: `domain:${normalizedDomain}`,
    name: siteLabel(normalizedDomain)
  };
}

function classifyLocalDevelopment(domain: string, urlInfo: ReturnType<typeof parseUrl>): Classification | null {
  if (domain === "localhost" || domain === "127.0.0.1" || domain === "::1") {
    return {
      key: urlInfo.port ? `local:${urlInfo.port}` : "local-dev",
      name: urlInfo.port ? `Local ${urlInfo.port}` : "Local Dev"
    };
  }
  return null;
}

function classifyGitHub(domain: string, urlInfo: ReturnType<typeof parseUrl>): Classification | null {
  if (domain !== "github.com") {
    return null;
  }

  const repo = githubRepoName(urlInfo.pathname || "");
  if (!repo) {
    return {
      key: "domain:github.com",
      name: "GitHub"
    };
  }

  return {
    key: `github:${repo.key}`,
    name: `${repo.name} GitHub`
  };
}

function githubRepoName(pathname: string): { key: string; name: string } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const owner = parts[0] as string;
  const repo = parts[1] as string;
  if (owner.length > 40 || repo.length > 60) {
    return null;
  }

  return {
    key: `${owner}/${repo}`.toLowerCase(),
    name: titleCase(repo)
  };
}

function domainMatches(domain: string, needle: string): boolean {
  if (needle.endsWith(".")) {
    return domain.includes(needle);
  }
  return domain === needle || domain.endsWith(`.${needle}`);
}

function siteLabel(domain: string): string {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length >= 2) {
    const base = parts.at(-2) as string;
    return titleCase(base);
  }

  return "Other";
}

function titleCase(value: unknown): string {
  return String(value || "Other")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 32);
}
