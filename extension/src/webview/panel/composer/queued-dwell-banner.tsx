/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { QueuedDwellEntry, WebviewToHostMessage } from '../../../shared/protocol';

export interface QueuedDwellBannerProps {
  queuedDwell: QueuedDwellEntry[];
  sessionPath: string | null;
  onInterrupt: () => void;
  onClearQueue: () => void;
  postMessage: (msg: WebviewToHostMessage) => void;
  now?: number;
}

function formatWait(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function QueuedDwellBanner({
  queuedDwell,
  sessionPath,
  onInterrupt,
  onClearQueue,
  postMessage,
  now = Date.now(),
}: QueuedDwellBannerProps) {
  const fired = queuedDwell.filter((entry) => entry.watchdogFired && !entry.abandoned);
  if (!sessionPath || fired.length === 0) {
    return null;
  }

  return (
    <div
      class="flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-sm"
      role="alert"
      aria-live="polite"
      style={{
        borderColor: 'color-mix(in srgb, var(--panel-warning) 30%, transparent)',
        backgroundColor: 'color-mix(in srgb, var(--panel-warning) 10%, transparent)',
      }}
    >
      {fired.map((entry) => {
        const waitMs = now - entry.enqueuedAt;
        return (
          <div key={entry.localId} class="flex flex-wrap items-center gap-2">
            <span class="flex-1">
              Queued message has been waiting {formatWait(waitMs)}. The current turn may be stuck.
            </span>
            <div class="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                class="action-btn"
                onClick={onInterrupt}
                title="Stop the current turn"
              >
                Stop current turn
              </button>
              <button
                type="button"
                class="action-btn"
                onClick={() =>
                  postMessage({
                    type: 'rearmQueuedDwellWatchdog',
                    sessionPath,
                    localId: entry.localId,
                  })
                }
                title="Keep waiting and reset the dwell watchdog"
              >
                Keep waiting
              </button>
              <button
                type="button"
                class="action-btn"
                onClick={onClearQueue}
                title="Remove queued messages (does not stop the current turn)"
              >
                Remove queued
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
