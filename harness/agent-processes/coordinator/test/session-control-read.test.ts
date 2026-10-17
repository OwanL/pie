import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readSessionControlTranscript as read,
  SessionControlReadError,
  SESSION_CONTROL_READ_DEFAULT_CHARACTERS,
  SESSION_CONTROL_READ_MAX_CHARACTERS,
  type SessionControlReadOptions,
  type SessionControlReadResult,
  type SessionControlReadSource,
} from '../session-control-read.js';
import type { SessionEntryLike } from '../../../session-storage/transcripts/transcript.js';
import { createSessionControlSender, formatSessionControlPrompt } from '../../lib/rpc/session-control-attribution.js';
import { AGENT_MESSAGE_PROVENANCE_CUSTOM_TYPE } from '../../lib/rpc/message-contract.js';
import { AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY } from '../../workers/agent-message-provenance.js';

const time = '2026-10-14T00:00:00.000Z';
const user = (id: string, text: string): SessionEntryLike => ({
  id, timestamp: time, type: 'message', message: { role: 'user', content: text },
});
const assistant = (id: string, text: string): SessionEntryLike => ({
  id, timestamp: time, type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] },
});
const source = (entries: SessionEntryLike[]): SessionControlReadSource => ({
  sessionId: 'durable-session-1', entries, activity: { activity: 'running', busy: true, runningTools: 1 },
});
const body = (result: SessionControlReadResult): string => result.transcript.map((fragment) => fragment.text).join('');
const bounded = (result: SessionControlReadResult, budget: number): void => {
  assert.ok(JSON.stringify(result).length <= budget, `${JSON.stringify(result).length} exceeds ${budget}`);
};
const expectError = (fn: () => unknown, code: SessionControlReadError['code']): void => {
  assert.throws(fn, (error: unknown) => error instanceof SessionControlReadError && error.code === code);
};

function exhaustOlder(input: SessionControlReadSource, options: SessionControlReadOptions = {}): SessionControlReadResult[] {
  const pages = [read(input, options)];
  for (let count = 0; pages.at(-1)!.hasOlder; count += 1) {
    assert.ok(count < 200, 'older paging must progress');
    const page = read(input, { ...options, direction: 'older', cursor: pages.at(-1)!.cursor });
    assert.ok(page.transcript.length > 0, 'available content must not yield an empty page');
    pages.push(page);
  }
  return pages;
}

test('defaults are speech-only, include incoming users, and project activity without payloads', () => {
  assert.equal(SESSION_CONTROL_READ_DEFAULT_CHARACTERS, 4000);
  assert.equal(SESSION_CONTROL_READ_MAX_CHARACTERS, 262144);
  const input = source([user('u', 'incoming instruction'), {
    ...assistant('a', 'answer'), message: { role: 'assistant', stopReason: 'stop', content: [
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'text', text: 'answer' },
      { type: 'toolCall', id: 't', name: 'ask_user', arguments: { question: 'private question' } },
    ] },
  }, { id: 'r', timestamp: time, type: 'message', message: {
    role: 'toolResult', toolCallId: 't', toolName: 'ask_user', content: [{ type: 'text', text: 'selected answer' }],
  } }]);
  (input.activity as unknown as Record<string, unknown>).toolPayload = 'must not escape';
  const page = read(input);
  assert.equal(body(page), 'incoming instructionanswer');
  assert.deepEqual(page.activity, { activity: 'running', busy: true, runningTools: 1 });
  assert.equal(page.hasOlder, false);
  assert.equal(page.hasNewer, false);
  bounded(page, 4000);
  const details = read(input, { includeReasoning: true, includeToolCalls: true });
  assert.ok(body(details).includes('private reasoning'));
  assert.ok(body(details).includes('private question'));
  assert.ok(body(details).includes('selected answer'));
  assert.deepEqual(details.transcript.map((row) => row.kind), ['text', 'reasoning', 'text', 'tool-input', 'tool-result']);
});

