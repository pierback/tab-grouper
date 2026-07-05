export function tabToPromptRecord(tab, settings) {
  const urlInfo = parseUrl(tab.url);
  return {
    id: tab.id,
    title: tab.title || "Untitled",
    domain: urlInfo.hostname || "unknown",
    url: settings.includeFullUrls ? tab.url || "" : undefined,
    pageHint: settings.includePageHints ? tab.pageHint || undefined : undefined
  };
}

export function tabToLocalRecord(tab) {
  const urlInfo = parseUrl(tab.url);
  return {
    id: tab.id,
    title: tab.title || "Untitled",
    domain: urlInfo.hostname || "unknown",
    url: tab.url || "",
    index: Number.isInteger(tab.index) ? tab.index : 0
  };
}

export function isGroupableTab(tab, settings) {
  return !getTabSkipReason(tab, settings);
}

export function getTabSkipReason(tab, settings) {
  if (!tab || !Number.isInteger(tab.id)) {
    return "invalid";
  }
  if (settings.ignorePinnedTabs && tab.pinned) {
    return "pinned";
  }
  if (!tab.url) {
    return "missing-url";
  }
  if (settings.keepExistingGroups && isTabGrouped(tab)) {
    return "already-grouped";
  }
  return null;
}

export function isTabGrouped(tab) {
  return Number.isInteger(tab?.groupId) && tab.groupId !== -1;
}

export function parseUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      hostname: url.hostname.replace(/^www\./, ""),
      protocol: url.protocol,
      pathname: url.pathname,
      port: url.port
    };
  } catch {
    return {
      hostname: "",
      protocol: "",
      pathname: "",
      port: ""
    };
  }
}
