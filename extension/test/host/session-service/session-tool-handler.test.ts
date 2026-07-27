import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialArchState } from '../../../src/host/core/arch-state';
import { onToolFinished, onToolStarted } from '../../../src/host/session-service/handlers/tools';
import type { ArchState } from '../../../src/host/core/arch-state';
import type { Event } from '../../../src/host/core/events';
import type { ToolCall, SessionSummary } from '../../../src/shared/protocol';

test('canonical semantic tool handlers keep observers but skip legacy transcript ToolCall events', () => {
  const sessionPath = '/workspace/session.jsonl';
  const archState = createInitialArchState();
  const observed: ToolCall[] = [];
  const dispatched: unknown[] = [];
  const deps = {
    getArchState: () => archState,
    dispatchArch: (event: unknown) => dispatched.push(event),
    runObserver: {
      onToolStarted: (_path: string, toolCall: ToolCall) => observed.push(toolCall),
      onToolFinished: (_path: string, toolCall: ToolCall) => observed.push(toolCall),
    } as any,
    state: { touchSessionTranscript: () => undefined } as any,
    scheduleRender: () => undefined,
    requireEventSessionPath: (_eventName: string, path?: string) => path ?? null,
  };

  onToolStarted({
    requestId: 'req', sessionPath, messageId: 'live-message', toolCallId: 'tool',
    name: 'read', input: {}, startedAt: 10, parallelGroupId: 'batch',
  }, deps, { skipTranscriptMutation: true });
  onToolFinished({
    requestId: 'req', sessionPath, messageId: 'live-message', toolCallId: 'tool',
    name: 'read', input: {}, result: 'done', status: 'completed', parallelGroupId: 'batch',
  }, deps, { skipTranscriptMutation: true });

  assert.deepEqual(dispatched, []);
  assert.equal(observed.length, 2);
  assert.equal(observed[0]?.parallelGroupId, 'batch');
  assert.equal(observed[1]?.parallelGroupId, 'batch');
});

test('tool.finished keeps backend name and input when the owner message is unavailable', () => {
  const sessionPath = '/workspace/session.jsonl';
  const archState = createInitialArchState();
  let observed: ToolCall | undefined;
  const dispatched: unknown[] = [];

  onToolFinished({
    requestId: 'req-1',
    sessionPath,
    messageId: 'missing-owner',
    toolCallId: 'tool-1',
    name: 'bash',
    input: { command: 'npm test' },
    result: { exitCode: 1 },
    status: 'failed',
    durationMs: 250,
  }, {
    getArchState: () => archState,
    dispatchArch: (event) => dispatched.push(event),
    runObserver: {
      onToolFinished: (_path: string, toolCall: ToolCall) => { observed = toolCall; },
    } as any,
    state: { touchSessionTranscript: () => undefined } as any,
    scheduleRender: () => undefined,
    requireEventSessionPath: (_eventName, path) => path ?? null,
  });

  assert.equal(observed?.name, 'bash');
  assert.deepEqual(observed?.input, { command: 'npm test' });
  assert.equal(observed?.durationMs, 250);
  assert.deepEqual(dispatched, [{
    kind: 'ToolCall',
    sessionPath,
    messageId: 'missing-owner',
    toolCall: observed,
  }]);
});

// ─── Path-identity canonicalization in the live path ───────────────────────

/** A deps mock that applies FileChangesUpdated events to the ArchState (the
 *  reducer does this in production), so successive onToolStarted/onToolFinished
 *  calls see each other's file changes — exercising the live accumulation. */
function liveDeps(archState: ArchState, sessionPath: string) {
  return {
    getArchState: () => archState,
    dispatchArch: (event: Event) => {
      if (event.kind === 'FileChangesUpdated' && event.sessionPath === sessionPath) {
        archState.fileChanges.bySession[sessionPath] = event.fileChanges;
      }
    },
    runObserver: {
      onToolStarted: () => undefined,
      onToolFinished: () => undefined,
    } as any,
    state: { touchSessionTranscript: () => undefined } as any,
    scheduleRender: () => undefined,
    requireEventSessionPath: (_eventName: string, path?: string) => path ?? null,
  };
}

