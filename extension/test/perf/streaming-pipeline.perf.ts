/**
 * Streaming-pipeline performance harness for pie.
 *
 * Feeds mocked backend streaming events (busy.changed → message.started →
 * N×message.delta → message.thinking → tool calls → message.finished) through
 * the REAL CQRS pipeline:
 *
 *   dispatch()          ── pure reducer (O(transcript) find per delta today)
 *   selectViewState()   ── pure projection (memoized; O(1) on unchanged-delta
 *                          posts, O(transcript) recompute on a genuine delta)
 *   buildStateEnvelope()── pure snapshot builder
 *   structuredClone()    ── proxy for webview.postMessage clone cost
 *
 * It runs the current orchestration (no projection in `scheduleRender`; one
 * `getViewState` in `postState`) and retains the former extra-projection path
 * as a labelled legacy comparison. The pure-function costs (reducer lookup,
 * projection, envelope construction, clone) are measured against real source,
 * so source changes move those numbers automatically.
 *
 * Run:   npx tsx ./test/perf/streaming-pipeline.perf.ts
 *        (also: `npm run perf` from extension/)
 *
 * Not swept by `npm test` (file is *.perf.ts, not *.test.ts), so it never runs
 * in CI. Writes a timestamped JSON report to ./test/perf/reports/.
 */

import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../../src/host/core/arch-state';
import { dispatch } from '../../src/host/core/dispatch';
import { selectViewState } from '../../src/host/core/projection';
import {
  buildStateEnvelope,
  createSidebarSyncState,
  type SidebarSyncState,
} from '../../src/host/sidebar/sync';
import type { Event } from '../../src/host/core/events';
import type { ChatMessage, ToolCall, ViewState } from '../../src/shared/protocol';

// ─── Scenario constants ─────────────────────────────────────────────────────

const SESSION_PATH = '/ws/perf-session';
const REQUEST_ID = 'req-perf';
const MESSAGE_ID = 'msg-perf';
const DELTA_COUNT = 200; // deltas per simulated reply
const THINKING_COUNT = 4;
const TOOL_CYCLES = 2; // tool.started → 4× progress → tool.finished each
const TOOL_PROGRESS_PER_CYCLE = 4;
const TRANSCRIPT_LENGTHS = [0, 100, 400, 1000];
const TOOL_LOOKUP_ITERS = 5000;

// ─── Orchestration mode (legacy vs current) ──────────────────────────────────
//
// `legacy` preserves the former extra scheduleRender/postState projection work
// for before/after comparison. `current` mirrors source today: status bar and
// boot logging read ArchState directly, and postState computes ViewState once.

interface OrchestrationMode {
  name: string;
  scheduleRenderDoubleProjection: boolean;
  postStateDoubleProjection: boolean;
}

const BASELINE: OrchestrationMode = {
  name: 'legacy',
  scheduleRenderDoubleProjection: true,
  postStateDoubleProjection: true,
};
const FIXED_ORCH: OrchestrationMode = {
  name: 'current',
  scheduleRenderDoubleProjection: false,
  postStateDoubleProjection: false,
};

// ─── Timings accumulator ──────────────────────────────────────────────────────

interface Acc {
  reducerUs: number; // sum of dispatch() time
  projectionUs: number; // sum of selectViewState() time (all calls)
  projectionCalls: number;
  postUs: number; // getViewState#1 + buildStateEnvelope + clone
  postCloneUs: number; // structuredClone of the posted message
  postCount: number;
  events: number;
  deltas: number;
}

function newAcc(): Acc {
  return {
    reducerUs: 0,
    projectionUs: 0,
    projectionCalls: 0,
    postUs: 0,
    postCloneUs: 0,
    postCount: 0,
    events: 0,
    deltas: 0,
  };
}

// ─── Transcript seeding ──────────────────────────────────────────────────────

