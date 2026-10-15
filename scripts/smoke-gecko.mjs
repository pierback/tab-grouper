import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { GECKO_EXTENSION_ID } from "./lib/gecko_manifest.mjs";

const BROWSERS = {
  zen: { path: process.env.ZEN_PATH || "/Applications/Zen Browser.app/Contents/MacOS/zen", zenFolders: true },
  firefox: { path: process.env.FIREFOX_PATH || "/Applications/Firefox.app/Contents/MacOS/firefox", zenFolders: false }
};

const root = process.cwd();
const target = readTarget(process.argv.slice(2));
const browser = BROWSERS[target];
const headed = process.env.GECKO_SMOKE_HEADED === "1";
const nativeHostName = "com.fabianpieringer.tab_grouper";
const timeoutMs = 150_000;

async function runSmoke() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), `tab-grouper-${target}-smoke-`));
  let browserProcess;
  let server;
  let restoreNativeHostManifest = null;

  try {
    run("nub", ["run", `build:${target}`], root);
    restoreNativeHostManifest = await installTemporaryNativeHost(workDir);
    const report = createDeferred();
    server = await startFixtureServer(report);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const extensionDir = await prepareSmokeExtension(workDir, origin);

    browserProcess = spawn(path.join(root, "node_modules", ".bin", "web-ext"), [
      "run",
      "--source-dir", extensionDir,
      "--firefox", browser.path,
      "--profile-create-if-missing",
      "--firefox-profile", path.join(workDir, "profile"),
      "--no-reload",
      ...(browser.zenFolders ? ["--pref", "extensions.experiments.enabled=true"] : []),
      ...(headed ? [] : ["--arg=-headless"])
    ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const output = [];
    browserProcess.stdout.on("data", (chunk) => output.push(String(chunk)));
    browserProcess.stderr.on("data", (chunk) => output.push(String(chunk)));

    const result = await withTimeout(report.promise, timeoutMs, () => `${target} smoke timed out.\n${output.join("")}`);
    verify(result);
    console.log(`${target} smoke test passed.`);
  } finally {
    // web-ext does not stop the browser it launched, so end the whole process group.
    if (browserProcess?.pid) {
      try {
        process.kill(-browserProcess.pid, "SIGTERM");
      } catch {}
    }
    server?.close();
    await restoreNativeHostManifest?.();
    await rm(workDir, { recursive: true, force: true });
  }
}

function verify(result) {
  assert.equal(result.error, undefined, result.error);
  const { tidy, afterTidy, undo, afterUndo, fixtureTabIds } = result;
  assert.equal(tidy.ok, true, JSON.stringify(tidy));
  assert.equal(tidy.provider, "local-codex-cli", JSON.stringify(tidy));
  assert.equal(tidy.usedFallback, false, JSON.stringify(tidy));

  // Zen builds create folders; the Firefox build falls back to tab groups for the same setting.
  const group = afterTidy.groups.find((candidate) => candidate.title === "Native Codex");
  assert.ok(group, `Expected a "Native Codex" group: ${JSON.stringify(afterTidy.groups)}`);
  assert.equal(group.color, browser.zenFolders ? "zen-workspace-color" : "purple");
  assert.equal(group.collapsed, true);
  for (const tabId of fixtureTabIds) {
    const tab = afterTidy.tabs.find((candidate) => candidate.id === tabId);
    assert.equal(tab?.groupId, group.id, `Tab ${tabId} should be in the group.`);
    assert.equal(tab?.pinned, browser.zenFolders, `Tab ${tabId} pinned state after tidy.`);
  }

  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(afterUndo.groups.some((candidate) => candidate.id === group.id), false, "Undo should remove the group.");
  for (const tabId of fixtureTabIds) {
    const tab = afterUndo.tabs.find((candidate) => candidate.id === tabId);
    assert.equal(tab?.groupId, -1, `Tab ${tabId} should be ungrouped after undo.`);
    assert.equal(tab?.pinned, false, `Tab ${tabId} should be unpinned after undo.`);
  }
}

async function prepareSmokeExtension(workDir, origin) {
  const extensionDir = path.join(workDir, "extension");
  await cp(path.join(root, "build", target), extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // Optional permissions need a user gesture, which a headless run cannot provide.
  manifest.permissions = [...manifest.permissions, "nativeMessaging"];
  manifest.background.scripts = [...manifest.background.scripts, "smoke_background.js"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(extensionDir, "smoke_background.js"), `chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("smoke.html") + "?origin=" + encodeURIComponent(${JSON.stringify(origin)}) });
});
`);
  await writeFile(path.join(extensionDir, "smoke.html"), `<!doctype html><meta charset="utf-8"><title>Tab Grouper smoke</title><script type="module" src="smoke.js"></script>\n`);
  await writeFile(path.join(extensionDir, "smoke.js"), smokePageSource());
  return extensionDir;
}

function smokePageSource() {
  return `const origin = new URLSearchParams(location.search).get("origin");

async function snapshot(windowId) {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId })
  ]);
  return {
    tabs: tabs.map(({ id, pinned, groupId, url }) => ({ id, pinned, groupId, url })),
    groups
  };
}

async function waitForComplete(tabIds) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
    if (tabs.every((tab) => tab.status === "complete" && tab.url.startsWith(origin))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const states = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
  throw new Error("Fixture tabs did not finish loading: " + JSON.stringify(states.map(({ status, url, title }) => ({ status, url, title }))));
}

function step(name) {
  return fetch(origin + "/step", { method: "POST", body: name }).catch(() => {});
}

async function run() {
  await step("page started");
  await chrome.storage.local.set({ provider: "local-codex-cli", groupTarget: "zen-folders", allowHeuristicFallback: false });
  const { id: windowId } = await chrome.windows.getCurrent();
  const fixtureTabIds = [];
  for (const name of ["alpha", "beta", "gamma"]) {
    const tab = await chrome.tabs.create({ url: origin + "/" + name, active: false, windowId });
    fixtureTabIds.push(tab.id);
  }
  await step("fixture tabs opened");
  await waitForComplete(fixtureTabIds);
  await step("fixture tabs loaded");
  const tidy = await chrome.runtime.sendMessage({ type: "TIDY_CURRENT_WINDOW", windowId });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await step("tidy returned " + JSON.stringify(tidy).slice(0, 300));
  const afterTidy = await snapshot(windowId);
  const undo = await chrome.runtime.sendMessage({ type: "UNDO_LAST_TIDY", windowId });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterUndo = await snapshot(windowId);
  return { fixtureTabIds, tidy, afterTidy, undo, afterUndo };
}

run()
  .catch((error) => ({ error: String(error) + "\n" + (error?.stack || "") }))
  .then((result) => fetch(origin + "/report", { method: "POST", body: JSON.stringify(result) }));
`;
}

async function installTemporaryNativeHost(workDir) {
  const nativeDir = path.join(workDir, "native-host");
  const binaryPath = path.join(nativeDir, "tab-grouper-native-host");
  const fakeCodexPath = path.join(nativeDir, "fake-codex.mjs");
  await mkdir(nativeDir, { recursive: true });
  await writeFile(fakeCodexPath, fakeCodexSource(), { mode: 0o755 });
  run("go", ["build", "-o", binaryPath, "."], path.join(root, "native-host"));
  await writeFile(
    `${binaryPath}.config.json`,
    `${JSON.stringify({ version: 1, lockExecutables: true, codexExecutable: fakeCodexPath, claudeExecutable: "" }, null, 2)}\n`,
    { mode: 0o600 }
  );

  const manifestDir = path.join(os.homedir(), "Library", "Application Support", "Mozilla", "NativeMessagingHosts");
  const manifestPath = path.join(manifestDir, `${nativeHostName}.json`);
  const previousManifest = await readFile(manifestPath, "utf8").then(
    (contents) => ({ exists: true, contents }),
    () => ({ exists: false, contents: "" })
  );
  await mkdir(manifestDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify({
    name: nativeHostName,
    description: "Tab Grouper Gecko smoke test native host",
    path: binaryPath,
    type: "stdio",
    allowed_extensions: [GECKO_EXTENSION_ID]
  }, null, 2)}\n`, { mode: 0o644 });

  return async () => {
    spawnSync("pkill", ["-f", `${binaryPath} --daemon`], { stdio: "ignore" });
    if (previousManifest.exists) {
      await writeFile(manifestPath, previousManifest.contents, { mode: 0o644 });
      return;
    }
    await rm(manifestPath, { force: true });
  };
}

function fakeCodexSource() {
  return `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const outputIndex = args.indexOf("--output-last-message");
const inputMatch = stdin.match(/Input JSON:\\n([\\s\\S]*?)\\n\\nReturn exactly:/);
if (!args.includes("exec") || outputIndex < 0 || !inputMatch) {
  console.error("unexpected codex invocation");
  process.exit(2);
}
const tabIds = JSON.parse(inputMatch[1]).tabs
  .filter((tab) => tab.domain === "127.0.0.1")
  .map((tab) => tab.id);
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  groups: [{ name: "Native Codex", color: "purple", tabIds }]
}));
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }) + "\\n");
`;
}

function startFixtureServer(report) {
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/step") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.end("ok");
        console.log(`[smoke step] ${body}`);
      });
      return;
    }
    if (request.method === "POST" && request.url === "/report") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.end("ok");
        report.resolve(JSON.parse(body));
      });
      return;
    }
    const name = request.url.slice(1) || "index";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Fixture ${name}</title><h1>${name}</h1>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function readTarget(args) {
  const index = args.indexOf("--target");
  const value = index === -1 ? "zen" : args[index + 1];
  if (!Object.hasOwn(BROWSERS, value)) {
    throw new Error(`Unsupported smoke target "${value}". Supported: ${Object.keys(BROWSERS).join(", ")}.`);
  }
  return value;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

await runSmoke();
