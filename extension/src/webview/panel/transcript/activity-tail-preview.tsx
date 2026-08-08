/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { summarizeSubagentToolCallInput } from '../../../shared/tool-call-analysis';
import { formatToolResult } from '../../../shared/tool-result-format';
import { cx } from '../utils/cx';
import { getToolCallPresentation } from '../tool-call-summary';
import type { RawContentPart, RawMessage, SubagentSingleResult } from '../../../shared/subagent-result';
import {
  ACTIVITY_TAIL_ROW_HEIGHT_PX,
  collapseSpaces,
  takeLastChars,
  type TurnActivityTail,
} from './activity-tail';
import { textFromToolResult } from './highlight';
import { isForwardExtension, useBufferedText, type BufferedTextRate } from './use-buffered-text';

/**
 * Shared live-preview rows for activity tails.
 *
 * Houses the reusable terminal-style tail renderer ({@link TurnActivityTailBody})
 * plus its console-style row-scroll buffering hook ({@link useTailConsoleScroll}),
 * together with the collapsed-subagent preview tail derivation
 * ({@link subagentPreviewTail}). Both the turn-activity block and the collapsed
 * subagent card consume these to render the same plug-and-play preview rows from
 * a {@link TurnActivityTail}.
 */

/** Reveal rate for the activity tail: deliberately much slower than streaming
 *  message bodies so the typing is perceptible and *readable* in the compact
 *  preview. A low `charsPerFrame` plus a tight `maxScaleFactor` cap means even
 *  fast bursts (e.g. reasoning dumped in a single chunk) buffer up and then
 *  stream in over many frames instead of snapping in — the stronger
 *  buffer/smoothing effect the tail is meant to project. The snap threshold
 *  is kept small so the trailing tail types out smoothly rather than jumping. */
const TAIL_RATE: BufferedTextRate = { charsPerFrame: 3, minAdvance: 2, snapThreshold: 14, maxScaleFactor: 2 };

/** Safety ceiling on the rendered tail text. We render the *full* revealed tail
 *  (not a re-windowed char slice) so its wrapped line count grows monotonically
 *  as tokens stream in — that monotonic growth is what {@link useTailConsoleScroll}
 *  keys its per-row scroll animation on. Realistic reasoning / tool output sits
 *  well below this, so the cap only kicks in for pathological inputs, where the
 *  tail degrades to a stable (no-scroll) preview rather than laying out a huge
 *  string every frame. */
export const TAIL_RENDER_MAX_CHARS = 20000;

interface TurnActivityTailBodyProps {
  tail: TurnActivityTail;
  /** Keep prior output rows when a compact preview changes source (reasoning →
   * tool output → reply), so the rows behave like one continuous console. */
  continuous?: boolean;
}

interface ContinuousPreviewSource {
  accumulated: string;
  segment: string;
}

/** Retain enough history for many screenfuls while bounding a long-lived card's
 * animation cache. The renderer itself still lays out only the newest 20k. */
export const CONTINUOUS_PREVIEW_MAX_CHARS = TAIL_RENDER_MAX_CHARS * 4;

function longestSuffixPrefix(left: string, right: string): number {
  if (!left || !right) return 0;
  const prefix = new Array<number>(right.length).fill(0);
  for (let i = 1, matched = 0; i < right.length; i += 1) {
    while (matched > 0 && right[i] !== right[matched]) matched = prefix[matched - 1];
    if (right[i] === right[matched]) matched += 1;
    prefix[i] = matched;
  }

  let matched = 0;
  for (let i = 0; i < left.length; i += 1) {
    while (matched > 0 && left[i] !== right[matched]) matched = prefix[matched - 1];
    if (left[i] === right[matched]) matched += 1;
    if (matched === right.length && i < left.length - 1) matched = prefix[matched - 1];
  }
  return matched;
}

/** Merge source snapshots into one append-only visual stream. Empty snapshots
 * preserve the previous rows, while overlapping snapshots (including a bounded
 * tail sliding forward) append only genuinely new text. */
