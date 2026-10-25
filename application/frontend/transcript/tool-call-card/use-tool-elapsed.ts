import { useEffect, useState } from 'preact/hooks';
import type { ToolCall } from '../../../lib/protocol/index.js';

/** Presentation clock only; the host's start epoch owns execution timing. */
export function useToolElapsed(status: ToolCall['status'], startedAt?: number, durationMs?: number): number | null {
  const [now, setNow] = useState(Date.now);
  const running = status === 'running' && typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt >= 0;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  if (running) {
    const elapsed = now - startedAt!;
    return elapsed >= 10_000 ? elapsed : null;
  }
  return (status === 'completed' || status === 'failed') && typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 10_000 ? durationMs : null;
}
