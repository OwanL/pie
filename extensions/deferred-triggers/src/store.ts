/**
 * Sidecar I/O + replay for the `defer_trigger` tool.
 *
 * `PIE_TRIGGERS_DIR` (host→backend env) holds `triggers.jsonl` — an append-only
 * JSONL op log SHARED with the host-side registry (the host appends claim /
 * delivery / cancel ops; this tool appends `register` / `cancel` ops). Both
 * sides replay the log to compute the active set. The format MUST match the host's
 * `extension/src/host/deferred-triggers/store.ts`.
 *
 * Op shapes (one JSON object per line):
 *   register: { id, op:'register', sessionPath, targetSession?, triggers, message?, note?, at }
 *   claim:    { id, op:'claim', sessionPath, claimId, ownerId, ownerPid, reason, at, dispatchStartedAt? }
 *   dispatch: { id, op:'dispatch-started', sessionPath, claimId, ownerId, ownerPid, at }
 *   release:  { id, op:'release', sessionPath, claimId, reason, at, recoveryState? }
 *   failed:   { id, op:'failed', sessionPath, reason, at }
 *   fire:     { id, op:'fire', sessionPath, claimId, reason, at }
 *   cancel:   { op:'cancel', sessionPath, targetId?, at }
 *
 * `sessionPath` is the CREATOR's session (the session that registered the
 * wake and owns list/cancel). `targetSession` is the session that receives the
 * delivery; legacy records omit it and target their creator. The tool reads
 * the creator path from `ctx.sessionManager.getSessionFile()`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateWakeConditions } from '../../../shared/wake-conditions.js';
import type { ActiveTrigger, TriggerOp, TriggerSpec } from './types.js';

const TRIGGERS_DIR_ENV = 'PIE_TRIGGERS_DIR';
const TRIGGERS_FILE = 'triggers.jsonl';

function getTriggersFilePath(): string | undefined {
  const dir = process.env[TRIGGERS_DIR_ENV]?.trim();
  return dir ? path.join(dir, TRIGGERS_FILE) : undefined;
}

/** Read + parse every op line. Malformed lines are skipped (never throw). */
export function readTriggerOps(): TriggerOp[] {
  const file = getTriggersFilePath();
  if (!file) return [];
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const ops: TriggerOp[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const op = normalizeOp(parsed);
    if (op) ops.push(op);
  }
  // Claim artifacts are authoritative if a host died after its atomic claim
  // but before the matching JSONL append.
  const prefix = `${TRIGGERS_FILE}.claim-`;
  try {
    for (const name of fs.readdirSync(path.dirname(file)).filter((entry) => entry.startsWith(prefix)).sort()) {
      try {
        const artifactPath = path.join(path.dirname(file), name);
        const op = normalizeOp(JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown);
        if (op?.op !== 'claim' || !op.claimId) continue;
        const terminal = ops.some((candidate) =>
          candidate.id === op.id
          && candidate.claimId === op.claimId
          && (candidate.op === 'release' || candidate.op === 'fire'));
        if (terminal) {
          try { fs.unlinkSync(artifactPath); } catch { /* fail closed */ }
          continue;
        }
        const logged = ops.some((candidate) => candidate.op === 'claim' && candidate.claimId === op.claimId);
        if (!logged) ops.push(op);
      } catch {
        // Ignore malformed foreign artifacts.
      }
    }
  } catch {
    // Sidecar directory may disappear while listing.
  }
  return ops;
}

