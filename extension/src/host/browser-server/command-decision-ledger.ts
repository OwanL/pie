/**
 * Browser command decision ledger + gate (browser server plan §5.2).
 *
 * Every schema-valid browser application command that reaches host command
 * routing records exactly one terminal host decision (`accepted` | `rejected`)
 * and produces exactly one host-side `commandAck` emission. The bounded,
 * host-instance-local ledger stores `{clientCommandId, canonical fingerprint,
 * decision, reason?, decidedAt}` with a finite TTL and capacity:
 *
 *   - a duplicate `clientCommandId` with the SAME fingerprint is never run
 *     twice and never receives a second ack — it is answered only through a
 *     `commandStatusRequest` (read-only reconciliation);
 *   - a duplicate `clientCommandId` with a DIFFERENT payload is a typed
 *     protocol violation: no second `commandAck`, and the socket is closed;
 *   - neither path re-enters the reducer/effect path.
 *
 * The exactly-once property is about the host decision and emission, not
 * network delivery: a close can lose the ack before the browser observes it,
 * so the client may see one ack or zero acks, and reconciliation happens
 * through the ledger (never by replaying the command).
 */

import type { RendererCommandContext, WebviewToHostMessage } from '../../shared/protocol';
import { isBrowserApplicationCommand } from '../../shared/browser-ingress';

/** TTL of one ledger entry (finite, host-instance-local). */
export const COMMAND_DECISION_TTL_MS = 10 * 60 * 1000;
/** Bounded capacity; oldest entries are evicted first. */
export const COMMAND_DECISION_CAPACITY = 256;

export interface CommandDecisionEntry {
  clientCommandId: string;
  fingerprint: string;
  /** `pending` = reserved in-flight (concurrent-duplicate fence); the final
   *  decision overwrites it. Status queries map `pending` to `unknown`. */
  decision: 'pending' | 'accepted' | 'rejected';
  reason?: string;
  decidedAt: number;
}

/**
 * Deterministic canonical fingerprint of a command payload: stable JSON with
 * recursively sorted keys, excluding the browser-minted `clientCommandId`
 * (the ledger key) and `viewGeneration` (renderer-stamped per socket, so a
 * reconnect resend of the same command carries a fresh generation).
 */
export function canonicalCommandFingerprint(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => key !== 'clientCommandId' && key !== 'viewGeneration')
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** Bounded host-instance-local decision ledger. */
export class BrowserCommandDecisionLedger {
  private readonly entries = new Map<string, CommandDecisionEntry>();

  constructor(
    private readonly capacity: number = COMMAND_DECISION_CAPACITY,
    private readonly ttlMs: number = COMMAND_DECISION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record one terminal decision; bounded capacity, oldest first. */
  record(entry: CommandDecisionEntry): void {
    this.prune();
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(entry.clientCommandId, entry);
  }

  lookup(clientCommandId: string): CommandDecisionEntry | undefined {
    this.prune();
    return this.entries.get(clientCommandId);
  }

  /** Drop entries older than the TTL. */
  prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.decidedAt > this.ttlMs) this.entries.delete(id);
    }
  }

  size(): number {
    return this.entries.size;
  }
}

/** Host-side routing of a validated browser message (the `MessageRouter`). */
export type BrowserRouteMessage = (msg: WebviewToHostMessage, context: RendererCommandContext) => Promise<void>;

/** Ack emission to one renderer (targeted imperative). */
export type BrowserPostToRenderer = (rendererId: string, message: import('../../shared/protocol').HostToWebviewMessage) => void;

/** Typed socket closure for a protocol violation. */
export type BrowserCloseRenderer = (rendererId: string, reason: string) => void;

export interface BrowserCommandGateOptions {
  /** The host command router (with per-renderer `context` threading). */
  routeMessage: BrowserRouteMessage;
  /** Emit a targeted imperative to one renderer (hub.postImperative). */
  postToRenderer: BrowserPostToRenderer;
  /** Close the renderer's socket for a typed protocol violation. */
  closeRenderer: BrowserCloseRenderer;
  /** A validated `inlineConfirmResponse` from a renderer (the source-aware
   *  confirmation seam resolves here, never through command routing). */
  onInlineConfirmResponse?(rendererId: string, confirmId: string, confirmed: boolean): void;
  ledger?: BrowserCommandDecisionLedger;
  now?: () => number;
}