test('terminal source entries do not fold late tool-result and assistant appends into old coverage', () => {
  const input = source([user('u', 'task'), { ...assistant('a', 'first'), message: {
    role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'first' },
      { type: 'toolCall', id: 'tool1', name: 'ask_user', arguments: { question: 'choose' } }],
  } }]);
  const first = read(input, { includeToolCalls: true });
  input.entries = [...input.entries, { id: 'r', timestamp: time, type: 'message', message: {
    role: 'toolResult', toolCallId: 'tool1', toolName: 'ask_user', content: [{ type: 'text', text: 'approved' }],
    details: { answer: 'approved' },
  } }, assistant('a2', 'follow-up')];
  const next = read(input, { direction: 'newer', cursor: first.cursor, includeToolCalls: true });
  assert.ok(body(next).includes('approved'));
  assert.ok(body(next).endsWith('follow-up'));
  assert.equal(body(next).includes('first'), false);
  assert.equal(body(next).includes('choose'), false);
  assert.equal(next.hasOlder, false);
  assert.equal(next.hasNewer, false);
});

test('large speech pages within entries, expands budgets, and preserves independent coverage edges', () => {
  const original = Array.from({ length: 18000 }, (_, index) => `${index.toString(36)}|`).join('');
  const input = source([user('old', 'older task'), assistant('a', original)]);
  const latest = read(input, { maxCharacters: 1400 });
  assert.ok(latest.transcript[0]!.offset > 0);
  assert.equal(latest.transcript[0]!.totalCharacters, original.length);
  const older = read(input, { direction: 'older', cursor: latest.cursor, maxCharacters: 3000 });
  input.entries = [...input.entries, user('new', 'new incoming'), assistant('new-a', 'new reply')];
  const newer = read(input, { direction: 'newer', cursor: older.cursor, maxCharacters: 1800 });
  assert.equal(body(newer), 'new incomingnew reply');
  assert.equal(newer.hasOlder, true);
  assert.equal(newer.hasNewer, false);
  const pages = [older, latest];
  let cursor = newer.cursor;
  for (let count = 0; ; count += 1) {
    assert.ok(count < 100);
    const page = read(input, { direction: 'older', cursor, maxCharacters: 4000 });
    pages.unshift(page);
    bounded(page, 4000);
    cursor = page.cursor;
    if (!page.hasOlder) break;
  }
  assert.equal(pages.map(body).join(''), `older task${original}`);
  const end = read(input, { direction: 'newer', cursor, maxCharacters: 4000 });
  assert.deepEqual(end.transcript, []);
  assert.equal(end.hasOlder, false);
  assert.equal(end.hasNewer, false);
  bounded(latest, 1400);
  bounded(older, 3000);
  bounded(newer, 1800);
});

test('full included tool input and result text remain retrievable, not permanent previews', () => {
  const payload = 'full tool result '.repeat(6000);
  const input = source([{ ...assistant('a', ''), message: {
    role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't', name: 'ask_user', arguments: { prompt: payload } }],
  } }, { id: 'r', timestamp: time, type: 'message', message: { role: 'toolResult', toolCallId: 't', toolName: 'ask_user',
    content: [{ type: 'text', text: payload }], details: { choice: 'Accepted', transcript: payload },
  } }]);
  const pages = exhaustOlder(input, { includeToolCalls: true, maxCharacters: 16000 });
  const fragments = pages.reverse().flatMap((page) => page.transcript);
  const actualInput = fragments.filter((f) => f.kind === 'tool-input').map((f) => f.text).join('');
  const actualResult = fragments.filter((f) => f.kind === 'tool-result').map((f) => f.text).join('');
  assert.equal(actualInput, JSON.stringify({ prompt: payload }));
  assert.equal(actualResult, JSON.stringify({ content: [{ type: 'text', text: payload }] }));
  assert.equal(actualResult.includes('details'), false);
  for (const page of pages) bounded(page, 16000);
});

