import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { attachJsonlLineReader } from '../shared/jsonl';
import type { InitialContextEstimate } from '../shared/protocol';
import {
  establishWindowsProcessTreeGuardian,
  terminateProcessTree,
  type WindowsProcessTreeGuardian,
} from './process-tree';
import type { SdkPatchIdentity } from './sdk-patch-barrier';
import type {
  InitialContextEstimateWorkerInput,
  InitialContextEstimateWorkerOutput,
} from './initial-context-estimate-worker';

const IPC_READ_FD = 3;
const IPC_WRITE_FD = 4;
const MAX_FRAME_BYTES = 256 * 1024;

export interface InitialContextEstimateClientOptions {
  entryPath: string;
  sdkPath: string;
  sdkPatchIdentity: SdkPatchIdentity;
  nodePath?: string;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  spawnProcess?: typeof spawn;
  establishGuardian?: typeof establishWindowsProcessTreeGuardian;
  terminateTree?: typeof terminateProcessTree;
  onDiagnostic?: (chunk: string) => void;
}

interface ActiveChild {
  child: ChildProcess;
  guardian?: WindowsProcessTreeGuardian;
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

/** One-shot temporary inventory worker. Every call spawns a fresh process;
 * there is deliberately no runtime/resource cache or root-session promotion. */
export class InitialContextEstimateClient {
  private readonly timeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly active = new Set<ActiveChild>();
  private disposed = false;

  constructor(private readonly options: InitialContextEstimateClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0
      || !Number.isSafeInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs <= 0) {
      throw new Error('Initial-context inventory timeouts must be positive safe integers.');
    }
  }

  async estimate(input: {
    cwd: string;
    agentDir: string;
    model: { provider: string; id: string };
  }): Promise<InitialContextEstimate | undefined> {
    if (this.disposed) return undefined;
    let active: ActiveChild | undefined;
    try {
      const spawnProcess = this.options.spawnProcess ?? spawn;
      const child = spawnProcess(this.options.nodePath ?? process.execPath, [this.options.entryPath], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        env: buildInitialContextInventoryEnv(),
        cwd: input.cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      active = { child };
      this.active.add(active);
      const outbound = child.stdio[IPC_READ_FD] as Writable | null;
      const inbound = child.stdio[IPC_WRITE_FD] as Readable | null;
      if (!child.pid || !outbound || !inbound) throw new Error('Initial-context inventory worker did not expose bounded IPC descriptors.');

      active.guardian = await (this.options.establishGuardian ?? establishWindowsProcessTreeGuardian)(
        child.pid,
        Math.min(this.timeoutMs, 10_000),
      );
      this.attachDiagnostics(child);

      const response = this.readResponse(inbound, child);
      const request: InitialContextEstimateWorkerInput = {
        sdkPath: this.options.sdkPath,
        sdkPatchIdentity: this.options.sdkPatchIdentity,
        cwd: input.cwd,
        agentDir: input.agentDir,
        parentPid: process.pid,
        model: input.model,
      };
      const wire = `${JSON.stringify(request)}\n`;
      if (Buffer.byteLength(wire, 'utf8') > MAX_FRAME_BYTES) throw new Error('Initial-context inventory request exceeded its frame limit.');
      outbound.end(wire);

      const output = await withTimeout(response, this.timeoutMs, 'Initial-context inventory worker timed out.');
      return output.ok ? output.estimate : undefined;
    } catch {
      return undefined;
    } finally {
      if (active) {
        try {
          await this.cleanup(active);
          this.active.delete(active);
        } catch {
          // Keep failed cleanup tracked so backend disposal can attempt every
          // termination path again instead of silently orphaning the child.
        }
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed && this.active.size === 0) return;
    this.disposed = true;
    const failures: unknown[] = [];
    await Promise.all([...this.active].map(async (active) => {
      try {
        await this.cleanup(active);
        this.active.delete(active);
      } catch (error) {
        failures.push(error);
      }
    }));
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Initial-context inventory cleanup failed.');
    }
  }

  private readResponse(inbound: Readable, child: ChildProcess): Promise<InitialContextEstimateWorkerOutput> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, value?: InitialContextEstimateWorkerOutput) => {
        if (settled) return;
        settled = true;
        detach();
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error); else resolve(value!);
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(`Initial-context inventory worker exited before responding (${code ?? signal ?? 'unknown'}).`));
      };
      const detach = attachJsonlLineReader(inbound, (line) => {
        try {
          const value: unknown = JSON.parse(line);
          if (!isOutput(value)) throw new Error('Initial-context inventory worker returned an invalid response.');
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
      this.options.onDiagnostic?.(bounded.toString('utf8'));
    });
    attach(child.stdout);
    attach(child.stderr);
  }

  private async cleanup(active: ActiveChild): Promise<void> {
    const pid = active.child.pid;
    active.child.stdio[IPC_READ_FD]?.destroy();
    active.child.stdio[IPC_WRITE_FD]?.destroy();
    active.child.stdout?.destroy();
    active.child.stderr?.destroy();
    let guardianError: unknown;
    if (active.guardian) {
      try {
        await active.guardian.terminate();
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
    // The worker tree is gone, but the guardian itself may still be alive.
    // Retain this record so disposal retries guardian termination rather than
    // silently orphaning its process after a timeout/error.
    if (guardianError !== undefined) throw guardianError;
  }
}

function isOutput(value: unknown): value is InitialContextEstimateWorkerOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  if (output.ok === false) return typeof output.error === 'string';
  if (output.ok !== true || !output.estimate || typeof output.estimate !== 'object' || Array.isArray(output.estimate)) return false;
  const estimate = output.estimate as Record<string, unknown>;
  return Number.isSafeInteger(estimate.tokens) && (estimate.tokens as number) >= 0
    && Number.isSafeInteger(estimate.contextWindow) && (estimate.contextWindow as number) > 0;
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
