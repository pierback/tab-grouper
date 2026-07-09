import { createHash } from "node:crypto";

export function extensionIdFromPublicKey(publicKeyDer) {
  const hash = createHash("sha256").update(publicKeyDer).digest();
  const letters = [];
  for (const byte of hash.subarray(0, 16)) {
    letters.push(String.fromCharCode(97 + (byte >> 4)));
    letters.push(String.fromCharCode(97 + (byte & 0x0f)));
  }
  return letters.join("");
}

export function extensionIdFromManifestKey(manifestKey) {
  if (typeof manifestKey !== "string" || manifestKey.length === 0) {
    throw new Error("manifest.json must contain a non-empty string key field.");
  }
  return extensionIdFromPublicKey(Buffer.from(manifestKey, "base64"));
}