/** Append one op line. Creates the dir/file if needed. Throws on missing dir. */
export function appendTriggerOp(op: TriggerOp): string {
  const file = getTriggersFilePath();
  if (!file) {
    throw new Error('PIE_TRIGGERS_DIR is not set — the host has not configured the deferred-triggers sidecar.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(op) + '\n', undefined, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

/** Pure replay: walk ops in order and compute the current active triggers. */
export function replayTriggers(ops: TriggerOp[]): Map<string, ActiveTrigger> {
  const map = new Map<string, ActiveTrigger>();
  for (const op of ops) {
    if (op.op === 'register') {
      if (!op.id || !op.triggers) continue;
      map.set(op.id, {
        id: op.id,
        sessionPath: op.sessionPath,
        targetSession: op.targetSession?.trim() ? op.targetSession : op.sessionPath,
        triggers: op.triggers,
        message: normalizedMessage(op),
        note: normalizedMessage(op),
        registeredAt: op.at ?? new Date(0).toISOString(),
        deliveryState: 'pending',
      });
    } else if (op.op === 'cancel') {
      if (op.targetId) {
        // A targeted cancel is creator-owned. Do not let a session that merely
        // knows another trigger id consume it.
        const target = map.get(op.targetId);
        if (target?.sessionPath === op.sessionPath) map.delete(op.targetId);
      } else {
        for (const [id, t] of map) {
          if (t.sessionPath === op.sessionPath) map.delete(id);
        }
      }
    } else if (op.id) {
      const trigger = map.get(op.id);
      if (!trigger) continue;
      if (op.op === 'claim') {
        if (op.claimId && trigger.deliveryState !== 'claimed') {
          const dispatchStartedAt = op.dispatchStartedAt;
          map.set(op.id, {
            ...trigger,
            deliveryState: 'claimed',
            recoveryState: dispatchStartedAt ? 'acknowledgement-ambiguous' : undefined,
            deliveryDetail: dispatchStartedAt
              ? 'delivery may have started; awaiting acknowledgement and automatic retry is blocked'
              : 'delivery claimed; dispatch is pending',
            claimId: op.claimId,
            claimOwnerId: op.ownerId,
            claimOwnerPid: op.ownerPid,
            claimAt: op.at,
            dispatchStartedAt,
            wakeReason: op.reason,
          });
        }
      } else if (op.op === 'dispatch-started') {
        if (op.claimId && trigger.claimId === op.claimId) {
          map.set(op.id, {
            ...trigger,
            deliveryState: 'claimed',
            recoveryState: 'acknowledgement-ambiguous',
            deliveryDetail: 'delivery may have started; awaiting acknowledgement and automatic retry is blocked',
            dispatchStartedAt: op.dispatchStartedAt ?? op.at ?? trigger.claimAt,
          });
        }
      } else if (op.op === 'release') {
        if (op.claimId && trigger.claimId === op.claimId) {
          map.set(op.id, {
            ...trigger,
            deliveryState: 'retryable',
            recoveryState: op.recoveryState,
            deliveryDetail: op.reason ?? 'delivery failed before dispatch',
            claimId: undefined,
            claimOwnerId: undefined,
            claimOwnerPid: undefined,
            claimAt: undefined,
            dispatchStartedAt: undefined,
          });
        }
      } else if (op.op === 'failed') {
        if (trigger.deliveryState !== 'claimed') {
          map.set(op.id, { ...trigger, deliveryState: 'retryable', recoveryState: undefined, deliveryDetail: op.reason ?? 'delivery could not be attempted', wakeReason: op.wakeReason ?? trigger.wakeReason });
        }
      } else if (op.op === 'fire' && (!op.claimId || trigger.claimId === op.claimId)) {
        map.delete(op.id);
      }
    }
  }
  return map;
}

/** Active triggers owned by a given creator session (newest first by id is fine). */
export function listActiveForSession(sessionPath: string): ActiveTrigger[] {
  const all = replayTriggers(readTriggerOps());
  return [...all.values()].filter((t) => t.sessionPath === sessionPath);
}

function normalizedMessage(op: Pick<TriggerOp, 'message' | 'note'>): string {
  if (typeof op.message === 'string' && op.message.trim()) return op.message;
  return typeof op.note === 'string' ? op.note : '';
}

function normalizeOp(value: unknown): TriggerOp | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!['register', 'cancel', 'claim', 'dispatch-started', 'release', 'failed', 'fire'].includes(String(v.op))) return undefined;
  if (typeof v.sessionPath !== 'string') return undefined;
  const op: TriggerOp = { op: v.op as TriggerOp['op'], sessionPath: v.sessionPath };
  if (typeof v.id === 'string') op.id = v.id;
  if (typeof v.at === 'string') op.at = v.at;
  if (typeof v.message === 'string') op.message = v.message;
  if (typeof v.note === 'string') op.note = v.note;
  if (typeof v.targetSession === 'string' && v.targetSession.trim()) op.targetSession = v.targetSession;
  if (typeof v.reason === 'string') op.reason = v.reason;
  if (typeof v.wakeReason === 'string') op.wakeReason = v.wakeReason;
  if (typeof v.targetId === 'string') op.targetId = v.targetId;
  if (typeof v.claimId === 'string') op.claimId = v.claimId;
  if (typeof v.ownerId === 'string') op.ownerId = v.ownerId;
  if (typeof v.ownerPid === 'number' && Number.isSafeInteger(v.ownerPid) && v.ownerPid > 0) op.ownerPid = v.ownerPid;
  if (typeof v.dispatchStartedAt === 'string') op.dispatchStartedAt = v.dispatchStartedAt;
  if (v.recoveryState === 'dead-owner-recovered') op.recoveryState = v.recoveryState;
  if (v.op === 'register') {
    if (!op.id) return undefined;
    const triggers = normalizeSpecs(v.triggers);
    if (!triggers || triggers.length === 0) return undefined;
    op.triggers = triggers;
  }
  if ((op.op === 'claim' || op.op === 'dispatch-started' || op.op === 'release') && (!op.id || !op.claimId)) return undefined;
  if ((op.op === 'failed' || op.op === 'fire') && !op.id) return undefined;
  return op;
}

function normalizeSpecs(value: unknown): TriggerSpec[] | undefined {
  return validateWakeConditions(value).specs;
}
