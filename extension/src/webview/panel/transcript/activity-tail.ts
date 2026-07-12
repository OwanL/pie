/**
 * Compact "last few rows" live-activity tail derivation.
 *
 * Extends {@link TurnActivityState} with a bounded, terminal-style preview of
 * what the agent is producing right now: the tail of streaming reasoning/reply
 * text, the input + streaming output of the running tool, or the live activity
 * inside a running subagent.
 *
 * All source data already lives in the projected transcript snapshot — the
 * streaming assistant message's `parts` (text/reasoning), the running
 * tool call's `result` (the `partialResult` pushed by `tool.progress`, which
 * `bash` populates as stdout streams), and the subagent tool call's `result`
 * (the live `SubagentResult` with `streamingText`/`runningTools`). No host or
 * protocol changes are required; this is a pure webview-side projection that
 * re-derives on every posted snapshot (~6×/sec via the 150ms streaming debounce).
 */

import type { ChatMessagePart, ToolCall } from '../../../shared/protocol';
import { normalizeToolCallName } from '../../../shared/tool-call-analysis';
import { getToolCallPresentation } from '../tool-call-summary';
import { textFromToolResult } from './highlight';
import {
  getRenderableSubagentResultFromToolCall,
  type SubagentSingleResult,
} from './subagent';

/** Default number of content lines rendered in the tail's content block
 *  (streaming reasoning/reply text, a tool's output, or a multi-tool `→ name`
 *  listing). The live count is overridable via the `activityTailLines` pref,
 *  threaded through the derive functions as `lineBudget`; this constant is the
 *  fallback when none is supplied. */
export const ACTIVITY_TAIL_MAX_LINES = 2;
/**
 * Maximum characters of streaming text/reasoning considered for the tail.
 * Kept generous so the wrapped preview can actually fill the available width
 * rather than leaving most of the row budget empty.
 */
export const ACTIVITY_TAIL_MAX_CHARS = 480;
/** Soft cap for a single rendered line before CSS ellipsis takes over. */
export const ACTIVITY_TAIL_LINE_MAX_CHARS = 180;
/** Estimated rendered height of a single tail row, in px (matches CSS line-height). */
export const ACTIVITY_TAIL_ROW_HEIGHT_PX = 18;

export interface TurnActivityTail {
  /** Semantic kind; drives styling (e.g. reasoning renders muted/italic). */
  kind: 'reasoning' | 'text' | 'tool' | 'subagent';
  /**
   * Inline label rendered as the first row of a tool/subagent block — the tool
   * name, agent name, or `running N tools` count — merged with {@link inputLine}
   * as `label ▸ input` so the caller and its command share one row instead of
   * two. Omitted for reasoning / reply text (no header row).
   */
  label?: string;
  /** Optional one-line input shown beside {@link label} (e.g. a bash command, subagent task). */
  inputLine?: string;
  /** Tail content lines, already clipped to the configured line budget. Newest at the bottom. */
  lines: string[];
  /** True when more content exists above the shown lines (renders the top fade). */
  truncated: boolean;
  /** Show a blinking cursor indicating live streaming/execution. */
  cursor: boolean;
  /** Reserved total rows the block keeps constant so it never reflows as
   *  content streams: the content-line budget plus one composite header row
   *  for tools/subagents (reasoning/reply text has no header). Drives the
   *  virtualizer's height estimate. */
  reservedRows: number;
  /**
   * The raw, monotonically-growing source text behind {@link lines} for
   * reasoning / reply / tool tails (the full streaming segment, or a tool's
   * accumulated output). When present, the tail body buffers this source and
   * re-derives its own windowed preview from the *revealed* portion, so new
   * tokens stream in smoothly at the caret even after the source has grown past
   * the preview window (the sliding-window regime) — instead of jumping a full
   * window every snapshot. Omitted for subagent / multi-tool tails, whose
   * {@link lines} are discrete status lines rather than a growing char stream.
   */
  sourceText?: string;
}

/** A derived tail plus the header label that should replace the strip's default label. */
export interface DerivedActivityTail {
  tail: TurnActivityTail;
  label: string;
}

/** Reserved total rows a tail block keeps constant so it never reflows as
 *  content streams in: the content-line budget plus one composite header row
 *  for tools/subagents (reasoning/reply text has no header row). */
function reservedRowCount(kind: TurnActivityTail['kind'], lineBudget: number): number {
  return kind === 'tool' || kind === 'subagent' ? lineBudget + 1 : lineBudget;
}

export function takeLastChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

