import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { attachJsonlLineReader } from '../lib/rpc/jsonl.js';
import type { SystemPromptEntry } from '../lib/rpc/session-events.js';
import {
  establishWindowsProcessTreeGuardian,
  terminateProcessTree,
  type WindowsProcessTreeGuardian,
} from '../lib/process-lifecycle/process-tree.js';
import {
  assertSdkRuntimeAgreement,
  parseSdkRuntimeSelection,
  type SdkRuntimeSelection,
} from '../lib/sdk-integration/sdk-runtime-selection.js';
import {
  INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION,
  type InitialContextEstimateWorkerInitialization,
  type InitialContextEstimateWorkerReady,
} from './initial-context-estimate-protocol.js';
import type {
  InitialContextEstimateWorkerInput,
  InitialContextEstimateWorkerOutput,
  InitialContextEstimateWorkerTimings,
  InitialContextInventory,
} from './initial-context-estimate-worker';

const IPC_READ_FD = 3;
const IPC_WRITE_FD = 4;
const MAX_FRAME_BYTES = 30 * 1024 * 1024;
const DEFAULT_DISCOVERY_QUEUE_LIMIT = 16;

export interface InitialContextEstimateTimingSample extends InitialContextEstimateWorkerTimings {
  readonly stage: 'prewarm' | 'discover';
  readonly spawnDurationMs?: number;
  readonly guardianDurationMs?: number;
  readonly preloadDurationMs?: number;
  readonly responseDurationMs?: number;
  readonly totalDurationMs: number;
  readonly prewarmed?: boolean;
  readonly outcome: 'success' | 'failure';
}

export interface InitialContextEstimateClientOptions {
  entryPath: string;
  sdkPath: string;
  sdkRuntime: SdkRuntimeSelection;
  nodePath?: string;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxQueuedDiscoveries?: number;
  spawnProcess?: typeof spawn;
  establishGuardian?: typeof establishWindowsProcessTreeGuardian;
  terminateTree?: typeof terminateProcessTree;
  onDiagnostic?: (chunk: string) => void;
  /** Bounded lifecycle timings; samples never include paths or inventory data. */
  onTiming?: (sample: InitialContextEstimateTimingSample) => void;
}

interface ActiveChild {
  child: ChildProcess;
  guardian?: WindowsProcessTreeGuardian;
  outbound: Writable;
  inbound: Readable;
  state: 'starting' | 'idle' | 'busy' | 'cleaning';
  purpose: 'prewarm' | 'on-demand';
  spawnDurationMs?: number;
  guardianDurationMs?: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  cleanupPromise?: Promise<void>;
  cleanupStarted?: boolean;
  guardianTerminationPromise?: Promise<void>;
  lateGuardianCleanupPromise?: Promise<void>;
  cancelStartup?: () => void;
  preloadDurationMs?: number;
  spawnError?: Error;
}

interface StartupMetrics {
  spawnDurationMs?: number;
  guardianDurationMs?: number;
  preloadDurationMs?: number;
}

export function buildInitialContextInventoryEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const forced: NodeJS.ProcessEnv = {
    PIE_INITIAL_CONTEXT_INVENTORY: '1',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    YARN_OFFLINE: '1',
    YARN_ENABLE_NETWORK: '0',
    YARN_ENABLE_TELEMETRY: '0',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  };
  const forcedKeys = new Set(Object.keys(forced).map((key) => key.toLowerCase()));
  const env = Object.fromEntries(
    Object.entries(base).filter(([key]) => !forcedKeys.has(key.toLowerCase())),
  );
  return { ...env, ...forced };
}

/**
 * Holds at most one SDK-preloaded spare. The child imports only the validated
 * SDK modules during prewarm, then is consumed by exactly one discovery and
 * always retired. A bounded FIFO serializes concurrent calls rather than
 * multiplying worker processes; excess calls fail open like any unavailable
 * inventory.
 */