function setupActiveSession(state: ArchState): ArchState {
  return produce(state, (draft) => {
    draft.sessions.sessions.push({
      path: SESSION_PATH,
      name: 'Perf',
      cwd: '/ws',
      modifiedAt: '2026-01-01T00:00:00Z',
      messageCount: 0,
      isPlaceholder: false,
    });
    if (!draft.sessions.openTabPaths.includes(SESSION_PATH)) {
      draft.sessions.openTabPaths.push(SESSION_PATH);
    }
    draft.sessions.activeSessionPath = SESSION_PATH;
    if (!draft.sessions.runningSessionPaths.includes(SESSION_PATH)) {
      draft.sessions.runningSessionPaths.push(SESSION_PATH);
    }
    draft.transcript.bySession[SESSION_PATH] = [];
    draft.transcript.windowBySession[SESSION_PATH] = {
      totalCount: 0,
      loadedStart: 0,
      loadedEnd: 0,
      hasOlder: false,
      hasNewer: false,
      isPartial: false,
      hasUserMessages: false,
    };
  });
}

/** Seed `n` prior completed messages (alternating user/assistant; every 5th
 *  assistant carries 1–2 completed tool calls). Returns the seeded state plus
 *  the list of all tool-call ids present (for the lookup micro-bench). */
function seedTranscript(state: ArchState, n: number): { state: ArchState; toolCallIds: string[] } {
  const toolCallIds: string[] = [];
  const state0 = produce(state, (draft) => {
    const list = draft.transcript.bySession[SESSION_PATH]!;
    for (let i = 0; i < n; i++) {
      const isAssistant = i % 2 === 1;
      const id = `seed-${i}`;
      if (isAssistant) {
        const toolCalls: ToolCall[] = [];
        if (i % 5 === 0) {
          for (let k = 0; k < 1 + (i % 2); k++) {
            const tcId = `seed-tool-${i}-${k}`;
            toolCalls.push({
              id: tcId,
              name: 'bash',
              input: { command: 'echo hi' },
              result: 'hi',
              status: 'completed',
              startedAt: 1700000000000 + i,
              durationMs: 12 + k,
            });
            toolCallIds.push(tcId);
          }
        }
        const msg: ChatMessage = {
          id,
          role: 'assistant',
          createdAt: new Date(1700000000000 + i * 1000).toISOString(),
          markdown: `Assistant message number ${i}. `.repeat(8),
          parts: [{ kind: 'text', text: `Assistant message number ${i}.` }],
          status: 'completed',
          toolCalls,
        };
        list.push(msg);
      } else {
        list.push({
          id,
          role: 'user',
          createdAt: new Date(1700000000000 + i * 1000).toISOString(),
          markdown: `User message number ${i}. `.repeat(6),
          status: 'completed',
        });
      }
    }
    // Keep the window covering the whole transcript so projection reports it loaded.
    const w = draft.transcript.windowBySession[SESSION_PATH]!;
    w.totalCount = n;
    w.loadedEnd = n;
    w.hasUserMessages = n > 0;
  });
  return { state: state0, toolCallIds };
}

// ─── Reply event generator ───────────────────────────────────────────────────

