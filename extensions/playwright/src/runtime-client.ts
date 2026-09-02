import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

import { canonicalSessionPath } from './artifacts.js';
import { encodeJsonl, JsonlDecoder } from './protocol.js';
import type { RuntimeResponse } from './types.js';

interface ChildLike {
  stdin: { write(data: string): boolean; end?(): void };
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close' | 'exit', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
  pid?: number;
}
export type SidecarSpawn = () => ChildLike;

interface Pending {
  id: string; method: string;
  resolve(value: RuntimeResponse): void; reject(error: Error): void;
  timer: NodeJS.Timeout; cancelGrace?: NodeJS.Timeout; abort?: () => void;
}

export class PlaywrightRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) { super(message); this.name = 'PlaywrightRuntimeError'; }
}

/**
 * Kills a sidecar process together with every Chromium descendant. Plain
 * SIGKILL on Windows terminates only the named process, so the tree kill goes
 * through taskkill; the plain kill is a fallback for other platforms and for
 * children that already exited.
 */
export function killProcessTree(child: ChildLike | undefined): void {
  if (!child) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already dead */ }
}

function defaultSpawn(): ChildLike {
  const entry = fileURLToPath(new URL('./sidecar.mjs', import.meta.url));
  return spawn(process.execPath, [entry], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

export interface RequestOptions {
  timeoutMs?: number; signal?: AbortSignal; sessionId?: string; allowNeedsReopen?: boolean;
}

const REOPEN_MESSAGE = 'The playwright sidecar was restarted after a failure. Every prior playwright session/page/ref id is invalid; call playwright open to start over.';

export class RuntimeClient {
  private child?: ChildLike;
  private decoder = new JsonlDecoder();
  private readonly pending = new Map<string, Pending>();
  private recovering?: Promise<void>;
  private stopping = false;
  private needsReopen = false;

  constructor(
    readonly sessionPath: string,
    private readonly spawnSidecar: SidecarSpawn = defaultSpawn,
    private readonly cancelGraceMs = 5000,
    private readonly shutdownTimeoutMs = 5000,
  ) {}

  get state(): 'stopped' | 'ready' | 'needs_reopen' | 'recovering' {
    if (this.recovering) return 'recovering';
    if (this.needsReopen) return 'needs_reopen';
    if (!this.child) return 'stopped';
    return 'ready';
  }
  get pid(): number | undefined { return this.child?.pid; }

  private start(): void {
    if (this.child) return;
    this.stopping = false; this.decoder = new JsonlDecoder();
    const child = this.spawnSidecar(); this.child = child;
    child.stdout.on('data', (chunk) => {
      if (child !== this.child) return;
      try { for (const record of this.decoder.push(chunk)) this.handleRecord(record); }
      catch (error) { void this.failAndRecover(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr?.on('data', () => { /* sidecar diagnostics are intentionally not copied into model context */ });
    child.on('error', (error) => { if (child === this.child) void this.failAndRecover(error); });
    child.on('close', () => {
      if (child === this.child && !this.stopping) {
        void this.failAndRecover(new PlaywrightRuntimeError('BROWSER_CRASHED', 'Playwright sidecar exited unexpectedly. All browser sessions are gone.', false));
      }
    });
  }

  private write(record: unknown): void {
    if (!this.child) throw new PlaywrightRuntimeError('RUNTIME_REOPEN_REQUIRED', REOPEN_MESSAGE, false);
    this.child.stdin.write(encodeJsonl(record));
  }

  private handleRecord(raw: unknown): void {
    if (!raw || typeof raw !== 'object') throw new PlaywrightRuntimeError('SIDECAR_PROTOCOL_ERROR', 'Playwright sidecar returned a non-object record.', true);
    const record = raw as Record<string, unknown>;
    if (record.v === 1 && record.kind === 'protocol_error') {
      const shape = (record.error ?? {}) as { code?: unknown; message?: unknown };
      throw new PlaywrightRuntimeError(
        typeof shape.code === 'string' && shape.code in PROTOCOL_ERROR_CODES ? shape.code : 'SIDECAR_PROTOCOL_ERROR',
        typeof shape.message === 'string' ? shape.message : 'Playwright sidecar reported a protocol error.',
        true,
      );
    }
    if (record.v !== 1 || record.kind !== 'response' || typeof record.id !== 'string') {
      throw new PlaywrightRuntimeError('SIDECAR_PROTOCOL_ERROR', 'Playwright sidecar returned a malformed response.', true);
    }
    const pending = this.pending.get(record.id);
    if (!pending) throw new PlaywrightRuntimeError('SIDECAR_PROTOCOL_ERROR', `Playwright sidecar returned stale request id ${record.id}.`, true);
    if (record.ok !== true) {
      const shape = (record.error ?? {}) as { code?: unknown; message?: unknown; retryable?: unknown };
      const code = typeof shape.code === 'string' ? shape.code : 'SIDECAR_PROTOCOL_ERROR';
      const mustTerminateRunCode = pending.method === 'run_code' && (code === 'RUN_CODE_TIMEOUT' || code === 'CANCELLED');
      const error = new PlaywrightRuntimeError(
        code,
        `${typeof shape.message === 'string' ? shape.message : 'Playwright sidecar request failed.'}${mustTerminateRunCode ? ` The browser runtime was terminated. ${REOPEN_MESSAGE}` : ''}`,
        mustTerminateRunCode ? false : shape.retryable === true,
      );
      this.settle(pending);
      if (mustTerminateRunCode) {
        // The rejected async body or function can continue executing inside the
        // sidecar. Destroy the process tree before exposing the timeout/cancel
        // result so delayed mutations cannot escape the request boundary.
        void this.failAndRecover(new PlaywrightRuntimeError('RUNTIME_REOPEN_REQUIRED', REOPEN_MESSAGE, false));
      }
      pending.reject(error);
      return;
    }
    this.settle(pending);
    pending.resolve((record.result ?? {}) as RuntimeResponse);
  }

  private settle(pending: Pending): void {
    this.pending.delete(pending.id);
    clearTimeout(pending.timer);
    if (pending.cancelGrace) clearTimeout(pending.cancelGrace);
    pending.abort?.();
  }

  private rejectPending(item: Pending, cause: Error): void {
    this.settle(item);
    item.reject(cause);
  }

  private timeoutCode(method: string): 'RUN_CODE_TIMEOUT' | 'ACTION_TIMEOUT' {
    return method === 'run_code' ? 'RUN_CODE_TIMEOUT' : 'ACTION_TIMEOUT';
  }

  async request(method: string, params: unknown, options: RequestOptions = {}): Promise<RuntimeResponse> {
    if (this.recovering) await this.recovering;
    if (this.needsReopen && !options.allowNeedsReopen && method !== 'open' && method !== 'close') {
      throw new PlaywrightRuntimeError('RUNTIME_REOPEN_REQUIRED', REOPEN_MESSAGE, false);
    }
    this.start();
    const id = randomUUID(); const timeoutMs = options.timeoutMs ?? 30000;
    return await new Promise<RuntimeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        // An ambiguous operation is never replayed: the sidecar and every
        // browser it owns are torn down; the next open lazily restarts.
        void this.failAndRecover(new PlaywrightRuntimeError(
          this.timeoutCode(method),
          `${method} did not settle within ${timeoutMs}ms. The operation may already have affected the page; the browser runtime was restarted. ${REOPEN_MESSAGE}`,
          false,
        ));
      }, timeoutMs);
      const pending: Pending = { id, method, resolve, reject, timer };
      if (options.signal) {
        const abort = () => {
          try { this.write({ v: 1, kind: 'cancel', id }); } catch { /* recovery owns cleanup */ }
          // If the sidecar cannot settle the cancellation within a bounded grace
          // period, force-terminate the process tree and invalidate the runtime.
          pending.cancelGrace = setTimeout(() => {
            if (!this.pending.has(id)) return;
            void this.failAndRecover(new PlaywrightRuntimeError('CANCELLED', 'Playwright request was cancelled and the sidecar did not settle in time; the browser runtime was restarted.', false));
          }, this.cancelGraceMs);
          pending.cancelGrace.unref?.();
        };
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(new PlaywrightRuntimeError('CANCELLED', 'Playwright request was cancelled before dispatch.'));
          return;
        }
        options.signal.addEventListener('abort', abort, { once: true });
        pending.abort = () => options.signal?.removeEventListener('abort', abort);
      }
      this.pending.set(id, pending);
      try { this.write({ v: 1, kind: 'request', id, method, params }); }
      catch (error) { this.settle(pending); reject(error as Error); }
    });
  }

  private async failAndRecover(cause: Error): Promise<void> {
    if (this.recovering || this.stopping) return this.recovering;
    const child = this.child; this.child = undefined;
    const pendingValues = [...this.pending.values()];
    for (const item of pendingValues) this.rejectPending(item, cause);
    killProcessTree(child);
    this.needsReopen = true;
    this.recovering = Promise.resolve().finally(() => { this.recovering = undefined; });
    await this.recovering;
  }

  markReopened(): void { this.needsReopen = false; }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.recovering) await this.recovering.catch(() => {});
    const child = this.child; this.child = undefined;
    const pendingValues = [...this.pending.values()];
    for (const item of pendingValues) this.rejectPending(item, new PlaywrightRuntimeError('RUNTIME_REOPEN_REQUIRED', 'Owning pie session shut down; every playwright session id is invalid.', false));
    if (child) {
      let graceful = true;
      try { child.stdin.write(encodeJsonl({ v: 1, kind: 'shutdown' })); } catch { graceful = false; }
      if (graceful) graceful = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
        child.on('close', () => { clearTimeout(timer); resolve(true); });
      });
      if (!graceful) killProcessTree(child);
    }
    this.needsReopen = false;
    this.stopping = false;
  }

  killForTesting(): void { killProcessTree(this.child); }
}

