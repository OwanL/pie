/** Bounded text fingerprints for renderer-owned transcript leaf comparisons. */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const DEFAULT_TEXT_SAMPLE_CHARS = 192;

export interface BoundedTextIdentity {
  length: number;
  /** Non-cryptographic checksum of bounded head/middle/tail samples. */
  hash: string;
}

/** Hash text without traversing more than head + middle + tail sample budgets. */
export function boundedTextIdentity(value: string, sampleChars: number = DEFAULT_TEXT_SAMPLE_CHARS): BoundedTextIdentity {
  assertNonNegativeInteger('sampleChars', sampleChars);
  const sample = boundedTextSample(value, sampleChars);
  return { length: value.length, hash: hashString(`${value.length}\u0000${sample}`) };
}

export function equalBoundedTextIdentity(left: BoundedTextIdentity, right: BoundedTextIdentity): boolean {
  return left.length === right.length && left.hash === right.hash;
}

function boundedTextSample(value: string, sampleChars: number): string {
  if (sampleChars === 0) return '';
  if (value.length <= sampleChars * 3) return value;
  const middleStart = Math.max(0, Math.floor(value.length / 2) - Math.floor(sampleChars / 2));
  return [
    value.slice(0, sampleChars),
    value.slice(middleStart, middleStart + sampleChars),
    value.slice(-sampleChars),
  ].join('\u0000');
}

function hashString(value: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
