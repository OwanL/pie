/**
 * Bounded pending-command store (browser server plan §5.2/§5.3).
 *
 * The browser keeps a bounded, in-memory store of every sent-but-unacknowledged
 * application command plus its bounded optimistic metadata, mirrored to
 * `sessionStorage` at ≤ 64 KiB for page reload. The mirror NEVER contains
 * image bytes, base64, data URLs, `Blob`s, or `ArrayBuffer`s — only compact
 * metadata (clientCommandId, type, decision, and for `addComposerInput` the
 * input's declared metadata + a content digest).
 *
 * Reconciliation is read-only and never replays:
 *
 *   - `commandAck` marks the entry `accepted`/`rejected`;
 *   - `commandStatus` answers a `commandStatusRequest` (sent for every
 *     unknown entry after a reconnect/hello);
 *   - an authoritative snapshot can confirm an `addComposerInput` early by
 *     matching the staged input's metadata/identity in
 *     `viewState.pendingComposerInputs`; snapshot absence alone never proves
 *     rejection;
 *   - `addComposerInput` staging keeps the live page-memory copy (bounded
 *     aggregate bytes) until an accepted ack AND a confirming snapshot; on a
 *     `rejected`/never-accepted answer the UI restores from page memory or
 *     asks the user to reattach — the image payload is never replayed
 *     automatically.
 */

import type { ComposerInput, ComposerInputDraft, WebviewToHostMessage } from '../../shared/protocol';
import { isBrowserApplicationCommand } from '../../shared/browser-ingress';
import { utf8ByteLength } from '../../shared/utf8';

/** In-memory capacity (last 32 entries). */
export const PENDING_COMMAND_CAPACITY = 32;
/** sessionStorage mirror budget (≤ 64 KiB). */
export const PENDING_COMMAND_MIRROR_MAX_BYTES = 64 * 1024;
/** addComposerInput staging aggregate bound (mirrors the ingress 20 MiB). */
export const PENDING_INPUT_STAGING_MAX_BYTES = 20 * 1024 * 1024;
/** Uncertain state bound: ≤ 10 s or until the next authoritative snapshot
 *  reflects the effect, whichever is first. */
export const UNCERTAIN_STATE_MAX_MS = 10_000;

export type PendingCommandDecision = 'pending' | 'accepted' | 'rejected' | 'unknown';

export interface PendingCommandEntry {
  clientCommandId: string;
  type: string;
  decision: PendingCommandDecision;
  reason?: string;
  sentAt: number;
  /** addComposerInput: declared input metadata for snapshot matching. */
  inputMeta?: { mimeType: string; name: string; sizeBytes: number; source: string };
  /** addComposerInput: content digest of the staged payload (never the
   *  payload itself in the mirror). */
  inputDigest?: string;
}

const MIRROR_KEY = 'pie.pendingCommands.v1';

/** Compact digest of a staged input payload (never stored raw). */
function digestOf(value: string): string {
  // FNV-1a 32-bit — a bounded content fingerprint, not a security boundary.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function readMirror(): PendingCommandEntry[] {
  try {
    const raw = window.sessionStorage.getItem(MIRROR_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PendingCommandEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Record<string, unknown>;
      return typeof candidate.clientCommandId === 'string'
        && typeof candidate.type === 'string'
        && (candidate.decision === 'pending' || candidate.decision === 'accepted'
          || candidate.decision === 'rejected' || candidate.decision === 'unknown');
    });
  } catch {
    return [];
  }
}

function writeMirror(entries: PendingCommandEntry[]): void {
  try {
    const serialized = JSON.stringify(entries.map(({ clientCommandId, type, decision, reason, sentAt, inputMeta, inputDigest }) => ({
      clientCommandId,
      type,
      decision,
      ...(reason !== undefined ? { reason } : {}),
      sentAt,
      ...(inputMeta !== undefined ? { inputMeta } : {}),
      ...(inputDigest !== undefined ? { inputDigest } : {}),
    })));
    if (utf8ByteLength(serialized) > PENDING_COMMAND_MIRROR_MAX_BYTES) {
      // Over budget: drop the mirror entirely (in-memory store stays live).
      window.sessionStorage.removeItem(MIRROR_KEY);
      return;
    }
    window.sessionStorage.setItem(MIRROR_KEY, serialized);
  } catch {
    // sessionStorage unavailable (private mode / quota): in-memory only.
  }
}

/**
 * Bounded pending-command store. Module singleton: the browser transport
 * tracks every application command here; the host-sync layer resolves entries
 * from `commandAck`/`commandStatus`/snapshot confirmation.
 */
class PendingCommandStore {
  private readonly entries: PendingCommandEntry[] = [];
  /** addComposerInput page-memory staging: clientCommandId → draft. Bounded
   *  aggregate bytes; NEVER mirrored. */
  private readonly stagedInputs = new Map<string, { draft: ComposerInputDraft; bytes: number }>();
  private stagedBytes = 0;

  constructor() {
    // Restore the mirror on page load: entries whose ack may have been lost
    // become `unknown` (never replayed; reconciled via commandStatusRequest).
    for (const entry of readMirror()) {
      if (entry.decision === 'pending') entry.decision = 'unknown';
      this.entries.push(entry);
    }
    if (this.entries.length > 0) writeMirror(this.entries);
  }

