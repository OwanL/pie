import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

import { canonicalSessionPath } from './artifacts.js';
import {
  assertChildToolRuntimeOwnerOpen,
  registerChildToolRuntimeCleanup,
  type ChildToolRuntimeOwner,
} from '../../agent-processes/lib/process-lifecycle/child-tool-runtime-owner.js';
import { encodeJsonl, JsonlDecoder } from './protocol.js';
import type { RuntimeResponse } from './types.js';

interface ChildLike {
  stdin: { write(data: string): boolean; end?(): void };
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close' | 'exit', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  off?(event: 'close' | 'exit', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
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

const exitedChildren = new WeakSet<ChildLike>();
const childExitResults = new WeakMap<ChildLike, { code: number | null; signal: NodeJS.Signals | null }>();
const confirmedTreeKills = new WeakSet<ChildLike>();
const unresolvedTreeKills = new WeakMap<ChildLike, string>();

function markChildExited(child: ChildLike, code: number | null, signal: NodeJS.Signals | null): void {
  exitedChildren.add(child);
  childExitResults.set(child, { code, signal });
}

function childExitResult(child: ChildLike): { code: number | null; signal: NodeJS.Signals | null } | undefined {
  const observed = childExitResults.get(child);
  if (observed) return observed;
  if (child.exitCode !== undefined && child.exitCode !== null) {
    return { code: child.exitCode, signal: child.signalCode ?? null };
  }
  if (child.signalCode !== undefined && child.signalCode !== null) {
    return { code: null, signal: child.signalCode };
  }
  return undefined;
}

function hasExited(child: ChildLike): boolean {
  return exitedChildren.has(child) || childExitResult(child) !== undefined;
}

interface ChildExitOutcome {
  exited: boolean;
  clean: boolean;
}

function waitForChildExit(child: ChildLike, timeoutMs: number): Promise<ChildExitOutcome> {
  const priorExit = childExitResult(child);
  if (hasExited(child)) return Promise.resolve({
    exited: true,
    clean: priorExit?.code === 0 && priorExit.signal === null,
  });
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: ChildExitOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      resolve(outcome);
    };
    const onExit = (code: number | null, signal?: NodeJS.Signals | null) => {
      const normalizedSignal = signal ?? null;
      markChildExited(child, code, normalizedSignal);
      finish({ exited: true, clean: code === 0 && normalizedSignal === null });
    };
    child.on('exit', onExit);
    child.on('close', onExit);
    timer = setTimeout(() => {
      const result = childExitResult(child);
      finish({ exited: hasExited(child), clean: result?.code === 0 && result.signal === null });
    }, Math.max(0, timeoutMs));
    const result = childExitResult(child);
    if (hasExited(child)) finish({ exited: true, clean: result?.code === 0 && result.signal === null });
  });
}

function unresolvedCleanupError(message: string): PlaywrightRuntimeError {
  return new PlaywrightRuntimeError('RUNTIME_CLEANUP_UNRESOLVED', `${message} Runtime cleanup remains unresolved.`, false);
}

function killProcessTreeSync(child: ChildLike | undefined): void {
  if (!child || hasExited(child)) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 1000 });
      if (!result.error && result.status === 0) {
        confirmedTreeKills.add(child);
        unresolvedTreeKills.delete(child);
      } else {
        unresolvedTreeKills.set(child, result.error?.message ?? `taskkill exited with code ${String(result.status)}`);
      }
    } catch (error) {
      unresolvedTreeKills.set(child, error instanceof Error ? error.message : String(error));
    }
  } else if (process.platform !== 'win32' && child.pid !== undefined) {
    unresolvedTreeKills.set(child, `process-tree termination is unsupported on ${process.platform}`);
  }
  try { child.kill('SIGKILL'); } catch { /* best effort during process exit */ }
}

/**
 * Force-terminates a sidecar and its Chromium descendants, then waits for the
 * sidecar's exit event. A successful kill() only confirms signal delivery; it
 * does not prove that the process exited.
 */
