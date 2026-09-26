/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useRef } from 'preact/hooks';

import { AGENT_ACTIVITY_LABELS, type TurnActivityState } from './activity';
import { TurnActivityBlock } from './turn-activity-tail';
import {
  TurnActivityStrip,
  activityPhaseHasRunningDot,
  activityToneToStripTone,
  type TurnActivityPhase,
} from './turn-activity-strip';

export interface TurnActivityRegionProps {
  /** Current turn activity state. May be null (e.g. the typing indicator before
   *  any phase is known) — the strip then falls back to the "preparing" label. */
  state: TurnActivityState | null;
  /** Render the strip with standalone spacing (typing-indicator row). When
   *  standalone, the strip's `detail` is suppressed to match the prior
   *  typing-indicator behaviour. */
  standalone?: boolean;
}

/**
 * Animated swap between the compact activity strip and the live tail block.
 *
 * Both live in single-track grid regions (`1fr` visible / `0fr` collapsed) that
 * cross-fade and height-animate in opposite directions, mirroring the bash
 * tool-call body open/close: when a tail arrives the block expands while the
 * strip collapses, and vice-versa when it leaves. Because the two tracks are
 * anti-correlated siblings, the container's height glides between the strip's
 * and the block's natural height instead of jumping — so the transcript no
 * longer snaps when the preview opens or closes.
 *
 * No JS mount/unmount choreography is needed: the block track stays mounted
 * (collapsed to `0fr`) and simply toggles `data-open`, so the grid transition
 * animates both directions. To animate the *close*, the last tail-bearing
 * state is cached so the block still has content to collapse after the live
 * tail has gone — otherwise the body would vanish in a single frame. The
 * collapsed track is `aria-hidden` so only the visible phase is announced.
 */
export function TurnActivityRegion({ state, standalone }: TurnActivityRegionProps) {
  const hasTail = Boolean(state?.tail);

  // Cache the most recent tail-bearing state so the block has something to
  // collapse (animate closed) once the live tail disappears. Mutated in render:
  // a plain ref used as a "latest value" memo, safe here because it only ever
  // lags the current state by one snapshot and is idempotent.
  const lastTailStateRef = useRef<TurnActivityState | null>(null);
  if (state && state.tail) lastTailStateRef.current = state;
  const blockState = state && state.tail ? state : lastTailStateRef.current;
  const blockContent = blockState && blockState.tail ? blockState : null;

  const phase = (state?.phase as TurnActivityPhase | undefined) ?? 'preparing';
  const label = state?.label ?? AGENT_ACTIVITY_LABELS.preparing;
  const ariaLabel = state?.ariaLabel ?? 'Agent is preparing response';

  return (
    <div class="turn-activity-region">
      <div class="turn-activity-track" data-open={!hasTail ? 'true' : 'false'}>
        <div class="turn-activity-track-inner" aria-hidden={!hasTail ? undefined : 'true'}>
          <TurnActivityStrip
            label={label}
            detail={standalone ? undefined : state?.detail}
            tone={activityToneToStripTone(state?.tone ?? 'neutral')}
            runningDot={activityPhaseHasRunningDot(phase)}
            phase={phase}
            standalone={standalone}
            ariaLabel={ariaLabel}
          />
        </div>
      </div>
      <div class="turn-activity-track" data-open={hasTail ? 'true' : 'false'}>
        <div class="turn-activity-track-inner" aria-hidden={hasTail ? undefined : 'true'}>
          {blockContent && <TurnActivityBlock state={blockContent} />}
        </div>
      </div>
    </div>
  );
}