test('tool results omit SDK details and image bytes, while decisions and all textual content remain pageable', () => {
  const image = { type: 'image', mimeType: 'image/png', width: 640, height: 480,
    get data(): string { throw new Error('image bytes must not be touched'); },
  };
  const result: SessionEntryLike = { id: 'r', timestamp: time, type: 'message', message: {
    role: 'toolResult', toolCallId: 'ask', toolName: 'ask_user',
    content: [{ type: 'text', text: 'Accepted decision '.repeat(500) }, image],
    get details(): unknown { throw new Error('SDK details must not be touched'); },
  } };
  const input = source([{ ...assistant('input', ''), message: { role: 'assistant', stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'ask', name: 'ask_user', arguments: { image, question: 'choose' } }],
  } }, result]);
  const pages = exhaustOlder(input, { includeToolCalls: true, maxCharacters: 1000 });
  const fragments = pages.reverse().flatMap((page) => page.transcript);
  const fullResult = fragments.filter((part) => part.kind === 'tool-result').map((part) => part.text).join('');
  const fullInput = fragments.filter((part) => part.kind === 'tool-input').map((part) => part.text).join('');
  assert.equal(fullResult, JSON.stringify({ content: [{ type: 'text', text: 'Accepted decision '.repeat(500) },
    { type: 'image', mimeType: 'image/png', width: 640, height: 480, omitted: true }] }));
  assert.equal(fullInput, JSON.stringify({ image: { type: 'image', mimeType: 'image/png', width: 640, height: 480, omitted: true }, question: 'choose' }));
  for (const page of pages) bounded(page, 1000);
});

test('current tool names are a bounded live header, independent of transcript payload opt-ins', () => {
  const input = source([user('u', 'task')]);
  const longName = `${'x'.repeat(79)}😀tail`;
  input.activity = { ...input.activity, runningToolNames: ['ask_user', 'bash', 'bash', longName, 'a', 'b', 'c', 'd', 'e', 'f'] };
  const page = read(input);
  assert.deepEqual(page.activity.runningToolNames, ['ask_user', 'bash', 'x'.repeat(79), 'a', 'b', 'c', 'd', 'e']);
  assert.equal(page.activity.runningToolNamesTruncated, true);
  assert.equal(body(page), 'task');
  bounded(page, 4000);
});

test('whole envelope budget counts escaped content, metadata, activity and cursor; Unicode boundaries stay safe', () => {
  const original = ('😀漢字\\\"\n\t'.repeat(2500));
  const input = source([assistant('a', original)]);
  const pages = exhaustOlder(input, { maxCharacters: 1000 });
  assert.equal(pages.reverse().map(body).join(''), original);
  for (const page of pages) {
    bounded(page, 1000);
    for (const fragment of page.transcript) {
      assert.equal(/^[\uDC00-\uDFFF]/u.test(fragment.text), false);
      assert.equal(/[\uD800-\uDBFF]$/u.test(fragment.text), false);
    }
  }
  const huge = read(source([assistant('large', '漢'.repeat(300000))]), { maxCharacters: 262144 });
  assert.ok(body(huge).length > 250000);
  bounded(huge, 262144);
});

test('cursor binds identity, exact history prefix and projection, but not character budget or live header', () => {
  const input = source([user('u', 'task'), assistant('a', 'answer'.repeat(1000))]);
  const page = read(input);
  expectError(() => read({ ...input, sessionId: 'reused-title-new-session' }, { direction: 'older', cursor: page.cursor }), 'READ_CURSOR_INVALIDATED');
  expectError(() => read(input, { direction: 'older', cursor: page.cursor, includeReasoning: true }), 'READ_CURSOR_INVALIDATED');
  expectError(() => read(input, { direction: 'older', cursor: page.cursor, includeToolCalls: true }), 'READ_CURSOR_INVALIDATED');
  expectError(() => read(source([user('u', 'rewritten'), input.entries[1]!]), { direction: 'older', cursor: page.cursor }), 'READ_CURSOR_INVALIDATED');
  expectError(() => read(source([input.entries[0]!]), { direction: 'older', cursor: page.cursor }), 'READ_CURSOR_INVALIDATED');
  expectError(() => read(source([user('branch-u', 'task'), input.entries[1]!]), { direction: 'older', cursor: page.cursor }), 'READ_CURSOR_INVALIDATED');
  const next = read({ ...input, activity: { activity: 'idle', busy: false } }, { direction: 'older', cursor: page.cursor, maxCharacters: 12000 });
  assert.equal(next.activity.activity, 'idle');
  assert.equal(next.hasOlder, false);
});

