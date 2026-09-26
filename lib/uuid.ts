/**
 * Browser-safe UUID v4 generation.
 *
 * `crypto.randomUUID()` only exists in secure contexts, so renderers served
 * over plain `http://<lan-ip>` (LAN browser server) throw on every command.
 * This helper delegates to the native `randomUUID` when available and
 * otherwise builds a standards-compliant UUID v4 from
 * `crypto.getRandomValues`, which IS available on insecure contexts. Entropy
 * always comes from the platform CSPRNG — never `Math.random`.
 */

/** RFC 4122 UUID v4: 8-4-4-4-12 hex, version nibble `4`, variant `10xx`. */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

function hexByte(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/** Mint one UUID v4 (browser-safe: secure contexts and insecure contexts). */
export function createUuidV4(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('No secure entropy source: crypto.randomUUID and crypto.getRandomValues are both unavailable');
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  // Set the version (0100) and variant (10xx) bits per RFC 4122 §4.4.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, hexByte).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}