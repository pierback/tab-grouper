import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const nativeHostName = "com.fabianpieringer.tab_grouper";

async function runSmoke() {
  let chromeProcess;
  let profileDir;
  let server;
  let restoreNativeHostManifest = null;

  try {
    profileDir = await mkdtemp(path.join(os.tmpdir(), "tab-grouper-smoke-"));
    const smokeExtension = await prepareSmokeExtension(profileDir);
    restoreNativeHostManifest = await installTemporaryNativeHost(profileDir, smokeExtension.id);
    server = await startFixtureServer();
    const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
    const fixtureUrls = [`${fixtureOrigin}/alpha`, `${fixtureOrigin}/beta`];

    chromeProcess = spawn(chromePath, [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-component-update",
      "--remote-debugging-port=0",
      "about:blank"
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const debugPort = await waitForDebugPort(profileDir, chromeProcess);
    const browserInfo = await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
    const browser = await CdpClient.connect(browserInfo.webSocketDebuggerUrl, { enableRuntime: false });

    try {
      const loadedExtension = await browser.send("Extensions.loadUnpacked", { path: smokeExtension.dir });
      assert.equal(loadedExtension.id, smokeExtension.id);
      const popupUrl = `chrome-extension://${loadedExtension.id}/popup.html`;
      const createdTarget = await browser.send("Target.createTarget", {
        url: popupUrl,
        newWindow: true
      });
      const popupTarget = await waitForTarget(debugPort, (target) =>
        target.id === createdTarget.targetId || (target.type === "page" && target.url === popupUrl)
      );
      const popup = await CdpClient.connect(popupTarget.webSocketDebuggerUrl);

      try {
        const setup = await evaluate(popup, `
          (async () => {
            const call = (api, method, ...args) => new Promise((resolve, reject) => {
              api[method](...args, (value) => {
                const error = chrome.runtime.lastError;
                if (error) {
                  reject(new Error(error.message));
                  return;
                }
                resolve(value);
              });
            });
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const waitForElement = async (selector) => {
              for (let attempt = 0; attempt < 80; attempt += 1) {
                const element = document.querySelector(selector);
                if (element) {
                  return element;
                }
                await sleep(100);
              }
              throw new Error("Timed out waiting for popup element: " + selector);
            };
            const waitForTabUrls = async (windowId, urls) => {
              for (let attempt = 0; attempt < 120; attempt += 1) {
                const tabs = await call(chrome.tabs, "query", { windowId });
                if (urls.every((url) => tabs.some((tab) => tab.url === url))) {
                  return tabs;
                }
                await sleep(100);
              }
              return await call(chrome.tabs, "query", { windowId });
            };
            await waitForElement("#tidy-button");
            await call(chrome.storage.local, "clear");
            const currentWindow = await call(chrome.windows, "getCurrent");
            for (const url of ${JSON.stringify(fixtureUrls)}) {
              await call(chrome.tabs, "create", {
                windowId: currentWindow.id,
                url,
                active: false
              });
            }
            const tabs = await waitForTabUrls(currentWindow.id, ${JSON.stringify(fixtureUrls)});
            return {
              windowId: currentWindow.id,
              tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url }))
            };
          })()
        `);

      assert.equal(
        setup.tabs.filter((tab) => fixtureUrls.includes(tab.url)).length,
        2,
        `Expected fixture tabs in popup window setup, got ${JSON.stringify(setup.tabs)}`
      );

      const tidyResult = await evaluate(popup, `
        (async () => {
          const call = (api, method, ...args) => new Promise((resolve, reject) => {
            api[method](...args, (value) => {
              const error = chrome.runtime.lastError;
              if (error) {
                reject(new Error(error.message));
                return;
              }
              resolve(value);
            });
          });
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const waitForElement = async (selector) => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const element = document.querySelector(selector);
              if (element) {
                return element;
              }
              await sleep(100);
            }
            throw new Error("Timed out waiting for popup element: " + selector);
          };
          const waitForText = async (needle) => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const text = document.querySelector("#result")?.textContent || "";
              if (text.includes(needle)) {
                return text;
              }
              await sleep(100);
            }
            throw new Error("Timed out waiting for popup text: " + needle + "; last text: " + (document.querySelector("#result")?.textContent || ""));
          };

          const tidyButton = await waitForElement("#tidy-button");
          await waitForElement("#result");
          tidyButton.click();
          const tidyText = await waitForText("Created");
          const currentWindow = await call(chrome.windows, "getCurrent");
          const tabs = await call(chrome.tabs, "query", { windowId: currentWindow.id });
          const groups = await call(chrome.tabGroups, "query", { windowId: currentWindow.id });
          return {
            tidyText,
            undoHidden: document.querySelector("#undo-button").hidden,
            windowId: currentWindow.id,
            tabs: tabs.map((tab) => ({
              id: tab.id,
              url: tab.url,
              groupId: tab.groupId,
              pinned: tab.pinned
            })),
            groups: groups.map((group) => ({
              id: group.id,
              title: group.title,
              color: group.color,
              windowId: group.windowId
            }))
          };
        })()
      `);

      assert.equal(tidyResult.windowId, setup.windowId);
      assert.equal(tidyResult.undoHidden, false);
      assert.match(tidyResult.tidyText, /Created 1 group/);

      const fixtureTabs = tidyResult.tabs.filter((tab) => fixtureUrls.includes(tab.url));
      assert.equal(fixtureTabs.length, 2, "Expected both fixture tabs to be present.");
      assert.notEqual(fixtureTabs[0].groupId, -1, "First fixture tab was not grouped.");
      assert.equal(fixtureTabs[0].groupId, fixtureTabs[1].groupId, "Fixture tabs were not grouped together.");

      const createdGroup = tidyResult.groups.find((group) => group.id === fixtureTabs[0].groupId);
      assert(createdGroup, "Created tab group was not visible through chrome.tabGroups.");
      assert.equal(createdGroup.title, `Local ${server.address().port}`);

      const undoResult = await evaluate(popup, `
        (async () => {
          const call = (api, method, ...args) => new Promise((resolve, reject) => {
            api[method](...args, (value) => {
              const error = chrome.runtime.lastError;
              if (error) {
                reject(new Error(error.message));
                return;
              }
              resolve(value);
            });
          });
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const waitForElement = async (selector) => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const element = document.querySelector(selector);
              if (element) {
                return element;
              }
              await sleep(100);
            }
            throw new Error("Timed out waiting for popup element: " + selector);
          };
          const waitForText = async (needle) => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const text = document.querySelector("#result")?.textContent || "";
              if (text.includes(needle)) {
                return text;
              }
              await sleep(100);
            }
            throw new Error("Timed out waiting for popup text: " + needle + "; last text: " + (document.querySelector("#result")?.textContent || ""));
          };

          const undoButton = await waitForElement("#undo-button");
          undoButton.click();
          const undoText = await waitForText("Undid");
          const currentWindow = await call(chrome.windows, "getCurrent");
          const tabs = await call(chrome.tabs, "query", { windowId: currentWindow.id });
          const groups = await call(chrome.tabGroups, "query", { windowId: currentWindow.id });
          return {
            undoText,
            undoHidden: document.querySelector("#undo-button").hidden,
            tabs: tabs.map((tab) => ({
              id: tab.id,
              url: tab.url,
              groupId: tab.groupId
            })),
            groups: groups.map((group) => ({
              id: group.id,
              title: group.title
            }))
          };
        })()
      `);

      assert.match(undoResult.undoText, /Undid 2 tabs/);
      assert.equal(undoResult.undoHidden, true);
      const fixtureTabsAfterUndo = undoResult.tabs.filter((tab) => fixtureUrls.includes(tab.url));
      assert.equal(fixtureTabsAfterUndo.length, 2, "Expected both fixture tabs after undo.");
      assert.equal(fixtureTabsAfterUndo.every((tab) => tab.groupId === -1), true, "Undo did not ungroup fixture tabs.");
      assert.equal(undoResult.groups.some((group) => group.title === createdGroup.title), false);

      await evaluate(popup, `
        new Promise((resolve, reject) => {
          chrome.tabs.remove(${JSON.stringify(fixtureTabsAfterUndo.map((tab) => tab.id))}, () => {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve(true);
          });
        })
      `);

      const nativeFixtureUrls = [`${fixtureOrigin}/native-alpha`, `${fixtureOrigin}/native-beta`];
      await evaluate(popup, `
        (async () => {
          const call = (api, method, ...args) => new Promise((resolve, reject) => {
            api[method](...args, (value) => {
              const error = chrome.runtime.lastError;
              if (error) {
                reject(new Error(error.message));
                return;
              }
              resolve(value);
            });
          });
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const waitForTabUrls = async (windowId, urls) => {
            for (let attempt = 0; attempt < 120; attempt += 1) {
              const tabs = await call(chrome.tabs, "query", { windowId });
              if (urls.every((url) => tabs.some((tab) => tab.url === url))) {
                return tabs;
              }
              await sleep(100);
            }
            return await call(chrome.tabs, "query", { windowId });
          };
          await call(chrome.storage.local, "set", {
            provider: "local-codex-cli",
            minimumGroupSize: 2,
            includeFullUrls: false,
            includePageHints: true,
            ignorePinnedTabs: true,
            keepExistingGroups: true,
            collapseGroups: false,
            providerRequestTimeoutMs: 15000
          });
          const currentWindow = await call(chrome.windows, "getCurrent");
          for (const url of ${JSON.stringify(nativeFixtureUrls)}) {
            await call(chrome.tabs, "create", {
              windowId: currentWindow.id,
              url,
              active: false
            });
          }
          await waitForTabUrls(currentWindow.id, ${JSON.stringify(nativeFixtureUrls)});
          return { windowId: currentWindow.id };
        })()
      `, { userGesture: true });

      const nativeTidyResult = await evaluate(popup, `
        (async () => {
          const call = (api, method, ...args) => new Promise((resolve, reject) => {
            api[method](...args, (value) => {
              const error = chrome.runtime.lastError;
              if (error) {
                reject(new Error(error.message));
                return;
              }
              resolve(value);
            });
          });
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const waitForElement = async (selector) => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const element = document.querySelector(selector);
              if (element) {
                return element;
              }
              await sleep(100);
            }
            throw new Error("Timed out waiting for popup element: " + selector);
          };
          const waitForText = async (needle) => {
            for (let attempt = 0; attempt < 120; attempt += 1) {
              const text = document.querySelector("#result")?.textContent || "";
              if (text.includes(needle)) {
                return text;
              }
              await sleep(100);
            }
            throw new Error("Timed out waiting for popup text: " + needle + "; last text: " + (document.querySelector("#result")?.textContent || ""));
          };

          const tidyButton = await waitForElement("#tidy-button");
          tidyButton.click();
          const tidyText = await waitForText("Created");
          const currentWindow = await call(chrome.windows, "getCurrent");
          const tabs = await call(chrome.tabs, "query", { windowId: currentWindow.id });
          const groups = await call(chrome.tabGroups, "query", { windowId: currentWindow.id });
          return {
            tidyText,
            undoHidden: document.querySelector("#undo-button").hidden,
            tabs: tabs.map((tab) => ({
              id: tab.id,
              url: tab.url,
              groupId: tab.groupId
            })),
            groups: groups.map((group) => ({
              id: group.id,
              title: group.title,
              color: group.color
            }))
          };
        })()
      `);

      assert.equal(nativeTidyResult.undoHidden, false);
      assert.match(nativeTidyResult.tidyText, /Created 1 group/);
      assert.doesNotMatch(nativeTidyResult.tidyText, /fallback/i);

      const nativeFixtureTabs = nativeTidyResult.tabs.filter((tab) => nativeFixtureUrls.includes(tab.url));
      assert.equal(nativeFixtureTabs.length, 2, "Expected both native fixture tabs to be present.");
      assert.notEqual(nativeFixtureTabs[0].groupId, -1, "First native fixture tab was not grouped.");
      assert.equal(nativeFixtureTabs[0].groupId, nativeFixtureTabs[1].groupId, "Native fixture tabs were not grouped together.");

      const nativeGroup = nativeTidyResult.groups.find((group) => group.id === nativeFixtureTabs[0].groupId);
      assert(nativeGroup, "Native provider group was not visible through chrome.tabGroups.");
      assert.equal(nativeGroup.title, "Native Codex");
      assert.equal(nativeGroup.color, "purple");

      const nativeUndoResult = await evaluate(popup, `
        (async () => {
          const call = (api, method, ...args) => new Promise((resolve, reject) => {
            api[method](...args, (value) => {
              const error = chrome.runtime.lastError;
              if (error) {
                reject(new Error(error.message));
                return;
              }
              resolve(value);
            });
          });
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const waitForElement = async (selector) => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const element = document.querySelector(selector);
              if (element) {
                return element;
              }
              await sleep(100);
            }
            throw new Error("Timed out waiting for popup element: " + selector);
          };
          const waitForText = async (needle) => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const text = document.querySelector("#result")?.textContent || "";
              if (text.includes(needle)) {
                return text;
              }
              await sleep(100);
            }
            throw new Error("Timed out waiting for popup text: " + needle + "; last text: " + (document.querySelector("#result")?.textContent || ""));
          };

          const undoButton = await waitForElement("#undo-button");
          undoButton.click();
          const undoText = await waitForText("Undid");
          const currentWindow = await call(chrome.windows, "getCurrent");
          const tabs = await call(chrome.tabs, "query", { windowId: currentWindow.id });
          return {
            undoText,
            undoHidden: document.querySelector("#undo-button").hidden,
            tabs: tabs.map((tab) => ({
              id: tab.id,
              url: tab.url,
              groupId: tab.groupId
            }))
          };
        })()
      `);

      assert.match(nativeUndoResult.undoText, /Undid 2 tabs/);
      assert.equal(nativeUndoResult.undoHidden, true);
      const nativeFixtureTabsAfterUndo = nativeUndoResult.tabs.filter((tab) => nativeFixtureUrls.includes(tab.url));
      assert.equal(nativeFixtureTabsAfterUndo.length, 2, "Expected both native fixture tabs after undo.");
      assert.equal(nativeFixtureTabsAfterUndo.every((tab) => tab.groupId === -1), true, "Native provider undo did not ungroup fixture tabs.");

      await evaluate(popup, `
        new Promise((resolve) => {
          chrome.windows.remove(${setup.windowId}, () => resolve(true));
        })
      `).catch(() => null);
      } finally {
        popup.close();
      }
    } finally {
      browser.close();
    }

  console.log("Chrome unpacked extension smoke test passed, including Native Messaging provider flow with page hints.");
  } finally {
    if (chromeProcess) {
      await closeChrome(chromeProcess, profileDir).catch(() => null);
    }
    if (server) {
      await closeServer(server).catch(() => null);
    }
    if (restoreNativeHostManifest) {
      await restoreNativeHostManifest().catch(() => null);
    }
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => null);
    }
  }
}