function sessionWithCwd(path: string, cwd: string): SessionSummary {
  return { path, name: 's', cwd, modifiedAt: '', messageCount: 0 };
}

test('live path: parent + subagent edits to one file merge across relative/absolute spellings', () => {
  const sessionPath = '/proj/session.jsonl';
  const archState = createInitialArchState();
  archState.sessions.sessions = [sessionWithCwd(sessionPath, '/proj')];
  const deps = liveDeps(archState, sessionPath);

  // Parent edits `src/shared.ts` (relative).
  onToolStarted({
    requestId: 'r1', sessionPath, messageId: 'm1', toolCallId: 't1',
    name: 'edit', input: { path: 'src/shared.ts', oldText: 'x', newText: 'a\nb' }, startedAt: 1,
  }, deps, { skipTranscriptMutation: true });

  // Subagent edits the SAME file via its absolute spelling.
  const subagentResult = {
    content: [{ type: 'text', text: 'done' }],
    details: {
      mode: 'single', results: [{
        agent: 'worker', exitCode: 0,
        messages: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'edit', arguments: { path: '/proj/src/shared.ts', oldText: 'a\nb', newText: 'a\nb\nc\nd' } }] }],
        stderr: '', usage: {},
      }],
    },
  };
  onToolFinished({
    requestId: 'r2', sessionPath, messageId: 'm2', toolCallId: 't2',
    name: 'subagent', input: { agent: 'worker', task: 't' }, result: subagentResult, status: 'completed',
  }, deps, { skipTranscriptMutation: true });

  const changes = archState.fileChanges.bySession[sessionPath] ?? [];
  assert.equal(changes.length, 1, 'parent + subagent edits to one file must merge in the live path');
  assert.equal(changes[0].additions, 6);
  assert.equal(changes[0].deletions, 3);
});

test('live path: create-then-delete matches across relative/absolute spellings', () => {
  const sessionPath = '/proj/session.jsonl';
  const archState = createInitialArchState();
  archState.sessions.sessions = [sessionWithCwd(sessionPath, '/proj')];
  const deps = liveDeps(archState, sessionPath);

  // write (relative) then bash rm (absolute) of the SAME file → net no-op.
  // Both are derived at tool START (the bash command is parsed from the input),
  // so the create-then-delete reconciliation happens across two onToolStarted
  // calls — exercising the live upsert's canonical matching.
  onToolStarted({
    requestId: 'r1', sessionPath, messageId: 'm1', toolCallId: 't1',
    name: 'write', input: { path: 'tmp/gen.uid', content: 'x' }, startedAt: 1,
  }, deps, { skipTranscriptMutation: true });
  onToolStarted({
    requestId: 'r2', sessionPath, messageId: 'm2', toolCallId: 't2',
    name: 'bash', input: { command: 'rm /proj/tmp/gen.uid' }, startedAt: 2,
  }, deps, { skipTranscriptMutation: true });

  const changes = archState.fileChanges.bySession[sessionPath] ?? [];
  assert.equal(changes.length, 0, 'create + delete of the same file is a net no-op');
});

test('live path: a write does not relabel an already modified path as created', () => {
  const sessionPath = '/proj/session.jsonl';
  const archState = createInitialArchState();
  archState.sessions.sessions = [sessionWithCwd(sessionPath, '/proj')];
  const deps = liveDeps(archState, sessionPath);

  onToolStarted({
    requestId: 'r1', sessionPath, messageId: 'm1', toolCallId: 't1',
    name: 'edit', input: { path: 'existing.ts', oldText: 'x', newText: 'y' }, startedAt: 1,
  }, deps, { skipTranscriptMutation: true });
  onToolStarted({
    requestId: 'r2', sessionPath, messageId: 'm2', toolCallId: 't2',
    name: 'write', input: { path: 'existing.ts', content: 'z' }, startedAt: 2,
  }, deps, { skipTranscriptMutation: true });

  const changes = archState.fileChanges.bySession[sessionPath] ?? [];
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, 'modified');
});