function buildReplyEvents(): Event[] {
  const events: Event[] = [];
  events.push({ kind: 'BusyChanged', sessionPath: SESSION_PATH, running: true });
  events.push({
    kind: 'MessageStarted',
    sessionPath: SESSION_PATH,
    messageId: MESSAGE_ID,
    requestId: REQUEST_ID,
    modelId: 'perf-model',
    thinkingLevel: 'medium',
    timestamp: Date.now(),
  });
  for (let i = 0; i < DELTA_COUNT; i++) {
    events.push({
      kind: 'MessageDelta',
      sessionPath: SESSION_PATH,
      messageId: MESSAGE_ID,
      delta: `word${i} `,
    });
  }
  for (let i = 0; i < THINKING_COUNT; i++) {
    events.push({
      kind: 'MessageThinking',
      sessionPath: SESSION_PATH,
      messageId: MESSAGE_ID,
      thinking: `reasoning step ${i} `.repeat(10),
    });
  }
  for (let c = 0; c < TOOL_CYCLES; c++) {
    const tcId = `perf-tool-${c}`;
    events.push({
      kind: 'ToolCall',
      sessionPath: SESSION_PATH,
      messageId: MESSAGE_ID,
      toolCall: {
        id: tcId,
        name: 'bash',
        input: { command: `ls -la /ws/${c}` },
        status: 'running',
        startedAt: Date.now(),
      },
    });
    for (let p = 0; p < TOOL_PROGRESS_PER_CYCLE; p++) {
      events.push({
        kind: 'ToolCall',
        sessionPath: SESSION_PATH,
        messageId: MESSAGE_ID,
        toolCall: { id: tcId, name: 'bash', input: { command: `ls -la /ws/${c}` }, status: 'running' },
      });
    }
    events.push({
      kind: 'ToolCall',
      sessionPath: SESSION_PATH,
      messageId: MESSAGE_ID,
      toolCall: {
        id: tcId,
        name: 'bash',
        input: { command: `ls -la /ws/${c}` },
        result: `output for tool ${c}`,
        status: 'completed',
        durationMs: 42,
      },
    });
  }
  events.push({
    kind: 'MessageFinished',
    sessionPath: SESSION_PATH,
    message: {
      id: MESSAGE_ID,
      role: 'assistant',
      createdAt: new Date().toISOString(),
      markdown: 'Final perf answer. ' + 'content '.repeat(40),
      parts: [{ kind: 'text', text: 'Final perf answer.' }],
      status: 'completed',
      durationMs: 800,
    },
  });
  events.push({ kind: 'BusyChanged', sessionPath: SESSION_PATH, running: false });
  return events;
}

// ─── Pipeline steps (timed) ──────────────────────────────────────────────────

/** Replicates `PieExtension.dispatchArchEvent` + `scheduleRender` for one event. */
function stepEvent(state: ArchState, event: Event, mode: OrchestrationMode, acc: Acc): ArchState {
  const t0 = performance.now();
  const result = dispatch(state, event);
  state = result.state;
  const t1 = performance.now();
  acc.reducerUs += (t1 - t0) * 1000;
  acc.events++;
  if (event.kind === 'MessageDelta') acc.deltas++;

  // Legacy scheduleRender paid TWO full projections per event.
  if (mode.scheduleRenderDoubleProjection) {
    const p0 = performance.now();
    selectViewState(state); // sync (bootLog fields only)
    const p1 = performance.now();
    acc.projectionUs += (p1 - p0) * 1000;
    acc.projectionCalls++;
    const p2 = performance.now();
    selectViewState(state); // microtask (status bar: needs notice + runningSessionPaths.length)
    const p3 = performance.now();
    acc.projectionUs += (p3 - p2) * 1000;
    acc.projectionCalls++;
  }
  // Current mode: status bar reads archState.settings.notice + .sessions.runningSessionPaths.length
  // directly; bootLog reads archState fields. No projection. (scheduleState still queues a post.)
  return state;
}

/** Replicates `SidebarViewProvider.postState` for one debounced post. */
function stepPost(state: ArchState, syncState: SidebarSyncState, mode: OrchestrationMode, acc: Acc): SidebarSyncState {
  const t0 = performance.now();
  const vs1 = selectViewState(state); // for the envelope
  const result = buildStateEnvelope(syncState, vs1, true);
  syncState = result.nextSyncState;
  const t1 = performance.now();
  acc.postUs += (t1 - t0) * 1000;
  acc.projectionUs += (t1 - t0) * 1000; // getViewState#1 is a projection call
  acc.projectionCalls++;

  if (mode.postStateDoubleProjection) {
    const w0 = performance.now();
    selectViewState(state); // bootLog only — WASTE
    const w1 = performance.now();
    acc.projectionUs += (w1 - w0) * 1000;
    acc.projectionCalls++;
  }

  if (result.message) {
    const c0 = performance.now();
    structuredClone(result.message); // proxy for webview.postMessage structured clone
    const c1 = performance.now();
    acc.postUs += (c1 - c0) * 1000;
    acc.postCloneUs += (c1 - c0) * 1000;
  }
  acc.postCount++;
  return syncState;
}

