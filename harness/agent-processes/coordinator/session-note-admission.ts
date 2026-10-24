import { createHash, randomUUID } from 'node:crypto';

export interface SessionNoteReceipt {
  readonly status: 'accepted' | 'queued' | 'unknown' | 'rejected' | 'unavailable';
  readonly messageId: string;
  readonly delivery?: string;
  readonly outcome?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly wake?: false;
  readonly retention?: string;
}

export type SessionNoteAdmissionResult =
  | { status: 'admitted'; messageId: string }
  | { status: 'duplicate'; receipt: SessionNoteReceipt }
  | { status: 'rejected'; reason: 'rate_limited' | 'coordination_capacity'; retryAfterMs?: number; guidance: string };

export interface SessionNoteAdmissionOptions {
  now?: () => number;
  pairBurst?: number;
  pairPerMinute?: number;
  recipientBurst?: number;
  recipientPerMinute?: number;
  duplicateWindowMs?: number;
  retentionMs?: number;
  maxPairs?: number;
  maxRecipients?: number;
  maxRecent?: number;
}

interface Bucket {
  owner?: string;
  sourceOwner?: string;
  targetOwner?: string;
  tokens: number;
  updatedAt: number;
  latest?: {
    messageId: string;
    digest: string;
    expiresAt: number;
    receipt: SessionNoteReceipt;
  };
}

const DEFAULTS = {
  pairBurst: 5,
  pairPerMinute: 20,
  recipientBurst: 15,
  recipientPerMinute: 60,
  duplicateWindowMs: 5_000,
  retentionMs: 5 * 60_000,
  maxPairs: 2_048,
  maxRecipients: 1_024,
  maxRecent: 2_048,
};

/**
 * Admission control for cross-session notes. Quota keys come only from
 * authenticated coordinator identities; message bodies are digested and never
 * retained. Default limits are conservative starting points, not empirically
 * optimized values. Token buckets bound bursts as well as sustained traffic.
 */
export class SessionNoteAdmission {
  private readonly now: () => number;
  private readonly pairBurst: number;
  private readonly pairPerMs: number;
  private readonly recipientBurst: number;
  private readonly recipientPerMs: number;
  private readonly duplicateWindowMs: number;
  private readonly retentionMs: number;
  private readonly maxPairs: number;
  private readonly maxRecipients: number;
  private readonly maxRecent: number;
  private readonly pairs = new Map<string, Bucket>();
  private readonly recipients = new Map<string, Bucket>();
  private recentCount = 0;

  constructor(options: SessionNoteAdmissionOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.pairBurst = options.pairBurst ?? DEFAULTS.pairBurst;
    this.pairPerMs = (options.pairPerMinute ?? DEFAULTS.pairPerMinute) / 60_000;
    this.recipientBurst = options.recipientBurst ?? DEFAULTS.recipientBurst;
    this.recipientPerMs = (options.recipientPerMinute ?? DEFAULTS.recipientPerMinute) / 60_000;
    this.duplicateWindowMs = options.duplicateWindowMs ?? DEFAULTS.duplicateWindowMs;
    this.retentionMs = options.retentionMs ?? DEFAULTS.retentionMs;
    this.maxPairs = options.maxPairs ?? DEFAULTS.maxPairs;
    this.maxRecipients = options.maxRecipients ?? DEFAULTS.maxRecipients;
    this.maxRecent = options.maxRecent ?? DEFAULTS.maxRecent;
    if (![this.pairBurst, this.recipientBurst, this.pairPerMs, this.recipientPerMs,
      this.duplicateWindowMs, this.retentionMs, this.maxPairs, this.maxRecipients, this.maxRecent]
      .every(value => Number.isFinite(value) && value > 0)) {
      throw new TypeError('Session note admission limits must be positive finite numbers.');
    }
  }

  admit(sourceOwner: string, targetOwner: string, body: string): SessionNoteAdmissionResult {
    if (!this.validIdentity(sourceOwner) || !this.validIdentity(targetOwner) || sourceOwner === targetOwner
      || typeof body !== 'string' || !body.trim() || Buffer.byteLength(body, 'utf8') > 16 * 1024) {
      throw new TypeError('Note admission requires distinct bounded owners and non-empty body text up to 16 KiB UTF-8.');
    }
    const now = this.now();
    this.prune(now);
    const pairKey = JSON.stringify([sourceOwner, targetOwner]);
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    let pair = this.pairs.get(pairKey);
    let recipient = this.recipients.get(targetOwner);

    if (pair?.latest && pair.latest.expiresAt > now && pair.latest.digest === digest) {
      return { status: 'duplicate', receipt: pair.latest.receipt };
    }

    const needsPair = !pair;
    const needsRecipient = !recipient;
    const needsRecent = !pair?.latest;
    if ((needsPair && this.pairs.size >= this.maxPairs)
      || (needsRecipient && this.recipients.size >= this.maxRecipients)
      || (needsRecent && this.recentCount >= this.maxRecent)) {
      return {
        status: 'rejected', reason: 'coordination_capacity',
        retryAfterMs: this.capacityRetryAfter(now, needsPair, needsRecipient, needsRecent),
        guidance: 'Coordinator note-admission state is full. Wait before retrying; no note was accepted.',
      };
    }

    pair ??= { sourceOwner, targetOwner, tokens: this.pairBurst, updatedAt: now };
    recipient ??= { owner: targetOwner, tokens: this.recipientBurst, updatedAt: now };
    const pairTokens = this.refill(pair, now, this.pairBurst, this.pairPerMs);
    const recipientTokens = this.refill(recipient, now, this.recipientBurst, this.recipientPerMs);
    const pairRetry = this.retryAfter(pairTokens, this.pairPerMs);
    const recipientRetry = this.retryAfter(recipientTokens, this.recipientPerMs);
    if (pairRetry !== undefined || recipientRetry !== undefined) {
      pair.tokens = pairTokens;
      recipient.tokens = recipientTokens;
      if (this.pairs.has(pairKey)) this.pairs.set(pairKey, pair);
      if (this.recipients.has(targetOwner)) this.recipients.set(targetOwner, recipient);
      return {
        status: 'rejected', reason: 'rate_limited',
        retryAfterMs: Math.max(pairRetry ?? 0, recipientRetry ?? 0),
        guidance: 'Note rate limit reached. No note was accepted; wait for retryAfterMs before sending again.',
      };
    }

    pair.tokens = pairTokens - 1;
    pair.updatedAt = now;
    recipient.tokens = recipientTokens - 1;
    recipient.updatedAt = now;
    const messageId = randomUUID();
    const hadRecent = !!pair.latest;
    pair.latest = {
      messageId,
      digest,
      expiresAt: now + this.duplicateWindowMs,
      receipt: Object.freeze({ status: 'unknown', messageId, outcome: 'unknown', delivery: 'acknowledgement-pending' }),
    };
    if (needsPair) this.pairs.set(pairKey, pair);
    if (needsRecipient) this.recipients.set(targetOwner, recipient);
    if (!hadRecent) this.recentCount++;
    return { status: 'admitted', messageId };
  }

