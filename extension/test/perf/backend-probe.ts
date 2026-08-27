/**
 * Shared backend-probe helpers for the pie perf harnesses (session-store,
 * sdk-open-attribution, session-host-pipeline).
 *
 * Spawns the REAL pie backend process (out/backend.js, coordinator role) over
 * the real JSON-RPC stdio wire protocol and times cold session RPCs. All
 * session.open / preload / page profiling runs against throwaway copies of
 * sampled sessions. The real transcript JSONLs are only read by session.list,
 * although that request may maintain its rebuildable SQLite metadata sidecar
 * beside the store. Transcript write-path methods fail fast via
 * WRITE_METHOD_BLOCKLIST.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_ROOT = resolve(HERE, '..', '..');
export const REPO_ROOT = resolve(EXTENSION_ROOT, '..');
export const DEFAULT_SESSION_DIR = join(REPO_ROOT, 'data', 'outcomes', 'sessions');
export const SESSION_DIR = process.env.PIE_PERF_SESSION_DIR
  ? resolve(process.env.PIE_PERF_SESSION_DIR)
  : DEFAULT_SESSION_DIR;
export const BACKEND_PATH = join(EXTENSION_ROOT, 'out', 'backend.js');
export const SDK_PATH = join(EXTENSION_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent');

export const OP_TIMEOUT_MS: Record<string, number> = {
  'session.list': 300_000,
  'session.open': 300_000,
  'session.preload': 300_000,
  'session.loadTranscriptPage': 120_000,
};

/**
 * Write-path methods. This probe is a read-only profiler: requesting any of
 * these fails fast instead of touching the store. (session.forget deletes the
 * session file; truncateAfter rewrites it; create/duplicate write new files.)
 */
export const WRITE_METHOD_BLOCKLIST = new Set([
  'session.forget',
  'session.truncateAfter',
  'session.create',
  'session.duplicate',
  'session.rename',
]);

export interface BackendHandle {
  readyMs: number;
  readyPayload: unknown;
  request<T>(method: string, params: unknown): Promise<{ result: T; ms: number }>;
  /** Latest event payload per event name (the authoritative `session.opened`
   *  payload is delivered as an event, not as the open response). */
  lastEvent: Map<string, unknown>;
  stop(): Promise<void>;
}

export function spawnBackend(sessionDir: string): Promise<BackendHandle> {
  const agentDir = mkdtempSync(join(tmpdir(), 'pie-perf-agent-'));
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: '1',
  };
  const proc = spawn(process.execPath, [BACKEND_PATH, '--sdkPath', SDK_PATH, '--cwd', REPO_ROOT, '--hostPid', String(process.pid), '--backendGeneration', '1'], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  const startedAt = performance.now();
  let readyMs = 0;
  let readyPayload: unknown;
  let buffer = '';
  let nextId = 0;
  const pending = new Map<string, { resolve: (v: { ok: boolean; value: unknown; ms: number }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const stderrTail: string[] = [];
  const lastEvent = new Map<string, unknown>();

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrTail.push(text);
    if (stderrTail.join('').length > 64_000) stderrTail.shift();
  });

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const obj = value as Record<string, unknown>;
      if (typeof obj['id'] === 'string' && 'ok' in obj) {
        const entry = pending.get(obj['id']);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(obj['id']);
          entry.resolve({ ok: obj['ok'] === true, value: obj, ms: performance.now() - (entry as any).startedAt });
        }
      } else if (typeof obj['event'] === 'string') {
        lastEvent.set(obj['event'], obj['payload']);
        if (obj['event'] === 'backend.ready') {
          readyMs = performance.now() - startedAt;
          readyPayload = obj['payload'];
        }
      }
    }
  });

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`backend not ready within 120s; stderr tail: ${stderrTail.join('').slice(-4000)}`)), 120_000);
    const check = setInterval(() => {
      if (readyMs > 0) {
        clearInterval(check);
        clearTimeout(timer);
        resolveReady();
      }
    }, 25);
    proc.once('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      rejectReady(new Error(`backend exited before ready (code ${code}); stderr tail: ${stderrTail.join('').slice(-4000)}`));
    });
  });

  const request = async <T>(method: string, params: unknown): Promise<{ ok: boolean; value: T; ms: number }> => {
    if (WRITE_METHOD_BLOCKLIST.has(method)) {
      throw new Error(`refusing to send write method ${method} from the read-only perf harness`);
    }
    const id = `perf-${nextId++}`;
    const line = JSON.stringify({ id, method, params }) + '\n';
    const timeoutMs = OP_TIMEOUT_MS[method] ?? 60_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as any, reject, timer, startedAt: performance.now() } as any);
      proc.stdin.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        }
      });
    });
  };

  const stop = async (): Promise<void> => {
    try {
      proc.stdin.end();
    } catch { /* already closed */ }
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolveStop(); }, 5_000);
      proc.once('exit', () => { clearTimeout(timer); resolveStop(); });
    });
    rmSync(agentDir, { recursive: true, force: true });
  };

  return ready.then(() => ({
    readyMs,
    readyPayload,
    lastEvent,
    request: async <T>(method: string, params: unknown) => {
      const { ok, value, ms } = await request<T>(method, params);
      if (!ok) {
        const error = (value as Record<string, unknown>)['error'] ?? {};
        throw new Error(`${method} failed: ${JSON.stringify(error)}`);
      }
      return { result: (value as Record<string, unknown>)['result'] as T, ms };
    },
    stop,
  }));
}

export interface Sample {
  path: string;
  bytes: number;
  name: string;
}

export function sampleSessions(): Sample[] {
  const files: Sample[] = [];
  const collect = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(full);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const bytes = statSync(full).size;
          if (bytes > 0) files.push({ path: full, bytes, name: entry.name });
        } catch { /* raced deletion */ }
      }
    }
  };
  collect(SESSION_DIR);
  files.sort((a, b) => a.bytes - b.bytes);
  if (files.length === 0) return [];
  const picks: Sample[] = [];
  const targets = [files[0], ...pickNearest(files, [1 << 20, 10 << 20, 40 << 20]), files[files.length - 1]];
  const seen = new Set<string>();
  for (const s of targets) {
    if (s && !seen.has(s.path)) { seen.add(s.path); picks.push(s); }
  }
  return picks;
}

function pickNearest(files: Sample[], targetBytes: number[]): (Sample | undefined)[] {
  return targetBytes.map((target) => {
    let best: Sample | undefined;
    let bestDelta = Infinity;
    for (const f of files) {
      const delta = Math.abs(f.bytes - target);
      if (delta < bestDelta) { bestDelta = delta; best = f; }
    }
    return best;
  });
}

/**
 * Copy sampled sessions into a throwaway store. All session.open / preload /
 * page profiling runs against this copy, never the real store.
 */
export function copySamplesToTempStore(samples: Sample[]): { storeDir: string; copies: Sample[] } {
  const storeDir = mkdtempSync(join(tmpdir(), 'pie-perf-store-'));
  const copies: Sample[] = [];
  for (const sample of samples) {
    const target = join(storeDir, sample.name);
    const src = readFileSync(sample.path);
    writeFileSync(target, src);
    copies.push({ path: target, bytes: sample.bytes, name: sample.name });
  }
  return { storeDir, copies };
}