interface RunResult {
  transcriptLen: number;
  mode: string;
  regime: 'burst' | 'slow-stream';
  perDeltaReducerUs: number;
  perDeltaProjectionUs: number;
  perDeltaSyncUs: number; // reducer + projection (the per-delta main-thread cost)
  projectionCallsPerDelta: number;
  postCount: number;
  postUs: number;
  postCloneUs: number;
  viewStateJsonBytes: number;
}

function runScenario(
  seedState: ArchState,
  mode: OrchestrationMode,
  regime: 'burst' | 'slow-stream',
): RunResult {
  // Build fresh events per run: handleMessageFinished embeds `event.message`
  // into the Immer-produced state, and Immer auto-freezes it on return.
  // Reusing a frozen event object across runs (warmup + real) crashes on the
  // toolCalls assignment. Production parses a fresh event per backend line.
  const replyEvents = buildReplyEvents();
  let state = seedState;
  let syncState = createSidebarSyncState('perf-host');
  const acc = newAcc();

  for (const event of replyEvents) {
    state = stepEvent(state, event, mode, acc);
    if (regime === 'slow-stream' && event.kind === 'MessageDelta') {
      // deltas >50ms apart → every delta flushes its own post (debounce never coalesces)
      syncState = stepPost(state, syncState, mode, acc);
    }
  }
  if (regime === 'burst') {
    // all deltas coalesce into a single debounced post after the stream settles
    syncState = stepPost(state, syncState, mode, acc);
  }

  const viewState: ViewState = selectViewState(state);
  const viewStateJsonBytes = Buffer.byteLength(JSON.stringify(viewState), 'utf8');
  const deltas = Math.max(acc.deltas, 1);

  return {
    transcriptLen: (seedState.transcript.bySession[SESSION_PATH] ?? []).length,
    mode: mode.name,
    regime,
    perDeltaReducerUs: acc.reducerUs / deltas,
    perDeltaProjectionUs: acc.projectionUs / deltas,
    perDeltaSyncUs: (acc.reducerUs + acc.projectionUs) / deltas,
    projectionCallsPerDelta: acc.projectionCalls / deltas,
    postCount: acc.postCount,
    postUs: acc.postUs,
    postCloneUs: acc.postCloneUs,
    viewStateJsonBytes,
  };
}

// ─── Tool-call lookup micro-bench (bottleneck #4: onToolFinished/Progress) ────

interface ToolLookupResult {
  transcriptLen: number;
  baselineLookupUs: number; // flatMap+find per lookup
  fixedLookupUs: number; // Map.get per lookup (index built once)
  iters: number;
}

function benchToolLookup(transcript: ChatMessage[], toolCallIds: string[]): ToolLookupResult {
  const iters = TOOL_LOOKUP_ITERS;
  // Baseline: the exact expression in handlers/tools.ts
  const b0 = performance.now();
  for (let i = 0; i < iters; i++) {
    const id = toolCallIds[i % toolCallIds.length];
    transcript.flatMap((m) => m.toolCalls ?? []).find((tc) => tc.id === id);
  }
  const b1 = performance.now();

  // Fixed: index built once (in reality maintained incrementally on ToolCall events)
  const idx = new Map<string, ToolCall>();
  for (const m of transcript) for (const tc of m.toolCalls ?? []) idx.set(tc.id, tc);
  const f0 = performance.now();
  for (let i = 0; i < iters; i++) {
    const id = toolCallIds[i % toolCallIds.length];
    idx.get(id);
  }
  const f1 = performance.now();

  return {
    transcriptLen: transcript.length,
    baselineLookupUs: ((b1 - b0) * 1000) / iters,
    fixedLookupUs: ((f1 - f0) * 1000) / iters,
    iters,
  };
}

// ─── Median-of-trials wrapper (reduces run-to-run JIT/GC noise) ───────────────

