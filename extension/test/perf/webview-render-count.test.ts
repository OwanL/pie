/**
 * Webview render-count harness — the missing webview-side perf feedback loop.
 *
 * The host posts a fully structured-cloned `ViewState` ~7×/sec while streaming.
 * `postMessage`'s structured clone gives every nested object a fresh reference
 * even when content is byte-identical, which is the root cause of every
 * memo-barrier failure on the webview (see the comment block in
 * `src/webview/panel/utils/view-state-stabilize.ts`). There was no webview-side
 * measurement — only a host-side one (`streaming-pipeline.perf.ts`) — so the
 * structural fixes in the follow-up to 48596cf were flying blind. This file is
 * that feedback loop (diagnose-skill Phase 1): a deterministic, agent-runnable
 * pass/fail signal for "did the memo barriers hold, and did the O(transcript)
 * indicator walks bail when only the streaming message grew".
 *
 * Why a `*.test.ts` (CI-swept) and not a `*.perf.ts`: the assertions here are
 * render-COUNT invariants (exact counts), not timing microbenchmarks. They are
 * fully deterministic — there is no virtualizer, no rAF, no ResizeObserver
 * layout, no `performance.now` noise — so they belong in CI as regression
 * guards. A timing `.perf.ts` would be skipped by `npm test` and could not
 * catch a barrier regression automatically. The cost is one fast test file.
 *
 * Faithfulness: snapshots are produced by `structuredClone` (the same clone
 * semantics `postMessage` applies), so nested objects get fresh refs every
 * tick exactly as in production. `MessageItem` is exercised through the REAL
 * `areMessageItemPropsEqual` comparer and the REAL `MessageItemView` inner
 * (hooks + markdown path), so a barrier regression here is a barrier
 * regression in production.
 *
 * Two parts:
 *
 *  Part A — MessageItem memo barrier: locks in commit 48596cf. Asserts
 *  non-streaming rows render exactly once across N streaming deltas and only
 *  the streaming row re-renders per delta. A control variant (default shallow
 *  `memo`, no comparer) proves the harness would have caught the original
 *  broken barrier (every row re-renders every delta).
 *
 *  Part B — `useComposerIndicators` recomputation: locks in the Step 2 fix.
 *  Asserts the O(transcript) indicator walks (token usage, context breakdown,
 *  completed-cost summary, subagent direct cost) recompute a number of times
 *  INDEPENDENT of the delta count and transcript length for stable-result
 *  cases, instead of once per snapshot.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../_helpers/dom';
installDom();

// MessageItemView renders markdown, which routes through DOMPurify. Stub it to
// identity (same as test/webview/components/app-smoke.test.ts) so we don't need a real sanitizer.
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render, type FunctionComponent } from 'preact';
import { act } from 'preact/test-utils';
import { memo } from 'preact/compat';

import type {
  ChatMessage,
  ChatPrefs,
  ContextWindowUsage,
  ModelInfo,
  ModelSettings,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
} from '../../src/shared/protocol';
import { DEFAULT_CHAT_PREFS, EMPTY_TRANSCRIPT_WINDOW } from '../../src/shared/protocol';
import {
  MessageItemView,
  areMessageItemPropsEqual,
  type MessageItemProps,
} from '../../src/webview/panel/transcript/message-item';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../../src/webview/panel/transcript/types';
import { useComposerIndicators } from '../../src/webview/panel/composer/use-composer-indicators';
import { buildSessionUsageSnapshot } from '../../src/shared/session-usage';

type IndicatorsInputs = Parameters<typeof useComposerIndicators>[0];

// ─── Constants ───────────────────────────────────────────────────────────────

const DELTAS = 50;
const SESSION_PATH = '/session/a';
const MODEL_ID = 'test-model';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let usageSeq = 0;
function makeUsage() {
  usageSeq += 1;
  return {
    inputTokens: 1000 * usageSeq,
    outputTokens: 200 * usageSeq,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1200 * usageSeq,
  };
}

function makeUserMessage(id: string, text: string): ChatMessage {
  return {
    id,
    role: 'user',
    createdAt: '2026-01-01T12:00:00.000Z',
    markdown: text,
    status: 'completed',
  };
}

function makeAssistantMessage(id: string, text: string, withUsage = true): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-01-01T12:00:01.000Z',
    markdown: text,
    parts: [{ kind: 'text', text }],
    status: 'completed',
    modelId: MODEL_ID,
    thinkingLevel: 'off' as ThinkingLevel,
    durationMs: 800,
    ...(withUsage ? { usage: makeUsage() } : {}),
  };
}

function makeStreamingAssistant(id: string, text: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-01-01T12:00:02.000Z',
    markdown: text,
    parts: [{ kind: 'text', text }],
    status: 'streaming',
    modelId: MODEL_ID,
    thinkingLevel: 'off' as ThinkingLevel,
  };
}

/** Build a transcript of `pairs` user/assistant turns (assistants carry usage),
 *  optionally followed by one streaming assistant message. */
