import { createHash } from 'node:crypto';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalizeJson(record[key])]));
}

/** Hash JSON by semantic content rather than caller-controlled object key order. */
export function hashCanonicalJson(value: unknown): string {
  return sha256(JSON.stringify(canonicalizeJson(value)));
}