export async function killProcessTree(child: ChildLike | undefined, timeoutMs = 5000): Promise<void> {
  if (!child) return;
  const priorTreeFailure = unresolvedTreeKills.get(child);
  if (hasExited(child)) {
    if (priorTreeFailure) throw unresolvedCleanupError(`Process-tree termination failed (${priorTreeFailure}); Chromium descendants may remain.`);
    if (confirmedTreeKills.has(child)) return;
    // Once the sidecar exits, its PID may be reused. Do not retry taskkill
    // against that PID; an exited sidecar alone says nothing about descendants.
    throw unresolvedCleanupError(`Playwright sidecar process ${child.pid ?? '(unknown PID)'} exited before descendant cleanup was confirmed.`);
  }
  const boundedTimeout = Math.max(1, timeoutMs);
  const deadline = Date.now() + boundedTimeout;
  let treeKillFailure: string | undefined;
  let treeKillSucceeded = confirmedTreeKills.has(child);
  if (process.platform === 'win32' && child.pid !== undefined && !treeKillSucceeded) {
    // Leave time after taskkill for the child exit event to be observed. The
    // direct kill below remains a fallback if taskkill fails or times out.
    const treeKillTimeout = Math.max(1, Math.floor(boundedTimeout / 2));
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        let killer: ReturnType<typeof spawn>;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          killer.off('error', onError);
          killer.off('close', onClose);
          resolve();
        };
        const onError = (error: Error) => {
          treeKillFailure = `taskkill could not start: ${error.message}`;
          finish();
        };
        const onClose = (code: number | null, signal?: NodeJS.Signals | null) => {
          if (code !== 0 || (signal !== null && signal !== undefined)) {
            treeKillFailure = `taskkill exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}`;
          } else {
            treeKillSucceeded = true;
            confirmedTreeKills.add(child);
          }
          finish();
        };
        try {
          killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch (error) {
          treeKillFailure = `taskkill could not start: ${error instanceof Error ? error.message : String(error)}`;
          resolve();
          return;
        }
        killer.on('error', onError);
        killer.on('close', onClose);
        timer = setTimeout(() => {
          treeKillFailure = `taskkill did not finish within ${treeKillTimeout}ms`;
          try { killer.kill(); } catch { /* best effort */ }
          finish();
        }, treeKillTimeout);
      });
    } catch (error) {
      treeKillFailure = `taskkill failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (process.platform !== 'win32' && child.pid !== undefined) {
    // This runtime's descendant-tree cleanup contract is Windows-only. A direct
    // signal is not evidence that Chromium descendants were terminated.
    treeKillFailure = `process-tree termination is unsupported on ${process.platform}`;
  }
  const remainingMs = Math.max(0, deadline - Date.now());
  const exit = waitForChildExit(child, remainingMs);
  try { child.kill('SIGKILL'); } catch { /* observe exit below; report if unresolved */ }
  const sidecarExit = await exit;
  if (!sidecarExit.exited || treeKillFailure) {
    const reasons = [
      !sidecarExit.exited ? `Could not confirm Playwright sidecar process${child.pid === undefined ? '' : ` ${child.pid}`} exited within ${boundedTimeout}ms after force-kill.` : undefined,
      treeKillFailure ? `Process-tree termination failed (${treeKillFailure}); Chromium descendants may remain.` : undefined,
    ].filter((reason): reason is string => reason !== undefined);
    if (treeKillFailure) unresolvedTreeKills.set(child, treeKillFailure);
    throw unresolvedCleanupError(reasons.join(' '));
  }
  unresolvedTreeKills.delete(child);
  if (process.platform === 'win32' && child.pid !== undefined) confirmedTreeKills.add(child);
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
  private unresolvedCleanup?: { child: ChildLike; error: Error };
  private shutdownPromise?: Promise<void>;
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
      catch (error) { void this.failAndRecover(error instanceof Error ? error : new Error(String(error))).catch(() => {}); }
    });
    child.stderr?.on('data', () => { /* sidecar diagnostics are intentionally not copied into model context */ });
    child.on('error', (error) => { if (child === this.child) void this.failAndRecover(error).catch(() => {}); });
    child.on('exit', (code, signal) => { markChildExited(child, code, signal ?? null); });
    child.on('close', (code, signal) => {
      markChildExited(child, code, signal ?? null);
      if (child === this.child && !this.stopping) {
        void this.failAndRecover(new PlaywrightRuntimeError('BROWSER_CRASHED', 'Playwright sidecar exited unexpectedly. All browser sessions are gone.', false)).catch(() => {});
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
        // sidecar. Confirm process exit before exposing the timeout/cancel
        // result so delayed mutations cannot escape the request boundary.
        void this.failAndRecover(new PlaywrightRuntimeError('RUNTIME_REOPEN_REQUIRED', REOPEN_MESSAGE, false)).then(
          () => pending.reject(error),
          (cleanupError: unknown) => pending.reject(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))),
        );
      } else {
        pending.reject(error);
      }
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
    if (this.unresolvedCleanup) throw this.unresolvedCleanup.error;
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
          `${method} did not settle within ${timeoutMs}ms. The operation may already have affected the page; the browser runtime was terminated. ${REOPEN_MESSAGE}`,
          false,
        )).catch(() => {});
      }, timeoutMs);
      const pending: Pending = { id, method, resolve, reject, timer };
      if (options.signal) {
        const abort = () => {
          try { this.write({ v: 1, kind: 'cancel', id }); } catch { /* recovery owns cleanup */ }
          // If the sidecar cannot settle the cancellation within a bounded grace
          // period, force-terminate the process tree and invalidate the runtime.
          pending.cancelGrace = setTimeout(() => {
            if (!this.pending.has(id)) return;
            void this.failAndRecover(new PlaywrightRuntimeError('CANCELLED', 'Playwright request was cancelled and the sidecar did not settle in time; the browser runtime was terminated.', false)).catch(() => {});
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
    if (this.recovering) return this.recovering;
    if (this.stopping) return;
    const child = this.child; this.child = undefined;
    const pendingValues = [...this.pending.values()];
    const recovery = (async () => {
      let rejection = cause;
      if (child) {
        try { await killProcessTree(child, this.shutdownTimeoutMs); }
        catch (error) {
          rejection = error instanceof Error ? error : new Error(String(error));
          this.unresolvedCleanup = { child, error: rejection };
        }
      }
      this.needsReopen = true;
      for (const item of pendingValues) this.rejectPending(item, rejection);
      if (rejection !== cause) throw rejection;
    })();
    this.recovering = recovery.finally(() => { this.recovering = undefined; });
    await this.recovering;
  }

  markReopened(): void { this.needsReopen = false; }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const shutdown = this.shutdownInternal();
    this.shutdownPromise = shutdown;
    try { await shutdown; }
    finally { if (this.shutdownPromise === shutdown) this.shutdownPromise = undefined; }
  }

  private async shutdownInternal(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      if (this.recovering) await this.recovering;
      if (this.unresolvedCleanup) {
        await killProcessTree(this.unresolvedCleanup.child, this.shutdownTimeoutMs);
        this.unresolvedCleanup = undefined;
      }
      const child = this.child; this.child = undefined;
      const pendingValues = [...this.pending.values()];
      for (const item of pendingValues) this.rejectPending(item, new PlaywrightRuntimeError('RUNTIME_REOPEN_REQUIRED', 'Owning pie session shut down; every playwright session id is invalid.', false));
      if (child) {
        let graceful = true;
        try { child.stdin.write(encodeJsonl({ v: 1, kind: 'shutdown' })); } catch { graceful = false; }
        if (graceful) {
          const exit = await waitForChildExit(child, this.shutdownTimeoutMs);
          graceful = exit.exited && exit.clean;
        }
        if (!graceful) {
          try { await killProcessTree(child, this.shutdownTimeoutMs); }
          catch (error) {
            const cleanupError = error instanceof Error ? error : new Error(String(error));
            this.unresolvedCleanup = { child, error: cleanupError };
            throw cleanupError;
          }
        }
      }
      this.needsReopen = false;
    } finally {
      this.stopping = false;
    }
  }

  killForTesting(): void { killProcessTreeSync(this.child); }
}

export class RuntimeRegistry {
  private readonly clients = new Map<string, RuntimeClient>();
  private readonly childClients = new Map<string, RuntimeClient>();
  constructor(private readonly spawnSidecar?: SidecarSpawn) {}
  async get(sessionPath: string): Promise<RuntimeClient> {
    const key = await canonicalSessionPath(sessionPath);
    let client = this.clients.get(key);
    if (!client) { client = new RuntimeClient(key, this.spawnSidecar); this.clients.set(key, client); }
    return client;
  }
  /** Resolve a runtime private to one in-memory child execution attempt. */
  getForChild(owner: ChildToolRuntimeOwner): RuntimeClient {
    assertChildToolRuntimeOwnerOpen(owner);
    let client = this.childClients.get(owner.id);
    if (!client) {
      client = new RuntimeClient(`child:${owner.id}`, this.spawnSidecar);
      this.childClients.set(owner.id, client);
      registerChildToolRuntimeCleanup(owner, 'playwright', async () => await this.shutdownChild(owner.id));
    }
    return client;
  }
  private async shutdownChild(ownerId: string): Promise<void> {
    const client = this.childClients.get(ownerId);
    await client?.shutdown();
    this.childClients.delete(ownerId);
  }
  async peek(sessionPath: string): Promise<RuntimeClient | undefined> { return this.clients.get(await canonicalSessionPath(sessionPath)); }
  async shutdownSession(sessionPath: string): Promise<void> {
    const key = await canonicalSessionPath(sessionPath);
    const client = this.clients.get(key);
    await client?.shutdown();
    this.clients.delete(key);
  }
  async shutdownAll(): Promise<void> {
    const clients = [...this.clients.entries()].map(([key, client]) => ({ key, client, child: false as const }));
    const childClients = [...this.childClients.entries()].map(([key, client]) => ({ key, client, child: true as const }));
    const results = await Promise.allSettled([...clients, ...childClients].map(async ({ key, client, child }) => {
      await client.shutdown();
      (child ? this.childClients : this.clients).delete(key);
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length > 1) {
      throw new AggregateError(failures.map((failure) => failure.reason), `${failures.length} Playwright runtimes could not be shut down cleanly.`);
    }
  }
  killAllSync(): void {
    for (const client of this.clients.values()) client.killForTesting();
    for (const client of this.childClients.values()) client.killForTesting();
  }
  get size(): number { return this.clients.size + this.childClients.size; }
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
  process.once('beforeExit', () => {
    void state.registry.shutdownAll().catch((error: unknown) => {
      process.stderr.write(`Playwright runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });
  process.once('exit', () => state.registry.killAllSync());
}