export function mergeContinuousPreviewSource(
  previous: ContinuousPreviewSource,
  nextSegment: string,
): ContinuousPreviewSource {
  if (!nextSegment) return previous;
  const boundedSegment = nextSegment.slice(-TAIL_RENDER_MAX_CHARS);
  if (!previous.segment) {
    return { accumulated: boundedSegment.slice(-CONTINUOUS_PREVIEW_MAX_CHARS), segment: boundedSegment };
  }
  if (boundedSegment === previous.segment) return previous;

  const overlap = boundedSegment.startsWith(previous.segment)
    ? previous.segment.length
    : longestSuffixPrefix(previous.segment, boundedSegment);
  const addition = boundedSegment.slice(overlap);
  if (!addition) return { accumulated: previous.accumulated, segment: boundedSegment };
  const separator = overlap === 0 && previous.accumulated && !/\s$/.test(previous.accumulated) ? '\n' : '';
  const accumulated = `${previous.accumulated}${separator}${addition}`;
  return {
    accumulated: accumulated.slice(-CONTINUOUS_PREVIEW_MAX_CHARS),
    segment: boundedSegment,
  };
}

/**
 * Render the live-activity tail as a fixed-height, terminal-style block.
 *
 * The block reserves a constant row budget per kind (the configured content-row
 * count for reasoning / reply text, plus one header row for a running tool /
 * subagent) so its height never changes as content streams in - that is what
 * stops the transcript from jumping around while the agent works. Rows render
 * top-to-bottom; the blinking caret attaches to the newest row.
 *
 * Tool / subagent tails merge their label (tool / agent name) and input (the
 * command / task) onto the first row as `label ▸ input`, so the caller and its
 * command share a line instead of consuming two. Reasoning and reply text have
 * no header row - the italic / muted styling already signals reasoning and the
 * caret signals reply, so a dedicated `reasoning...` label would just waste a row.
 *
 * Truncation ("more output exists above") is conveyed by a gentle top fade on
 * the content block rather than a dedicated `...` row, so the preview reads
 * seamlessly. The fade is driven by the actual rendered overflow: any time the
 * wrapped content is taller than the reserved block, the oldest (top) content
 * fades out. This catches both "many short source lines" and "one long line
 * that wraps across several rows".
 *
 * Console-style streaming. The body wraps to fill the reserved width and
 * collapses source newlines (joined with a space) so the limited preview rows
 * carry as much of the recent tail as possible. The text is bottom-anchored
 * (`bottom: 0`) so the newest row + caret stay pinned to the bottom and wrapped
 * overflow scrolls off the top — and, crucially, so the visible rows never shift
 * when the wrapped height changes (bottom-anchoring is immune to the height
 * wobble that a char-budgeted window used to cause, which made the preview slide
 * and jump). New tokens are buffered and revealed character-by-character at a
 * slow, readable rate (see `useBufferedText` with `TAIL_RATE`), so the preview
 * types into the current line like a typewriter — the x position of any placed
 * text never moves, only the caret advances.
 *
 * When a new row wraps in, `useTailConsoleScroll` runs a small push animation
 * (see the hook): it nudges the whole block down by one row-height with no
 * transition (so the freshly-wrapped row sits just below the view, restoring the
 * pre-wrap layout), then glides it back up over ~150ms. That glide scrolls every
 * row up by exactly one row-height: the oldest row slides off the top (clipped),
 * the rows in between follow, and the newest row slides in at the bottom — a
 * smooth, followable row-scroll instead of an instant jump the eye has to
 * re-acquire. The animation is detected off the wrapped line count exceeding its
 * historical peak, so height wobble never false-fires a scroll.
 */