test('included tool text rewrites invalidate, excluded SDK details rewrites do not move visible offsets', () => {
  const entry: SessionEntryLike = { id: 'result', timestamp: time, type: 'message', message: {
    role: 'toolResult', toolName: 'ask_user', content: [{ type: 'text', text: 'accepted' }], details: { duplicate: 'accepted' },
  } };
  const input = source([entry]);
  const page = read(input, { includeToolCalls: true });
  entry.message!.details = { duplicate: 'updated excluded diagnostics' };
  assert.deepEqual(read(input, { direction: 'newer', cursor: page.cursor, includeToolCalls: true }).transcript, []);
  entry.message!.content = [{ type: 'text', text: 'declined' }];
  expectError(() => read(input, { direction: 'newer', cursor: page.cursor, includeToolCalls: true }), 'READ_CURSOR_INVALIDATED');
});

test('synthetic bulk image/details history keeps small reads independent of excluded payload serialization', (t) => {
  const bulk = 'B'.repeat(1024 * 1024);
  const entries = Array.from({ length: 64 }, (_, index): SessionEntryLike => ({
    id: `bulk-${index}`, parentId: index ? `bulk-${index - 1}` : null, timestamp: time, type: 'message', message: {
      role: 'toolResult', toolName: 'screenshot', content: [{ type: 'text', text: `decision ${index}` },
        { type: 'image', mimeType: 'image/png', data: bulk }], details: { mirroredImage: bulk },
    },
  }));
  const input = source([user('u', 'instruction'), ...entries]);
  const start = performance.now();
  const latest = read(input, { maxCharacters: 1000 });
  const latestMs = performance.now() - start;
  const olderStart = performance.now();
  const older = read(input, { direction: 'older', cursor: latest.cursor, maxCharacters: 1000 });
  const olderMs = performance.now() - olderStart;
  const toolsStart = performance.now();
  const tools = read(input, { includeToolCalls: true, maxCharacters: 1000 });
  const toolsMs = performance.now() - toolsStart;
  const rawStart = performance.now();
  let rawCharacters = 0;
  for (const entry of entries) rawCharacters += JSON.stringify(entry).length;
  const rawMs = performance.now() - rawStart;
  t.diagnostic(`synthetic ${Math.round(rawCharacters / 1024 / 1024)} MiB raw payload; 1000-char latest=${latestMs.toFixed(2)}ms older=${olderMs.toFixed(2)}ms tools=${toolsMs.toFixed(2)}ms; raw serialization baseline=${rawMs.toFixed(2)}ms (engine-only, no disk parse)`);
  assert.equal(body(latest), 'instruction');
  assert.deepEqual(older.transcript, []);
  assert.equal(body(tools).includes(bulk.slice(0, 1000)), false);
  for (const page of [latest, older, tools]) bounded(page, 1000);
});

test('empty and tool-only speech projections return usable cursors that follow append', () => {
  const input = source([{ id: 'r', timestamp: time, type: 'message', message: {
    role: 'toolResult', content: 'excluded payload',
  } }]);
  const empty = read(input);
  assert.deepEqual(empty.transcript, []);
  assert.equal(empty.hasOlder, false);
  input.entries = [...input.entries, user('u', 'incoming')];
  assert.deepEqual(read(input, { direction: 'older', cursor: empty.cursor }).transcript, []);
  const newer = read(input, { direction: 'newer', cursor: empty.cursor });
  assert.equal(body(newer), 'incoming');
  assert.equal(newer.hasOlder, false);
});

test('incoming agent attribution is retained, images explicitly omit binary payload, unfinished assistants excluded', () => {
  const sender = createSessionControlSender({ sessionId: 'sender-id', identityFallback: false }, 'Sender');
  const incoming = user('u', formatSessionControlPrompt('instruction', sender));
  (incoming.message as unknown as Record<string, unknown>)[AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY] = { sender };
  const image = user('image', '');
  image.message!.content = [{ type: 'text', text: 'look' }, { type: 'image', data: 'BASE64'.repeat(10000), mimeType: 'image/png' }];
  const interrupted = assistant('interrupted', 'partial must not render');
  interrupted.message!.stopReason = 'aborted';
  const page = read(source([incoming, image, interrupted]));
  assert.equal(page.transcript[0]!.text, 'instruction');
  assert.deepEqual(page.transcript[0]!.sender, sender);
  assert.equal(body(page).includes('BASE64'), false);
  assert.ok(body(page).includes('omitted'));
  assert.equal(body(page).includes('partial must not render'), false);
});

