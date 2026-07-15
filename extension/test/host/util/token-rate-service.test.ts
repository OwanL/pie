import assert from 'node:assert/strict';
import test from 'node:test';

import type { ActiveRunSummary, ChatMessage } from '../../../src/shared/protocol';
import type { ArchState } from '../../../src/host/core/arch-state';
import { TokenRateService } from '../../../src/host/token-rate-service';
import { encode as bpeEncode, decode as bpeDecode } from 'gpt-tokenizer/encoding/cl100k_base';

const BASE_NOW = 1_700_000_0000;

const TOKEN_BASE = bpeEncode('The quick brown fox jumps over the lazy dog. '.repeat(1000));

/** Build text that tokenizes to exactly `tokens` cl100k_base tokens. */
function tokenText(tokens: number): string {
  if (tokens <= 0) return '';
  return bpeDecode(TOKEN_BASE.slice(0, Math.min(tokens, TOKEN_BASE.length)));
}

function streamingMessage(id: string, chars: number): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: tokenText(Math.round(chars / 4)),
    status: 'streaming',
    toolCalls: [],
  };
}

/** A finished assistant turn carrying the full turn-latency breakdown. */
function finishedTurn(id: string, latency: {
  turnLatencyMs: number;
  overheadMs: number;
  providerLatencyMs: number;
}): ChatMessage {
  return {
    ...streamingMessage(id, 4),
    status: 'completed',
    markdown: 'done',
    turnLatencyMs: latency.turnLatencyMs,
    overheadMs: latency.overheadMs,
    providerLatencyMs: latency.providerLatencyMs,
  };
}

function runSummary(runId: string): ActiveRunSummary {
  // Only runId is read by the service; the rest is shape-only.
  return { runId } as unknown as ActiveRunSummary;
}

/** A mutable ArchState stand-in the test drives directly. */
function makeArchState(overrides: {
  openTabs?: string[];
  running?: string[];
  active?: string | null;
  transcripts?: Record<string, ChatMessage[]>;
  runSummaries?: Record<string, ActiveRunSummary | null>;
}): ArchState {
  const openTabs = overrides.openTabs ?? [];
  const running = overrides.running ?? [];
  return {
    sessions: {
      sessions: [],
      openTabPaths: openTabs,
      pinnedTabPaths: [],
      runningSessionPaths: running,
      unreadFinishedSessionPaths: [],
      activeSessionPath: overrides.active ?? null,
      workspaceCwd: null,
      analyticsFactorsBySession: {},
    },
    transcript: {
      bySession: overrides.transcripts ?? {},
      windowBySession: {},
      systemPromptsBySession: {},
      editingMessageIdBySession: {},
    },
    composer: {
      activeRunSummaryBySession: overrides.runSummaries ?? {},
    },
  } as unknown as ArchState;
}

test('background (non-active) session is measured continuously: switching back does not restart the average', () => {
  // Session A generates 100 tok/s; session B is the active/selected tab the
  // whole time. Before the fix the webview only ever received the active
  // session's transcript, so it could not measure A while B was selected —
  // switching back to A restarted the average. The host service ticks A every
  // tick regardless of which session is active.
  let arch = makeArchState({
    openTabs: ['/a', '/b'],
    running: ['/a'],
    active: '/b', // B is selected; A runs in the background
    transcripts: { '/a': [streamingMessage('a1', 0)] },
    runSummaries: { '/a': runSummary('r1') },
  });
  const service = new TokenRateService({
    getArchState: () => arch,
    onActiveRateChanged: () => {},
  });

  // A produces 100 tokens/s (400 chars/s) across three ticks while B is active.
  service.tick(BASE_NOW);                          // empty -> paused (TTFT)
  arch.transcript.bySession['/a'] = [streamingMessage('a1', 400)];
  service.tick(BASE_NOW + 1000);                   // 100 tokens -> generating
  arch.transcript.bySession['/a'] = [streamingMessage('a1', 800)];
  service.tick(BASE_NOW + 2000);                   // 200 tokens -> ~100 tok/s

  const bgRate = service.getRate('/a');
  assert.equal(bgRate.state, 'generating');
  assert.equal(bgRate.liveOutputTokens, 200, 'current unreported output is exposed for live analytics');
  const rate = Number.parseFloat(bgRate.label.replace(/[^\d.]/g, ''));
  assert.ok(rate >= 90 && rate <= 110, `expected ~100 tok/s for background session, got ${rate}`);

  // Now switch the active session to A. The rate must reflect the continuous
  // measurement — it must NOT restart from "measuring" (history was retained).
  arch = makeArchState({
    openTabs: ['/a', '/b'],
    running: ['/a'],
    active: '/a',
    transcripts: { '/a': [streamingMessage('a1', 800)] },
    runSummaries: { '/a': runSummary('r1') },
  });
  const afterSwitch = service.getRate('/a');
  assert.equal(afterSwitch.state, 'generating');
  const rateAfterSwitch = Number.parseFloat(afterSwitch.label.replace(/[^\d.]/g, ''));
  assert.ok(
    rateAfterSwitch >= 90 && rateAfterSwitch <= 110,
    `expected ~100 tok/s to continue after switching back, got ${rateAfterSwitch}`,
  );
});

