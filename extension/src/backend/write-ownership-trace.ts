/**
 * Test-build append/truncate owner instrumentation.
 *
 * Every session append/truncate records `{sessionPath, ownerRole, workerId,
 * workerGeneration}` in test builds. The coordinator records cold writes
 * (ownerRole `coordinator`); the patched SDK session-manager seam records
 * every runtime append/truncate (ownerRole `worker` for leased workers,
 * `coordinator` when the legacy runtime writes without a lease adapter).
 *
 * Gated by PIE_WRITE_OWNERSHIP_TRACE_DIR: when unset, recording is a no-op
 * and production carries no instrumentation. Records are one JSON line per
 * file write, appended to `<dir>/write-ownership-<pid>.jsonl`, best-effort
 * (a failed record never fails the write it instruments).
 */
import * as fs from 'node:fs';

export interface WriteOwnershipRecord {
  event: 'pie.write-ownership';
  ts: number;
  pid: number;
  seam: string;
  sessionPath: string | null;
  ownerRole: 'worker' | 'coordinator';
  workerId?: string;
  workerGeneration?: number;
  coordinatorGeneration?: number;
}

let filePath: string | undefined;
let resolvedTraceDir: string | undefined;

/** Resolve the gate lazily so test builds can toggle the env var at runtime. */
export function isWriteOwnershipTraceEnabled(): boolean {
  resolvedTraceDir = process.env.PIE_WRITE_OWNERSHIP_TRACE_DIR?.trim();
  return resolvedTraceDir !== undefined && resolvedTraceDir.length > 0;
}

function resolveFilePath(): string | undefined {
  if (filePath && resolvedTraceDir === process.env.PIE_WRITE_OWNERSHIP_TRACE_DIR?.trim()) return filePath;
  filePath = undefined;
  if (!isWriteOwnershipTraceEnabled()) return undefined;
  filePath = `${resolvedTraceDir}/write-ownership-${process.pid}.jsonl`;
  try {
    fs.mkdirSync(resolvedTraceDir!, { recursive: true });
  } catch {
    return undefined;
  }
  return filePath;
}

/** Best-effort append of one ownership record. Never throws to the caller. */
export function recordWriteOwnership(record: WriteOwnershipRecord): void {
  const target = resolveFilePath();
  if (!target) return;
  try {
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Instrumentation is best-effort; the write it instruments already happened.
  }
}
