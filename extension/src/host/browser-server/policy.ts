/**
 * Browser server policy (browser server plan §5.3/§6.3/§4.1).
 *
 * Pure, hand-rolled validators and bounds for the loopback boundary: Host and
 * Origin checks (DNS-rebinding / foreign-origin defense), connection/payload
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
 * Validate the `Origin` header of a WebSocket upgrade (browser server plan
 * §6.3): accept only the EXACT served origin (`http://127.0.0.1:<port>`).
 * Missing, `null`, wildcard, extension-webview, and foreign origins are
 * rejected. The served HTML never uses `localhost` in scripts, so
 * `http://localhost:<port>` is also rejected (it is not the served origin).
 */
export function isValidWebSocketOrigin(originHeader: string | undefined, expectedPort: number): boolean {
  if (typeof originHeader !== 'string' || originHeader.length === 0) return false;
  if (originHeader.length > 512) return false;
  if (originHeader === 'null') return false;
  // The served origin is exactly http://127.0.0.1:<port> — nothing else.
  return originHeader === `http://127.0.0.1:${expectedPort}`;
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