  /** Commit the delivery evidence for the most recent admitted note on a pair. */
  commit(messageId: string, receipt: Omit<SessionNoteReceipt, 'messageId'>): boolean {
    if (!this.validMessageId(messageId) || !receipt || !['accepted', 'queued', 'unknown', 'rejected', 'unavailable'].includes(receipt.status)) return false;
    const sanitized: SessionNoteReceipt = Object.freeze({
      status: receipt.status,
      messageId,
      ...(typeof receipt.delivery === 'string' ? { delivery: receipt.delivery.slice(0, 64) } : {}),
      ...(typeof receipt.outcome === 'string' ? { outcome: receipt.outcome.slice(0, 64) } : {}),
      ...(typeof receipt.reason === 'string' ? { reason: receipt.reason.slice(0, 64) } : {}),
      ...(receipt.wake === false ? { wake: false as const } : {}),
      ...(typeof receipt.retention === 'string' ? { retention: receipt.retention.slice(0, 64) } : {}),
    });
    for (const pair of this.pairs.values()) {
      if (pair.latest?.messageId === messageId) {
        pair.latest.receipt = sanitized;
        return true;
      }
    }
    return false;
  }

  /** Forget only dedupe evidence after a known local admission failure.
   * Rate tokens deliberately remain charged to prevent retry-based bypass. */
  forget(messageId: string): boolean {
    if (!this.validMessageId(messageId)) return false;
    for (const pair of this.pairs.values()) {
      if (pair.latest?.messageId === messageId) {
        pair.latest = undefined;
        this.recentCount--;
        return true;
      }
    }
    return false;
  }

  /** Privacy deletion purges identity-linked receipts and quotas. A normal
   * close intentionally keeps them so close/reopen cannot reset rate limits. */
  retireOwner(owner: string, options: { deleted?: boolean } = {}): void {
    if (!options.deleted) return;
    for (const [key, pair] of this.pairs) {
      if (pair.sourceOwner === owner || pair.targetOwner === owner) {
        if (pair.latest) this.recentCount--;
        this.pairs.delete(key);
      }
    }
    this.recipients.delete(owner);
  }

  private refill(bucket: Bucket, now: number, burst: number, perMs: number): number {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const tokens = Math.min(burst, bucket.tokens + elapsed * perMs);
    if (now >= bucket.updatedAt) bucket.updatedAt = now;
    return tokens;
  }

  private retryAfter(tokens: number, perMs: number): number | undefined {
    return tokens >= 1 ? undefined : Math.max(1, Math.ceil((1 - tokens) / perMs));
  }

  private prune(now: number): void {
    for (const [key, pair] of this.pairs) {
      if (pair.latest && pair.latest.expiresAt <= now) {
        pair.latest = undefined;
        this.recentCount--;
      }
      if (now - pair.updatedAt >= this.retentionMs && !pair.latest) this.pairs.delete(key);
    }
    for (const [owner, bucket] of this.recipients) {
      if (now - bucket.updatedAt >= this.retentionMs) this.recipients.delete(owner);
    }
  }

  private capacityRetryAfter(now: number, needsPair: boolean, needsRecipient: boolean, needsRecent: boolean): number {
    const waits: number[] = [];
    if (needsPair && this.pairs.size >= this.maxPairs) {
      waits.push(Math.min(...[...this.pairs.values()].map(bucket => bucket.updatedAt + this.retentionMs)));
    }
    if (needsRecipient && this.recipients.size >= this.maxRecipients) {
      waits.push(Math.min(...[...this.recipients.values()].map(bucket => bucket.updatedAt + this.retentionMs)));
    }
    if (needsRecent && this.recentCount >= this.maxRecent) {
      waits.push(Math.min(...[...this.pairs.values()].flatMap(bucket => bucket.latest ? [bucket.latest.expiresAt] : [])));
    }
    const retryAt = Math.max(...waits);
    return Number.isFinite(retryAt) ? Math.max(1, Math.ceil(retryAt - now)) : this.retentionMs;
  }

  private validIdentity(value: unknown): value is string {
    return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value, 'utf8') <= 512;
  }
  private validMessageId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 128;
  }
}