export function TurnActivityTailBody({ tail, continuous = false }: TurnActivityTailBodyProps) {
  const { kind, label, inputLine, lines, cursor, sourceText } = tail;
  const hasComposite = Boolean(label);
  // Smoothly stream the live tail in instead of snapping a full chunk every
  // snapshot. Reasoning / reply / tool tails carry the raw, monotonically
  // growing `sourceText`; we buffer that source and reveal the *full* tail (not
  // a re-windowed char slice), so new tokens type in at the caret and the
  // wrapped line count grows monotonically — which is what the row-scroll
  // animation keys on. Subagent / multi-tool tails have no single growing
  // source, so we buffer their joined status lines directly. The slower reveal
  // rate (vs streaming message bodies) makes the typing perceptible in the
  // small preview while staying well ahead of typical output; characters are
  // always shown fully opaque (no opacity ramp on the text itself), so the
  // streamed text stays crisp and readable.
  const streaming = Boolean(cursor);
  const rawJoined = lines.filter((l) => l.length > 0).join(' ');
  const currentSource = sourceText ?? rawJoined;
  const continuousSourceRef = useRef<ContinuousPreviewSource>({ accumulated: '', segment: '' });
  if (continuous) {
    continuousSourceRef.current = mergeContinuousPreviewSource(continuousSourceRef.current, currentSource);
  } else {
    continuousSourceRef.current = { accumulated: currentSource, segment: currentSource };
  }
  const source = continuous ? continuousSourceRef.current.accumulated : currentSource;
  const hasContent = source.length > 0;
  // The caret sits on the composite row while no output has arrived, otherwise
  // at the end of the flowing body text.
  const caretOnComposite = Boolean(cursor) && !hasContent;
  const revealed = useBufferedText(source, streaming, TAIL_RATE);
  // Render the full revealed tail (capped only as a safety bound) so the wrapped
  // line count is monotonic; the row-scroll hook depends on that growth.
  const joined = sourceText || continuous
    ? collapseSpaces(revealed.length > TAIL_RENDER_MAX_CHARS ? revealed.slice(revealed.length - TAIL_RENDER_MAX_CHARS) : revealed)
    : revealed;
  const { pushY, animating, overflows, singleRow, refs } = useTailConsoleScroll(
    joined,
    source,
    hasContent,
    lines.length >= 2,
  );
  const showFade = hasContent && overflows;
  const contentEmpty = !hasContent && !(cursor && !hasComposite);

  return (
    <div class={cx('turn-activity-tail', kind)} data-kind={kind} aria-hidden="true">
      {hasComposite && label && (
        <div class="turn-activity-tail-row turn-activity-tail-composite">
          <span class="turn-activity-tail-label">{label}</span>
          {inputLine && <span class="turn-activity-tail-sep" aria-hidden="true">▸</span>}
          {inputLine && (
            <span class="turn-activity-tail-text" title={inputLine}>{inputLine}</span>
          )}
          {caretOnComposite && <span class="turn-activity-tail-cursor" aria-hidden="true" />}
        </div>
      )}
      {/*
        The content block normally reserves the configured output-row budget.
        Its explicit empty signal lets owning tool/subagent previews collapse
        that budget before concrete output arrives without depending on DOM
        whitespace or :empty behavior. The lone-caret branch covers the rare
        tail with no composite and no content but a live cursor.
      */}
      <div
        ref={refs.containerRef}
        data-empty={contentEmpty ? 'true' : undefined}
        class={cx(
          'turn-activity-tail-content',
          singleRow && 'turn-activity-tail-content-single-row',
          showFade && 'truncated',
        )}
      >
        {hasContent ? (
          <span
            ref={refs.textRef}
            class="turn-activity-tail-text"
            title={joined}
            style={{
              transform: `translateY(${pushY}px)`,
              transition: animating ? 'transform 150ms ease-out' : 'none',
            }}
          >
            {joined}
            {cursor && <span class="turn-activity-tail-cursor" aria-hidden="true" />}
          </span>
        ) : (
          !hasComposite && cursor && (
            <div class="turn-activity-tail-row">
              <span class="turn-activity-tail-cursor" aria-hidden="true" />
            </div>
          )
        )}
      </div>
    </div>
  );
}

interface TailConsoleScrollRefs {
  containerRef: { current: HTMLDivElement | null };
  textRef: { current: HTMLSpanElement | null };
}

/** True when the live tail's underlying stream continues cleanly from the
 *  previous render — i.e. content is present in *both* renders and `source`
 *  grew by appending (a forward extension), not replaced.
 *
 *  This decides whether a row-scroll animation may run: only a *continuing*
 *  stream animates, so a source that simply grows on every posted snapshot
 *  never re-suppresses (re-suppressing every snapshot would cut every in-flight
 *  glide and re-introduce the snap). A replacement (reasoning→reply, tool A→tool
 *  B, a status line changing), a fresh mount, or content (re)appearing all return
 *  false so the first row of the new stream just appears instead of scrolling.
 *  `prevHasContent` guards the mount / appear case; `isForwardExtension` guards
 *  growth-vs-replacement (and treats an empty previous as a continuation, which
 *  is why the `prevHasContent` guard is required). */
export function streamContinues(
  prevSource: string,
  source: string,
  prevHasContent: boolean,
  hasContent: boolean,
): boolean {
  return hasContent && prevHasContent && isForwardExtension(prevSource, source);
}

interface TailConsoleScroll {
  /** Vertical translate (px) applied to the bottom-anchored text block to drive
   *  the per-row scroll animation. `0` at rest; briefly `+deltaRows·rowHeight`
   *  the instant a new row wraps (nudging the block down so the new row sits
   *  just below the view), then glided back to `0` by the CSS transition — which
   *  scrolls every row up by one row-height: oldest off the top, newest in at
   *  the bottom. */
  pushY: number;
  /** Whether the CSS transform transition is armed (only during the glide). */
  animating: boolean;
  /** True when the wrapped text is taller than the reserved block (top fade). */
  overflows: boolean;
  /** True when the rendered content occupies exactly one visual row. */
  singleRow: boolean;
  refs: TailConsoleScrollRefs;
}

