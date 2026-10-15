export const GECKO_EXTENSION_ID = "tab-grouper@fabianpieringer";
export const GECKO_MIN_VERSION = "142.0";

// Firefox exposes the windows API without a permission and rejects the entry.
const CHROME_ONLY_PERMISSIONS = new Set(["windows"]);

export const GECKO_TARGETS = Object.freeze({
  firefox: { zenFolders: false },
  zen: { zenFolders: true }
});

export function createGeckoManifest(chromeManifest, { zenFolders }) {
  const { key: _key, options_page: optionsPage, background, ...manifest } = chromeManifest;
  return {
    ...manifest,
    name: zenFolders ? `${manifest.name} (Zen)` : manifest.name,
    permissions: manifest.permissions.filter((permission) => !CHROME_ONLY_PERMISSIONS.has(permission)),
    browser_specific_settings: {
      gecko: {
        id: GECKO_EXTENSION_ID,
        strict_min_version: GECKO_MIN_VERSION,
        data_collection_permissions: {
          required: ["none"]
        }
      }
    },
    background: {
      scripts: [background.service_worker],
      type: background.type
    },
    options_ui: {
      page: optionsPage,
      open_in_tab: true
    },
    ...(zenFolders
      ? {
          experiment_apis: {
            zenFolders: {
              schema: "experiments/zen_folders/schema.json",
              parent: {
                scopes: ["addon_parent"],
                paths: [["zenFolders"]],
                script: "experiments/zen_folders/api.js"
              }
            }
          }
        }
      : {})
  };
}
