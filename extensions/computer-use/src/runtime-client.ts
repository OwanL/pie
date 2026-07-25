import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';

import { canonicalSessionPath } from './artifacts.js';
import { encodeJsonl, JsonlDecoder } from './protocol.js';
import type { ComputerAction, ComputerSequence, HeldState, MouseButton, RuntimeResponse, SessionHeldState } from './types.js';

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
  id: string; method: string; sessionId?: string; potential: HeldState; releaseSessionIds?: string[];
  resolve(value: RuntimeResponse): void; reject(error: Error): void;
  timer: NodeJS.Timeout; abort?: () => void; child?: ChildLike;
}

export class ComputerRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly artifacts?: { sequencePath?: string; tracePath?: string },
    readonly held?: HeldState,
    readonly heldBySession?: SessionHeldState[],
  ) { super(message); this.name = 'ComputerRuntimeError'; }
}

function emptyHeld(): HeldState { return { keys: [], buttons: [] }; }
function normalizedHeld(value: unknown): HeldState {
  const h = (value ?? {}) as { keys?: unknown; buttons?: unknown };
  return {
    keys: Array.isArray(h.keys) ? h.keys.filter((v): v is string => typeof v === 'string') : [],
    buttons: Array.isArray(h.buttons) ? h.buttons.filter((v): v is MouseButton => v === 'left' || v === 'middle' || v === 'right') : [],
  };
}
function mergeHeld(...values: HeldState[]): HeldState {
  return { keys: [...new Set(values.flatMap((v) => v.keys))], buttons: [...new Set(values.flatMap((v) => v.buttons))] };
}
function hasHeld(value: HeldState): boolean { return value.keys.length > 0 || value.buttons.length > 0; }
function normalizedHeldBySession(value: unknown): SessionHeldState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof (item as { sessionId?: unknown }).sessionId !== 'string') return [];
    return [{ sessionId: (item as { sessionId: string }).sessionId, held: normalizedHeld((item as { held?: unknown }).held) }];
  });
}

export function potentialHeldForAction(action: ComputerAction): HeldState {
  if (action.kind === 'key_down') return { keys: [action.key], buttons: [] };
  if (action.kind === 'mouse_down') return { keys: [], buttons: [action.button] };
  if (action.kind === 'drag') return { keys: [], buttons: [action.button ?? 'left'] };
  if (action.kind === 'hotkey') return { keys: [...action.keys], buttons: [] };
  if (action.kind === 'press') return { keys: [action.key], buttons: [] };
  return emptyHeld();
}
export function potentialHeldForSequence(sequence: ComputerSequence | undefined): HeldState {
  return sequence ? sequence.actions.reduce((held, step) => mergeHeld(held, potentialHeldForAction(step.action)), emptyHeld()) : emptyHeld();
}