function buildTranscript(opts: { pairs: number; streaming?: boolean }): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < opts.pairs; i++) {
    messages.push(makeUserMessage(`u-${i}`, `User message ${i}`));
    messages.push(makeAssistantMessage(`a-${i}`, `Assistant answer ${i}. `.repeat(4)));
  }
  if (opts.streaming) {
    messages.push(makeStreamingAssistant('stream-1', 'word0 '));
  }
  return messages;
}

function buildTranscriptWithSubagentCall(): ChatMessage[] {
  const messages: ChatMessage[] = [];
  messages.push(makeUserMessage('u-0', 'do the thing'));
  messages.push({
    ...makeAssistantMessage('a-0', 'delegating'),
    toolCalls: [
      {
        id: 'tc-sub',
        name: 'subagent',
        input: { agent: 'worker', task: 'do stuff' },
        result: {
          content: [],
          details: {
            mode: 'single',
            results: [
              { agent: 'worker', usage: { input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 6000, turns: 1 } },
            ],
          },
        },
        status: 'completed',
        startedAt: 1700000000000,
        durationMs: 12,
      },
    ],
  });
  return messages;
}

// ─── Stable peripheral props (kept reference-stable across deltas, mirroring
//     hydrateViewState's stabilization of prefs + useCallback handlers) ────────

const STABLE_PREFS: ChatPrefs = { ...DEFAULT_CHAT_PREFS };
const noop = () => {};
const STABLE_RENDER_TOOL_CALL: RenderToolCall = () => null;
const STABLE_CONTEXT_MENU: TranscriptContextMenuHandler = () => noop;

const AVAILABLE_MODELS: ModelInfo[] = [
  {
    id: MODEL_ID,
    name: 'Test Model',
    provider: 'test',
    reasoning: false,
    inputKinds: ['text'],
    contextWindow: 200_000,
    subagent: {
      eligible: true,
      aggregate: 10,
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  },
];
const MODEL_SETTINGS: ModelSettings = { defaultModel: MODEL_ID, defaultThinkingLevel: 'off' };
const TRANSCRIPT_WINDOW: TranscriptWindow = {
  ...EMPTY_TRANSCRIPT_WINDOW,
  totalCount: 0,
  loadedEnd: 0,
  hasUserMessages: true,
  isPartial: false,
};

// ─── Ref-identity tracker (counts memo recomputes via distinct refs) ─────────

class RefTracker {
  private refs = new Map<string, Set<unknown>>();
  record(key: string, value: unknown): void {
    let set = this.refs.get(key);
    if (!set) { set = new Set(); this.refs.set(key, set); }
    set.add(value);
  }
  /** Number of distinct object references observed for `key` = number of times
   *  the producing memo's factory ran (useMemo returns the cached ref when its
   *  deps are unchanged, so a stable result yields 1 distinct ref). */
  distinct(key: string): number {
    return this.refs.get(key)?.size ?? 0;
  }
}

// ─── DOM container ────────────────────────────────────────────────────────────

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  container.id = 'app';
  document.body.appendChild(container);
});
afterEach(() => {
  render(null, container);
  container.remove();
});