/**
 * Console-style row-scroll animation for the activity tail.
 *
 * The text block is bottom-anchored (`bottom: 0`) so the newest row + caret stay
 * pinned to the bottom and the visible rows never shift when the wrapped height
 * changes. This hook watches the wrapped line count (measured synchronously,
 * before paint) and, whenever it exceeds its historical peak, runs a two-step
 * push animation:
 *
 *  1. Translate the block DOWN by `deltaRows · rowHeight` with NO transition —
 *     this restores the pre-wrap layout (the freshly-wrapped row sits just below
 *     the view), so the frame that adds the new row never paints the jumped
 *     state. Applied in `useLayoutEffect` so it lands before paint (no flash).
 *  2. On the next animation frame, glide the translate back to `0` over ~150ms.
 *     That glide scrolls every row up by one row-height: the oldest row slides
 *     off the top (clipped), the rows in between follow, and the newest row
 *     slides in at the bottom — a smooth, followable row-scroll.
 *
 * Peak-based detection is what makes this robust: only a wrapped line count
 * that exceeds its all-time peak is treated as a real new row, so any height
 * wobble never false-fires a scroll. The baseline resets (without animating)
 * whenever the underlying stream is *replaced* rather than grown by appending
 * — mount, content (re)appearing, or a source switch (reasoning→reply, tool
 * A→tool B) — so the first row of a new stream just appears instead of
 * scrolling. Replacement is detected via `isForwardExtension` (not raw text
 * equality): a *growing* source is a continuation, so it never re-suppresses —
 * crucial, because the source grows on every posted snapshot, and re-suppressing
 * every snapshot would cut every in-flight glide and re-introduce the snap.
 */
function useTailConsoleScroll(
  text: string,
  source: string,
  hasContent: boolean,
  initialOverflow: boolean,
): TailConsoleScroll {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const peakRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const prevSourceRef = useRef('');
  const prevHasContentRef = useRef(false);
  const suppressRef = useRef(true); // suppress the mount measure (no scroll on first paint)
  // Seed the fade for static renders / first paint (before the layout effect
  // measures real overflow). Collapsed streaming/tool tails emit a single line
  // so this stays false for them and the measure is authoritative; subagent /
  // multi-tool tails can still seed true from multiple item lines.
  const [overflows, setOverflows] = useState(initialOverflow);
  // A one-row preview does not need the configured multi-row stability budget.
  // This is measured from layout rather than source newlines because the source
  // is collapsed and can either fit or wrap depending on the panel width.
  const [singleRow, setSingleRow] = useState(false);
  const [pushY, setPushY] = useState(0);
  const [animating, setAnimating] = useState(false);

  // Suppress the scroll animation whenever the underlying stream does NOT
  // continue cleanly from the previous one — i.e. on mount, when content
  // (re)appears, or when the source is replaced rather than grown by appending.
  // Forward growth (normal streaming) continues the stream and animates
  // normally. Mutated in render (a "latest value" ref, like the region's
  // lastTailState): it only ever lags the stream by one render and is idempotent.
  const streamContinuesFlag = streamContinues(
    prevSourceRef.current,
    source,
    prevHasContentRef.current,
    hasContent,
  );
  if (!streamContinuesFlag) {
    suppressRef.current = true;
  }
  prevSourceRef.current = source;
  prevHasContentRef.current = hasContent;

  const cancelRaf = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  useLayoutEffect(() => {
    if (!hasContent) {
      peakRef.current = 0;
      cancelRaf();
      setPushY(0);
      setAnimating(false);
      setOverflows(false);
      setSingleRow(false);
      return;
    }
    const el = textRef.current;
    const container = containerRef.current;
    if (!el || !container) return;

    // Wrapped line count of the full rendered tail (pre-transform layout
    // height). Read synchronously, before paint, so a freshly-wrapped row can be
    // masked by the push animation in the very same commit — the jumped state is
    // never painted. `text` is a dependency on purpose: the body re-renders per
    // animation frame as tokens type in, and we must re-measure each frame to
    // catch the exact frame a new row wraps.
    const textH = el.clientHeight;
    const containerH = container.clientHeight;
    const lineCount = Math.max(1, Math.round(textH / ACTIVITY_TAIL_ROW_HEIGHT_PX));
    const nextOverflow = textH > containerH + 0.5;
    setOverflows((prev) => (prev !== nextOverflow ? nextOverflow : prev));
    setSingleRow((prev) => (prev !== (lineCount === 1) ? lineCount === 1 : prev));

    if (suppressRef.current) {
      // New stream / mount: adopt the current line count as the baseline peak
      // without scrolling.
      suppressRef.current = false;
      peakRef.current = lineCount;
      cancelRaf();
      setPushY(0);
      setAnimating(false);
      return;
    }

    if (lineCount > peakRef.current) {
      // A new row just wrapped in. Nudge the block down by the number of new
      // rows (no transition) so it still shows the pre-wrap layout — the new row
      // sits just below the view — then glide it back up to 0 next frame. That
      // glide is the smooth console-style row scroll (see the hook doc).
      const delta = lineCount - peakRef.current;
      peakRef.current = lineCount;
      cancelRaf();
      setPushY(delta * ACTIVITY_TAIL_ROW_HEIGHT_PX);
      setAnimating(false);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setAnimating(true);
        setPushY(0);
      });
    }
  }, [text, hasContent]);

  useEffect(() => () => cancelRaf(), []);

  return { pushY, animating, overflows, singleRow, refs: { containerRef, textRef } };
}