export class RuntimeRegistry {
  private readonly clients = new Map<string, RuntimeClient>();
  constructor(private readonly spawnSidecar?: SidecarSpawn) {}
  async get(sessionPath: string): Promise<RuntimeClient> {
    const key = await canonicalSessionPath(sessionPath);
    let client = this.clients.get(key);
    if (!client) { client = new RuntimeClient(key, this.spawnSidecar); this.clients.set(key, client); }
    return client;
  }
  async peek(sessionPath: string): Promise<RuntimeClient | undefined> { return this.clients.get(await canonicalSessionPath(sessionPath)); }
  async shutdownSession(sessionPath: string): Promise<void> {
    const key = await canonicalSessionPath(sessionPath);
    const client = this.clients.get(key);
    await client?.shutdown();
    this.clients.delete(key);
  }
  async shutdownAll(): Promise<void> {
    const clients = [...this.clients.entries()];
    await Promise.allSettled(clients.map(async ([key, client]) => { await client.shutdown(); this.clients.delete(key); }));
  }
  killAllSync(): void { for (const client of this.clients.values()) client.killForTesting(); }
  get size(): number { return this.clients.size; }
}

const PROTOCOL_ERROR_CODES: Record<string, true> = {
  MALFORMED_REQUEST: true, MALFORMED_CANCEL: true, MALFORMED_JSONL: true, OVERSIZED_JSONL: true,
};

