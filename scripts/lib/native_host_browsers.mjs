const BROWSER_MANIFEST_TARGETS = Object.freeze([
  { id: "chrome", label: "Google Chrome", manifestDirParts: ["Google", "Chrome"] },
  { id: "brave", label: "Brave", manifestDirParts: ["BraveSoftware", "Brave-Browser"] },
  { id: "edge", label: "Microsoft Edge", manifestDirParts: ["Microsoft Edge"] },
  { id: "chromium", label: "Chromium", manifestDirParts: ["Chromium"] },
  { id: "chrome-canary", label: "Chrome Canary", manifestDirParts: ["Google", "Chrome Canary"] },
  // Unverified best-effort guess; correct if this differs from a real Helium install.
  { id: "helium", label: "Helium", manifestDirParts: ["Helium"] }
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