  /** Track one outbound application command. Returns the stamped message
   *  (with the minted clientCommandId) or null when the store is full. */
  track(message: WebviewToHostMessage): { message: WebviewToHostMessage } | null {
    if (!isBrowserApplicationCommand(message.type)) return null;
    const clientCommandId = crypto.randomUUID();
    const stamped = { ...message, clientCommandId } as WebviewToHostMessage;
    const entry: PendingCommandEntry = {
      clientCommandId,
      type: message.type,
      decision: 'pending',
      sentAt: Date.now(),
    };
    if (message.type === 'addComposerInput') {
      const draft = (message as Extract<WebviewToHostMessage, { type: 'addComposerInput' }>).input;
      const bytes = estimateDraftBytes(draft);
      if (this.stagedBytes + bytes > PENDING_INPUT_STAGING_MAX_BYTES) return null;
      this.stagedInputs.set(clientCommandId, { draft, bytes });
      this.stagedBytes += bytes;
      if (draft.kind === 'imageBlob') {
        entry.inputMeta = {
          mimeType: draft.mimeType,
          name: draft.name,
          sizeBytes: draft.sizeBytes,
          source: draft.source,
        };
        entry.inputDigest = digestOf(JSON.stringify(draft));
      }
    }
    this.entries.push(entry);
    while (this.entries.length > PENDING_COMMAND_CAPACITY) {
      const evicted = this.entries.shift();
      if (evicted) this.releaseStaging(evicted.clientCommandId);
    }
    writeMirror(this.entries);
    return { message: stamped };
  }

  /** Resolve one entry from a host `commandAck`. */
  onAck(clientCommandId: string, decision: 'accepted' | 'rejected', reason?: string): void {
    const entry = this.find(clientCommandId);
    if (!entry) return;
    entry.decision = decision;
    if (reason !== undefined) entry.reason = reason;
    if (decision === 'accepted') this.releaseStaging(clientCommandId);
    writeMirror(this.entries);
  }

  /** Resolve one entry from a `commandStatus` answer. */
  onStatus(clientCommandId: string, decision: 'accepted' | 'rejected' | 'unknown'): void {
    const entry = this.find(clientCommandId);
    if (!entry) return;
    entry.decision = decision;
    if (decision === 'accepted') this.releaseStaging(clientCommandId);
    writeMirror(this.entries);
  }

  /** Forget a command that never crossed the browser transport boundary.
   *
   * Tracking happens before serialization so the minted `clientCommandId` is
   * part of the exact frame measured against the transport bound. A socket
   * close/send exception or an oversized encoded frame means the host could
   * not have observed that command, so retaining it as pending would create a
   * false uncertain mutation on reconnect. */
  discardUnsent(clientCommandId: string): void {
    const index = this.entries.findIndex((entry) => entry.clientCommandId === clientCommandId);
    if (index < 0) return;
    this.entries.splice(index, 1);
    this.releaseStaging(clientCommandId);
    writeMirror(this.entries);
  }

  /** Snapshot confirmation for `addComposerInput`: presence of the matching
   *  input metadata/identity in the host-owned pending inputs confirms
   *  acceptance early (absence alone never proves rejection). */
  confirmAcceptedBySnapshot(pendingInputs: readonly ComposerInput[]): void {
    for (const entry of this.entries) {
      if (entry.type !== 'addComposerInput' || entry.decision === 'accepted' || entry.decision === 'rejected') continue;
      if (entry.inputMeta && pendingInputs.some((input) =>
        input.kind === 'imageBlob'
        && input.mimeType === entry.inputMeta?.mimeType
        && input.name === entry.inputMeta.name
        && input.sizeBytes === entry.inputMeta.sizeBytes
        && input.source === entry.inputMeta.source)) {
        entry.decision = 'accepted';
        this.releaseStaging(entry.clientCommandId);
      }
    }
    writeMirror(this.entries);
  }

  /** Entries needing read-only reconciliation after a reconnect/hello. */
  unknownEntries(): PendingCommandEntry[] {
    return this.entries.filter((entry) => entry.decision === 'unknown' || entry.decision === 'pending');
  }

  /** Entries still uncertain (ack lost, not yet reconciled). */
  uncertainEntries(): PendingCommandEntry[] {
    const now = Date.now();
    return this.entries.filter((entry) =>
      (entry.decision === 'unknown' || entry.decision === 'pending')
      && now - entry.sentAt <= UNCERTAIN_STATE_MAX_MS);
  }

  /** Restore the staged draft for a never-accepted `addComposerInput`
   *  (page memory; the image payload is never replayed automatically). */
  takeStagedInput(clientCommandId: string): ComposerInputDraft | null {
    const staged = this.stagedInputs.get(clientCommandId);
    if (!staged) return null;
    this.releaseStaging(clientCommandId);
    return staged.draft;
  }

  lookup(clientCommandId: string): PendingCommandEntry | undefined {
    return this.find(clientCommandId);
  }

  size(): number {
    return this.entries.length;
  }

  private find(clientCommandId: string): PendingCommandEntry | undefined {
    return this.entries.find((entry) => entry.clientCommandId === clientCommandId);
  }

  private releaseStaging(clientCommandId: string): void {
    const staged = this.stagedInputs.get(clientCommandId);
    if (!staged) return;
    this.stagedInputs.delete(clientCommandId);
    this.stagedBytes = Math.max(0, this.stagedBytes - staged.bytes);
  }
}

/** Bounded estimate of a draft's page-memory footprint (raw bytes). */
function estimateDraftBytes(draft: ComposerInputDraft): number {
  if (draft.kind === 'imageBlob') {
    // base64 → raw: 3/4 of the encoded length.
    return Math.ceil(draft.dataBase64.length * 0.75);
  }
  return 0;
}

/** Module singleton (the browser transport + host-sync share it). */
export const pendingCommandStore = new PendingCommandStore();
