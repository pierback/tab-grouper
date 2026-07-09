const textEncoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

export function truncateToByteLength(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (utf8ByteLength(text) <= maxBytes) {
    return text;
  }

  let bytes = 0;
  let truncated = "";
  for (const codePoint of text) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (bytes + codePointBytes > maxBytes) {
      break;
    }
    bytes += codePointBytes;
    truncated += codePoint;
  }
  return truncated;
}
