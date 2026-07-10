import * as fs from 'node:fs';
import * as path from 'node:path';

import { getDeferredTriggersDir, TRIGGERS_FILE } from '../../shared/deferred-triggers-paths';
import type { DeferredTriggerView, TriggerKind, TriggerSpec } from '../../shared/protocol';

// Re-export the shared trigger-spec types so existing imports from this
// module (`registry.ts`) keep resolving, while the protocol remains the single
// source of truth (the webview also consumes these via ViewState.deferredTriggers).
export type { TriggerKind, TriggerSpec };

/**
 * Deferred-trigger sidecar persistence + pure replay.
 *
 * The sidecar is an append-only JSONL op log (`triggers.jsonl`) with TWO
 * writers in TWO processes:
 *  - the `defer_trigger` tool (backend process) appends `register` / `cancel`.
 *  - the host registry (extension host process) appends `fire` / `cancel`.
 *
 * Single-line `appendFileSync` writes are atomic enough for this low-volume
 * log (a handful of ops per session). Both writers + the reader replay the
 * whole log to compute the current active set — files stay small. Mirrors the
 * `session-review-store` sidecar pattern but op-based (multi-writer) instead of
 * latest-record-wins (single-writer).
 *
 * Op shapes (one JSON object per line):
 *   register: { id, op:'register', sessionPath, triggers, note, at }
 *   fire:     { id, op:'fire',     sessionPath, reason, at }   (id = fired trigger)
 *   cancel:   { op:'cancel',       sessionPath, targetId?, at } (targetId absent = all for sessionPath)
 *
 * `sessionPath` on every op is the WATCHER's session (the session that called
 * `defer_trigger` and will be resumed). `triggers[].sessionPath` (on the
 * `session_finished` spec) is the WATCHED session.
 */

export interface TriggerOp {
  /** register / fire: the trigger id. cancel: unused. */
  id?: string;
  op: 'register' | 'cancel' | 'fire';
  /** The watcher's session path (the session to resume). */
  sessionPath: string;
  /** register: the trigger specs (OR semantics; first to fire wins). */
  triggers?: TriggerSpec[];
  /** register: task reminder replayed on wake-up. */
  note?: string;
  /** register: ISO timestamp of registration (used to re-arm timers on reload). */
  at?: string;
  /** cancel: specific trigger id; absent = cancel all for sessionPath. */
  targetId?: string;
  /** fire: human-readable reason. */
  reason?: string;
}

export type ActiveTrigger = DeferredTriggerView;

/** Resolve the sidecar file path, or undefined when the dir env is unset. */
export function getTriggersFilePath(): string | undefined {
  const dir = getDeferredTriggersDir();
  return dir ? path.join(dir, TRIGGERS_FILE) : undefined;
}

/** Ensure the sidecar directory exists (best-effort; failures swallowed). */
export function ensureTriggersDir(): void {
  const dir = getDeferredTriggersDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Non-fatal: the first append also attempts to create it.
  }
}

/** Read + parse every op line. Malformed lines are skipped (never throw). */
export function readTriggerOps(): TriggerOp[] {
  const file = getTriggersFilePath();
  if (!file) return [];
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return new Array<TriggerOp>();
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
  return ops;
}

/** Append one op line. Creates the dir/file if needed. Throws on missing dir. */
export function appendTriggerOp(op: TriggerOp): void {
  const file = getTriggersFilePath();
  if (!file) {
    throw new Error('deferred-triggers sidecar dir is not configured (PI_CODING_AGENT_DIR unset).');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(op) + '\n', 'utf8');
}

/**
 * Watch the sidecar dir for changes and invoke `onChange` (debounced) so the
 * registry re-reads after the tool (or itself) appends an op. Mirrors
 * `startReviewWatcher`. Returns a disposer.
 */
export function startTriggerWatcher(onChange: () => void): () => void {
  const dir = getDeferredTriggersDir();
  if (!dir) return () => {};
  ensureTriggersDir();
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, (_, filename) => {
      if (filename !== TRIGGERS_FILE) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 200);
    });
  } catch {
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

/**
 * Pure replay: walk ops in order and compute the current active triggers.
 *  - register → set(id, …)
 *  - fire     → delete(id)
 *  - cancel   → delete(targetId) or, when no targetId, delete all for sessionPath
 */
export function replayTriggers(ops: TriggerOp[]): Map<string, ActiveTrigger> {
  const map = new Map<string, ActiveTrigger>();
  for (const op of ops) {
    if (op.op === 'register') {
      if (!op.id || !op.triggers) continue;
      map.set(op.id, {
        id: op.id,
        sessionPath: op.sessionPath,
        triggers: op.triggers,
        note: typeof op.note === 'string' ? op.note : '',
        registeredAt: op.at ?? new Date(0).toISOString(),
      });
    } else if (op.op === 'fire') {
      if (op.id) map.delete(op.id);
    } else if (op.op === 'cancel') {
      if (op.targetId) {
        map.delete(op.targetId);
      } else {
        for (const [id, t] of map) {
          if (t.sessionPath === op.sessionPath) map.delete(id);
        }
      }
    }
  }
  return map;
}

/** Coerce a parsed JSONL line into a `TriggerOp`, or undefined if invalid. */
function normalizeOp(value: unknown): TriggerOp | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.op !== 'register' && v.op !== 'cancel' && v.op !== 'fire') return undefined;
  if (typeof v.sessionPath !== 'string') return undefined;
  const op: TriggerOp = { op: v.op, sessionPath: v.sessionPath };
  if (typeof v.id === 'string') op.id = v.id;
  if (typeof v.at === 'string') op.at = v.at;
  if (typeof v.note === 'string') op.note = v.note;
  if (typeof v.reason === 'string') op.reason = v.reason;
  if (typeof v.targetId === 'string') op.targetId = v.targetId;
  if (v.op === 'register') {
    if (!op.id) return undefined;
    const triggers = normalizeSpecs(v.triggers);
    if (!triggers || triggers.length === 0) return undefined;
    op.triggers = triggers;
  }
  return op;
}

function normalizeSpecs(value: unknown): TriggerSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const specs: TriggerSpec[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const s = item as Record<string, unknown>;
    if (s.kind !== 'session_finished' && s.kind !== 'timer' && s.kind !== 'user_input') return undefined;
    const spec: TriggerSpec = { kind: s.kind };
    if (s.kind === 'session_finished') {
      if (s.sessionPath !== undefined) {
        if (typeof s.sessionPath !== 'string' || s.sessionPath.trim() === '') return undefined;
        spec.sessionPath = s.sessionPath;
      }
    } else if (s.kind === 'timer') {
      if (typeof s.ms !== 'number' || !Number.isFinite(s.ms) || s.ms <= 0 || !Number.isInteger(s.ms)) return undefined;
      spec.ms = s.ms;
    }
    specs.push(spec);
  }
  return specs;
}
