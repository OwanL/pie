import { h, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { WorkingTimeState } from '../../../shared/protocol';
import { WorkingTimeTooltip } from './working-time-tooltip';

export interface WorkingTimeIndicatorState {
  label: string | null;
  ariaLabel: string;
  tooltip: string;
  tooltipNode?: ComponentChildren;
}

export function useWorkingTimeIndicator({
  sessionPath,
  workingTimeBySession,
}: {
  sessionPath: string | null;
  workingTimeBySession: Record<string, WorkingTimeState>;
}): WorkingTimeIndicatorState {
  const state = sessionPath ? workingTimeBySession[sessionPath] : undefined;
  const activeSince = state?.activeSince ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (activeSince === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeSince]);

  if (!sessionPath) {
    return { label: null, ariaLabel: 'Agent working time unavailable', tooltip: '' };
  }

  const elapsedMs = Math.max(0, state?.accumulatedMs ?? 0)
    + (activeSince === null ? 0 : Math.max(0, now - activeSince));
  const label = formatWorkingTime(elapsedMs);
  const spoken = formatWorkingTimeLong(elapsedMs);
  return {
    label,
    ariaLabel: `Total agent working time: ${spoken}`,
    tooltip: `Total agent working time: ${spoken}. Includes model and provider waits, retries, history compaction, and tool execution. Excludes idle time waiting for you between runs.`,
    tooltipNode: h(WorkingTimeTooltip, { state, elapsedMs }),
  };
}

/** Compact duration for the bottom-right toolbar chip. */
export function formatWorkingTime(durationMs: number): string {
  const totalSeconds = finiteSeconds(durationMs);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours === 0) return `${minutes}m ${seconds}s`;
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  if (days === 0) return `${hours}h ${minutes}m`;
  return `${days}d ${hours}h`;
}

function formatWorkingTimeLong(durationMs: number): string {
  const totalSeconds = finiteSeconds(durationMs);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  return parts.join(', ');
}

function finiteSeconds(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0
    ? Math.floor(durationMs / 1000)
    : 0;
}
