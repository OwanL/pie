/**
 * Redact common credential forms before values cross durable analytics,
 * diagnostics, or renderer boundaries. This module is dependency-free so
 * reusable extensions and the VS Code host apply exactly the same policy.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[private key redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/([?&](?:x-api-key|api[_-]?key|token|session[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PRIVATE_KEY|PASSWORD)=)[^\s,;}]+/g, '$1[redacted]')
    .replace(/(["']?\b(?:x-api-key|api[_-]?key|authorization|proxy[_-]?authorization|password|passwd|passphrase|secret|token|session[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|credential|cookie|set-cookie)\b["']?\s*[:=]\s*)(["']?)([^"'&\s,;}]+)/gi, '$1$2[redacted]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[credential redacted]')
    .replace(/\[redacted\](?:\s+\[redacted\])+/g, '[redacted]');
}

const SENSITIVE_KEY_SUFFIXES = [
  'apikey', 'accesstoken', 'authtoken', 'refreshtoken', 'clientsecret',
  'privatekey', 'secretaccesskey', 'password', 'passphrase', 'credential',
  'token', 'authorization',
] as const;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'authorization' || normalized === 'bearer'
    || normalized === 'passwd' || normalized === 'secret'
    || normalized === 'cookie' || normalized === 'setcookie'
    || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function sanitizeBinary(value: Uint8Array): Uint8Array {
  // latin1 is deliberately one-byte-per-code-point: unmatched binary bytes are
  // preserved exactly while ASCII credential forms embedded in tool output are
  // filtered before content-addressed persistence.
  const original = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const filtered = redactSensitiveText(original.toString('latin1'));
  return Buffer.from(filtered, 'latin1');
}

/** Deep credential filtering for independently-owned analytics detail. It
 * preserves supported rich values while replacing sensitive properties and
 * credential-shaped text (including text carried in binary views) before
 * producer-side serialization. */
export function sanitizeAnalyticsDetail(value: unknown, active = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value === 'number') {
    // V8 serialization can encode the same integer as either an integer or a
    // double based on the value's hidden representation. Re-materialize the
    // signed-int32 range so semantic replays produce identical durable bytes.
    // Keep -0 distinct and collapse NaN payload variants to one value.
    if (Object.is(value, -0)) return -0;
    if (Number.isNaN(value)) return Number.NaN;
    if (Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff) return value | 0;
    return value;
  }
  if (value === null || value === undefined || typeof value === 'boolean'
    || typeof value === 'bigint') return value;
  if (Buffer.isBuffer(value)) return sanitizeBinary(value);
  if (value instanceof Uint8Array) return sanitizeBinary(value);
  if (value instanceof ArrayBuffer) return sanitizeBinary(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return sanitizeBinary(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== 'object') return undefined;
  if (active.has(value)) throw new Error('Cyclic analytics detail is not supported.');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      // Seed then remove a nonnumeric value so V8 uses one general tagged
      // element representation regardless of the source array's numeric
      // history. Setting the length first retains the semantic distinction
      // between a sparse slot and an explicit undefined value.
      const result: unknown[] = [null];
      result.pop();
      result.length = value.length;
      for (let index = 0; index < value.length; index += 1) {
        if (Object.prototype.hasOwnProperty.call(value, index)) {
          result[index] = sanitizeAnalyticsDetail(value[index], active);
        }
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      // Establish a general tagged field before storing its canonical value.
      // Otherwise V8 may specialize a numeric property from prior allocation
      // history and serialize the same int32 as a double on a later replay.
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: null,
      });
      result[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeAnalyticsDetail(child, active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}