// ─── Failed-tool reconciliation (live-vs-reattach divergence) ──────────────

test('live path: a failed tool removes its optimistically-added file changes', () => {
  // onToolStarted derives file changes from the INPUT before the result is
  // known (optimistic). If the tool later fails, those entries must be removed
  // so the live manifest matches the reattach derivation (which skips
  // status==='failed' tools) — eliminating the transient divergence.
  const sessionPath = '/proj/session.jsonl';
  const archState = createInitialArchState();
  archState.sessions.sessions = [sessionWithCwd(sessionPath, '/proj')];
  const deps = liveDeps(archState, sessionPath);

  onToolStarted({
    requestId: 'r1', sessionPath, messageId: 'm1', toolCallId: 't1',
    name: 'edit', input: { path: 'src/x.ts', oldText: 'a', newText: 'b' }, startedAt: 1,
  }, deps, { skipTranscriptMutation: true });
  assert.equal((archState.fileChanges.bySession[sessionPath] ?? []).length, 1, 'optimistic entry added at start');

  onToolFinished({
    requestId: 'r1', sessionPath, messageId: 'm1', toolCallId: 't1',
    name: 'edit', input: { path: 'src/x.ts', oldText: 'a', newText: 'b' }, result: 'err', status: 'failed',
  }, deps, { skipTranscriptMutation: true });

  assert.deepEqual(archState.fileChanges.bySession[sessionPath] ?? [], [], 'failed tool entry must be removed');
});

test('live path: a failed bash rm removes its optimistically-added deletion', () => {
  const sessionPath = '/proj/session.jsonl';
  const archState = createInitialArchState();
  archState.sessions.sessions = [sessionWithCwd(sessionPath, '/proj')];
  const deps = liveDeps(archState, sessionPath);

  onToolStarted({
    requestId: 'r1', sessionPath, messageId: 'm1', toolCallId: 't1',
    name: 'bash', input: { command: 'rm src/stale.ts' }, startedAt: 1,
  }, deps, { skipTranscriptMutation: true });
  assert.equal((archState.fileChanges.bySession[sessionPath] ?? []).length, 1);

  onToolFinished({
    requestId: 'r1', sessionPath, messageId: 'm1', toolCallId: 't1',
    name: 'bash', input: { command: 'rm src/stale.ts' }, result: 'err', status: 'failed',
  }, deps, { skipTranscriptMutation: true });

  assert.deepEqual(archState.fileChanges.bySession[sessionPath] ?? [], [], 'failed bash deletion must be removed');
});

test('live path: a failed subagent does not leak its inner changes', () => {
  const sessionPath = '/proj/session.jsonl';
  const archState = createInitialArchState();
  archState.sessions.sessions = [sessionWithCwd(sessionPath, '/proj')];
  const deps = liveDeps(archState, sessionPath);

  const subagentResult = {
    content: [{ type: 'text', text: 'done' }],
    details: {
      mode: 'single', results: [{
        agent: 'worker', exitCode: 0,
        messages: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'write', arguments: { path: 'src/sub.ts', content: 'x' } }] }],
        stderr: '', usage: {},
      }],
    },
  };
  onToolFinished({
    requestId: 'r1', sessionPath, messageId: 'm1', toolCallId: 't1',
    name: 'subagent', input: { agent: 'worker', task: 't' }, result: subagentResult, status: 'failed',
  }, deps, { skipTranscriptMutation: true });

  assert.deepEqual(archState.fileChanges.bySession[sessionPath] ?? [], [], 'failed subagent must not leak inner changes');
});
