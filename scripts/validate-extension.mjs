import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert(manifest.manifest_version === 3, "Manifest must be MV3.");
assert(manifest.permissions.includes("tabs"), "Manifest must request tabs permission.");
assert(manifest.permissions.includes("tabGroups"), "Manifest must request tabGroups permission.");
assert(manifest.permissions.includes("alarms"), "Scheduled auto tidy requires alarms permission.");
assert(!manifest.host_permissions || manifest.host_permissions.length === 0, "Cloud API origins must not be required host permissions.");
assert(
  manifest.optional_permissions?.includes("nativeMessaging"),
  "Native messaging must be optional for local CLI providers."
);
assert(
  manifest.optional_permissions?.includes("scripting"),
  "Scripting must be optional for page hints."
);
assert(
  manifest.optional_host_permissions?.includes("https://*/*") &&
  manifest.optional_host_permissions?.includes("http://*/*"),
  "Page hint origins must be optional host permissions."
);
assert(
  manifest.optional_host_permissions?.includes("https://api.openai.com/*"),
  "OpenAI API origin must be optional."
);
assert(
  manifest.optional_host_permissions?.includes("https://api.anthropic.com/*"),
  "Anthropic API origin must be optional."
);
assert(fs.existsSync(path.join(root, manifest.background.service_worker)), "Service worker file is missing.");
assert(fs.existsSync(path.join(root, manifest.action.default_popup)), "Popup file is missing.");
assert(fs.existsSync(path.join(root, manifest.options_page)), "Options file is missing.");

const optionsHtml = fs.readFileSync(path.join(root, manifest.options_page), "utf8");
const popupHtml = fs.readFileSync(path.join(root, manifest.action.default_popup), "utf8");
assert(optionsHtml.includes('id="autoTidyEnabled"'), "Auto tidy control is missing.");
assert(optionsHtml.includes('id="autoTidyIntervalMinutes"'), "Auto tidy interval control is missing.");
assert(optionsHtml.includes('id="providerRequestTimeoutSeconds"'), "Provider timeout control is missing.");
assert(!optionsHtml.includes('type="submit"'), "Options must autosave without a Save button.");
assert(popupHtml.includes('id="provider-meta"'), "Popup model and reasoning metadata is missing.");
assert(popupHtml.includes('id="auto-tidy-status"'), "Popup auto tidy status is missing.");

console.log("Extension manifest validated.");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