function startFixtureServer() {
  const fixtureServer = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<title>${request.url}</title><h1>${request.url}</h1>`);
  });

  return new Promise((resolve, reject) => {
    fixtureServer.on("error", reject);
    fixtureServer.listen(0, "127.0.0.1", () => resolve(fixtureServer));
  });
}

async function prepareSmokeExtension(profileDir) {
  const extensionDir = path.join(profileDir, "extension");
  await cp(root, extensionDir, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      if (!relative) {
        return true;
      }
      return !relative.split(path.sep).some((part) =>
        part === ".git" ||
        part === "node_modules" ||
        part === "bin"
      );
    }
  });

  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const extensionKey = createExtensionKey();
  manifest.key = extensionKey.publicKeyBase64;
  manifest.permissions = Array.from(new Set([...(manifest.permissions || []), "nativeMessaging", "scripting"]));
  manifest.host_permissions = Array.from(new Set([...(manifest.host_permissions || []), "http://127.0.0.1/*"]));
  manifest.optional_permissions = (manifest.optional_permissions || [])
    .filter((permission) => permission !== "nativeMessaging" && permission !== "scripting");
  if (manifest.optional_permissions.length === 0) {
    delete manifest.optional_permissions;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    dir: extensionDir,
    id: extensionKey.extensionId
  };
}

function createExtensionKey() {
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "der"
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "der"
    }
  });
  return {
    publicKeyBase64: publicKey.toString("base64"),
    extensionId: extensionIdFromPublicKey(publicKey)
  };
}

function extensionIdFromPublicKey(publicKeyDer) {
  const hash = createHash("sha256").update(publicKeyDer).digest();
  const letters = [];
  for (const byte of hash.subarray(0, 16)) {
    letters.push(String.fromCharCode(97 + (byte >> 4)));
    letters.push(String.fromCharCode(97 + (byte & 0x0f)));
  }
  return letters.join("");
}

async function installTemporaryNativeHost(homeDir, extensionId) {
  const nativeDir = path.join(homeDir, "native-host");
  const binaryPath = path.join(nativeDir, "tab-grouper-native-host");
  const fakeCodexPath = path.join(nativeDir, "fake-codex.mjs");
  await mkdir(nativeDir, { recursive: true });
  await writeFile(fakeCodexPath, fakeCodexSource(), { mode: 0o755 });
  run("go", ["build", "-o", binaryPath, "."], path.join(root, "native-host"));
  await writeFile(
    `${binaryPath}.config.json`,
    `${JSON.stringify({
      version: 1,
      lockExecutables: true,
      codexExecutable: fakeCodexPath,
      claudeExecutable: ""
    }, null, 2)}\n`,
    { mode: 0o600 }
  );

  const manifest = `${JSON.stringify({
    name: nativeHostName,
    description: "Tab Grouper smoke test native host",
    path: binaryPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }, null, 2)}\n`;
  const realManifestDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  const realManifestPath = path.join(realManifestDir, `${nativeHostName}.json`);
  const previousManifest = await readFile(realManifestPath, "utf8").then(
    (contents) => ({ exists: true, contents }),
    () => ({ exists: false, contents: "" })
  );
  const manifestDirs = [
    realManifestDir,
    path.join(homeDir, "NativeMessagingHosts"),
    path.join(homeDir, "Default", "NativeMessagingHosts"),
    path.join(homeDir, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
  ];
  for (const manifestDir of manifestDirs) {
    await mkdir(manifestDir, { recursive: true });
    await writeFile(path.join(manifestDir, `${nativeHostName}.json`), manifest, { mode: 0o644 });
  }

  return async () => {
    if (previousManifest.exists) {
      await writeFile(realManifestPath, previousManifest.contents, { mode: 0o644 });
      return;
    }
    await rm(realManifestPath, { force: true });
  };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function fakeCodexSource() {
  return `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const outputIndex = args.indexOf("--output-last-message");
if (!args.includes("exec") || outputIndex < 0 || !args[outputIndex + 1]) {
  console.error("unexpected codex invocation");
  process.exit(2);
}
const inputMatch = stdin.match(/Input JSON:\\n([\\s\\S]*?)\\n\\nReturn exactly:/);
if (!inputMatch) {
  console.error("missing input JSON block");
  process.exit(3);
}
let input;
try {
  input = JSON.parse(inputMatch[1]);
} catch (error) {
  console.error("invalid input JSON block: " + error.message);
  process.exit(3);
}
const localTabs = (input.tabs || [])
  .filter((tab) => tab.domain === "127.0.0.1");
if (!localTabs.every((tab) => typeof tab.pageHint === "string" && tab.pageHint.includes("Title:"))) {
  console.error("expected superficial page hints for local fixture tabs");
  process.exit(3);
}
const tabIds = localTabs.map((tab) => tab.id);
if (tabIds.length < 2) {
  console.error("expected at least two local fixture tabs");
  process.exit(3);
}
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  groups: [
    { name: "Native Codex", color: "purple", tabIds: tabIds.slice(0, 2) }
  ]
}));
`;
}

async function waitForDebugPort(userDataDir, processHandle) {
  const activePortPath = path.join(userDataDir, "DevToolsActivePort");
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Chrome exited early with code ${processHandle.exitCode}.`);
    }
    try {
      const [port] = String(await readFile(activePortPath, "utf8")).trim().split("\n");
      if (Number.isInteger(Number(port))) {
        return Number(port);
      }
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Timed out waiting for Chrome remote debugging port.");
}