const TRIALS = 11;

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function runMedian(
  seedState: ArchState,
  mode: OrchestrationMode,
  regime: 'burst' | 'slow-stream',
  trials = TRIALS,
): RunResult {
  runScenario(seedState, mode, regime); // warmup (JIT)
  const samples: RunResult[] = [];
  for (let i = 0; i < trials; i++) samples.push(runScenario(seedState, mode, regime));
  const pick = (k: 'perDeltaReducerUs' | 'perDeltaProjectionUs' | 'perDeltaSyncUs' | 'projectionCallsPerDelta' | 'postUs' | 'postCloneUs'): number =>
    median(samples.map((s) => s[k] as number));
  return {
    transcriptLen: samples[0].transcriptLen,
    mode: mode.name,
    regime,
    perDeltaReducerUs: pick('perDeltaReducerUs'),
    perDeltaProjectionUs: pick('perDeltaProjectionUs'),
    perDeltaSyncUs: pick('perDeltaSyncUs'),
    projectionCallsPerDelta: pick('projectionCallsPerDelta'),
    postCount: samples[0].postCount,
    postUs: pick('postUs'),
    postCloneUs: pick('postCloneUs'),
    viewStateJsonBytes: samples[0].viewStateJsonBytes,
  };
}

// ─── Reducer-internals isolation bench ────────────────────────────────────────
// Attributes per-delta reducer cost to (a) bare Immer produce overhead,
// (b) the O(n) find through an Immer draft (today's handleMessageDelta),
// (c) a raw find with no draft, and (d) an indexed lookup. Tells us whether
// a messageId→index fix actually moves the reducer number or whether Immer
// structural-copy overhead dominates regardless.

interface ReducerInternalsResult {
  transcriptLen: number;
  noopProduceUs: number;
  produceFindDraftUs: number;
  rawFindUs: number;
  indexedUs: number;
}

function benchReducerInternals(seeded: ArchState, n: number): ReducerInternalsResult {
  const sp = SESSION_PATH;
  const list = seeded.transcript.bySession[sp] ?? [];
  const id = list.length ? list[list.length - 1].id : 'nope';
  const iters = 1000;

  let t = performance.now();
  for (let i = 0; i < iters; i++) produce(seeded, () => {});
  const noopUs = ((performance.now() - t) * 1000) / iters;

  t = performance.now();
  for (let i = 0; i < iters; i++) {
    produce(seeded, (d) => {
      d.transcript.bySession[sp]?.find((m: ChatMessage) => m.id === id);
    });
  }
  const produceFindDraftUs = ((performance.now() - t) * 1000) / iters;

  t = performance.now();
  for (let i = 0; i < iters; i++) {
    list.find((m) => m.id === id);
  }
  const rawFindUs = ((performance.now() - t) * 1000) / iters;

  const idx = new Map<string, number>();
  list.forEach((m, i) => idx.set(m.id, i));
  t = performance.now();
  for (let i = 0; i < iters; i++) idx.get(id);
  const indexedUs = ((performance.now() - t) * 1000) / iters;

  return { transcriptLen: n, noopProduceUs: noopUs, produceFindDraftUs, rawFindUs, indexedUs };
}

// ─── Output formatting ───────────────────────────────────────────────────────

function fmt(us: number): string {
  if (us >= 1000) return `${(us / 1000).toFixed(2)}ms`;
  return `${us.toFixed(2)}µs`;
}

function printRunTable(rows: RunResult[]): void {
  console.log('\n=== Per-delta streaming cost (reducer + projection) ===');
  console.log(
    'len  | mode        | regime      | reducer/delta | projection/delta | projCalls/delta | sync/delta  | posts | post cost  | clone cost | VS json KB',
  );
  console.log('-'.repeat(150));
  for (const r of rows) {
    console.log(
      [
        String(r.transcriptLen).padStart(4),
        r.mode.padEnd(11),
        r.regime.padEnd(11),
        fmt(r.perDeltaReducerUs).padStart(13),
        fmt(r.perDeltaProjectionUs).padStart(16),
        r.projectionCallsPerDelta.toFixed(2).padStart(15),
        fmt(r.perDeltaSyncUs).padStart(11),
        String(r.postCount).padStart(5),
        fmt(r.postUs).padStart(9),
        fmt(r.postCloneUs).padStart(11),
        (r.viewStateJsonBytes / 1024).toFixed(1).padStart(10),
      ].join(' | '),
    );
  }
}