test('a finished run transitions to paused (not frozen on generating) and the state is retained while the tab stays open', () => {
  let arch = makeArchState({
    openTabs: ['/a'],
    running: ['/a'],
    active: '/a',
    transcripts: { '/a': [streamingMessage('a1', 0)] },
    runSummaries: { '/a': runSummary('r1') },
  });
  const service = new TokenRateService({
    getArchState: () => arch,
    onActiveRateChanged: () => {},
  });

  service.tick(BASE_NOW);
  arch.transcript.bySession['/a'] = [streamingMessage('a1', 400)];
  service.tick(BASE_NOW + 1000); // generating ~100 tok/s (1st sample)
  arch.transcript.bySession['/a'] = [streamingMessage('a1', 800)];
  service.tick(BASE_NOW + 2000); // generating ~100 tok/s (2nd sample -> rate)
  assert.equal(service.getRate('/a').state, 'generating');

  // Run finishes: session leaves runningSessionPaths, streaming message completes.
  arch = makeArchState({
    openTabs: ['/a'],
    running: [],
    active: '/a',
    transcripts: { '/a': [{ ...streamingMessage('a1', 800), status: 'completed' }] },
    runSummaries: { '/a': runSummary('r1') },
  });
  service.tick(BASE_NOW + 3000); // final tick -> paused, last rate held
  const finished = service.getRate('/a');
  assert.equal(finished.state, 'paused');
  // Last rate is retained (held) so the indicator shows the held value, not idle.
  assert.match(finished.label, /tok\/s/);

  // A subsequent tick must not keep transitioning / re-measuring a finished run.
  service.tick(BASE_NOW + 4000);
  assert.equal(service.getRate('/a').state, 'paused');
});

test('a new run in an existing session resets the accumulator', () => {
  let arch = makeArchState({
    openTabs: ['/a'],
    running: ['/a'],
    active: '/a',
    transcripts: { '/a': [streamingMessage('a1', 400)] },
    runSummaries: { '/a': runSummary('r1') },
  });
  const service = new TokenRateService({
    getArchState: () => arch,
    onActiveRateChanged: () => {},
  });
  service.tick(BASE_NOW);
  service.tick(BASE_NOW + 1000);
  assert.equal(service.getRate('/a').state, 'generating');

  // A brand-new run (new runId) starts; the previous accumulator must reset.
  arch = makeArchState({
    openTabs: ['/a'],
    running: ['/a'],
    active: '/a',
    transcripts: { '/a': [streamingMessage('a2', 0)] }, // new streaming message, empty (TTFT)
    runSummaries: { '/a': runSummary('r2') },
  });
  service.tick(BASE_NOW + 2000);
  const reset = service.getRate('/a');
  assert.equal(reset.state, 'paused'); // empty new message -> paused until output flows
  assert.equal(reset.label, '—');
});

test('onActiveRateChanged fires only when the active session display changes', () => {
  const arch = makeArchState({
    openTabs: ['/a'],
    running: ['/a'],
    active: '/a',
    transcripts: { '/a': [streamingMessage('a1', 0)] },
    runSummaries: { '/a': runSummary('r1') },
  });
  let changeCount = 0;
  const service = new TokenRateService({
    getArchState: () => arch,
    onActiveRateChanged: () => { changeCount += 1; },
  });

  service.tick(BASE_NOW);            // idle -> paused (TTFT): change
  service.tick(BASE_NOW + 1000);     // still empty, still paused: no change
  arch.transcript.bySession['/a'] = [streamingMessage('a1', 400)];
  service.tick(BASE_NOW + 2000);     // paused -> generating: change
  service.tick(BASE_NOW + 3000);     // generating, rate may fluctuate -> change(s)
  assert.ok(changeCount >= 2, `expected at least 2 active-rate change notifications, got ${changeCount}`);
});

test('onRatesTick fires for aggregate-relevant changes but not unchanged idle/tool ticks', () => {
  const arch = makeArchState({
    openTabs: ['/a'],
    running: ['/a'],
    active: '/a',
    transcripts: { '/a': [streamingMessage('a1', 0)] },
    runSummaries: { '/a': runSummary('r1') },
  });
  let aggregateTicks = 0;
  const service = new TokenRateService({
    getArchState: () => arch,
    onActiveRateChanged: () => {},
    onRatesTick: () => { aggregateTicks += 1; },
  });

  service.tick(BASE_NOW);
  assert.equal(aggregateTicks, 1);
  service.tick(BASE_NOW + 200);
  assert.equal(aggregateTicks, 1, 'unchanged paused state does not rebuild aggregate charts');
  arch.transcript.bySession['/a'] = [streamingMessage('a1', 400)];
  service.tick(BASE_NOW + 400);
  assert.equal(aggregateTicks, 2, 'new live output requests a fast aggregate refresh');
});

