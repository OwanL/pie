const MESSAGE_JUMP_SETTLE_MINIMUM_MS = 1_500;
const MESSAGE_JUMP_SETTLE_SAFETY_TIMEOUT_MS = 2_500;
const MESSAGE_JUMP_STABLE_FRAMES_REQUIRED = 2;
const MESSAGE_JUMP_EPSILON_PX = 1;

interface MessageRailJumpControllerOptions {
  element: HTMLDivElement;
  getRowStart: (rowIndex: number) => number | null;
  navigationActiveRef: { current: boolean };
  programmaticScrollTargetRef: { current: number | null };
  setAutoFollow: (value: boolean) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (frame: number) => void;
  now?: () => number;
  minimumMs?: number;
  safetyTimeoutMs?: number;
}

export interface MessageRailJumpController {
  jumpTo: (rowIndex: number) => void;
  cancel: () => void;
  dispose: () => void;
}

/**
 * Owns a bounded, cancelable jump to one virtual transcript row.
 *
 * TanStack's `scrollToIndex` keeps a private reconciliation loop alive while
 * estimates are replaced by measured sizes. That loop has no public cancel
 * operation, so a wheel or native-thumb movement during reconciliation can be
 * overwritten on the next frame. This controller performs the same bounded
 * re-targeting from the live measurement cache, while the shared navigation
 * ref lets manual input cancel ownership synchronously.
 */
export function createMessageRailJumpController({
  element,
  getRowStart,
  navigationActiveRef,
  programmaticScrollTargetRef,
  setAutoFollow,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (frame) => cancelAnimationFrame(frame),
  now = () => performance.now(),
  minimumMs = MESSAGE_JUMP_SETTLE_MINIMUM_MS,
  safetyTimeoutMs = MESSAGE_JUMP_SETTLE_SAFETY_TIMEOUT_MS,
}: MessageRailJumpControllerOptions): MessageRailJumpController {
  let frame: number | null = null;
  let rowIndex: number | null = null;
  let startedAt = 0;
  let previousTarget = Number.NaN;
  let stableFrames = 0;

  const stopFrame = () => {
    if (frame === null) return;
    cancelFrame(frame);
    frame = null;
  };

  const finish = () => {
    stopFrame();
    rowIndex = null;
    navigationActiveRef.current = false;
  };

  const align = (): boolean => {
    if (rowIndex === null) return false;
    const rowStart = getRowStart(rowIndex);
    if (rowStart === null || !Number.isFinite(rowStart)) {
      stableFrames = 0;
      return false;
    }
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const target = Math.max(0, Math.min(rowStart, maxScrollTop));
    const targetChanged = Math.abs(target - previousTarget) > MESSAGE_JUMP_EPSILON_PX;
    const before = element.scrollTop;
    if (Math.abs(before - target) > MESSAGE_JUMP_EPSILON_PX) {
      const priorBehavior = element.style.scrollBehavior;
      try {
        element.style.scrollBehavior = 'auto';
        element.scrollTop = target;
      } finally {
        element.style.scrollBehavior = priorBehavior;
      }
      programmaticScrollTargetRef.current = element.scrollTop === before ? null : element.scrollTop;
    }
    const aligned = Math.abs(element.scrollTop - target) <= MESSAGE_JUMP_EPSILON_PX;
    stableFrames = aligned && !targetChanged ? stableFrames + 1 : 0;
    previousTarget = target;
    return aligned;
  };

  const schedule = () => {
    if (frame !== null) return;
    frame = requestFrame(() => {
      frame = null;
      if (!navigationActiveRef.current || rowIndex === null) {
        finish();
        return;
      }
      align();
      const elapsed = now() - startedAt;
      if (
        (elapsed >= minimumMs && stableFrames >= MESSAGE_JUMP_STABLE_FRAMES_REQUIRED)
        || elapsed >= safetyTimeoutMs
      ) {
        finish();
        return;
      }
      schedule();
    });
  };

  const jumpTo = (nextRowIndex: number) => {
    stopFrame();
    rowIndex = nextRowIndex;
    startedAt = now();
    previousTarget = Number.NaN;
    stableFrames = 0;
    setAutoFollow(false);
    navigationActiveRef.current = true;
    align();
    schedule();
  };

  return {
    jumpTo,
    cancel: finish,
    dispose: finish,
  };
}
