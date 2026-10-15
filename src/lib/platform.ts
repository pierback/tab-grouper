export function isGeckoExtensionRuntime(): boolean {
  return chrome.runtime?.getURL?.("")?.startsWith("moz-extension:") ?? false;
}
