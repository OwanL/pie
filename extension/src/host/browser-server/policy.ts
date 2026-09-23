/**
 * Browser server policy (browser server plan §5.3/§6.3/§4.1).
 *
 * Pure, hand-rolled validators and bounds for the browser-server boundary:
 * Host and Origin checks (DNS-rebinding / foreign-origin defense), connection/payload
 * bounds, handshake bounds, and the pre-send socket gates. No dependencies;
 * everything here is deterministic and unit-testable without a socket.
 */

/** Policy constants. */
export const BROWSER_SERVER_POLICY = {
  /** Max concurrent browser renderers per host instance (§5.3). */
  maxConcurrentRenderers: 4,
  /** Bound handshake time: a socket that never sends `ready` is closed. */
  handshakeTimeoutMs: 10_000,
  /** Malformed-message rate bound (§5.3): ≥ 5 violations within the window
   *  close the socket with a typed reason. */
  maxMalformedMessages: 5,
  malformedWindowMs: 60_000,
  /** Pre-send gate: socket bufferedAmount above this high-water mark stops
   *  further snapshot posts (latest-wins coalescing, §4.1). */
  bufferedAmountHighWaterBytes: 8 * 1024 * 1024,
  /** Hard record ceiling (matches `browser-ingress` 32 MiB). */
  maxFrameBytes: 32 * 1024 * 1024,
  /** Default loopback port preference (§6.2). */
  defaultPort: 1997,
  /** Min/max valid configured port. */
  minPort: 1,
  maxPort: 65535,
} as const;

/** Canonical loopback host names accepted in the `Host` header. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Validate the `Host` header against the canonical loopback host/port
 * (browser server plan §6.3). Browsers send `host[:port]`; the port must
 * match the actual bound port when present. A missing Host header, a foreign
 * hostname, a loopback host with a mismatched port, or a header with an
 * embedded path is rejected.
 */
export function isValidLoopbackHostHeader(
  hostHeader: string | undefined,
  expectedPort: number,
): boolean {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
  if (hostHeader.length > 255) return false;
  // No scheme, path, query, or userinfo may appear in a valid Host header.
  if (hostHeader.includes('/') || hostHeader.includes('\\') || hostHeader.includes('@')
    || hostHeader.includes('?') || hostHeader.includes('#')) {
    return false;
  }
  // Bracket IPv6 form: `[::1]` or `[::1]:port`.
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']');
    if (close < 0) return false;
    const host = hostHeader.slice(0, close + 1);
    if (!LOOPBACK_HOSTS.has(host)) return false;
    const rest = hostHeader.slice(close + 1);
    if (rest === '') return true;
    if (!rest.startsWith(':')) return false;
    return rest.slice(1) === String(expectedPort);
  }
  const colon = hostHeader.lastIndexOf(':');
  if (colon < 0) {
    // No port: accept only if the expected port is the default HTTP port the
    // client would omit — loopback ports are ephemeral, so require the port.
    return false;
  }
  const host = hostHeader.slice(0, colon);
  const port = hostHeader.slice(colon + 1);
  if (!LOOPBACK_HOSTS.has(host)) return false;
  if (!/^[0-9]{1,5}$/u.test(port)) return false;
  return Number(port) === expectedPort;
}

/**
 * Validate Host against loopback or one of this host's exact private IPv4
 * interface addresses. LAN acceptance is explicit and address-scoped: DNS
 * names, public IPs, and arbitrary RFC1918 addresses are not accepted.
 */
export function isValidBrowserHostHeader(
  hostHeader: string | undefined,
  expectedPort: number,
  allowedLanAddresses: readonly string[] = [],
): boolean {
  if (isValidLoopbackHostHeader(hostHeader, expectedPort)) return true;
  if (typeof hostHeader !== 'string' || hostHeader.length === 0 || hostHeader.length > 255) return false;
  if (hostHeader.includes('/') || hostHeader.includes('\\') || hostHeader.includes('@')
    || hostHeader.includes('?') || hostHeader.includes('#')) return false;
  const colon = hostHeader.lastIndexOf(':');
  if (colon <= 0) return false;
  const host = hostHeader.slice(0, colon);
  const port = hostHeader.slice(colon + 1);
  return port === String(expectedPort)
    && isLanIPv4Address(host)
    && allowedLanAddresses.includes(host);
}

