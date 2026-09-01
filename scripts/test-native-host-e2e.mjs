import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeHostRuntimePaths } from "./lib/native_host_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeHostDir = path.join(root, "native-host");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tab-grouper-native-e2e-"));
const daemonTestEnv = {
  TAB_GROUPER_NATIVE_HOST_IDLE_TIMEOUT_MS: "500",
  TAB_GROUPER_NATIVE_HOST_IDLE_CHECK_INTERVAL_MS: "50"
};
let binaryPath;

try {
  binaryPath = path.join(tempDir, "tab-grouper-native-host");
  const fakeCodexPath = path.join(tempDir, "fake-codex.mjs");
  fs.writeFileSync(fakeCodexPath, fakeCodexSource(), { mode: 0o755 });
  run("go", ["build", "-o", binaryPath, "."], nativeHostDir);
  fs.writeFileSync(
    `${binaryPath}.config.json`,
    `${JSON.stringify({
      version: 1,
      lockExecutables: true,
      codexExecutable: fakeCodexPath,
      claudeExecutable: ""
    }, null, 2)}\n`,
    { mode: 0o600 }
  );

  const statusResponse = await runNativeHost(binaryPath, {
    version: 3,
    type: "NATIVE_HOST_STATUS_REQUEST",
    requestId: "native-e2e-status-1",
    provider: "codex"
  });

  assert.equal(statusResponse.ok, true, JSON.stringify(statusResponse));
  assert.equal(statusResponse.version, 3);
  assert.equal(statusResponse.provider, "local-codex-cli");
  assert.deepEqual(statusResponse.status, {
    provider: "local-codex-cli",
    configured: true,
    executableAvailable: true,
    authChecked: true,
    authenticated: true,
    lockExecutables: true
  });

  const response = await runNativeHost(binaryPath, {
    version: 3,
    type: "TAB_GROUP_PLAN_REQUEST",
    requestId: "native-e2e-1",
    provider: "codex",
    timeoutMs: 5000,
    minimumGroupSize: 2,
    tabs: [
      { id: 1, title: "Issue", domain: "github.com" },
      { id: 2, title: "Pull Request", domain: "github.com" }
    ]
  });

  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.version, 3);
  assert.equal(response.provider, "local-codex-cli");
  assert.deepEqual(response.plan.groups, [
    { name: "Pinned Codex", color: "blue", tabIds: [1, 2] }
  ]);
  console.log("Native host framed E2E test passed.");
} finally {
  if (binaryPath) {
    await waitForDaemonShutdown(nativeHostRuntimePaths(binaryPath).socketPath);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
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

async function runNativeHost(binaryPath, request) {
  const child = spawn(binaryPath, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...daemonTestEnv }
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  child.stdin.end(encodeNativeMessage(request));

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  assert.equal(exitCode, 0, stderr);

  const stdout = Buffer.concat(stdoutChunks);
  assert.ok(stdout.length >= 4, `native host returned no framed output. stderr: ${stderr}`);
  const size = stdout.readUInt32LE(0);
  assert.equal(stdout.length, size + 4, `unexpected native response size. stderr: ${stderr}`);
  return JSON.parse(stdout.subarray(4).toString("utf8"));
}

async function waitForDaemonShutdown(socketPath) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    if (!fs.existsSync(socketPath)) {
      return;
    }
    await sleep(50);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function fakeCodexSource() {
  return `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.join(" ") === "login status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (!args.includes("exec")) {
  console.error("expected codex exec");
  process.exit(2);
}
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex < 0 || !args[outputIndex + 1]) {
  console.error("missing output path");
  process.exit(2);
}
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  groups: [
    { name: "Pinned Codex", color: "blue", tabIds: [1, 2] }
  ]
}));
`;
}