function clampLines(lines: string[], max: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= max) return { lines, truncated: false };
  return { lines: lines.slice(lines.length - max), truncated: true };
}

function clampToLine(text: string, max = ACTIVITY_TAIL_LINE_MAX_CHARS): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1).trimEnd()}…`;
}

/** Collapse all whitespace (including source newlines) into single spaces so
 *  the preview flows as a single wrapping run that fills the reserved rows,
 *  instead of one clipped row per source line (which left the rows mostly
 *  empty when the source had many short lines). */
export function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Tool names (normalized, lowercase) that surface their own visible UI (e.g.
 *  ask_user renders a prompt the user already sees). Omitted from the activity
 *  preview tail so they don't duplicate that UI in the bottom preview rows. */
const OMITTED_FROM_TAIL = new Set<string>(['ask_user']);

/**
 * True when the tool result carries the SDK's own truncation metadata
 * (e.g. bash `details.truncation.truncated` when output exceeded the
 * OutputAccumulator's line/byte cap). Used so the `…` separator reflects hidden
 * output even when our own line cap hasn't kicked in.
 */
function isSdkResultTruncated(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return false;
  const truncation = (details as { truncation?: { truncated?: unknown } }).truncation;
  return Boolean(truncation?.truncated);
}

/**
 * Derive a live tail for the currently-streaming assistant message — but only
 * for *reasoning*. The assistant's reply text is already rendered in the
 * streaming message body above, so duplicating it in the compact bottom
 * preview just adds fast-moving noise; reasoning (often collapsed in the
 * body) and tool/subagent activity (derived separately, see
 * {@link deriveRunningToolTail} / {@link deriveMultiToolTail}) are the
 * behind-the-scenes signals worth previewing.
 *
 * Reasoning is surfaced only while it is the actively-streaming segment —
 * i.e. the last part is reasoning — so once reply text takes over the preview
 * falls back to the plain "responding" strip instead of freezing on already-
 * completed reasoning. The growing reasoning text is carried as
 * {@link TurnActivityTail.sourceText} so the body can buffer it and reveal new
 * tokens smoothly at the caret even after the source has grown past the preview
 * window.
 */
export function deriveStreamingTail(
  parts: ChatMessagePart[] | undefined,
  lineBudget: number = ACTIVITY_TAIL_MAX_LINES,
): DerivedActivityTail | null {
  if (!parts || parts.length === 0) return null;

  // Only reasoning, and only while it is the segment currently being produced
  // (the last part). Reply text (`kind: 'text'`) is intentionally not surfaced
  // here — see the function doc.
  const last = parts[parts.length - 1];
  if (last?.kind !== 'reasoning') return null;

  const kind = 'reasoning';
  const full = last.text;
  // Take a char-bounded tail and collapse newlines so the preview flows as a
  // single wrapping run that fills the reserved rows. The old approach split on
  // newlines and kept only the last `lineBudget` source lines, which left the
  // reserved rows mostly empty when the source had many short lines.
  const tailText = takeLastChars(full, ACTIVITY_TAIL_MAX_CHARS);
  const collapsed = collapseSpaces(tailText);
  if (collapsed.length === 0) return null;

  return {
    label: 'reasoning',
    tail: {
      kind,
      lines: [collapsed],
      truncated: full.length > tailText.length,
      cursor: true,
      reservedRows: reservedRowCount(kind, lineBudget),
      sourceText: full,
    },
  };
}

/**
 * Derive a live tail for a single running (non-subagent) tool call: the tool's
 * one-line input plus the tail of its streaming `partialResult` output.
 */
export function deriveToolTail(toolCall: ToolCall, lineBudget: number = ACTIVITY_TAIL_MAX_LINES): DerivedActivityTail | null {
  // Tools that surface their own visible UI (e.g. ask_user) are omitted — the
  // user already sees the prompt, so a duplicate preview row is noise.
  if (OMITTED_FROM_TAIL.has(normalizeToolCallName(toolCall.name))) return null;

  const presentation = getToolCallPresentation(toolCall);
  const inputLine = presentation.summary?.trim() || undefined;

  // Take a char-bounded tail and collapse newlines so a streaming terminal's
  // many short lines fill the reserved rows instead of leaving them empty.
  const resultText = textFromToolResult(toolCall.result) ?? '';
  const trimmed = resultText.replace(/\n+$/, '');
  const tailText = takeLastChars(trimmed, ACTIVITY_TAIL_MAX_CHARS);
  const collapsed = collapseSpaces(tailText);
  const lines = collapsed.length > 0 ? [collapsed] : [];
  const sdkTruncated = isSdkResultTruncated(toolCall.result);

  const hasBody = Boolean(inputLine) || lines.length > 0;
  if (!hasBody) return null;

  return {
    label: toolCall.name,
    tail: {
      kind: 'tool',
      label: toolCall.name,
      inputLine,
      lines,
      truncated: trimmed.length > tailText.length || sdkTruncated,
      cursor: true,
      reservedRows: reservedRowCount('tool', lineBudget),
      sourceText: trimmed || undefined,
    },
  };
}

function subagentSingleResultRunning(result: SubagentSingleResult): boolean {
  return result.exitCode === -1 || (result.runningTools?.length ?? 0) > 0;
}

function compactDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function compactTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/** Dense lifecycle and run metadata rows used when a child has not produced
 * visible output yet. These make the reserved preview rows useful during
 * provider waits and retries instead of showing an empty blinking caret. */
export function subagentDetailLines(result: SubagentSingleResult, now = Date.now()): string[] {
  const phaseLabels: Record<string, string> = {
    queued: 'Waiting for concurrency',
    preparing: 'Starting subagent',
    waiting_provider: 'Waiting for provider',
    streaming: 'Generating response',
    running_tool: 'Running tool',
    retry_wait: 'Waiting to retry provider',
  };
  const phase = result.activityPhase
    ? phaseLabels[result.activityPhase]
    : (subagentSingleResultRunning(result) ? 'Waiting for status update' : undefined);
  const stateFor = result.activitySince ? compactDuration(now - result.activitySince) : undefined;
  const progressAgo = result.lastProgressAt ? compactDuration(now - result.lastProgressAt) : undefined;
  const stallLimit = result.inactivityBudgetMs ? compactDuration(result.inactivityBudgetMs) : undefined;
  const lifecycle = [
    phase,
    result.activityDetail,
    stateFor && `${stateFor} in state`,
    progressAgo && `${progressAgo} since progress`,
    stallLimit && `${stallLimit} stall limit`,
  ].filter(Boolean).join(' · ');

  const model = result.selectedModel ?? result.model;
  const usage = result.usage;
  const cache = usage ? usage.cacheRead + usage.cacheWrite : 0;
  const contextTokens = usage?.contextTokens;
  const contextWindow = result.contextWindow;
  const contextPercent = contextTokens && contextWindow
    ? Math.round((contextTokens / contextWindow) * 100)
    : undefined;
  const latestThroughput = result.turnThroughputSamples
    ?.filter((sample) => sample.generationDurationMs > 0 && sample.outputTokens >= 0)
    .at(-1);
  const tokensPerSecond = latestThroughput
    ? latestThroughput.outputTokens / (latestThroughput.generationDurationMs / 1000)
    : undefined;
  const metadata = [
    result.provider && !model?.startsWith(`${result.provider}/`) ? result.provider : undefined,
    model,
    result.thinkingLevel && result.thinkingLevel !== 'off' ? `thinking ${result.thinkingLevel}` : undefined,
    contextTokens && contextWindow ? `context ${compactTokens(contextTokens)} / ${compactTokens(contextWindow)}${contextPercent != null ? ` (${contextPercent}%)` : ''}` : undefined,
    usage ? `tokens ${compactTokens(usage.input)} in / ${compactTokens(usage.output)} out` : undefined,
    cache > 0 ? `${compactTokens(cache)} cached` : undefined,
    tokensPerSecond != null ? `last ${tokensPerSecond.toFixed(1)} tok/s` : undefined,
    result.retryCount ? `${result.retryCount} ${result.retryCount === 1 ? 'retry' : 'retries'}` : undefined,
    result.selectionPool?.length ? `${result.selectionPool.length} model candidates` : undefined,
  ].filter(Boolean).join(' · ');

  return [lifecycle, metadata].filter(Boolean);
}

/** One compact activity line describing what a running subagent is doing right now. */
function subagentActivityLine(result: SubagentSingleResult, prefixAgent: boolean): string | null {
  const tools = result.runningTools?.filter(Boolean);
  if (tools && tools.length > 0) {
    const toolList = tools.join(' · ');
    return prefixAgent ? `${result.agent}: → ${toolList}` : `→ ${toolList}`;
  }

  const stream = result.streamingText?.trim();
  if (stream) {
    const parts = stream.split('\n').map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) {
      return clampToLine(prefixAgent ? `${result.agent}: ${last}` : last);
    }
  }

  return prefixAgent ? `${result.agent}: …` : '…';
}

/**
 * Derive a live tail for a running `subagent` tool call by peeking into its
 * live {@link SubagentResult}: the task plus the most recent activity of each
 * still-running sub-result (running tools, or the tail of streaming text).
 */
export function deriveSubagentTail(toolCall: ToolCall, lineBudget: number = ACTIVITY_TAIL_MAX_LINES): DerivedActivityTail | null {
  const sub = getRenderableSubagentResultFromToolCall(toolCall);
  if (!sub) return null;

  const running = sub.results.filter(subagentSingleResultRunning);
  if (running.length === 0) return null;

  const primary = running[0]!;
  const taskText = primary.task?.trim();
  const inputLine = taskText ? clampToLine(taskText) : undefined;

  const prefixAgent = running.length > 1;
  const all: string[] = [];
  for (const result of running) {
    const activityLine = subagentActivityLine(result, prefixAgent);
    const hasConcreteActivity = Boolean(activityLine && activityLine !== '…' && !activityLine.endsWith(': …'));
    if (hasConcreteActivity && activityLine) {
      all.push(activityLine);
    } else {
      const details = subagentDetailLines(result);
      // Parallel previews owe each child one row before spending scarce space
      // on secondary metadata. Prefix diagnostics so their source stays clear.
      if (prefixAgent && details[0]) all.push(`${result.agent}: ${details[0]}`);
      else all.push(...details);
    }
  }
  // A single child can use remaining rows for lifecycle/model diagnostics even
  // while a concrete tool/output line occupies the first row.
  if (
    !prefixAgent
    && all.length > 0
    && !all.some((line) => line.includes(' in state'))
    && Boolean(primary.activityPhase || primary.model || primary.selectedModel || primary.usage)
  ) {
    all.push(...subagentDetailLines(primary));
  }

  const lines = all.slice(0, lineBudget);
  const truncated = all.length > lineBudget;

  const label = primary.agent?.trim() || 'subagent';
  return {
    label,
    tail: {
      kind: 'subagent',
      label,
      inputLine,
      lines,
      truncated,
      cursor: true,
      reservedRows: reservedRowCount('subagent', lineBudget),
    },
  };
}

/**
 * Route a single running tool call to the right tail derivation (subagent vs
 * generic tool). Returns null when no meaningful tail can be derived.
 */
export function deriveRunningToolTail(toolCall: ToolCall, lineBudget: number = ACTIVITY_TAIL_MAX_LINES): DerivedActivityTail | null {
  if (normalizeToolCallName(toolCall.name) === 'subagent') {
    return deriveSubagentTail(toolCall, lineBudget);
  }
  return deriveToolTail(toolCall, lineBudget);
}

/**
 * Build a per-tool summary tail for the multi-tool case (e.g. parallel tool
 * calls). A `running N tools` composite row carries the count on row 1; each
 * running tool then renders as a compact `→ <name>` line below, capped to the
 * content-block budget so the whole block keeps its fixed 3-row height as tools
 * start/finish.
 */
export function deriveMultiToolTail(toolCalls: readonly ToolCall[], lineBudget: number = ACTIVITY_TAIL_MAX_LINES): DerivedActivityTail {
  const toolCount = toolCalls.length;
  const all = toolCalls.map((tc) => `→ ${tc.name}`);
  const { lines, truncated } = clampLines(all, lineBudget);
  const label = `running ${toolCount} tools`;
  return {
    label,
    tail: { kind: 'tool', label, lines, truncated, cursor: true, reservedRows: reservedRowCount('tool', lineBudget) },
  };
}

/**
 * Reserved row budget carried on the tail — drives the virtualizer's height
 * estimate so the block keeps a constant height as content streams. Computed
 * at derivation time from the configured content-line budget (the `lineBudget`
 * arg of the derive functions, ultimately the `activityTailLines` pref):
 * tools/subagents reserve a header row plus the content rows; reasoning/reply
 * text reserves just the content rows.
 */
export function activityTailRowCount(tail: TurnActivityTail): number {
  return tail.reservedRows;
}

/**
 * Rough rendered height of a tail, used by the virtualizer's size estimate so
 * initial layout is close before ResizeObserver re-measures the real height.
 * Matches the reserved row budget (see {@link activityTailRowCount}) plus the
 * block's vertical chrome; the real height is always measured from the DOM.
 */
export function estimateActivityTailHeight(tail: TurnActivityTail | null | undefined): number {
  if (!tail) return 0;
  return activityTailRowCount(tail) * ACTIVITY_TAIL_ROW_HEIGHT_PX + 8;
}
