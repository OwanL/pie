/**
 * Sidecar I/O + replay for the `defer_trigger` tool.
 *
 * `PIE_TRIGGERS_DIR` (host→backend env) holds `triggers.jsonl` — an append-only
 * JSONL op log SHARED with the host-side registry (the host appends `fire` /
 * `cancel` ops; this tool appends `register` / `cancel` ops). Both sides replay
 * the log to compute the active set. The format MUST match the host's
 * `extension/src/host/deferred-triggers/store.ts`.
 *
 * Op shapes (one JSON object per line):
 *   register: { id, op:'register', sessionPath, triggers, note, at }
 *   fire:     { id, op:'fire',     sessionPath, reason, at }   (id = fired trigger)
 *   cancel:   { op:'cancel',       sessionPath, targetId?, at } (targetId absent = all for sessionPath)
 *
 * `sessionPath` is the WATCHER's session (the session that called `defer_trigger`
 * and will be resumed). The tool reads the watcher's path from
 * `ctx.sessionManager.getSessionFile()`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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
  return ops;
}

/** Append one op line. Creates the dir/file if needed. Throws on missing dir. */
export function appendTriggerOp(op: TriggerOp): string {
  const file = getTriggersFilePath();
  if (!file) {
    throw new Error('PIE_TRIGGERS_DIR is not set — the host has not configured the deferred-triggers sidecar.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(op) + '\n', 'utf8');
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
        triggers: op.triggers,
        note: op.note ?? '',
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

/** Active triggers for a given watcher session (newest first by id is fine). */
export function listActiveForSession(sessionPath: string): ActiveTrigger[] {
  const all = replayTriggers(readTriggerOps());
  return [...all.values()].filter((t) => t.sessionPath === sessionPath);
}

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