/** A subagent that has been dispatched but hasn't started executing yet — the
 *  synthesized placeholder before any messages, streaming text/reasoning, or
 *  nested tool calls have arrived. Renders with a muted "waiting" treatment so
 *  queued agents (e.g. not-yet-started parallel members) recede behind active
 *  ones. */
export function isIdle(result: SubagentSingleResult): boolean {
  if (result.exitCode !== -1) return false;
  const hasMessages = Array.isArray(result.messages) && result.messages.length > 0;
  const hasStreamingText = !!result.streamingText?.trim();
  const hasStreamingReasoning = !!result.streamingReasoning?.trim();
  const hasRunningTools = (result.runningTools?.length ?? 0) > 0;
  // A real lifecycle update means the child has started. Only an explicitly
  // local queue remains visually idle; provider waits must not masquerade as
  // unexplained inactivity.
  const awaitingLocalCapacity = result.activityPhase === 'queued';
  return !hasMessages && !hasStreamingText && !hasStreamingReasoning && !hasRunningTools && awaitingLocalCapacity;
}

/** Cap on the tool output carried into the collapsed preview. Unlike the main
 *  transcript's activity tail (which windows to the last ~480 chars), the
 *  collapsed subagent preview includes the full recent tool output so a running
 *  bash / read etc. surfaces its actual content; the body then windows the
 *  visible rows with a top fade. Bounded only as a safety ceiling against
 *  pathological output so the per-snapshot re-derivation (~6×/sec) stays cheap. */
const SUBAGENT_TOOL_OUTPUT_MAX_CHARS = 8000;

interface LatestToolActivity {
  name: string;
  /** One-line command/input summary, if derivable (e.g. a bash command). */
  inputLine?: string;
  /** The tool's output text (partial while running, full when complete). */
  output?: string;
  /** True while the tool is still executing (no completed toolResult yet). */
  running: boolean;
}

/** Extract the most recent nested tool activity from a child's raw messages.
 *
 * Mirrors the tool-result collection in `subagent.ts`'s `collectRawToolResults`:
 * completed tool results land as `toolResult` messages (or user `toolResult`
 * parts), while a running tool's partial result is stamped directly on its
 * `toolCall` content part by the runner's `tool_execution_update` handler — so
 * it surfaces before the `toolResult` message arrives. Scans backward so the
 * newest toolCall wins (the one currently streaming output). */
