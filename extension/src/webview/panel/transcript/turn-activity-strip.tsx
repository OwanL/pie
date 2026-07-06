/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../utils/cx';

export type TurnActivityStripTone = 'neutral' | 'accent' | 'warning' | 'error' | 'success';

export type TurnActivityPhase =
  | 'streaming'
  | 'thinking'
  | 'runningTool'
  | 'preparing'
  | 'pruning'
  | 'startingModel'
  | 'waitingForSlot';

export interface TurnActivityStripProps {
  label: string;
  detail?: string;
  tone?: TurnActivityStripTone;
  runningDot?: boolean;
  standalone?: boolean;
  phase?: TurnActivityPhase;
  ariaLabel?: string;
}

export function activityToneToStripTone(
  tone: 'neutral' | 'active' | 'processing',
): TurnActivityStripTone {
  switch (tone) {
    case 'active':
      return 'accent';
    case 'processing':
      return 'warning';
    case 'neutral':
    default:
      return 'neutral';
  }
}

export function activityPhaseHasRunningDot(phase: TurnActivityPhase): boolean {
  return phase === 'streaming'
    || phase === 'thinking'
    || phase === 'runningTool'
    || phase === 'startingModel';
}

function defaultAriaLabel(label: string, detail?: string): string {
  return detail ? `Activity status: ${label}, ${detail}` : `Activity status: ${label}`;
}

export function TurnActivityStrip({
  label,
  detail,
  tone = 'neutral',
  runningDot = false,
  standalone = false,
  phase = 'preparing',
  ariaLabel,
}: TurnActivityStripProps) {
  return (
    <div
      class={cx(
        'turn-activity-strip',
        tone !== 'neutral' && tone,
        runningDot && 'running',
        standalone && 'standalone',
      )}
      data-phase={phase}
      role="status"
      aria-label={ariaLabel ?? defaultAriaLabel(label, detail)}
    >
      <span class="turn-activity-strip-label">
        {label}
        <span class={cx('turn-activity-strip-dot', runningDot && 'running', 'turn-activity-strip-ellipsis')} aria-hidden="true">
          {runningDot && <><span>.</span><span>.</span><span>.</span></>}
        </span>
      </span>
      {detail && <span class="turn-activity-strip-detail">{detail}</span>}
    </div>
  );
}
