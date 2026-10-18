import type { Readable } from 'node:stream';

export interface WindowsOwnedTreeOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
  /** Cancellation applies to pending startup, not to the returned tree. */
  signal?: AbortSignal;
}

export interface WindowsOwnedTreeProof {
  readonly gone: true;
  readonly activeProcesses: 0;
  readonly invocationId: string;
  readonly rootPid: number;
  readonly admissionSealed: true;
  readonly authority: 'open-windows-job-accounting';
}

export interface WindowsOwnedTreeUnknown {
  gone: false;
  invocationId: string;
  rootPid: number;
  diagnostic: string;
  evidenceDirectory: string;
}

export interface WindowsOwnedTree {
  readonly invocationId: string;
  readonly rootPid: number;
  /** Diagnostic only. Never a lifetime or extinction authority. */
  readonly guardianPid: number;
  readonly evidenceDirectory: string;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Root completion only; null means supervision was lost. */
  readonly completion: Promise<{ code: number | null }>;
  authorizeStartup(text: string): Promise<void>;
  stopAndDrain(options?: { timeoutMs?: number }): Promise<WindowsOwnedTreeProof | WindowsOwnedTreeUnknown>;
  closeAfterRelease(): Promise<void>;
}

export function spawnWindowsOwnedTree(options: WindowsOwnedTreeOptions): Promise<WindowsOwnedTree>;
