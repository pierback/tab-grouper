import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GECKO_EXTENSION_ID, createGeckoManifest } from "../scripts/lib/gecko_manifest.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const firefox = createGeckoManifest(chromeManifest, { zenFolders: false });
assert.equal(firefox.key, undefined);
assert.equal(firefox.options_page, undefined);
assert.equal(firefox.name, chromeManifest.name);
assert.deepEqual(firefox.background, { scripts: [chromeManifest.background.service_worker], type: "module" });
assert.deepEqual(firefox.options_ui, { page: chromeManifest.options_page, open_in_tab: true });
assert.equal(firefox.browser_specific_settings.gecko.id, GECKO_EXTENSION_ID);
assert.equal(firefox.experiment_apis, undefined);
assert.deepEqual(firefox.permissions, chromeManifest.permissions.filter((permission) => permission !== "windows"));
assert.deepEqual(firefox.optional_permissions, chromeManifest.optional_permissions);
assert.deepEqual(firefox.optional_host_permissions, chromeManifest.optional_host_permissions);

const zen = createGeckoManifest(chromeManifest, { zenFolders: true });
assert.equal(zen.name, `${chromeManifest.name} (Zen)`);
assert.equal(zen.browser_specific_settings.gecko.id, GECKO_EXTENSION_ID);
assert.equal(zen.experiment_apis.zenFolders.parent.script, "experiments/zen_folders/api.js");

for (const target of ["firefox", "zen"]) {
  const outRoot = path.join(root, "build", target);
  const built = JSON.parse(fs.readFileSync(path.join(outRoot, "manifest.json"), "utf8"));
  const files = [
    ...built.background.scripts,
    built.action.default_popup,
    built.options_ui.page,
    "styles.css"
  ];
  if (built.experiment_apis) {
    files.push(built.experiment_apis.zenFolders.schema, built.experiment_apis.zenFolders.parent.script);
  }
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(outRoot, file)), `${target} build is missing ${file}`);
  }
  assert.equal(Boolean(built.experiment_apis), target === "zen");
}

console.log("Gecko manifest tests passed.");
