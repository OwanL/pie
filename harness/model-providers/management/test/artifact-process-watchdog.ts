import type { ChildProcess, SpawnOptions } from 'node:child_process';
// @ts-expect-error The shared watchdog is JavaScript-only; keep its test-facing contract at this boundary.
import { watchChildProcess as watchUntyped, withProcessTreeIsolation as isolateUntyped } from '../../../../scripts/lib/process-watchdog.mjs';

interface ProcessTreeCleanup {
  gone: boolean;
  survivors: number[];
  diagnostics?: string[];
}

interface ProcessWatchdog {
  readonly timedOut: boolean;
  readonly aborted: boolean;
  settle(): Promise<ProcessTreeCleanup>;
}

// These aliases call the actual shared keeper without changing its ownership or cleanup behavior.
export const watchChildProcess: (
  child: ChildProcess,
  options: { timeoutMs: number; label: string },
) => ProcessWatchdog = watchUntyped;
export const withProcessTreeIsolation: <T extends SpawnOptions>(options: T) => Omit<T, 'detached'> & { detached: boolean } = isolateUntyped;
