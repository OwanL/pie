import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseSessionTranscript, renderTranscript } from '../src/transcript.js';

/** Write a temp session JSONL file from an array of entry objects. */
function writeSession(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-test-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

const header = { type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/x' };

test('parseSessionTranscript extracts toolCall names + arguments hint from assistant content', () => {
  const file = writeSession([
    header,
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] } },
    {
      type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'I will read the file.' },
          { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/repo/foo.ts' } },
        ],
      },
    },
  ]);

  const parsed = parseSessionTranscript(file, 40);
  const assistant = parsed.turns.find((t) => t.role === 'ASSISTANT');
  assert.ok(assistant, 'assistant turn present');
  assert.equal(assistant!.tools.length, 1);
  assert.match(assistant!.tools[0]!, /^read\(/);
  assert.match(assistant!.tools[0]!, /foo\.ts/);
  assert.match(assistant!.text, /I will read the file\./);
});

test('parseSessionTranscript surfaces toolName on toolResult rows and isError flag', () => {
  const file = writeSession([
    header,
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'run tests' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'running' }, { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'npm test' } }] } },
    { type: 'message', id: 't1', parentId: 'a1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'all tests passed' }], isError: false } },
  ]);

  const parsed = parseSessionTranscript(file, 40);
  const rendered = renderTranscript(parsed);
  // toolResult row should name the tool (bash) and carry the result text.
  assert.match(rendered, /TOOL_RESULT\(bash\)/);
  assert.match(rendered, /all tests passed/);
  const result = parsed.turns.find((t) => t.role === 'TOOL_RESULT');
  assert.equal(result!.toolName, 'bash');
  assert.equal(result!.isError, false);
});

test('parseSessionTranscript handles bashExecution command/output (not content)', () => {
  const file = writeSession([
    header,
    { type: 'message', id: 'b1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'bashExecution', command: 'echo hi', output: 'hi', exitCode: 0, cancelled: false, truncated: false } },
  ]);
  const parsed = parseSessionTranscript(file, 40);
  const bash = parsed.turns.find((t) => t.role === 'BASH');
  assert.ok(bash);
  assert.match(bash!.text, /\$ echo hi/);
  assert.match(bash!.text, /hi/);
});

test('parseSessionTranscript skips malformed lines without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-test-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify(header),
    'this is not json',
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'hello' } }),
    '{ broken json',
  ].join('\n') + '\n', 'utf8');

  const parsed = parseSessionTranscript(file, 40);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0]!.role, 'USER');
});

test('parseSessionTranscript keeps the first user message + most-recent turns when excerpting', () => {
  const entries: unknown[] = [header];
  for (let i = 0; i < 50; i++) {
    entries.push({ type: 'message', id: `u${i}`, parentId: null, timestamp: `2026-01-01T00:00:${i}Z`, message: { role: 'user', content: `msg ${i}` } });
  }
  const file = writeSession(entries);
  const parsed = parseSessionTranscript(file, 5);
  // first user + last 5
  assert.equal(parsed.turns[0]!.text, 'msg 0');
  assert.equal(parsed.turns[parsed.turns.length - 1]!.text, 'msg 49');
  assert.ok(parsed.truncated, 'truncated flag set');
});

test('parseSessionTranscript throws a clear error for a missing file', () => {
  assert.throws(() => parseSessionTranscript('/no/such/file.jsonl', 40), /Could not read session file/);
});