function latestToolActivity(result: SubagentSingleResult): LatestToolActivity | undefined {
  const messages: RawMessage[] = Array.isArray(result.messages) ? result.messages : [];
  if (messages.length === 0) return undefined;

  const toolResultMap = new Map<string, { result: unknown; isError?: boolean }>();
  for (const msg of messages) {
    if (msg.role === 'toolResult' && msg.toolCallId != null) {
      toolResultMap.set(String(msg.toolCallId), {
        result: formatToolResult(msg),
        isError: msg.isError,
      });
      continue;
    }
    if (msg.role !== 'user') continue;
    const parts: RawContentPart[] = Array.isArray(msg.content) ? msg.content : [];
    for (const part of parts) {
      if (part.type === 'toolResult' && part.id !== undefined) {
        toolResultMap.set(String(part.id), { result: part.result });
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const content: RawContentPart[] = Array.isArray(msg.content) ? msg.content : [];
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (!part || typeof part !== 'object' || part.type !== 'toolCall') continue;
      const id = part.id != null ? String(part.id) : undefined;
      const name = typeof part.name === 'string' ? part.name : undefined;
      if (!id || !name) continue;
      const completed = toolResultMap.get(id);
      const rawResult = completed?.result ?? part.result;
      const output = rawResult != null ? textFromToolResult(rawResult) : undefined;
      const presentation = getToolCallPresentation({
        id,
        name,
        input: part.arguments ?? {},
        result: rawResult,
        status: completed?.isError ? 'failed' : completed ? 'completed' : 'running',
      });
      return {
        name,
        inputLine: presentation.summary?.trim() || undefined,
        output: output ? takeLastChars(output.replace(/\n+$/, ''), SUBAGENT_TOOL_OUTPUT_MAX_CHARS) : undefined,
        running: !completed,
      };
    }
  }
  return undefined;
}

/** Build the collapsed subagent-card live preview.
 *
 * Replaces generic lifecycle placeholders ("Generating…", "Running tool…")
 * with actual content whenever it is available, in priority order:
 *
 *  1. Live model generation — reply text (`streamingText`), then reasoning
 *     (`streamingReasoning`). Reasoning is surfaced before any reply text has
 *     arrived, covering the phase that previously fell back to a bare
 *     "Generating…" label.
 *  2. A running nested tool — its name + one-line input plus its live output
 *     (e.g. bash stdout), including the full recent output rather than the main
 *     transcript's aggressively-windowed tail.
 *  3. Lifecycle fallback — projected phase label, used only when no actual
 *     content exists yet.
 *
 * Only a genuinely queued child is pending; reasoning, provider waits, and
 * tool execution all remain visibly active. */
export function subagentPreviewTail(
  result: SubagentSingleResult,
  lineBudget: number,
  running: boolean,
): TurnActivityTail | undefined {
  const rawTask = result.task?.trim();
  const taskInputLine = rawTask ? (summarizeSubagentToolCallInput({ task: rawTask }) ?? undefined) : undefined;

  const streamText = result.streamingText?.trim();
  const streamReasoning = result.streamingReasoning?.trim();

  // 1. Live model generation: prefer reply text, fall back to reasoning. Both
  //    replace the generic "Generating…" lifecycle label with the actual
  //    content being produced. (reply text already did this; reasoning is the
  //    new addition covering the reasoning-only phase before reply text.)
  if (streamText || streamReasoning) {
    const sourceText = (streamText || streamReasoning)!;
    const isReasoning = !streamText && !!streamReasoning;
    return {
      kind: isReasoning ? 'reasoning' : 'subagent',
      label: taskInputLine ? 'task' : undefined,
      inputLine: taskInputLine,
      lines: [sourceText],
      truncated: false,
      cursor: running && !isIdle(result),
      reservedRows: lineBudget + (taskInputLine ? 1 : 0),
      sourceText: sourceText || undefined,
    };
  }

  // 2. Most recent nested tool: surface its name + one-line input and any
  //    output (e.g. bash stdout) instead of a bare lifecycle label. Keep a
  //    completed tool visible while the child waits for its next provider turn;
  //    it remains the latest concrete activity until new generation arrives.
  //    Unlike the main transcript preview, this intentionally includes tools
  //    even before output arrives and retains their complete recent output.
  const tool = latestToolActivity(result);
  if (tool && running && (tool.inputLine || tool.output)) {
    return {
      kind: 'tool',
      label: tool.name,
      inputLine: tool.inputLine,
      lines: tool.output ? [tool.output] : [],
      truncated: false,
      cursor: tool.running && !isIdle(result),
      reservedRows: lineBudget + 1,
      sourceText: tool.output,
    };
  }

  // 3. No concrete live content yet. The header already carries lifecycle,
  // elapsed time, provider waits, and running-tool names, so repeating
  // "Generating…"/"Starting…" in a fixed-height preview wastes transcript
  // space. Keep only the useful one-line task; actual reasoning, reply text, or
  // nested tool detail will replace it as soon as it arrives.
  if (!taskInputLine) return undefined;
  return {
    kind: 'subagent',
    label: 'task',
    inputLine: taskInputLine,
    lines: [],
    truncated: false,
    cursor: false,
    reservedRows: 1,
    sourceText: undefined,
  };
}
