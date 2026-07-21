#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromManifestKey } from "./lib/extension_id.mjs";
import { resolveBrowserManifestTargets } from "./lib/native_host_browsers.mjs";
import { nativeHostRuntimePaths } from "./lib/native_host_runtime.mjs";

const NATIVE_HOST_NAME = "com.fabianpieringer.tab_grouper";

const args = parseArgs(process.argv.slice(2));
const browser = args.browser || "chrome";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (args.help) {
  printUsage();
  process.exit(0);
}

const extensionId = args["extension-id"] || readExtensionIdFromManifest(root);

if (!/^[a-p]{32}$/.test(extensionId)) {
  throw new Error("Extension ID must be the 32-character Chrome extension ID from chrome://extensions.");
}

if (process.platform !== "darwin") {
  throw new Error("This installer currently supports macOS Chrome-family browsers only.");
}

const browserTargets = resolveBrowserManifestTargets(browser);

const nativeHostDir = path.join(root, "native-host");
const binaryDir = path.join(nativeHostDir, "bin");
const binaryPath = path.join(binaryDir, "tab-grouper-native-host");
const configPath = `${binaryPath}.config.json`;
const codexExecutable = resolveExecutablePath(args["codex-path"] || "codex");
const claudeExecutable = resolveExecutablePath(args["claude-path"] || "claude");

run("nub", ["run", "build"], root);

fs.mkdirSync(binaryDir, { recursive: true });
run("go", ["build", "-o", binaryPath, "."], nativeHostDir);
fs.writeFileSync(
  configPath,
  `${JSON.stringify({
    version: 1,
    lockExecutables: true,
    codexExecutable,
    claudeExecutable
  }, null, 2)}\n`,
  { mode: 0o600 }
);
const daemonRestartResult = restartNativeHostDaemon(binaryPath);

const manifestContents = `${JSON.stringify({
  name: NATIVE_HOST_NAME,
  description: "Tab Grouper local Codex/Claude CLI bridge",
  path: binaryPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`]
}, null, 2)}\n`;
const installedManifests = browserTargets.map((target) => {
  const manifestDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    ...target.manifestDirParts,
    "NativeMessagingHosts"
  );
  const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(manifestPath, manifestContents, { mode: 0o644 });
  return { ...target, manifestPath };
});

console.log(`Built native host: ${binaryPath}`);
console.log(`Wrote native host config: ${configPath}`);
for (const target of installedManifests) {
  console.log(`Installed ${target.label} Native Messaging manifest: ${target.manifestPath}`);
}
if (daemonRestartResult.restarted) {
  console.log("Restarted native host daemon (old daemon terminated; a fresh one will start on next use).");
} else if (!daemonRestartResult.failed) {
  console.log("No running native host daemon to restart.");
}
if (!codexExecutable) {
  console.warn("Warning: codex CLI was not found during install. Local Codex CLI provider will fall back until reinstalled with a Codex path.");
}
if (!claudeExecutable) {
  console.warn("Warning: claude CLI was not found during install. Local Claude Code CLI provider will fall back until reinstalled with a Claude path.");
}

function parseArgs(rawArgs) {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const equalIndex = arg.indexOf("=");
    if (equalIndex > 0) {
      parsed[arg.slice(2, equalIndex)] = arg.slice(equalIndex + 1);
      continue;
    }
    const key = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function resolveExecutablePath(command) {
  if (!command) {
    return "";
  }
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return isExecutableFile(command) ? path.resolve(command) : "";
  }

  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return "";
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function restartNativeHostDaemon(executablePath) {
  const paths = nativeHostRuntimePaths(executablePath);
  const daemonPattern = `${escapeRegex(path.resolve(executablePath))}[[:space:]]+--daemon([[:space:]]|$)`;
  const result = spawnSync("pkill", ["-f", daemonPattern], {
    stdio: "ignore"
  });

  if (result.error) {
    console.warn(`Warning: failed to restart native host daemon: ${result.error.message}`);
    return { failed: true, restarted: false };
  }
  if (result.status !== 0 && result.status !== 1) {
    console.warn(`Warning: failed to restart native host daemon: pkill exited with status ${result.status}`);
    return { failed: true, restarted: false };
  }

  try {
    fs.rmSync(paths.socketPath, { force: true });
  } catch (error) {
    console.warn(`Warning: failed to remove stale native host daemon socket ${paths.socketPath}: ${error.message}`);
  }
  return { failed: false, restarted: result.status === 0 };
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function readExtensionIdFromManifest(rootDir) {
  const manifestPath = path.join(rootDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.key) {
    throw new Error("No --extension-id was provided and manifest.json has no key field. Run with --extension-id <chrome-extension-id> or ensure manifest.json has a key field.");
  }
  return extensionIdFromManifestKey(manifest.key);
}

function printUsage() {
  console.log(`Usage:
  nub run native:install
  nub run native:install --browser all
  nub run native:install --browser brave
  nub run native:install --codex-path /path/to/codex --claude-path /path/to/claude
  nub run native:install --extension-id <chrome-extension-id>

By default the installer derives the extension ID from manifest.json's key field.
Pass --browser all to install for Chrome, Brave, Edge, Chromium, Chrome Canary, and Helium.
Pass --extension-id to override it for another loaded extension.`);
}