/**
 * Exactly-once command gate for browser application commands. Non-command
 * messages pass straight through to the router. Application commands are
 * deduplicated against the ledger and produce exactly one `commandAck`
 * emission. `commandStatusRequest` messages are answered from the ledger
 * (read-only; never re-executed).
 */
export class BrowserCommandGate {
  private readonly ledger: BrowserCommandDecisionLedger;

  constructor(private readonly options: BrowserCommandGateOptions) {
    this.ledger = options.ledger ?? new BrowserCommandDecisionLedger(COMMAND_DECISION_CAPACITY, COMMAND_DECISION_TTL_MS, options.now ?? Date.now);
  }

  /** Route one validated browser message with its trusted renderer context. */
  async route(msg: WebviewToHostMessage, context: RendererCommandContext): Promise<void> {
    if (msg.type === 'commandStatusRequest') {
      this.answerStatus(msg.clientCommandId, context.rendererId);
      return;
    }
    if (msg.type === 'inlineConfirmResponse') {
      // Source-aware confirmation seam: the initiating renderer's explicit
      // response resolves the pending confirmation; never command routing.
      this.options.onInlineConfirmResponse?.(context.rendererId, msg.confirmId, msg.confirmed);
      return;
    }
    if (!isBrowserApplicationCommand(msg.type)) {
      await this.options.routeMessage(msg, context);
      return;
    }

    const clientCommandId = msg.clientCommandId;
    if (typeof clientCommandId !== 'string' || clientCommandId.length === 0) {
      // The fail-closed ingress schema already rejects this; defensive only.
      await this.options.routeMessage(msg, context);
      return;
    }

    const fingerprint = canonicalCommandFingerprint(msg);
    const existing = this.ledger.lookup(clientCommandId);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        // Duplicate of an already-decided OR in-flight command: never re-run,
        // never a second ack. Reconciliation happens only through status
        // queries.
        return;
      }
      // Same id, different payload: typed protocol violation → close socket.
      this.options.closeRenderer(context.rendererId, 'duplicate-client-command-id-with-different-payload');
      return;
    }

    // Reserve the id BEFORE routing: a concurrent duplicate arriving within
    // the routing window sees the pending placeholder and is never re-run
    // (check-then-act would let both frames through). The final decision
    // overwrites the placeholder.
    const decidedAt = (this.options.now ?? Date.now)();
    this.ledger.record({ clientCommandId, fingerprint, decision: 'pending', decidedAt });

    // The router reports command-level rejections synchronously during
    // routing (the rejection hook carries the browser client id). The capture
    // lives on a holder object so TS control-flow analysis does not narrow
    // the closure-written variable back to `null`.
    const rejectionState: { value: { type: string; reason: string } | null } = { value: null };
    const onRejected = (type: string, reason: string): void => {
      if (rejectionState.value === null) rejectionState.value = { type, reason };
    };
    try {
      await this.options.routeMessage(msg, { ...context, onBrowserCommandRejected: onRejected });
    } finally {
      // no per-call state to clear: the hook lives on the context object
    }

    const rejection = rejectionState.value;
    const decision = rejection === null ? 'accepted' as const : 'rejected' as const;
    this.ledger.record({
      clientCommandId,
      fingerprint,
      decision,
      ...(rejection !== null ? { reason: rejection.reason } : {}),
      decidedAt,
    });
    this.options.postToRenderer(context.rendererId, {
      type: 'commandAck',
      clientCommandId,
      decision,
      ...(rejection !== null ? { reason: rejection.reason } : {}),
    });
  }

  /** Answer a bounded read-only status query from the ledger. */
  private answerStatus(clientCommandId: string, rendererId: string): void {
    const entry = this.ledger.lookup(clientCommandId);
    // An in-flight (pending) command has no terminal decision yet: report
    // unknown; the client re-queries after the ack or the next snapshot.
    const decision: 'accepted' | 'rejected' | 'unknown' = entry && entry.decision !== 'pending' ? entry.decision : 'unknown';
    this.options.postToRenderer(rendererId, { type: 'commandStatus', clientCommandId, decision });
  }

  getLedger(): BrowserCommandDecisionLedger {
    return this.ledger;
  }
}
