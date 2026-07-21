import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function nativeHostRuntimePaths(executablePath) {
  const runtimeId = nativeHostRuntimeId(executablePath);
  const basePath = path.join("/tmp", `tab-grouper-native-host-${runtimeId}`);

  return {
    socketPath: `${basePath}.sock`,
    lockPath: `${basePath}.lock`,
    logPath: `${basePath}-daemon.log`
  };
}

function nativeHostRuntimeId(executablePath) {
  const absolutePath = path.resolve(executablePath);
  let resolvedPath = absolutePath;
  try {
    resolvedPath = fs.realpathSync(absolutePath);
  } catch {
    // Hash the absolute path when the executable does not exist yet.
  }

  return createHash("sha256").update(resolvedPath).digest("hex").slice(0, 16);
}