test('a closed session is dropped from the measured set', () => {
  let arch = makeArchState({
    openTabs: ['/a'],
    running: ['/a'],
    active: '/a',
    transcripts: { '/a': [streamingMessage('a1', 400)] },
    runSummaries: { '/a': runSummary('r1') },
  });
  const service = new TokenRateService({
    getArchState: () => arch,
    onActiveRateChanged: () => {},
  });
  service.tick(BASE_NOW);
  assert.equal(service.getRate('/a').state, 'generating');

  // Close the tab: it leaves openTabPaths entirely.
  arch = makeArchState({
    openTabs: [],
    running: [],
    active: null,
    transcripts: {},
    runSummaries: {},
  });
  service.tick(BASE_NOW + 1000);
  assert.equal(service.getRate('/a').state, 'idle');
});

test('a loaded (non-running) session surfaces its average turn latency even with no active generation', () => {
  // A transcript opened from disk (or restored after a window reload) is not in
  // `runningSessionPaths`, so without idle-state seeding the speed chip would
  // fall back to the bare IDLE placeholder ('—') even though its finished turns
  // carry a measured latency. The host seeds a latency-bearing idle state so
  // the average stays visible until the next run.
  const arch = makeArchState({
    openTabs: ['/a'],
    running: [],
    active: '/a',
    transcripts: {
      '/a': [
        finishedTurn('f1', { turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
        finishedTurn('f2', { turnLatencyMs: 2_000, overheadMs: 300, providerLatencyMs: 1_700 }),
      ],
    },
  });
  let changeCount = 0;
  const service = new TokenRateService({
    getArchState: () => arch,
    onActiveRateChanged: () => { changeCount += 1; },
  });

  service.tick(BASE_NOW);
  const idle = service.getRate('/a');
  assert.equal(idle.state, 'idle');
  assert.equal(idle.paused, false);
  // Inline: avg turn latency = (1000 + 2000) / 2 = 1500ms -> 1.5s.
  assert.equal(idle.label, '— · 1.5s');
  assert.match(idle.tooltip, /Avg turn latency: 1\.5s over 2 turns/);
  // Seeding the active session's latency is a display change -> one notification.
  assert.equal(changeCount, 1);

  // Idempotent: a subsequent tick must not re-seed or re-notify (the transcript
  // is static while idle, so the state is retained unchanged).
  service.tick(BASE_NOW + 1000);
  assert.equal(service.getRate('/a').label, '— · 1.5s');
  assert.equal(changeCount, 1);
});

test('a loaded session with no measured turns stays at the bare idle placeholder', () => {
  const arch = makeArchState({
    openTabs: ['/a'],
    running: [],
    active: '/a',
    transcripts: { '/a': [streamingMessage('s1', 0)] },
  });
  let changeCount = 0;
  const service = new TokenRateService({
    getArchState: () => arch,
    onActiveRateChanged: () => { changeCount += 1; },
  });

  service.tick(BASE_NOW);
  const idle = service.getRate('/a');
  assert.equal(idle.state, 'idle');
  assert.equal(idle.label, '—');
  // Nothing to average -> no display change to notify.
  assert.equal(changeCount, 0);
});

test('a run that starts on a previously-idle session replaces the idle state with a measured one', () => {
  // The idle seed is a placeholder until a run begins; once the session runs it
  // is measured normally and transitions to generating/paused, with the
  // historical latency still folded into the average (turn 2+ shows it inline).
  const arch = makeArchState({
    openTabs: ['/a'],
    running: [],
    active: '/a',
    transcripts: { '/a': [finishedTurn('f1', { turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 })] },
  });
  const service = new TokenRateService({
    getArchState: () => arch,
    onActiveRateChanged: () => {},
  });
  service.tick(BASE_NOW);
  assert.equal(service.getRate('/a').state, 'idle');
  assert.match(service.getRate('/a').label, /1\.0s/);

  // A new run begins: an empty streaming message appears, session is running.
  arch.transcript.bySession['/a'] = [
    finishedTurn('f1', { turnLatencyMs: 1_000, overheadMs: 100, providerLatencyMs: 900 }),
    streamingMessage('s1', 0),
  ];
  arch.sessions.runningSessionPaths = ['/a'];
  arch.composer.activeRunSummaryBySession['/a'] = runSummary('r1');
  service.tick(BASE_NOW + 1000);
  const running = service.getRate('/a');
  // Empty new message -> paused until output flows, but the historical latency
  // is still surfaced inline (the idle seed was replaced, not lost).
  assert.equal(running.state, 'paused');
  assert.match(running.label, /· 1\.0s/);
});