// The pi extension loader (jiti, moduleCache: false) re-evaluates this module on
// every session create. Module-scope state would reset on each evaluation,
// re-registering process teardown listeners and orphaning sidecar clients
// tracked by a discarded registry. Hold the singleton registry and the
// install-once flag on globalThis so every evaluation shares them; Symbol.for
// keeps the key stable across re-evaluations.
const RUNTIME_GLOBAL_KEY = Symbol.for('pie.playwright.runtime');
interface RuntimeGlobals { registry: RuntimeRegistry; teardownInstalled: boolean }
function runtimeGlobals(): RuntimeGlobals {
  const holder = globalThis as Record<PropertyKey, unknown>;
  const existing = holder[RUNTIME_GLOBAL_KEY] as RuntimeGlobals | undefined;
  if (existing) return existing;
  const value: RuntimeGlobals = { registry: new RuntimeRegistry(), teardownInstalled: false };
  Object.defineProperty(holder, RUNTIME_GLOBAL_KEY, { value, writable: false, configurable: false, enumerable: false });
  return value;
}

export const runtimeRegistry: RuntimeRegistry = runtimeGlobals().registry;

export function installProcessTeardown(): void {
  const state = runtimeGlobals();
  if (state.teardownInstalled) return;
  state.teardownInstalled = true;
  process.once('beforeExit', () => { void state.registry.shutdownAll(); });
  process.once('exit', () => state.registry.killAllSync());
}