async function waitForTarget(port, predicate) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find(predicate);
    if (target) {
      return target;
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for Chrome target.");
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${url}`);
  }
  return await response.json();
}

async function evaluate(client, expression, options = {}) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: Boolean(options.userGesture)
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function closeChrome(processHandle, userDataDir) {
  try {
    const activePortPath = path.join(userDataDir, "DevToolsActivePort");
    const [port] = String(await readFile(activePortPath, "utf8")).trim().split("\n");
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const browser = await CdpClient.connect(version.webSocketDebuggerUrl, { enableRuntime: false });
    try {
      await browser.send("Browser.close");
    } finally {
      browser.close();
    }
  } catch {
    processHandle.kill("SIGTERM");
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      processHandle.kill("SIGKILL");
      resolve();
    }, 3000);
    processHandle.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function closeServer(fixtureServer) {
  return new Promise((resolve, reject) => {
    fixtureServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class CdpClient {
  static async connect(url, options = {}) {
    const enableRuntime = options.enableRuntime !== false;
    const client = new CdpClient(url);
    await client.open();
    if (enableRuntime) {
      await client.send("Runtime.enable");
    }
    return client;
  }

  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  open() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
        return;
      }
      resolve(message.result || {});
    });

    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP socket closed."));
      }
      this.pending.clear();
    });

    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(message);
    });
  }

  close() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

await runSmoke();