/** Whether an address is RFC1918 or IPv4 link-local (the supported LAN scope). */
export function isLanIPv4Address(address: string): boolean {
  const octets = parseIPv4Address(address);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

/**
 * Restrict request sources as well as their browser-supplied Host/Origin
 * headers. A wildcard-bound LAN listener must not accept public IPv4 clients
 * that can forge those headers. IPv4-mapped addresses are normalized because
 * Node may expose them for dual-stack sockets.
 */
export function isAllowedBrowserRemoteAddress(remoteAddress: string | undefined, allowLan: boolean): boolean {
  if (!remoteAddress) return false;
  if (remoteAddress === '::1') return true;
  const address = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress;
  const octets = parseIPv4Address(address);
  if (!octets) return false;
  if (octets[0] === 127) return true;
  return allowLan && isLanIPv4Address(address);
}

function parseIPv4Address(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/u.test(part))) return null;
  const octets = parts.map(Number);
  return octets.some((octet) => octet < 0 || octet > 255) ? null : octets;
}

/**
 * Validate the `Origin` header of a WebSocket upgrade (browser server plan
 * §6.3): by default accept only the exact `http://127.0.0.1:<port>` origin.
 * LAN mode additionally accepts exact private IPv4 interface origins supplied
 * from this server's advertised URLs. Missing, `null`, wildcard,
 * extension-webview, and foreign origins are rejected; `localhost` remains
 * rejected because the served page uses the canonical 127.0.0.1 origin.
 */
export function isValidWebSocketOrigin(
  originHeader: string | undefined,
  expectedPort: number,
  allowedLanAddresses: readonly string[] = [],
): boolean {
  if (typeof originHeader !== 'string' || originHeader.length === 0) return false;
  if (originHeader.length > 512) return false;
  if (originHeader === 'null') return false;
  // Keep the canonical loopback origin exact. Opted-in LAN pages additionally
  // accept only the exact private IPv4 interface origin advertised by Pie.
  if (originHeader === `http://127.0.0.1:${expectedPort}`) return true;
  return allowedLanAddresses.some((address) => isLanIPv4Address(address)
    && originHeader === `http://${address}:${expectedPort}`);
}

/** `origin` string for the served page (used for CSP `connect-src` too). */
export function servedOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The page URL of a running server. */
export function pageUrl(port: number): string {
  return `${servedOrigin(port)}/`;
}

/** Whether a configured port is within the valid range (1..65535). */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= BROWSER_SERVER_POLICY.minPort && port <= BROWSER_SERVER_POLICY.maxPort;
}

/** A bounded violation tracker: ≥ `max` violations within `windowMs` trips. */
export class ViolationRateTracker {
  private violations: number[] = [];

  constructor(
    private readonly max: number = BROWSER_SERVER_POLICY.maxMalformedMessages,
    private readonly windowMs: number = BROWSER_SERVER_POLICY.malformedWindowMs,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record one violation; returns true when the bound is now exceeded. */
  record(): boolean {
    const now = this.now();
    this.violations = this.violations.filter((at) => now - at <= this.windowMs);
    this.violations.push(now);
    return this.violations.length >= this.max;
  }

  reset(): void {
    this.violations = [];
  }
}

/** Pre-send gate result (§4.1). */
export type SendGateResult =
  | { ok: true }
  | { ok: false; reason: 'buffered-amount-high-water' }
  | { ok: false; reason: 'combined-frame-over-limit' };

/**
 * Pre-send gate for one candidate browser frame. The transport measures the
 * complete candidate frame (`frameBytes`, including its renderer envelope)
 * and rejects/coalesces it when `bufferedAmount > 8 MiB` or
 * `bufferedAmount + frameBytes > 32 MiB`. A lagging browser receives the
 * LATEST snapshot only — delivery is latest-wins coalescing, never a backlog.
 */
export function evaluateSendGate(
  bufferedAmountBytes: number,
  frameBytes: number,
): SendGateResult {
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 0 || frameBytes > BROWSER_SERVER_POLICY.maxFrameBytes) {
    return { ok: false, reason: 'combined-frame-over-limit' };
  }
  if (!Number.isSafeInteger(bufferedAmountBytes) || bufferedAmountBytes < 0) {
    return { ok: false, reason: 'buffered-amount-high-water' };
  }
  if (bufferedAmountBytes > BROWSER_SERVER_POLICY.bufferedAmountHighWaterBytes) {
    return { ok: false, reason: 'buffered-amount-high-water' };
  }
  if (bufferedAmountBytes + frameBytes > BROWSER_SERVER_POLICY.maxFrameBytes) {
    return { ok: false, reason: 'combined-frame-over-limit' };
  }
  return { ok: true };
}