// ═══════════════════════════════════════════════════════════════════════════
//  Part A — MessageItem memo barrier (locks in commit 48596cf)
// ═══════════════════════════════════════════════════════════════════════════

interface CountedItem {
  Item: FunctionComponent<MessageItemProps>;
  counts: Map<string, number>;
}

/** Build a memoized MessageItem whose inner view increments a per-id render
 *  counter. `memo` bails BEFORE calling the inner function when the comparer
 *  holds, so the counter increments exactly when the barrier lets the row
 *  through — i.e. it counts real renders, not memo-bails. Pass no comparer to
 *  replicate the pre-48596cf default-shallow barrier (the control). */
function makeCountedItem(comparer?: (p: MessageItemProps, n: MessageItemProps) => boolean): CountedItem {
  const counts = new Map<string, number>();
  function CountedView(props: MessageItemProps) {
    counts.set(props.message.id, (counts.get(props.message.id) ?? 0) + 1);
    return h(MessageItemView, props);
  }
  const Item = comparer ? memo(CountedView, comparer) : memo(CountedView);
  return { Item, counts };
}

interface RowListProps {
  transcript: ChatMessage[];
  busy: boolean;
  prefs: ChatPrefs;
  Item: FunctionComponent<MessageItemProps>;
}

function RowList({ transcript, busy, prefs, Item }: RowListProps) {
  const lastIdx = transcript.length - 1;
  return h(
    'div',
    null,
    transcript.map((message, i) => {
      const isStreaming = busy && message.role === 'assistant' && message.status === 'streaming';
      const isLastAssistantMessage = busy && message.role === 'assistant' && i === lastIdx;
      return h(Item, {
        key: message.id,
        message,
        isStreaming,
        prefs,
        workingDirectory: '/ws',
        editingId: null,
        onEditRequest: noop,
        onEditConfirm: noop,
        onEditCancel: noop,
        onOpenFile: noop,
        onContextMenu: STABLE_CONTEXT_MENU,
        renderToolCall: STABLE_RENDER_TOOL_CALL,
        isLastAssistantMessage,
        sessionKey: SESSION_PATH,
      });
    }),
  );
}

/** Drive `deltas` streaming snapshots: each delta clones the transcript (fresh
 *  refs, mimicking postMessage) and grows the streaming message's markdown. */
function driveStreamingDeltas(
  baseTranscript: ChatMessage[],
  Item: FunctionComponent<MessageItemProps>,
  deltas: number,
): void {
  let snapshot = baseTranscript;
  act(() => {
    render(h(RowList, { transcript: snapshot, busy: true, prefs: STABLE_PREFS, Item }), container);
  });
  for (let d = 1; d <= deltas; d++) {
    snapshot = structuredClone(snapshot);
    const last = snapshot[snapshot.length - 1];
    last.markdown += `word${d} `;
    last.parts = [{ kind: 'text' as const, text: last.markdown }];
    act(() => {
      render(h(RowList, { transcript: snapshot, busy: true, prefs: STABLE_PREFS, Item }), container);
    });
  }
}

test('Part A: non-streaming rows render exactly once across streaming deltas (barrier holds)', () => {
  const { Item, counts } = makeCountedItem(areMessageItemPropsEqual);
  const base = buildTranscript({ pairs: 4, streaming: true });

  driveStreamingDeltas(base, Item, DELTAS);

  for (const msg of base) {
    if (msg.status === 'streaming') {
      // Initial render + one re-render per delta.
      assert.equal(
        counts.get(msg.id),
        DELTAS + 1,
        `streaming row ${msg.id} should re-render once per delta (got ${counts.get(msg.id)})`,
      );
    } else {
      assert.equal(
        counts.get(msg.id),
        1,
        `non-streaming row ${msg.id} should render exactly once across ${DELTAS} deltas (got ${counts.get(msg.id)})`,
      );
    }
  }
});

