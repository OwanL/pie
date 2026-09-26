const textEncoder = new TextEncoder();

/** UTF-8 byte length of a string (browser-safe; no Node Buffer). */
export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}