test('legacy incoming provenance sidecars retain attribution and cannot silently rebase old text', () => {
  const sender = createSessionControlSender({ sessionId: 'legacy-sender', identityFallback: false }, 'Legacy sender');
  const incoming = user('legacy-user', formatSessionControlPrompt('legacy instruction', sender));
  const marker: SessionEntryLike = { id: 'marker', timestamp: time, type: 'custom',
    customType: AGENT_MESSAGE_PROVENANCE_CUSTOM_TYPE, data: { userEntryId: incoming.id, sender } };
  const input = source([incoming, marker]);
  const page = read(input);
  assert.equal(body(page), 'legacy instruction');
  assert.deepEqual(page.transcript[0]!.sender, sender);
  input.entries = [...input.entries, assistant('new-answer', 'answer')];
  assert.equal(body(read(input, { direction: 'newer', cursor: page.cursor })), 'answer');
  const beforeMarker = read(source([incoming]));
  expectError(() => read(input, { direction: 'newer', cursor: beforeMarker.cursor }), 'READ_CURSOR_INVALIDATED');
});

test('durable bash execution inputs/results obey the same tool opt-in and full paging', () => {
  const output = 'complete shell output '.repeat(1000);
  const input = source([{ id: 'bash', timestamp: time, type: 'message', message: {
    role: 'bashExecution', command: 'echo command', output, exitCode: 0,
  } }]);
  const speech = read(input);
  assert.deepEqual(speech.transcript, []);
  const pages = exhaustOlder(input, { includeToolCalls: true, maxCharacters: 2000 });
  const fragments = pages.reverse().flatMap((page) => page.transcript);
  assert.equal(fragments.filter((fragment) => fragment.kind === 'tool-input').map((fragment) => fragment.text).join(''), 'echo command');
  assert.equal(fragments.filter((fragment) => fragment.kind === 'tool-result').map((fragment) => fragment.text).join(''), JSON.stringify({ output, exitCode: 0 }));
});

test('newer within-entry paging and alternating edge reads never duplicate earlier coverage', () => {
  const input = source([assistant('a', 'original '.repeat(600))]);
  let page = read(input, { maxCharacters: 1000 });
  const olderPages = [page];
  const appended = 'newer 😀 output '.repeat(1000);
  input.entries = [...input.entries, assistant('b', appended)];
  const newerPages: SessionControlReadResult[] = [];
  for (let count = 0; count < 100; count += 1) {
    const newer = read(input, { direction: 'newer', cursor: page.cursor, maxCharacters: count % 2 ? 2200 : 1000 });
    newerPages.push(newer);
    const older = read(input, { direction: 'older', cursor: newer.cursor, maxCharacters: count % 2 ? 1000 : 2400 });
    olderPages.unshift(older);
    page = older;
    if (!page.hasOlder && !page.hasNewer) break;
    assert.ok(count < 99, 'alternating paging must exhaust both edges');
  }
  assert.equal(olderPages.map(body).join(''), 'original '.repeat(600));
  assert.equal(newerPages.map(body).join(''), appended);
});

test('invalid parameters and insufficient whole-response budgets fail explicitly', () => {
  const input = source([user('u', 'task')]);
  for (const maxCharacters of [0, -1, 1.5, 262145, NaN]) expectError(() => read(input, { maxCharacters }), 'INVALID_PARAMS');
  expectError(() => read(input, { direction: 'older' }), 'INVALID_PARAMS');
  expectError(() => read(input, { cursor: 'arbitrary' }), 'INVALID_PARAMS');
  expectError(() => read(input, { direction: 'newer', cursor: 'arbitrary' }), 'INVALID_PARAMS');
  expectError(() => read(input, { includeToolCalls: 'true' as never }), 'INVALID_PARAMS');
  expectError(() => read(input, { maxCharacters: 1 }), 'READ_BUDGET_TOO_SMALL');
});