function printScaling(rows: RunResult[]): void {
  console.log('\n=== O(n) scaling check: per-delta sync cost vs transcript length (burst, current) ===');
  const burst = rows.filter((r) => r.regime === 'burst' && r.mode === 'current');
  if (burst.length < 2) return;
  const base = burst[0].perDeltaSyncUs;
  for (const r of burst) {
    const factor = r.perDeltaSyncUs / base;
    console.log(
      `  len=${String(r.transcriptLen).padStart(4)}  sync/delta=${fmt(r.perDeltaSyncUs).padStart(10)}  ×${factor.toFixed(2)} vs len=0`,
    );
  }
}

function printToolLookup(rows: ToolLookupResult[]): void {
  console.log('\n=== Tool-call lookup micro-bench (onToolFinished/Progress hot expression) ===');
  console.log('len  | baseline (flatMap+find) | fixed (Map.get) | speedup');
  console.log('-'.repeat(70));
  for (const r of rows) {
    const speedup = r.baselineLookupUs / Math.max(r.fixedLookupUs, 0.001);
    console.log(
      [
        String(r.transcriptLen).padStart(4),
        fmt(r.baselineLookupUs).padStart(23),
        fmt(r.fixedLookupUs).padStart(16),
        `×${speedup.toFixed(1)}`.padStart(8),
      ].join(' | '),
    );
  }
}

function printReducerInternals(rows: ReducerInternalsResult[]): void {
  console.log('\n=== Reducer-internals isolation (per single op) ===');
  console.log('len  | noop produce | produce+find(draft) | raw find | indexed | find share of produce+find');
  console.log('-'.repeat(95));
  for (const r of rows) {
    const findShare = r.produceFindDraftUs > 0 ? (r.produceFindDraftUs - r.noopProduceUs) / r.produceFindDraftUs : 0;
    console.log(
      [
        String(r.transcriptLen).padStart(4),
        fmt(r.noopProduceUs).padStart(13),
        fmt(r.produceFindDraftUs).padStart(20),
        fmt(r.rawFindUs).padStart(9),
        fmt(r.indexedUs).padStart(8),
        `${(findShare * 100).toFixed(0)}%`.padStart(8),
      ].join(' | '),
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  console.log('pie streaming-pipeline perf harness');
  console.log(`scenario: ${DELTA_COUNT} deltas + ${THINKING_COUNT} thinking + ${TOOL_CYCLES} tool cycles + finish`);
  console.log(`transcript lengths: ${TRANSCRIPT_LENGTHS.join(', ')}`);

  const runRows: RunResult[] = [];
  const toolRows: ToolLookupResult[] = [];
  const reducerInternalsRows: ReducerInternalsResult[] = [];

  for (const n of TRANSCRIPT_LENGTHS) {
    const base = setupActiveSession(createInitialArchState());
    const { state: seeded, toolCallIds } = seedTranscript(base, n);
    const transcript = seeded.transcript.bySession[SESSION_PATH] ?? [];

    for (const mode of [BASELINE, FIXED_ORCH]) {
      for (const regime of ['burst', 'slow-stream'] as const) {
        const result = runMedian(seeded, mode, regime);
        runRows.push(result);
      }
    }

    reducerInternalsRows.push(benchReducerInternals(seeded, n));

    if (toolCallIds.length > 0) {
      toolRows.push(benchToolLookup(transcript, toolCallIds));
    }
  }

  printRunTable(runRows);
  printScaling(runRows);
  printToolLookup(toolRows);
  printReducerInternals(reducerInternalsRows);

  // Write JSON report
  const here = dirname(fileURLToPath(import.meta.url));
  const reportsDir = join(here, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    scenario: { DELTA_COUNT, THINKING_COUNT, TOOL_CYCLES, TRANSCRIPT_LENGTHS },
    runs: runRows,
    toolLookups: toolRows,
    reducerInternals: reducerInternalsRows,
  };
  const reportPath = join(reportsDir, `streaming-pipeline-${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport written: ${reportPath}`);
}

void main();
