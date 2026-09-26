import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Phase 6 two-hot-worker crash-matrix fixture.
 *
 * Every `before_agent_start` on the target cwd appends one durable custom
 * entry (write-ownership trace evidence), records this worker's PID, and
 * optionally spawns a long-lived descendant process and/or opens a pending
 * extension UI dialog that blocks the turn until the harness responds.
 * All behavior is env-gated; a fixture with no matrix env vars is inert.
 */
const targetCwd = process.env.PIE_P6_MATRIX_TARGET_CWD;
const pidMarker = process.env.PIE_P6_MATRIX_PID_MARKER;
const descendantMarker = process.env.PIE_P6_MATRIX_DESCENDANT_MARKER;
const uiDialogMarker = process.env.PIE_P6_MATRIX_UI_DIALOG_MARKER;
const uiResponseMarker = process.env.PIE_P6_MATRIX_UI_RESPONSE_MARKER;
const safetyDeadlineMs = Number(process.env.PIE_P6_MATRIX_DEADLINE_MS ?? 120_000);

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function writeMarker(filePath: string | undefined, value: unknown): void {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
  } catch {
    // Marker evidence is best-effort; never fail the agent turn for it.
  }
}

function spawnDescendant(): void {
  if (!descendantMarker) return;
  try {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 150000);'], {
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
    if (child.pid) {
      writeMarker(descendantMarker, { pid: child.pid, workerPid: process.pid, spawnedAt: Date.now() });
    }
  } catch {
    // Best-effort: the descendant is extra evidence, not a requirement.
  }
}

export default function phase6CrashMatrixExtension(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (_event: unknown, ctx: { cwd?: string; ui: { select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined> } }) => {
    if (!targetCwd || !samePath(ctx.cwd, targetCwd)) return;
    // Durable append before anything else: the write-ownership trace must show
    // this worker generation as the sole writer of the session up to the kill.
    try {
      pi.appendEntry('phase6-matrix-pid', { pid: process.pid });
    } catch {
      // The entry is evidence; if the append seam is unavailable the trace
      // simply has fewer records.
    }
    writeMarker(pidMarker, { pid: process.pid, enteredAt: Date.now() });
    spawnDescendant();
    // The harness creates the dialog marker before the first message and the
    // fixture deletes it after use, so only the FIRST turn opens a dialog.
    // The dialog is fire-and-forget: it stays pending (and the coordinator
    // records its owner) while the turn continues to the provider request,
    // which is what lets the crash matrix prove BOTH the pending-UI owner
    // gate and the provider lease release in one kill.
    if (uiDialogMarker && fs.existsSync(uiDialogMarker)) {
      try {
        fs.unlinkSync(uiDialogMarker);
      } catch {
        return;
      }
      void ctx.ui.select('Phase 6 crash matrix', ['option-a', 'option-b'], {
        timeout: Math.max(10_000, safetyDeadlineMs),
      }).then((value) => {
        writeMarker(uiResponseMarker, { value, resolvedAt: Date.now() });
      }).catch(() => {
        // The worker may be killed while the dialog is pending; the marker
        // staying absent is the terminal-evidence the harness asserts.
      });
    }
  });
}