export class InitialContextEstimateClient {
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly maxQueuedDiscoveries: number;
  private readonly sdkRuntime: SdkRuntimeSelection;
  private readonly active = new Set<ActiveChild>();
  private current?: ActiveChild;
  private starting?: Promise<ActiveChild>;
  private startingPurpose?: ActiveChild['purpose'];
  private discoveryQueue: Promise<void> = Promise.resolve();
  private queuedDiscoveries = 0;
  private disposed = false;
  private disposePromise?: Promise<void>;
  private disposeInProgress = false;
  private disposeRetryRequired = false;

  constructor(private readonly options: InitialContextEstimateClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000;
    this.maxQueuedDiscoveries = options.maxQueuedDiscoveries ?? DEFAULT_DISCOVERY_QUEUE_LIMIT;
    this.sdkRuntime = parseSdkRuntimeSelection(options.sdkRuntime);
    assertSdkRuntimeAgreement(options.sdkPath, this.sdkRuntime);
    for (const [name, value] of [
      ['request', this.timeoutMs],
      ['startup', this.startupTimeoutMs],
      ['idle', this.idleTimeoutMs],
      ['cleanup', this.cleanupTimeoutMs],
      ['queued discoveries', this.maxQueuedDiscoveries],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Initial-context inventory ${name} limit must be a positive safe integer.`);
      }
    }
  }

  /** Preload the single optional spare; coordinator startup deliberately does not await it. */
  async warm(): Promise<void> {
    if (this.disposed) return;
    const startedAt = performance.now();
    let child: ActiveChild | undefined;
    let outcome: 'success' | 'failure' = 'failure';
    try {
      child = await this.ensureChild('prewarm');
      if (child.state !== 'idle' || hasExited(child.child)) {
        throw child.spawnError ?? new Error('Initial-context inventory worker exited after SDK preload.');
      }
      this.scheduleIdleDisposal(child);
      outcome = 'success';
    } finally {
      this.recordTiming({
        stage: 'prewarm',
        totalDurationMs: elapsedMs(startedAt),
        ...(child ? this.startupTiming(child) : {}),
        outcome,
      });
    }
  }

  discover(input: {
    cwd: string;
    agentDir: string;
    model: { provider: string; id: string };
  }): Promise<InitialContextInventory | undefined> {
    if (this.disposed || this.queuedDiscoveries >= this.maxQueuedDiscoveries) {
      return Promise.resolve(undefined);
    }
    this.queuedDiscoveries += 1;
    const result = this.discoveryQueue.then(async () => {
      if (this.disposed) return undefined;
      return await this.discoverOne(input);
    });
    this.discoveryQueue = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.queuedDiscoveries -= 1; });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    for (const active of this.active) active.cancelStartup?.();
    const disposal = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      await Promise.all([...this.active].map(async (active) => {
        clearTimeout(active.idleTimer);
        try {
          await this.cleanup(active);
          if (active.guardian) await this.cleanupLateGuardian(active, active.guardian);
          this.active.delete(active);
          if (this.current === active) this.current = undefined;
        } catch (error) {
          failures.push(error);
        }
      }));
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Initial-context inventory cleanup failed.');
      }
    });
    this.disposePromise = disposal;
    this.disposeInProgress = true;
    void disposal.then(() => {
      if (this.disposePromise !== disposal) return;
      this.disposeInProgress = false;
      if (this.disposeRetryRequired) {
        this.disposePromise = undefined;
        this.disposeRetryRequired = false;
      }
    }, () => {
      if (this.disposePromise === disposal) this.disposePromise = undefined;
      this.disposeInProgress = false;
      this.disposeRetryRequired = false;
    });
    return disposal;
  }

  private async discoverOne(input: {
    cwd: string;
    agentDir: string;
    model: { provider: string; id: string };
  }): Promise<InitialContextInventory | undefined> {
    const startedAt = performance.now();
    let active: ActiveChild | undefined;
    let responseDurationMs: number | undefined;
    let workerTimings: InitialContextEstimateWorkerTimings | undefined;
    let outcome: 'success' | 'failure' = 'failure';
    try {
      active = await this.ensureChild('on-demand');
      if (this.disposed || active.state !== 'idle') return undefined;
      clearTimeout(active.idleTimer);
      active.state = 'busy';
      const response = this.readResponse(active);
      const request: InitialContextEstimateWorkerInput = {
        protocolVersion: INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION,
        kind: 'discover',
        sdkPath: this.options.sdkPath,
        sdkRuntime: this.sdkRuntime,
        cwd: input.cwd,
        agentDir: input.agentDir,
        model: input.model,
      };
      const wire = `${JSON.stringify(request)}\n`;
      if (Buffer.byteLength(wire, 'utf8') > MAX_FRAME_BYTES) {
        throw new Error('Initial-context inventory request exceeded its frame limit.');
      }
      const responseStartedAt = performance.now();
      let output: InitialContextEstimateWorkerOutput;
      try {
        await endWithFrame(active.outbound, wire);
        output = await withTimeout(response, this.timeoutMs, 'Initial-context inventory worker timed out.');
      } finally {
        responseDurationMs = elapsedMs(responseStartedAt);
      }
      outcome = output.ok ? 'success' : 'failure';
      workerTimings = output.timings;
      return output.ok ? output.inventory : undefined;
    } catch {
      return undefined;
    } finally {
      if (active) {
        try {
          await this.cleanup(active);
          this.active.delete(active);
          if (this.current === active) this.current = undefined;
        } catch {
          // Failed cleanup remains the sole tracked process; never spawn over it.
        }
      }
      this.recordTiming({
        stage: 'discover',
        totalDurationMs: elapsedMs(startedAt),
        ...(active ? this.startupTiming(active) : {}),
        ...(active ? { prewarmed: active.purpose === 'prewarm' } : {}),
        ...(responseDurationMs !== undefined ? { responseDurationMs } : {}),
        ...(workerTimings ?? {}),
        outcome,
      });
    }
  }

  private async ensureChild(purpose: ActiveChild['purpose']): Promise<ActiveChild> {
    if (this.disposed) throw new Error('Initial-context inventory client is disposed.');
    const existing = this.current;
    if (existing) {
      if (existing.state === 'idle' && !hasExited(existing.child)) return existing;
      if (existing.state === 'busy') {
        if (purpose === 'prewarm') return existing;
        throw new Error('Initial-context inventory worker is already in use.');
      }
      if (existing.state === 'cleaning') {
        try {
          await this.cleanup(existing);
          this.active.delete(existing);
          if (this.current === existing) this.current = undefined;
        } catch (error) {
          throw new Error(`Initial-context inventory worker cleanup failed: ${toErrorMessage(error)}`);
        }
      } else if (hasExited(existing.child)) {
        try {
          await this.cleanup(existing);
          this.active.delete(existing);
          if (this.current === existing) this.current = undefined;
        } catch (error) {
          throw new Error(`Initial-context inventory worker cleanup failed: ${toErrorMessage(error)}`);
        }
      }
    }
    if (this.starting) {
      const starting = this.starting;
      const startingPurpose = this.startingPurpose;
      try {
        return await starting;
      } catch (error) {
        // A public request that arrived during a failed warmup may make one
        // clean on-demand attempt. Failed cleanup still blocks another spawn.
        if (purpose === 'on-demand' && startingPurpose === 'prewarm'
          && !this.disposed && this.active.size === 0) {
          if (this.starting === starting) {
            this.starting = undefined;
            this.startingPurpose = undefined;
          }
          return await this.ensureChild('on-demand');
        }
        throw error;
      }
    }
    if (this.active.size > 0) {
      throw new Error('An earlier initial-context inventory worker has not been confirmed stopped.');
    }

    const starting = this.startChild(purpose);
    this.starting = starting;
    this.startingPurpose = purpose;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) {
        this.starting = undefined;
        this.startingPurpose = undefined;
      }
    }
  }

  private async startChild(purpose: ActiveChild['purpose']): Promise<ActiveChild> {
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const metrics: StartupMetrics = {};
    const spawnStartedAt = performance.now();
    let child: ChildProcess;
    try {
      child = spawnProcess(this.options.nodePath ?? process.execPath, [this.options.entryPath], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        env: buildInitialContextInventoryEnv(),
        cwd: process.cwd(),
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } finally {
      metrics.spawnDurationMs = elapsedMs(spawnStartedAt);
    }
    const outbound = child.stdio[IPC_WRITE_FD] as Writable | null;
    const inbound = child.stdio[IPC_READ_FD] as Readable | null;
    if (!child.pid || !outbound || !inbound) {
      child.kill();
      throw new Error('Initial-context inventory worker did not expose bounded IPC descriptors.');
    }
    const active: ActiveChild = {
      child,
      outbound,
      inbound,
      state: 'starting',
      purpose,
      spawnDurationMs: metrics.spawnDurationMs,
    };
    this.active.add(active);
    this.current = active;
    this.attachDiagnostics(child);
    child.on('error', (error) => {
      active.spawnError ??= error;
      this.retireIdleChild(active);
    });
    child.on('exit', () => this.retireIdleChild(active));

    try {
      const guardianStartedAt = performance.now();
      const startupCancelled = new Promise<never>((_resolve, reject) => {
        active.cancelStartup = () => reject(new Error('Initial-context inventory client was disposed during worker startup.'));
      });
      const guardianPromise = Promise.resolve().then(() => (
        this.options.establishGuardian ?? establishWindowsProcessTreeGuardian
      )(child.pid!, Math.min(this.startupTimeoutMs, 10_000)));
      void guardianPromise.then((guardian) => {
        active.cancelStartup = undefined;
        if (!guardian) return;
        active.guardian = guardian;
        if (active.cleanupStarted) this.cleanupLateGuardian(active, guardian);
      }, () => {
        active.cancelStartup = undefined;
      });
      try {
        active.guardian = await Promise.race([guardianPromise, startupCancelled]);
        if (this.disposed) throw new Error('Initial-context inventory client was disposed during worker startup.');
      } finally {
        active.cancelStartup = undefined;
        metrics.guardianDurationMs = elapsedMs(guardianStartedAt);
        active.guardianDurationMs = metrics.guardianDurationMs;
      }

      const ready = this.readReady(active);
      const initialization: InitialContextEstimateWorkerInitialization = {
        protocolVersion: INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION,
        kind: 'initialize',
        sdkPath: this.options.sdkPath,
        sdkRuntime: this.sdkRuntime,
        parentPid: process.pid,
      };
      const wire = `${JSON.stringify(initialization)}\n`;
      if (Buffer.byteLength(wire, 'utf8') > MAX_FRAME_BYTES) {
        throw new Error('Initial-context inventory initialization exceeded its frame limit.');
      }
      await writeFrame(outbound, wire);
      const response = await withTimeout(ready, this.startupTimeoutMs, 'Initial-context inventory SDK preload timed out.');
      active.preloadDurationMs = response.timings?.sdkImportDurationMs;
      active.state = 'idle';
      if (this.disposed) throw new Error('Initial-context inventory client was disposed during SDK preload.');
      return active;
    } catch (error) {
      active.state = 'cleaning';
      try {
        await this.cleanup(active);
        this.active.delete(active);
        if (this.current === active) this.current = undefined;
      } catch {
        // Keep the unconfirmed child tracked to prevent a duplicate process.
      }
      throw error;
    }
  }

  private scheduleIdleDisposal(active: ActiveChild): void {
    clearTimeout(active.idleTimer);
    active.idleTimer = setTimeout(() => this.retireIdleChild(active), this.idleTimeoutMs);
    active.idleTimer.unref?.();
  }

  private retireIdleChild(active: ActiveChild): void {
    if (this.current !== active || active.state !== 'idle') return;
    clearTimeout(active.idleTimer);
    active.state = 'cleaning';
    void this.cleanup(active).then(() => {
      this.active.delete(active);
      if (this.current === active) this.current = undefined;
    }).catch((error) => {
      this.recordDiagnostic(`idle worker cleanup failed: ${toErrorMessage(error)}`);
    });
  }

  private startupTiming(active: ActiveChild): Pick<StartupMetrics, 'spawnDurationMs' | 'guardianDurationMs' | 'preloadDurationMs'> {
    return {
      ...(active.spawnDurationMs !== undefined ? { spawnDurationMs: active.spawnDurationMs } : {}),
      ...(active.guardianDurationMs !== undefined ? { guardianDurationMs: active.guardianDurationMs } : {}),
      ...(active.preloadDurationMs !== undefined ? { preloadDurationMs: active.preloadDurationMs } : {}),
    };
  }

  private readReady(active: ActiveChild): Promise<InitialContextEstimateWorkerReady> {
    return this.readFrame(active.inbound, active, isReady, 'Initial-context inventory worker did not complete SDK preload.');
  }

  private readResponse(active: ActiveChild): Promise<InitialContextEstimateWorkerOutput> {
    return this.readFrame(active.inbound, active, isOutput, 'Initial-context inventory worker exited before responding.');
  }

  private readFrame<T>(
    inbound: Readable,
    active: ActiveChild,
    validate: (value: unknown) => value is T,
    exitMessage: string,
  ): Promise<T> {
    const { child } = active;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, value?: T) => {
        if (settled) return;
        settled = true;
        detach();
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error); else resolve(value!);
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(`${exitMessage} (${code ?? signal ?? 'unknown'}).`));
      };
      if (active.spawnError) {
        reject(active.spawnError);
        return;
      }
      if (hasExited(child)) {
        reject(new Error(`${exitMessage} (process already exited).`));
        return;
      }
      const detach = attachJsonlLineReader(inbound, (line) => {
        try {
          const value: unknown = JSON.parse(line);
          if (!validate(value)) throw new Error('Initial-context inventory worker returned an invalid protocol frame.');
          finish(undefined, value);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }, {
        maxLineBytes: MAX_FRAME_BYTES - 1,
        emitTrailingLineOnEnd: false,
        onOverflow: () => finish(new Error('Initial-context inventory response exceeded its frame limit.')),
        onIncomplete: () => finish(new Error('Initial-context inventory response ended mid-frame.')),
      });
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }

  private attachDiagnostics(child: ChildProcess): void {
    let diagnosticBytes = 0;
    const attach = (stream: Readable | null) => stream?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      const remaining = Math.max(0, (64 * 1024) - diagnosticBytes);
      if (remaining === 0) return;
      const bounded = bytes.subarray(0, remaining);
      diagnosticBytes += bounded.byteLength;
      this.recordDiagnostic(bounded.toString('utf8'));
    });
    attach(child.stdout);
    attach(child.stderr);
  }

  private recordDiagnostic(chunk: string): void {
    try {
      this.options.onDiagnostic?.(chunk);
    } catch {
      // Diagnostics cannot change process lifecycle.
    }
  }

  private recordTiming(sample: InitialContextEstimateTimingSample): void {
    try {
      this.options.onTiming?.(sample);
    } catch {
      // Diagnostics must not change discovery or child cleanup behavior.
    }
  }

  private async cleanup(active: ActiveChild): Promise<void> {
    active.cleanupStarted = true;
    if (active.cleanupPromise) return await active.cleanupPromise;
    const attempt = this.cleanupChild(active);
    active.cleanupPromise = attempt;
    void attempt.catch(() => {
      if (active.cleanupPromise === attempt) active.cleanupPromise = undefined;
    });
    return await attempt;
  }

  private async cleanupChild(active: ActiveChild): Promise<void> {
    clearTimeout(active.idleTimer);
    active.state = 'cleaning';
    const pid = active.child.pid;
    active.child.stdio[IPC_READ_FD]?.destroy();
    active.child.stdio[IPC_WRITE_FD]?.destroy();
    active.child.stdout?.destroy();
    active.child.stderr?.destroy();
    let guardianError: unknown;
    if (active.guardian) {
      try {
        await this.terminateGuardian(active.guardian, active);
        return;
      } catch (error) {
        guardianError = error;
      }
    }
    try {
      if (pid) {
        await (this.options.terminateTree ?? terminateProcessTree)(pid, {
          confirmationTimeoutMs: this.cleanupTimeoutMs,
        });
      } else {
        active.child.kill();
      }
    } catch (fallbackError) {
      if (guardianError !== undefined) {
        throw new AggregateError(
          [guardianError, fallbackError],
          'Initial-context inventory guardian and process-tree cleanup failed.',
        );
      }
      throw fallbackError;
    }
    if (guardianError !== undefined) throw guardianError;
  }

  private terminateGuardian(guardian: WindowsProcessTreeGuardian, active: ActiveChild): Promise<void> {
    if (active.guardianTerminationPromise) return active.guardianTerminationPromise;
    const attempt = Promise.resolve().then(() => guardian.terminate());
    active.guardianTerminationPromise = attempt;
    void attempt.catch(() => {
      if (active.guardianTerminationPromise === attempt) active.guardianTerminationPromise = undefined;
    });
    return attempt;
  }

  private cleanupLateGuardian(active: ActiveChild, guardian: WindowsProcessTreeGuardian): Promise<void> {
    if (active.lateGuardianCleanupPromise) return active.lateGuardianCleanupPromise;
    const wasTracked = this.active.has(active);
    this.active.add(active);
    if (this.current === undefined) this.current = active;
    if (!wasTracked) {
      if (this.disposeInProgress) this.disposeRetryRequired = true;
      else this.disposePromise = undefined;
    }
    const attempt = (async () => {
      await active.cleanupPromise?.catch(() => undefined);
      await this.terminateGuardian(guardian, active);
      this.active.delete(active);
      if (this.current === active) this.current = undefined;
    })();
    active.lateGuardianCleanupPromise = attempt;
    void attempt.catch((error) => {
      if (active.lateGuardianCleanupPromise === attempt) active.lateGuardianCleanupPromise = undefined;
      this.active.add(active);
      if (this.current === undefined) this.current = active;
      if (this.disposeInProgress) this.disposeRetryRequired = true;
      else this.disposePromise = undefined;
      this.recordDiagnostic(`late guardian cleanup failed: ${toErrorMessage(error)}`);
    });
    return attempt;
  }
}

function isReady(value: unknown): value is InitialContextEstimateWorkerReady {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame.protocolVersion === INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION
    && frame.kind === 'ready'
    && (frame.timings === undefined || isWorkerTimings(frame.timings));
}

function isOutput(value: unknown): value is InitialContextEstimateWorkerOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  if (output.protocolVersion !== INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION
    || output.kind !== 'result'
    || (output.timings !== undefined && !isWorkerTimings(output.timings))) return false;
  if (output.ok === false) return typeof output.error === 'string';
  if (output.ok !== true || !output.inventory || typeof output.inventory !== 'object' || Array.isArray(output.inventory)) return false;
  const inventory = output.inventory as Record<string, unknown>;
  const estimate = inventory.estimate as Record<string, unknown> | undefined;
  return !!estimate
    && Number.isSafeInteger(estimate.tokens) && (estimate.tokens as number) >= 0
    && Number.isSafeInteger(estimate.contextWindow) && (estimate.contextWindow as number) > 0
    && Array.isArray(inventory.systemPrompts)
    && inventory.systemPrompts.every(isSystemPromptEntry);
}

function isWorkerTimings(value: unknown): value is InitialContextEstimateWorkerTimings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowedKeys = new Set<keyof InitialContextEstimateWorkerTimings>([
    'sdkImportDurationMs',
    'resourceDiscoveryDurationMs',
    'promptAndEstimateDurationMs',
  ]);
  return Object.entries(value).every(([key, duration]) => (
    allowedKeys.has(key as keyof InitialContextEstimateWorkerTimings)
    && typeof duration === 'number'
    && Number.isFinite(duration)
    && duration >= 0
  ));
}

function isSystemPromptEntry(value: unknown): value is SystemPromptEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (entry.source === 'provider' || entry.source === 'harness' || entry.source === 'user')
    && typeof entry.title === 'string'
    && typeof entry.text === 'string'
    && typeof entry.summary === 'string'
    && (entry.availability === 'available' || entry.availability === 'missing'
      || entry.availability === 'hidden' || entry.availability === 'unknown')
    && (entry.tooltip === undefined || typeof entry.tooltip === 'string')
    && (entry.id === undefined || typeof entry.id === 'string')
    && (entry.disabled === undefined || typeof entry.disabled === 'boolean')
    && (entry.toggleable === undefined || typeof entry.toggleable === 'boolean');
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function writeFrame(stream: Writable, wire: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(wire, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

async function endWithFrame(stream: Writable, wire: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.end(wire, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
