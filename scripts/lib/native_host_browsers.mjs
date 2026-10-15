const BROWSER_MANIFEST_TARGETS = Object.freeze([
  { id: "chrome", label: "Google Chrome", family: "chromium", manifestDirParts: ["Google", "Chrome"] },
  { id: "brave", label: "Brave", family: "chromium", manifestDirParts: ["BraveSoftware", "Brave-Browser"] },
  { id: "edge", label: "Microsoft Edge", family: "chromium", manifestDirParts: ["Microsoft Edge"] },
  { id: "chromium", label: "Chromium", family: "chromium", manifestDirParts: ["Chromium"] },
  { id: "chrome-canary", label: "Chrome Canary", family: "chromium", manifestDirParts: ["Google", "Chrome Canary"] },
  // Unverified best-effort guess; correct if this differs from a real Helium install.
  { id: "helium", label: "Helium", family: "chromium", manifestDirParts: ["Helium"] },
  { id: "firefox", label: "Firefox", family: "gecko", manifestDirParts: ["Mozilla"] },
  // Verified with scripts/smoke-zen.mjs: Zen reads Firefox's directory, not Application Support/zen.
  { id: "zen", label: "Zen", family: "gecko", manifestDirParts: ["Mozilla"] }
]);

export function resolveBrowserManifestTargets(browser = "chrome") {
  if (browser === "all") {
    return BROWSER_MANIFEST_TARGETS;
  }

  const target = BROWSER_MANIFEST_TARGETS.find((candidate) => candidate.id === browser);
  if (!target) {
    const supported = ["all", ...BROWSER_MANIFEST_TARGETS.map((candidate) => candidate.id)];
    throw new Error(`Unsupported browser "${browser}". Supported: ${supported.join(", ")}.`);
  }
  return [target];
}
