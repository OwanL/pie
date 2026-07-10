/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../../shared/protocol';
import { cx } from '../../utils/cx';
import { toMouseEvent } from '../../utils/preact-events';
import { getToolCallPresentation } from '../../tool-call-summary';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { CollapsibleCloseFooter } from '../../components/collapsible-close-footer';
import { CollapsibleGutter } from '../../components/collapsible-gutter';
import { textFromToolResult } from '../highlight';
import { useCollapsibleOpen } from '../use-collapsible-open';

import { formatToolCallResultForDisplay } from './format';
import { isCommandSummaryTool, buildToolCallHeaderSummaryModel } from './summary-model';
import { ToolCallBody } from './tool-call-body';
import { ToolCallHeader } from './tool-call-header';
import type { ToolResultPruningBadgeData } from '../tool-result-pruning-badge';
import {
  TOOL_CALL_CLOSE_GRACE_MS,
  TOOL_CALL_CLOSE_TRANSITION_MS,
  TOOL_CALL_COMPLETION_PULSE_MS,
  TOOL_CALL_EXPAND_MS,
} from './timing';

interface ToolCallCardProps {
  toolCall: ToolCall;
  autoExpand: boolean;
  className?: string;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
}

export function ToolCallCard({
  toolCall,
  autoExpand,
  className,
  workingDirectory,
  onOpenFile,
  onContextMenu,
}: ToolCallCardProps) {
  const [open, setOpen] = useCollapsibleOpen(`tool:${toolCall.id}`, autoExpand);
  const presentation = getToolCallPresentation(toolCall, { workingDirectory });
  const isShell = isCommandSummaryTool(toolCall.name);
  const isRunning = toolCall.status === 'running';

  // ── Post-completion grace + animated close (shell auto-show path only) ──
  // Shell tools auto-show their body while running. When a quick command
  // finishes in a split second the body used to snap-unmount in one frame
  // (a flash/flicker). Instead, after running→completed/failed we keep the
  // body expanded for a grace period so the user can read the output, then
  // animate it closed. This only applies to the AUTO-shown path — manual
  // opens are sticky and never auto-close.
  const [lingering, setLingering] = useState(false);
  const [closing, setClosing] = useState(false);
  // Brief highlight pulse on the card when a tool call completes (all tools).
  const [justCompleted, setJustCompleted] = useState(false);
  // One-shot expand animation (symmetric with the post-grace close). Applied
  // to the wrapper on the first render the AUTO-shown body appears.
  const [expand, setExpand] = useState(false);

  const prevRunningRef = useRef(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wall-clock completion time used to compute the remaining grace when the
  // close is scheduled (see effect below).
  const completedAtRef = useRef<number | null>(null);

  const renderBodyRef = useRef(false);
  // Stable id for the body region so the header can reference it via
  // `aria-controls` (only when the body is mounted — see renderBody).
  const bodyId = useId();

  // Refs mirror the latest open/lingering/closing so the status-transition
  // effect (keyed on toolCall.status) always reads current values without
  // re-subscribing on every toggle.
  const openRef = useRef(open);
  openRef.current = open;
  const lingeringRef = useRef(lingering);
  lingeringRef.current = lingering;
  const closingRef = useRef(closing);
  closingRef.current = closing;

  // Shell tools stream their output live — show the terminal pane while
  // running even when collapsed, so users can watch execution unfold. The
  // `lingering` term keeps it expanded during the post-completion grace.
  const showBody = open || (isShell && isRunning) || lingering;

  // Detect running→completed/failed to (a) flash a completion pulse for all
  // tool calls, and (b) enter the lingering state for the auto-shown shell
  // body. The actual close is scheduled/deferred below based on turn activity.
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    const nowRunning = toolCall.status === 'running';
    prevRunningRef.current = nowRunning;

    const justCompleted = wasRunning && !nowRunning;

    if (justCompleted) {
      // Completion pulse applies to every tool call (not just shell).
      if (toolCall.status === 'completed') {
        setJustCompleted(true);
        if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = setTimeout(() => {
          pulseTimerRef.current = null;
          setJustCompleted(false);
        }, TOOL_CALL_COMPLETION_PULSE_MS);
      }

      // Grace period only for the AUTO-shown shell body — never when the
      // user explicitly opened it (manual opens are sticky). Record the
      // completion time; the close itself is scheduled below.
      if (isShell && !openRef.current && !lingeringRef.current && !closingRef.current) {
        setLingering(true);
        completedAtRef.current = Date.now();
      }
    }

    // If the call returns to running, cancel any pending close so the
    // streaming body re-shows cleanly.
    if (!wasRunning && nowRunning) {
      setLingering(false);
      setClosing(false);
      completedAtRef.current = null;
      if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
      if (closeFallbackTimerRef.current) { clearTimeout(closeFallbackTimerRef.current); closeFallbackTimerRef.current = null; }
      return;
    }

    // Schedule the post-completion auto-close. The grace is measured from
    // completion so earlier commands close first. The close fires after the
    // grace regardless of turn activity (consecutive commands no longer stack
    // open panes mid-turn); only the currently-running or just-finished
    // (in-grace) pane stays open.
    const isLingering = justCompleted ? true : lingeringRef.current;
    const completedAt = completedAtRef.current;
    if (isLingering && !closingRef.current && !openRef.current && completedAt !== null) {
      const elapsed = Date.now() - completedAt;
      const remaining = Math.max(0, TOOL_CALL_CLOSE_GRACE_MS - elapsed);
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        setLingering(false);
        setClosing(true);
        // Fallback in case transitionend doesn't fire (e.g. the tab was
        // backgrounded). The body must unmount eventually.
        if (closeFallbackTimerRef.current) clearTimeout(closeFallbackTimerRef.current);
        closeFallbackTimerRef.current = setTimeout(() => {
          closeFallbackTimerRef.current = null;
          setClosing(false);
        }, TOOL_CALL_CLOSE_TRANSITION_MS + 60);
      }, remaining);
    }
  }, [toolCall.status, isShell]);

  // Cancel any pending auto-close when the user manually opens the body, so
  // an explicit expand is sticky.
  const cancelAutoClose = () => {
    if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
    if (closeFallbackTimerRef.current) { clearTimeout(closeFallbackTimerRef.current); closeFallbackTimerRef.current = null; }
    setLingering(false);
    setClosing(false);
  };

  // Clear all timers on unmount.
  useEffect(() => () => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    if (closeFallbackTimerRef.current) clearTimeout(closeFallbackTimerRef.current);
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
  }, []);

  const errorDetail = toolCall.status === 'failed'
    ? (textFromToolResult(toolCall.result) ?? formatToolCallResultForDisplay(toolCall)) || undefined
    : undefined;
  // Tool-result-pruner visibility marker: the extension merges
  // `pruningBadge` into `result.details` (rules that fired + tokens saved).
  // Surfaced in the header so it's visible even when the card is collapsed.
  const pruningBadge = (toolCall.result as { details?: { pruningBadge?: ToolResultPruningBadgeData } } | null | undefined)?.details?.pruningBadge;
  const summaryModel = buildToolCallHeaderSummaryModel(
    toolCall.name,
    presentation.summary,
    presentation.summaryPath,
    toolCall,
  );

  // Close the card via the animated `closing` path (shared by the manual
  // header/chevron toggle and the bottom `CollapsibleCloseFooter`). Routes
  // through the same grid-track collapse as the auto-close so manual close
  // is smooth instead of a snap. A fallback timer (mirroring the auto-close
  // path) unmounts the body if `transitionend` doesn't fire.
  const close = () => {
    cancelAutoClose();
    setClosing(true);
    setOpen(false);
    if (closeFallbackTimerRef.current) clearTimeout(closeFallbackTimerRef.current);
    closeFallbackTimerRef.current = setTimeout(() => {
      closeFallbackTimerRef.current = null;
      setClosing(false);
    }, TOOL_CALL_CLOSE_TRANSITION_MS + 60);
  };

  const toggleOpen = () => {
    const opening = !openRef.current;
    if (opening) {
      setOpen(true);
      cancelAutoClose();
    } else {
      close();
    }
  };

  const renderBody = showBody || closing;
  // The header summary tracks `showBody` (not `renderBody`): suppressed while
  // the terminal is running/lingering, then revealed the instant the body
  // begins closing so the command hands off into the header instead of
  // popping in after the body unmounts — eliminating the swap twitch.

  // One-shot expand animation for the AUTO-shown body (symmetric with the
  // post-grace close). When the body first appears while the card is
  // collapsed (!open — i.e. the auto-show path, not a manual open), apply the
  // `data-expand` flag so the wrapper's @keyframes opacity fade-in runs. The
  // fade is opacity-only (no grid track animation) so it doesn't fight the
  // per-delta height growth while output streams. Cleared on animationend (or
  // a fallback timer if the event is missed).
  useEffect(() => {
    const wasRendered = renderBodyRef.current;
    renderBodyRef.current = renderBody;
    if (renderBody && !wasRendered && !openRef.current) {
      setExpand(true);
      if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
      expandTimerRef.current = setTimeout(() => {
        expandTimerRef.current = null;
        setExpand(false);
      }, TOOL_CALL_EXPAND_MS + 60);
    }
  }, [renderBody]);

  return (
    <div
      class={cx(
        // `overflow-clip` (not `hidden`): clips children to the rounded card
        // corners identically without establishing a scroll container. (The
        // header is no longer sticky, so this no longer exists to free a
        // sticky header — it just keeps the corners clipped cleanly.)
        'overflow-clip rounded-xl border-l-2 border-l-transparent bg-card shadow-sm transition-all duration-150 hover:bg-control-hover hover:shadow-md',
        // Stable hook so the header can mirror the card's hover state
        // (see `.tool-call-card:hover .tool-call-header` in tool-call.css) —
        // without it the opaque header would keep `bg-card` while the card
        // body lifts to `bg-control-hover`, leaving a darker strip at the top.
        'tool-call-card',
        'forced-colors:border forced-colors:border-[ButtonText]',
        toolCall.status === 'failed' && 'border-l-danger/50',
        toolCall.status === 'completed' && 'border-l-success/60',
        justCompleted && 'tool-call-just-completed',
        presentation.variant === 'skill-load' && 'bg-accent/5 skill-load-glow',
        className,
      )}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(toMouseEvent(e)); }}
    >
      <ToolCallHeader
        open={open}
        bodyVisible={isShell && showBody}
        name={presentation.name}
        status={toolCall.status}
        summary={presentation.summary}
        summaryPath={presentation.summaryPath}
        summaryModel={summaryModel ?? undefined}
        sizeHint={presentation.sizeHint}
        errorDetail={errorDetail}
        pruningBadge={pruningBadge}
        durationMs={toolCall.durationMs}
        ariaControls={renderBody ? bodyId : undefined}
        onOpenFile={onOpenFile}
        onToggle={toggleOpen}
      />
      {renderBody && (
        <div
          id={bodyId}
          class="tool-call-body-wrap"
          data-streaming={isRunning ? 'true' : undefined}
          data-expand={expand ? 'true' : undefined}
          data-closing={!showBody && closing ? 'true' : undefined}
          onTransitionEnd={(e) => {
            // Only react to transitions on the wrapper itself, not children.
            if (e.target !== e.currentTarget) return;
            if (closing && !showBody) {
              if (closeFallbackTimerRef.current) { clearTimeout(closeFallbackTimerRef.current); closeFallbackTimerRef.current = null; }
              setClosing(false);
            }
          }}
          onAnimationEnd={(e) => {
            // Only clear on the wrapper's own expand animation (ignore child
            // animations like the streaming cursor blink).
            if (e.animationName !== 'tool-call-body-expand') return;
            if (expandTimerRef.current) { clearTimeout(expandTimerRef.current); expandTimerRef.current = null; }
            setExpand(false);
          }}
        >
          <div class="tool-call-body-inner">
            <ToolCallBody toolCall={toolCall} onOpenFile={onOpenFile} />
            {/* The footer is a close affordance for a *manually opened* body.
              The auto-shown shell body (running / post-completion grace) is
              transient and closes via its own grace path, where `data-closing`
              can't engage while `showBody` is true — so don't offer a close
              target there. */}
            {open && <CollapsibleCloseFooter onCollapse={close} />}
            {/* Left gutter collapse hitbox (border / indentation area). Only
              for a manually opened body — the auto-shown shell body is
              transient and shouldn't offer a manual collapse target. */}
            {open && <CollapsibleGutter onCollapse={close} />}
          </div>
        </div>
      )}
    </div>
  );
}
