import assert from 'node:assert/strict';
import test from 'node:test';

import { Compile } from '../../../extension/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/compile/index.mjs';

import { playwrightSchema } from '../src/schema.js';

const validator = Compile(playwrightSchema);

// Frozen public request/response-shape examples. These pin the wire contract
// before backend behavior exists; changing them is a breaking tool change.
const FROZEN_EXAMPLES: unknown[] = [
  { action: 'open', url: 'https://example.test/login', viewport: { width: 1280, height: 720 } },
  { action: 'open', sessionId: 'pw-auth', storageStatePath: 'C:/sessions/state.json', actionTimeoutMs: 15000, navigationTimeoutMs: 60000 },
  { action: 'observe', sessionId: 'pw-auth' },
  { action: 'observe', sessionId: 'pw-auth', pageId: 'p2', observation: { mode: 'full', depth: 10, screenshot: true, consoleLimit: 10, pageErrorLimit: 5, requestLimit: 5, downloadLimit: 5, includeTabs: true } },
  { action: 'observe', sessionId: 'pw-auth', observation: { target: { ref: 'e12', revision: 3 } } },
  { action: 'observe', sessionId: 'pw-auth', observation: { target: { selector: 'form#login' } } },
  { action: 'act', sessionId: 'pw-auth', pageId: 'p1', input: { kind: 'click', target: { ref: 'e7', revision: 2 } } },
  { action: 'act', sessionId: 'pw-auth', input: { kind: 'fill', target: { selector: '#email' }, value: 'user@example.test' } },
  { action: 'act', sessionId: 'pw-auth', input: { kind: 'navigate', url: 'https://example.test/next' } },
  { action: 'act', sessionId: 'pw-auth', input: { kind: 'wait', condition: { selector: '#ready' } }, timeoutMs: 5000 },
  { action: 'act', sessionId: 'pw-auth', pageId: 'p1', input: { kind: 'click', target: { ref: 'e9', revision: 1 } }, dialog: { action: 'accept', promptText: 'yes' } },
  { action: 'act', sessionId: 'pw-auth', input: { kind: 'select', target: { selector: '#color' }, values: ['blue'] } },
  { action: 'act', sessionId: 'pw-auth', input: { kind: 'upload', target: { selector: '#file-input' }, paths: ['C:/tmp/a.txt'] } },
  { action: 'act', sessionId: 'pw-auth', input: { kind: 'tab_open', url: 'https://example.test' } },
  { action: 'act', sessionId: 'pw-auth', input: { kind: 'tab_select', pageId: 'p3' } },
  { action: 'act', sessionId: 'pw-auth', input: { kind: 'tab_close' } },
  { action: 'run_code', sessionId: 'pw-auth', code: 'return await page.title();', timeout: 10000 },
  { action: 'close', sessionId: 'pw-auth', scope: 'session' },
  { action: 'close', scope: 'runtime' },
  { action: 'close', scope: 'runtime', sessionId: 'pw-auth', exportStorageState: true },
];

test('frozen example requests satisfy the public schema', () => {
  for (const example of FROZEN_EXAMPLES) {
    assert.equal(validator.Check(example), true, `example rejected: ${JSON.stringify(example)}\n${[...validator.Errors(example)].map((e) => e.message).join('\n')}`);
  }
});

test('schema enforces the discriminated union and strict fields', () => {
  const rejected: unknown[] = [
    { action: 'act', sessionId: 's', input: { kind: 'click', selector: '#a' } }, // target object is required
    { action: 'act', sessionId: 's', input: { kind: 'click', target: { selector: '#a' }, value: 'x' } }, // irrelevant field for kind
    { action: 'act', sessionId: 's', input: { kind: 'navigate' } }, // missing url
    { action: 'act', sessionId: 's', input: { kind: 'wait', condition: { timeMs: 5 }, extra: true } },
    { action: 'open', sessionId: 's', unknownField: 1 },
    { action: 'close', scope: 'everything' },
    { action: 'nope' },
    { action: 'open', viewport: { width: 100, height: 100 } }, // below viewport bounds
    { action: 'open', actionTimeoutMs: 500 }, // below timeout bound
    { action: 'act', sessionId: 's', input: { kind: 'wait', condition: { timeMs: 999 } } },
    { action: 'observe', sessionId: 's', observation: { mode: 'sometimes' } },
    { action: 'observe', sessionId: 's', observation: { depth: 0 } },
    { action: 'act', sessionId: 's', input: { kind: 'select', target: { selector: '#s' }, values: [] } }, // min 1 value
    { action: 'act', sessionId: 's', input: { kind: 'upload', target: { selector: '#f' }, paths: [] } }, // min 1 path
  ];
  for (const example of rejected) {
    assert.equal(validator.Check(example), false, `example unexpectedly accepted: ${JSON.stringify(example)}`);
  }
});

test('schema caps unbounded string sizes', () => {
  assert.equal(validator.Check({ action: 'open', url: `https://e.test/${'a'.repeat(10 * 1024)}` }), false);
  assert.equal(validator.Check({ action: 'open', url: 'https://e.test/' + 'a'.repeat(100) }), true);
  assert.equal(validator.Check({ action: 'open', sessionId: 's'.repeat(200) }), false);
  assert.equal(validator.Check({
    action: 'act', sessionId: 's', input: { kind: 'fill', target: { selector: '#a' }, value: 'v'.repeat(70 * 1024) },
  }), false);
  assert.equal(validator.Check({ action: 'run_code', sessionId: 's', code: 'x'.repeat(70 * 1024) }), false);
});
