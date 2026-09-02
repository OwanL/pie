import assert from 'node:assert/strict';
import test from 'node:test';

import { containsAriaRefEngine, validatePlaywrightParams } from '../src/validation.js';

function invalid(params: unknown, match: RegExp): void {
  assert.throws(() => validatePlaywrightParams(params), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGUMENTS');
    assert.match((error as Error).message, match);
    return true;
  });
}

test('valid open/observe/act/run_code/close parameter sets pass', () => {
  validatePlaywrightParams({ action: 'open', url: 'https://example.test' });
  validatePlaywrightParams({ action: 'observe', sessionId: 'pw-1', observation: { mode: 'none' } });
  validatePlaywrightParams({ action: 'act', sessionId: 'pw-1', pageId: 'p1', input: { kind: 'click', target: { ref: 'e3', revision: 2 } } });
  validatePlaywrightParams({ action: 'act', sessionId: 'pw-1', input: { kind: 'click', target: { selector: '#ok' } } });
  validatePlaywrightParams({ action: 'run_code', sessionId: 'pw-1', code: 'return 1;' });
  validatePlaywrightParams({ action: 'close', scope: 'runtime' });
});

test('missing/unknown actions and sessions are rejected', () => {
  invalid({ }, /parameters\.action/);
  invalid({ action: 'observe' }, /sessionId/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'teleport' } }, /kind is unsupported/);
  invalid({ action: 'observe', sessionId: 's', surprise: 1 }, /surprise/);
});

test('the aria-ref selector engine can never enter through selector fields', () => {
  assert.equal(containsAriaRefEngine('aria-ref=e1'), true);
  assert.equal(containsAriaRefEngine('css=div >> text=aria-ref='), true);
  assert.equal(containsAriaRefEngine('#submit'), false);
  // An attribute *selector* is not the ephemeral snapshot engine.
  assert.equal(containsAriaRefEngine('[data-ref=e1]'), false);

  invalid({ action: 'observe', sessionId: 's', observation: { target: { selector: 'aria-ref=e1' } } }, /aria-ref/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'click', target: { selector: 'aria-ref=e1' } } }, /aria-ref/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'wait', condition: { selector: 'css=main >> aria-ref=e5' } } }, /aria-ref/);
});

test('targets are exactly one of ref(+revision) or selector, and ref actions require pageId', () => {
  invalid({ action: 'act', sessionId: 's', input: { kind: 'click', target: { } } }, /exactly one/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'click', target: { ref: 'e1', revision: 1, selector: '#x' } } }, /exactly one/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'click', target: { ref: 'e1' } } }, /revision/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'click', target: { selector: '#x', revision: 1 } } }, /revision is only valid with/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'click', target: { ref: 'e1', revision: 1 } } }, /pageId is required/);
  validatePlaywrightParams({ action: 'act', sessionId: 's', pageId: 'p1', input: { kind: 'press', key: 'Enter' } });
});

test('wait conditions require exactly one predicate', () => {
  invalid({ action: 'act', sessionId: 's', input: { kind: 'wait', condition: {} } }, /exactly one/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'wait', condition: { url: 'https://e.test', text: 'Ready' } } }, /exactly one/);
  validatePlaywrightParams({ action: 'act', sessionId: 's', input: { kind: 'wait', condition: { timeMs: 1000 } } });
  invalid({ action: 'act', sessionId: 's', input: { kind: 'wait', condition: { timeMs: 999 } } }, /1000/);
});

test('dialog policy shape is strict', () => {
  validatePlaywrightParams({ action: 'act', sessionId: 's', pageId: 'p1', input: { kind: 'click', target: { selector: '#b' } }, dialog: { action: 'accept' } });
  invalid({ action: 'act', sessionId: 's', input: { kind: 'click', target: { selector: '#b' } }, dialog: { action: 'ignore' } }, /accept or dismiss/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'click', target: { selector: '#b' } }, dialog: { action: 'dismiss', promptText: 'x' } }, /promptText is only valid with action accept/);
});

test('close scope rules', () => {
  invalid({ action: 'close', scope: 'session' }, /sessionId/);
  invalid({ action: 'close', scope: 'runtime', exportStorageState: true }, /sessionId is required with exportStorageState/);
  invalid({ action: 'close', sessionId: 's' }, /scope/);
});

test('observation settings are a closed bounded object', () => {
  invalid({ action: 'observe', sessionId: 's', observation: { depth: 99 } }, /depth/);
  invalid({ action: 'observe', sessionId: 's', observation: { consoleLimit: 201 } }, /consoleLimit/);
  invalid({ action: 'observe', sessionId: 's', observation: { mode: 'none', screenshot: true } }, /cannot be combined/);
  invalid({ action: 'open', observation: { mode: 'none' } }, /must return the first accessibility observation/);
  invalid({ action: 'open', observation: { target: { ref: 'e1', revision: 1 } } }, /no observation revision/);
  invalid({ action: 'run_code', sessionId: 's', code: 'x', observation: { target: { selector: '#x' } } }, /target is not valid for run_code/);
});

test('numeric and size bounds', () => {
  invalid({ action: 'open', viewport: { width: 2000, height: 600 } }, /width/);
  invalid({ action: 'open', actionTimeoutMs: 999 }, /actionTimeoutMs/);
  invalid({ action: 'open', navigationTimeoutMs: 120_001 }, /navigationTimeoutMs/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'select', target: { selector: '#s' }, values: Array(101).fill('v') } }, /values/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'upload', target: { selector: '#f' }, paths: Array(21).fill('/tmp/x') } }, /paths/);
});