function defaultSpawn(): ChildLike {
  const entry = fileURLToPath(new URL('./sidecar.mjs', import.meta.url));
  return spawn(process.execPath, [entry], {
    env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false', CUA_DRIVER_RS_UPDATE_CHECK: 'false' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

export interface RequestOptions {
  timeoutMs?: number; signal?: AbortSignal; sessionId?: string; potential?: HeldState; allowNeedsReopen?: boolean;
}

export class RuntimeClient {
  private child?: ChildLike;
  private decoder = new JsonlDecoder();
  private readonly pending = new Map<string, Pending>();
  private readonly heldBySession = new Map<string, HeldState>();
  private recovering?: Promise<void>;
  private healthTimer?: NodeJS.Timeout;
  private stopping = false;
  private needsReopen = false;

  constructor(
    readonly sessionPath: string,
    private readonly spawnSidecar: SidecarSpawn = defaultSpawn,
    private readonly emergencyTimeoutMs = 10000,
    private readonly shutdownTimeoutMs = 2000,
  ) {}

  get state(): 'stopped' | 'ready' | 'needs_reopen' | 'recovering' {
    if (this.recovering) return 'recovering';
    if (!this.child) return 'stopped';
    return this.needsReopen ? 'needs_reopen' : 'ready';
  }
  get pid(): number | undefined { return this.child?.pid; }
  get hasHeldInput(): boolean { return [...this.snapshotHeldBySession().values()].some(hasHeld); }
  getHeld(sessionId: string): HeldState { return this.heldBySession.get(sessionId) ?? emptyHeld(); }

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
    child.on('close', () => { if (child === this.child && !this.stopping) void this.failAndRecover(new ComputerRuntimeError('SIDECAR_EXITED', 'Computer sidecar exited unexpectedly.', true)); });
    this.healthTimer = setInterval(() => {
      if (!this.stopping && this.child && !this.recovering) {
        void this.request('ping', {}, { timeoutMs: 5000, allowNeedsReopen: true }).catch(() => {});
      }
    }, 5000);
    this.healthTimer.unref?.();
  }

  private write(record: unknown): void {
    if (!this.child) throw new ComputerRuntimeError('RUNTIME_STOPPED', 'Computer runtime is not running.', true);
    this.child.stdin.write(encodeJsonl(record));
  }

  private handleRecord(raw: unknown): void {
    if (!raw || typeof raw !== 'object') throw new ComputerRuntimeError('MALFORMED_RESPONSE', 'Computer sidecar returned a non-object record.', true);
    const record = raw as Record<string, unknown>;
    if (record.v === 1 && record.kind === 'protocol_error') {
      const shape = (record.error ?? {}) as { code?: unknown; message?: unknown };
      throw new ComputerRuntimeError(typeof shape.code === 'string' ? shape.code : 'MALFORMED_RESPONSE', typeof shape.message === 'string' ? shape.message : 'Computer sidecar reported a protocol error.', true);
    }
    if (record.v !== 1 || record.kind !== 'response' || typeof record.id !== 'string') {
      throw new ComputerRuntimeError('MALFORMED_RESPONSE', 'Computer sidecar returned a malformed response.', true);
    }
    const pending = this.pending.get(record.id);
    if (!pending) throw new ComputerRuntimeError('STALE_RESPONSE', `Computer sidecar returned stale request id ${record.id}.`, true);
    this.pending.delete(record.id); clearTimeout(pending.timer); pending.abort?.();
    if (record.ok !== true) {
      const shape = (record.error ?? {}) as { code?: unknown; message?: unknown; retryable?: unknown; sequencePath?: unknown; tracePath?: unknown; held?: unknown; heldBySession?: unknown };
      const artifacts = {
        ...(typeof shape.sequencePath === 'string' ? { sequencePath: shape.sequencePath } : {}),
        ...(typeof shape.tracePath === 'string' ? { tracePath: shape.tracePath } : {}),
      };
      const errorHeld = shape.held === undefined ? undefined : normalizedHeld(shape.held);
      const errorHeldBySession = normalizedHeldBySession(shape.heldBySession);
      if (pending.sessionId) {
        this.heldBySession.set(pending.sessionId, errorHeld ?? mergeHeld(this.getHeld(pending.sessionId), pending.potential));
      }
      for (const item of errorHeldBySession) this.heldBySession.set(item.sessionId, item.held);
      const artifactText = [artifacts.sequencePath && `sequence: ${artifacts.sequencePath}`, artifacts.tracePath && `trace: ${artifacts.tracePath}`].filter(Boolean).join('; ');
      const baseMessage = typeof shape.message === 'string' ? shape.message : 'Computer sidecar request failed.';
      const error = new ComputerRuntimeError(
        typeof shape.code === 'string' ? shape.code : 'SIDECAR_ERROR',
        artifactText ? `${baseMessage} (${artifactText})` : baseMessage,
        shape.retryable === true,
        artifacts,
        errorHeld,
        errorHeldBySession.length ? errorHeldBySession : undefined,
      );
      pending.reject(error); return;
    }
    const result = (record.result ?? {}) as RuntimeResponse;
    if ((pending.method === 'open' || pending.method === 'close') && this.hasHeldInput) {
      pending.reject(new ComputerRuntimeError('RELEASE_FAILED', `Cannot ${pending.method} while parent-owned held input remains unresolved.`, true));
      return;
    }
    const resultHeldBySession = normalizedHeldBySession(result.heldBySession);
    for (const item of resultHeldBySession) this.heldBySession.set(item.sessionId, item.held);
    if (pending.sessionId && result.held !== undefined) this.heldBySession.set(pending.sessionId, normalizedHeld(result.held));
    const aggregateHeld = normalizedHeld(result.held);
    const releaseIncomplete = (pending.method === 'release_all' && (result.held === undefined || (pending.sessionId !== undefined && hasHeld(this.getHeld(pending.sessionId)))))
      || (pending.method === 'emergency_release' && (result.held === undefined || hasHeld(aggregateHeld)
        || (pending.releaseSessionIds ?? []).some((sessionId) => hasHeld(this.getHeld(sessionId)))));
    if (releaseIncomplete) {
      pending.reject(new ComputerRuntimeError('RELEASE_FAILED', 'The runtime could not release all held input.', true, undefined, aggregateHeld, resultHeldBySession));
      return;
    }
    pending.resolve(result);
  }

  private rejectPending(item: Pending, cause: Error): void {
    clearTimeout(item.timer); item.abort?.();
    if (item.sessionId) this.heldBySession.set(item.sessionId, mergeHeld(this.getHeld(item.sessionId), item.potential));
    item.reject(cause);
  }

  private timeoutEmergencyRequest(id: string, cause: ComputerRuntimeError): void {
    const timedOut = this.pending.get(id); if (!timedOut) return;
    const attemptChild = timedOut.child; this.pending.delete(id); this.rejectPending(timedOut, cause);
    for (const [siblingId, sibling] of [...this.pending]) {
      if (sibling.child !== attemptChild) continue;
      this.pending.delete(siblingId);
      this.rejectPending(sibling, new ComputerRuntimeError('SIDECAR_EXITED', 'Emergency-release sidecar was killed after timing out.', true));
    }
    if (attemptChild && attemptChild === this.child) {
      this.child = undefined;
      if (this.healthTimer) clearInterval(this.healthTimer); this.healthTimer = undefined;
    }
    try { attemptChild?.kill('SIGKILL'); } catch { /* already dead */ }
    this.needsReopen = true;
  }

  async request(method: string, params: unknown, options: RequestOptions = {}): Promise<RuntimeResponse> {
    if (this.recovering && method !== 'emergency_release') await this.recovering;
    if ((method === 'open' || method === 'close') && this.hasHeldInput) {
      throw new ComputerRuntimeError('RELEASE_FAILED', `Cannot ${method} while parent-owned held input remains unresolved.`, true);
    }
    if (this.needsReopen && !options.allowNeedsReopen && method !== 'open' && method !== 'emergency_release') {
      throw new ComputerRuntimeError('RUNTIME_RESTART_REQUIRED', 'The sidecar was restarted. Call computer open to rediscover or reopen the target.', true);
    }
    this.start();
    const requestChild = this.child; const id = randomUUID(); const timeoutMs = options.timeoutMs ?? 30000;
    const potential = options.potential ?? emptyHeld();
    return await new Promise<RuntimeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const error = new ComputerRuntimeError('REQUEST_TIMEOUT', `${method} timed out after ${timeoutMs}ms.`, true);
        if (method === 'emergency_release') this.timeoutEmergencyRequest(id, error);
        else void this.failAndRecover(error);
      }, timeoutMs);
      const releaseSessionIds = method === 'emergency_release'
        ? normalizedHeldBySession((params as { heldBySession?: unknown })?.heldBySession).map((item) => item.sessionId)
        : undefined;
      const pending: Pending = { id, method, sessionId: options.sessionId, potential, releaseSessionIds, resolve, reject, timer, child: requestChild };
      if (options.signal) {
        const abort = () => { try { this.write({ v: 1, kind: 'cancel', id }); } catch { /* recovery owns cleanup */ } };
        if (options.signal.aborted) {
          clearTimeout(timer);
          const error = new ComputerRuntimeError('CANCELLED', 'Computer request was cancelled.');
          if (options.sessionId) void this.releaseAllKnown(options.sessionId, potential).finally(() => reject(error));
          else reject(error);
          return;
        }
        options.signal.addEventListener('abort', abort, { once: true });
        pending.abort = () => options.signal?.removeEventListener('abort', abort);
      }
      this.pending.set(id, pending);
      try { this.write({ v: 1, kind: 'request', id, method, params }); }
      catch (error) {
        this.pending.delete(id); clearTimeout(timer); pending.abort?.();
        if (options.sessionId) void this.releaseAllKnown(options.sessionId, potential).finally(() => reject(error as Error));
        else reject(error as Error);
      }
    });
  }

  private snapshotHeldBySession(): Map<string, HeldState> {
    const unionBySession = new Map<string, HeldState>();
    for (const [sessionId, held] of this.heldBySession) unionBySession.set(sessionId, held);
    for (const pending of this.pending.values()) if (pending.sessionId) unionBySession.set(pending.sessionId, mergeHeld(unionBySession.get(pending.sessionId) ?? emptyHeld(), pending.potential));
    return unionBySession;
  }

  private async failAndRecover(cause: Error): Promise<void> {
    if (this.recovering || this.stopping) return this.recovering;
    const child = this.child; this.child = undefined;
    if (this.healthTimer) clearInterval(this.healthTimer); this.healthTimer = undefined;
    const unionBySession = this.snapshotHeldBySession();
    for (const [sessionId, held] of unionBySession) this.heldBySession.set(sessionId, held);
    const pendingValues = [...this.pending.values()]; this.pending.clear();
    for (const item of pendingValues) this.rejectPending(item, cause);
    try { child?.kill('SIGKILL'); } catch { /* already dead */ }
    this.needsReopen = true;
    this.recovering = (async () => {
      let attemptChild: ChildLike | undefined;
      try {
        this.start(); attemptChild = this.child;
        await this.request(
          'emergency_release',
          { heldBySession: [...unionBySession.entries()].map(([sessionId, held]) => ({ sessionId, held })) },
          { timeoutMs: this.emergencyTimeoutMs, allowNeedsReopen: true },
        );
      } catch {
        if (this.child === attemptChild) {
          this.child = undefined;
          if (this.healthTimer) clearInterval(this.healthTimer); this.healthTimer = undefined;
        }
        try { attemptChild?.kill('SIGKILL'); } catch { /* best effort */ }
      }
    })().finally(() => { this.recovering = undefined; });
    await this.recovering;
  }

  async releaseAllKnown(sessionId: string, additional: HeldState = emptyHeld()): Promise<void> {
    const held = mergeHeld(this.getHeld(sessionId), additional);
    if (!hasHeld(held)) return;
    try {
      const result = await this.request('release_all', { sessionId, held }, { sessionId, potential: held, allowNeedsReopen: true, timeoutMs: this.emergencyTimeoutMs });
      const remaining = normalizedHeld(result.held); this.heldBySession.set(sessionId, remaining);
      if (hasHeld(remaining)) throw new ComputerRuntimeError('RELEASE_FAILED', 'Failed to release held input.', true, undefined, remaining);
    } catch (error) {
      if (!(error instanceof ComputerRuntimeError) || error.held === undefined) {
        this.heldBySession.set(sessionId, mergeHeld(this.getHeld(sessionId), held));
      }
      await this.failAndRecover(new ComputerRuntimeError('RELEASE_FAILED', 'Failed to release held input.', true));
      if (!hasHeld(this.getHeld(sessionId))) return;
      throw error;
    }
  }

  async releaseAllHeldKnown(): Promise<void> {
    const heldSessions = [...this.snapshotHeldBySession()].filter(([, held]) => hasHeld(held));
    const failures: Error[] = [];
    for (const [sessionId, held] of heldSessions) {
      try { await this.releaseAllKnown(sessionId, held); }
      catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
    }
    const remainingBySession = [...this.heldBySession]
      .filter(([, held]) => hasHeld(held))
      .map(([sessionId, held]) => ({ sessionId, held }));
    if (remainingBySession.length > 0) {
      const detail = failures[0]?.message ? ` ${failures[0].message}` : '';
      throw new ComputerRuntimeError(
        'RELEASE_FAILED', `Failed to release all parent-owned held input.${detail}`, true, undefined,
        mergeHeld(...remainingBySession.map((item) => item.held)), remainingBySession,
      );
    }
  }

  markReopened(): void { this.needsReopen = false; }

  private async emergencyReleaseAfterHungShutdown(heldBySession: Map<string, HeldState>): Promise<void> {
    if (heldBySession.size === 0) return;
    for (const [sessionId, held] of heldBySession) this.heldBySession.set(sessionId, mergeHeld(this.getHeld(sessionId), held));
    this.stopping = false; let attemptChild: ChildLike | undefined;
    try {
      this.start(); attemptChild = this.child;
      await this.request(
        'emergency_release',
        { heldBySession: [...heldBySession.entries()].map(([sessionId, held]) => ({ sessionId, held })) },
        { timeoutMs: this.emergencyTimeoutMs, allowNeedsReopen: true },
      );
    } catch { /* the truthful ledger is retained for a later bounded retry */ }
    finally {
      this.stopping = true;
      if (this.child === attemptChild) {
        this.child = undefined;
        if (this.healthTimer) clearInterval(this.healthTimer); this.healthTimer = undefined;
      }
      try { attemptChild?.kill('SIGKILL'); } catch { /* already exited */ }
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    const heldBySession = new Map([...this.snapshotHeldBySession()].filter(([, held]) => hasHeld(held)));
    for (const [sessionId, held] of heldBySession) this.heldBySession.set(sessionId, held);
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer); this.healthTimer = undefined;
    if (this.recovering) await this.recovering.catch(() => {});
    const child = this.child; this.child = undefined;
    const pendingValues = [...this.pending.values()]; this.pending.clear();
    for (const item of pendingValues) this.rejectPending(item, new ComputerRuntimeError('RUNTIME_STOPPED', 'Owning session shut down.'));
    let graceful = true;
    if (child) {
      try { child.stdin.write(encodeJsonl({ v: 1, kind: 'shutdown' })); } catch { graceful = false; }
      if (graceful) graceful = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
        child.on('close', () => { clearTimeout(timer); resolve(true); });
      });
      if (!graceful) {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
      // Process exit alone cannot prove that backend shutdown released every
      // value. Confirm the parent ledger through a fresh bounded sidecar.
      if (heldBySession.size > 0) await this.emergencyReleaseAfterHungShutdown(heldBySession);
    } else if (heldBySession.size > 0) {
      // A prior failed recovery may have left no live child while the parent
      // still owns acknowledged/potential input. A fresh sidecar is the only
      // process that can issue the corresponding OS releases.
      await this.emergencyReleaseAfterHungShutdown(heldBySession);
    }
    const releaseRemains = [...this.heldBySession.values()].some(hasHeld);
    if (!releaseRemains) this.needsReopen = false;
    this.stopping = !releaseRemains;
  }

  killForTesting(): void { this.child?.kill('SIGKILL'); }
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
    const key = await canonicalSessionPath(sessionPath); const client = this.clients.get(key); await client?.shutdown();
    if (client && !client.hasHeldInput) this.clients.delete(key);
  }
  async shutdownAll(): Promise<void> {
    const clients = [...this.clients.entries()];
    await Promise.allSettled(clients.map(async ([key, client]) => { await client.shutdown(); if (!client.hasHeldInput) this.clients.delete(key); }));
  }
  killAllSync(): void { for (const client of this.clients.values()) client.killForTesting(); }
  get size(): number { return this.clients.size; }
}

export const runtimeRegistry = new RuntimeRegistry();
let teardownInstalled = false;
export function installProcessTeardown(): void {
  if (teardownInstalled) return; teardownInstalled = true;
  process.once('beforeExit', () => { void runtimeRegistry.shutdownAll(); });
  process.once('exit', () => runtimeRegistry.killAllSync());
}