test('Part A (control): default shallow memo re-renders every row every delta — the harness catches the original broken barrier', () => {
  // No comparer → Preact's default shallow compare. `message` is a fresh clone
  // every snapshot, so the barrier never holds and every row re-renders every
  // delta. This is the pre-48596cf behaviour; if `areMessageItemPropsEqual`
  // were ever removed or weakened, this is what production would regress to.
  const { Item, counts } = makeCountedItem();
  const base = buildTranscript({ pairs: 4, streaming: true });

  driveStreamingDeltas(base, Item, DELTAS);

  for (const msg of base) {
    assert.equal(
      counts.get(msg.id),
      DELTAS + 1,
      `row ${msg.id} should re-render every delta under default shallow memo (got ${counts.get(msg.id)})`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Part B — useComposerIndicators recomputation count
// ═══════════════════════════════════════════════════════════════════════════

function makeIndicatorsProbe() {
  const tracker = new RefTracker();
  function Probe({ inputs }: { inputs: IndicatorsInputs }) {
    const r = useComposerIndicators(inputs);
    tracker.record('sessionTokenIndicator', r.sessionTokenIndicator);
    tracker.record('contextBreakdown', r.contextBreakdown);
    tracker.record('sessionCostIndicator', r.sessionCostIndicator);
    return null;
  }
  return { Probe, tracker };
}

function stableInputs(overrides: Partial<IndicatorsInputs> = {}): IndicatorsInputs {
  return {
    activeModelId: MODEL_ID,
    activeThinkingLevel: 'off' as ThinkingLevel,
    modelSettings: MODEL_SETTINGS,
    availableModels: AVAILABLE_MODELS,
    contextUsage: null,
    systemPrompts: [] as SystemPromptEntry[],
    transcript: [],
    transcriptWindow: TRANSCRIPT_WINDOW,
    pruningResult: null,
    busy: false,
    sessionPath: SESSION_PATH,
    tokenRateBySession: {},
    ...overrides,
  };
}

test('Part B (streaming): token-usage + context-breakdown recompute is independent of delta count when results are stable', () => {
  // Streaming assistant message growing over DELTAS deltas; contextUsage.tokens
  // is reported (the common case) so the context breakdown's used/remaining
  // values come from the live snapshot, not the growing transcript estimate.
  // buildSessionTokenUsage sums message.usage — the streaming message has none,
  // so its result is stable across deltas and must NOT recompute per delta.
  const { Probe, tracker } = makeIndicatorsProbe();
  const base = buildTranscript({ pairs: 2, streaming: true });
  const contextUsage: ContextWindowUsage = { tokens: 50_000, contextWindow: 200_000, percent: 25 };

  let snapshot = base;
  act(() => {
    render(h(Probe, { inputs: stableInputs({ transcript: snapshot, busy: true, contextUsage }) }), container);
  });
  for (let d = 1; d <= DELTAS; d++) {
    snapshot = structuredClone(snapshot);
    const last = snapshot[snapshot.length - 1];
    last.markdown += `word${d} `;
    last.parts = [{ kind: 'text' as const, text: last.markdown }];
    act(() => {
      render(h(Probe, { inputs: stableInputs({ transcript: snapshot, busy: true, contextUsage }) }), container);
    });
  }

  // Stable-result indicators: recompute exactly once (initial), independent of
  // the 50 deltas. Before the Step 2 fix these recomputed 51× (once per
  // snapshot) because the transcript array ref changed every clone.
  assert.equal(
    tracker.distinct('sessionTokenIndicator'),
    1,
    `sessionTokenIndicator (sums usage; streaming msg has none) must be stable across deltas — got ${tracker.distinct('sessionTokenIndicator')}`,
  );
  assert.equal(
    tracker.distinct('contextBreakdown'),
    1,
    `contextBreakdown (contextUsage.tokens reported → used/remaining derived, not estimated) must be stable across deltas — got ${tracker.distinct('contextBreakdown')}`,
  );

  // The cost indicator legitimately updates while streaming: its live-turn
  // estimate grows with the streaming markdown, so it recomputes per delta.
  // (The Step 2 win here is that the O(transcript) completed-cost + subagent
  // walks inside it no longer re-run per delta — see the next test.)
  assert.ok(
    tracker.distinct('sessionCostIndicator') > 1,
    'sessionCostIndicator should still update per delta while streaming (live estimate grows)',
  );
});

test('Part B (busy, idle transcript): all indicator walks are independent of delta count when results are stable', () => {
  // Busy but NO streaming message (e.g. a tool running between turns): the
  // host still posts snapshots, the transcript ref changes every clone, but
  // every indicator result is byte-stable. This is the clean "stable-result"
  // case for the cost indicator too — its live-turn estimate is null (no
  // streaming message), so the only things that could move it are the
  // O(transcript) completed-cost summary and subagent direct-cost walk, which
  // must now bail.
  const { Probe, tracker } = makeIndicatorsProbe();
  const base = buildTranscriptWithSubagentCall();
  const contextUsage: ContextWindowUsage = { tokens: 40_000, contextWindow: 200_000, percent: 20 };

  let snapshot = base;
  act(() => {
    render(h(Probe, { inputs: stableInputs({ transcript: snapshot, busy: true, contextUsage }) }), container);
  });
  for (let d = 1; d <= DELTAS; d++) {
    // Identical content, fresh refs (the clone-breaks-refs reality).
    snapshot = structuredClone(snapshot);
    act(() => {
      render(h(Probe, { inputs: stableInputs({ transcript: snapshot, busy: true, contextUsage }) }), container);
    });
  }

  assert.equal(
    tracker.distinct('sessionTokenIndicator'),
    1,
    `sessionTokenIndicator must be stable across identical-content clones — got ${tracker.distinct('sessionTokenIndicator')}`,
  );
  assert.equal(
    tracker.distinct('contextBreakdown'),
    1,
    `contextBreakdown must be stable across identical-content clones — got ${tracker.distinct('contextBreakdown')}`,
  );
  assert.equal(
    tracker.distinct('sessionCostIndicator'),
    1,
    `sessionCostIndicator (completed-cost summary + subagent walk now bailing) must be stable — got ${tracker.distinct('sessionCostIndicator')}`,
  );
});

test('Part B: fresh structured-cloned whole-session usage does not reopen transcript cost walks', () => {
  const { Probe, tracker } = makeIndicatorsProbe();
  const base = buildTranscriptWithSubagentCall();
  const durableUsage = buildSessionUsageSnapshot(base);
  const contextUsage: ContextWindowUsage = { tokens: 40_000, contextWindow: 200_000, percent: 20 };

  for (let tick = 0; tick <= DELTAS; tick += 1) {
    act(() => {
      render(h(Probe, {
        inputs: stableInputs({
          transcript: structuredClone(base),
          sessionUsage: structuredClone(durableUsage),
          busy: true,
          contextUsage,
        }),
      }), container);
    });
  }

  assert.equal(
    tracker.distinct('sessionCostIndicator'),
    1,
    'equal whole-session accounting clones must not trigger recursive transcript/subagent cost walks',
  );
});

test('Part B: equal-shaped session switches cannot reuse prior transcript indicators', () => {
  let latest: ReturnType<typeof useComposerIndicators> | undefined;
  function Probe({ inputs }: { inputs: IndicatorsInputs }) {
    latest = useComposerIndicators(inputs);
    return null;
  }
  const first = [
    ...buildTranscriptWithSubagentCall(),
    makeUserMessage('u-tail', 'same tail'),
    makeAssistantMessage('a-tail', 'same tail answer'),
  ];
  const second = structuredClone(first);
  const result = second[1]?.toolCalls?.[0]?.result as { details?: unknown } | undefined;
  const details = result?.details as {
    results?: Array<{ usage?: { cost?: number } }>;
  } | undefined;
  assert.ok(details?.results?.[0]?.usage);
  details.results[0].usage.cost = 0.25;

  act(() => {
    render(h(Probe, { inputs: stableInputs({ sessionPath: '/session/first', transcript: first }) }), container);
  });
  const firstCost = latest?.sessionCostIndicator;
  act(() => {
    render(h(Probe, { inputs: stableInputs({ sessionPath: '/session/second', transcript: second }) }), container);
  });
  const secondCost = latest?.sessionCostIndicator;

  assert.ok(firstCost);
  assert.ok(secondCost);
  assert.notEqual(secondCost.tooltip, firstCost.tooltip, 'the second session must expose its own historical subagent cost');
});

test('Part B: recompute count is independent of transcript length for stable results', () => {
  // The same idle-busy scenario at two transcript lengths (4 vs 40 messages)
  // must recompute each indicator the same number of times (~1). Before the
  // Step 2 fix, each recompute walked the whole transcript, so the cost grew
  // with length — this asserts the walks no longer scale with transcript size.
  function runLength(pairs: number): { token: number; breakdown: number; cost: number } {
    const freshContainer = document.createElement('div');
    document.body.appendChild(freshContainer);
    try {
      const { Probe, tracker } = makeIndicatorsProbe();
      const base: ChatMessage[] = [];
      for (let i = 0; i < pairs; i++) {
        base.push(makeUserMessage(`u-${i}`, `User ${i}`));
        base.push(makeAssistantMessage(`a-${i}`, `Assistant ${i}. `.repeat(4)));
      }
      const contextUsage: ContextWindowUsage = { tokens: 40_000, contextWindow: 200_000, percent: 20 };
      let snapshot = base;
      act(() => {
        render(h(Probe, { inputs: stableInputs({ transcript: snapshot, busy: true, contextUsage }) }), freshContainer);
      });
      for (let d = 1; d <= DELTAS; d++) {
        snapshot = structuredClone(snapshot);
        act(() => {
          render(h(Probe, { inputs: stableInputs({ transcript: snapshot, busy: true, contextUsage }) }), freshContainer);
        });
      }
      return {
        token: tracker.distinct('sessionTokenIndicator'),
        breakdown: tracker.distinct('contextBreakdown'),
        cost: tracker.distinct('sessionCostIndicator'),
      };
    } finally {
      render(null, freshContainer);
      freshContainer.remove();
    }
  }

  const short = runLength(2);
  const long = runLength(20);

  assert.equal(short.token, 1, `short transcript token-usage recompute should be 1 — got ${short.token}`);
  assert.equal(long.token, 1, `long transcript token-usage recompute should be 1 — got ${long.token}`);
  assert.equal(short.breakdown, 1, `short breakdown recompute should be 1 — got ${short.breakdown}`);
  assert.equal(long.breakdown, 1, `long breakdown recompute should be 1 — got ${long.breakdown}`);
  assert.equal(short.cost, 1, `short cost-indicator recompute should be 1 — got ${short.cost}`);
  assert.equal(long.cost, 1, `long cost-indicator recompute should be 1 — got ${long.cost}`);
  // The whole point: recompute count does not grow with transcript length.
  assert.equal(short.token, long.token, 'token-usage recompute must not scale with transcript length');
  assert.equal(short.breakdown, long.breakdown, 'breakdown recompute must not scale with transcript length');
  assert.equal(short.cost, long.cost, 'cost-indicator recompute must not scale with transcript length');
});
