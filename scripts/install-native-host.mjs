#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NATIVE_HOST_NAME = "com.fabianpieringer.tab_grouper";
const BROWSER_MANIFEST_DIRS = {
  chrome: ["Google", "Chrome"],
  "chrome-canary": ["Google", "Chrome Canary"],
  chromium: ["Chromium"],
  brave: ["BraveSoftware", "Brave-Browser"],
  edge: ["Microsoft Edge"]
};

const args = parseArgs(process.argv.slice(2));
const browser = args.browser || "chrome";
const extensionId = args["extension-id"];

if (args.help || !extensionId) {
  printUsage();
  process.exit(extensionId ? 0 : 1);
}

if (!/^[a-p]{32}$/.test(extensionId)) {
  throw new Error("Extension ID must be the 32-character Chrome extension ID from chrome://extensions.");
}

if (process.platform !== "darwin") {
  throw new Error("This installer currently supports macOS Chrome-family browsers only.");
}

const browserDirParts = BROWSER_MANIFEST_DIRS[browser];
if (!browserDirParts) {
  throw new Error(`Unsupported browser "${browser}". Supported: ${Object.keys(BROWSER_MANIFEST_DIRS).join(", ")}.`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeHostDir = path.join(root, "native-host");
const binaryDir = path.join(nativeHostDir, "bin");
const binaryPath = path.join(binaryDir, "tab-grouper-native-host");
const configPath = `${binaryPath}.config.json`;
const codexExecutable = resolveExecutablePath(args["codex-path"] || "codex");
const claudeExecutable = resolveExecutablePath(args["claude-path"] || "claude");

run("npm", ["run", "build"], root);

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

const manifestDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  ...browserDirParts,
  "NativeMessagingHosts"
);
const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
fs.mkdirSync(manifestDir, { recursive: true });
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify({
    name: NATIVE_HOST_NAME,
    description: "Tab Grouper local Codex/Claude CLI bridge",
    path: binaryPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  }, null, 2)}\n`,
  { mode: 0o644 }
);

console.log(`Built native host: ${binaryPath}`);
console.log(`Wrote native host config: ${configPath}`);
console.log(`Installed Native Messaging manifest: ${manifestPath}`);
if (!codexExecutable) {
  console.warn("Warning: codex CLI was not found during install. Local Codex CLI provider will fall back until reinstalled with a Codex path.");
}
if (!claudeExecutable) {
  console.warn("Warning: claude CLI was not found during install. Local Claude Code CLI provider will fall back until reinstalled with a Claude path.");
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
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
    const value = rawArgs[index + 1];
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

function printUsage() {
  console.log(`Usage:
  npm run native:install -- --extension-id <chrome-extension-id>
  npm run native:install -- --browser brave --extension-id <chrome-extension-id>
  npm run native:install -- --extension-id <chrome-extension-id> --codex-path /path/to/codex --claude-path /path/to/claude

Find the extension ID in chrome://extensions after loading this folder unpacked.`);
}
