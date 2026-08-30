import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import registerDeferredTriggers from '../index.js';

const TRIGGERS_DIR_ENV = 'PIE_TRIGGERS_DIR';

let tempDir: string;
let savedTriggersDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-deferred-trigger-tool-test-'));
  savedTriggersDir = process.env[TRIGGERS_DIR_ENV];
  process.env[TRIGGERS_DIR_ENV] = tempDir;
});

afterEach(() => {
  if (savedTriggersDir === undefined) delete process.env[TRIGGERS_DIR_ENV];
  else process.env[TRIGGERS_DIR_ENV] = savedTriggersDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('successful registration normalizes only its own empty abort terminal', async () => {
  let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
  let messageEnd: ((event: { message: Record<string, unknown> }) => unknown) | undefined;
  registerDeferredTriggers({
    registerTool(value: unknown) {
      tool = value as typeof tool;
    },
    on(event: string, handler: unknown) {
      if (event === 'message_end') messageEnd = handler as typeof messageEnd;
    },
  } as never);

  assert.ok(tool);
  assert.ok(messageEnd);
  let aborts = 0;
  const result = await tool.execute(
    'defer-call',
    { action: 'register', triggers: [{ kind: 'timer', ms: 1_000 }], note: 'resume later' },
    undefined,
    undefined,
    {
      sessionManager: { getSessionFile: () => path.join(tempDir, 'session.jsonl') },
      abort: () => { aborts += 1; },
    },
  ) as { isError: boolean };
  assert.equal(result.isError, false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(aborts, 1);

  const aborted = {
    role: 'assistant',
    stopReason: 'aborted',
    errorMessage: 'Request was aborted.',
    content: [],
  };
  const replacement = messageEnd({ message: aborted }) as { message?: Record<string, unknown> };
  assert.equal(replacement.message?.stopReason, 'stop');
  assert.equal(replacement.message?.errorMessage, undefined);

  assert.equal(
    messageEnd({ message: aborted }),
    undefined,
    'the one-shot marker cannot normalize a later genuine abort',
  );
});

test('content-bearing and unrelated aborts remain interrupted terminals', async () => {
  let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
  let messageEnd: ((event: { message: Record<string, unknown> }) => unknown) | undefined;
  registerDeferredTriggers({
    registerTool(value: unknown) { tool = value as typeof tool; },
    on(event: string, handler: unknown) {
      if (event === 'message_end') messageEnd = handler as typeof messageEnd;
    },
  } as never);
  assert.ok(tool);
  assert.ok(messageEnd);

  assert.equal(messageEnd({ message: { role: 'assistant', stopReason: 'aborted', content: [] } }), undefined);
  await tool.execute(
    'defer-call',
    { action: 'register', triggers: [{ kind: 'user_input' }] },
    undefined,
    undefined,
    {
      sessionManager: { getSessionFile: () => path.join(tempDir, 'session.jsonl') },
      abort: () => undefined,
    },
  );

  const contentBearing = {
    role: 'assistant',
    stopReason: 'aborted',
    errorMessage: 'Request was aborted.',
    content: [{ type: 'text', text: 'partial answer' }],
  };
  assert.equal(messageEnd({ message: contentBearing }), undefined);
});
