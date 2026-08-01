import assert from 'node:assert/strict';
import test from 'node:test';

import { Value } from 'typebox/value';
import { computerSchema } from '../src/schema.js';
import { ComputerValidationError, validateComputerParams, validateSequence } from '../src/validation.js';

function valid(value: unknown) { assert.doesNotThrow(() => validateComputerParams(value)); }
function invalid(value: unknown, pattern: RegExp) { assert.throws(() => validateComputerParams(value), (error: unknown) => error instanceof ComputerValidationError && pattern.test(error.message)); }

test('public schema is strict and accepts one discriminated computer surface', () => {
  assert.equal(Value.Check(computerSchema, { action: 'open', selector: { kind: 'desktop' } }), true);
  assert.equal(Value.Check(computerSchema, { action: 'open', selector: { kind: 'desktop', title: 'bad' } }), true, 'cross-field combinations are checked by the strict runtime validator');
  assert.equal(Value.Check(computerSchema, { action: 'open', selector: { kind: 'desktop' }, unknown: 1 }), false);
  assert.deepEqual((computerSchema.properties.action as any).enum, ['open', 'observe', 'act', 'run_sequence', 'close']);
});

test('validation rejects fields and selector combinations belonging to another action', () => {
  invalid({ action: 'open', selector: { kind: 'desktop', title: 'x' } }, /selector.title/);
  invalid({ action: 'observe', sessionId: 's', input: { kind: 'focus' } }, /parameters.input/);
  invalid({ action: 'open', selector: { kind: 'pid' } }, /selector.pid/);
  invalid({ action: 'open', selector: { kind: 'window_id', windowId: 0 } }, /positive integer/);
  valid({ action: 'open', selector: { kind: 'process', process: 'editor', launch: true, args: ['--x'] } });
  valid({ action: 'open', selector: { kind: 'path', path: 'C:/app.exe', args: [] } });
});

test('open accepts optional screenshot/tree/state for an inline initial observation', () => {
  valid({ action: 'open', selector: { kind: 'desktop' }, screenshot: true, tree: true, state: true });
  valid({ action: 'open', selector: { kind: 'foreground' }, screenshot: false, tree: false, state: false });
  valid({ action: 'open', selector: { kind: 'foreground' }, state: true });
  invalid({ action: 'open', selector: { kind: 'desktop' }, revision: 1 }, /parameters.revision/);
  invalid({ action: 'open', selector: { kind: 'desktop' }, input: { kind: 'focus' } }, /parameters.input/);
});

test('point unions require exactly ref or coordinates and desktop scope is explicit', () => {
  invalid({ action: 'act', sessionId: 's', input: { kind: 'move', target: { ref: 'e:1:0', x: 1, y: 2 } } }, /exactly one/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'move', target: { x: -1, y: 2 } } }, /cannot be negative/);
  valid({ action: 'act', sessionId: 's', input: { kind: 'move', target: { x: -100, y: 2, scope: 'desktop' } } });
  invalid({ action: 'act', sessionId: 's', input: { kind: 'move', target: { ref: 'e:1:0', scope: 'desktop' } } }, /only valid with x\/y/);
});

test('action unions validate button/key vocab and incompatible combinations', () => {
  invalid({ action: 'act', sessionId: 's', input: { kind: 'mouse_down', button: 'fourth' } }, /left, middle, or right/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'press', key: 'DefinitelyNotAKey' } }, /supported NutJS key/);
  valid({ action: 'act', sessionId: 's', input: { kind: 'hotkey', keys: ['ctrl', 'A'] } });
  invalid({ action: 'act', sessionId: 's', input: { kind: 'right_click', button: 'left', target: { x: 1, y: 1 } } }, /input.button/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'drag', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, path: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }, /exactly one/);
  invalid({ action: 'act', sessionId: 's', input: { kind: 'scroll', deltaX: 0, deltaY: 0 } }, /non-zero/);
});

test('key validation accepts historical top-row aliases while keeping numpad names distinct', () => {
  for (const key of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'digit0', 'digit1', 'digit2', 'digit3', 'digit4', 'digit5', 'digit6', 'digit7', 'digit8', 'digit9', 'Num0', 'NumPad0']) {
    valid({ action: 'act', sessionId: 's', input: { kind: 'press', key } });
  }
});

test('sequence v1 enforces nondecreasing times, serial duration budget, and exactly one source', () => {
  valid({ action: 'run_sequence', sessionId: 's', sequence: { version: 1, actions: [
    { atMs: 0, action: { kind: 'key_down', key: 'W' } },
    { atMs: 0, action: { kind: 'key_down', key: 'D' } },
    { atMs: 10, action: { kind: 'key_up', key: 'W' } },
  ] } });
  valid({ action: 'run_sequence', sessionId: 's', sequence: { version: 1, actions: [{ atMs: 0, action: { kind: 'wait', durationMs: 600000 } }] } });
  invalid({ action: 'run_sequence', sessionId: 's', sequence: { version: 1, actions: [
    { atMs: 0, action: { kind: 'move', target: { x: 1, y: 1 }, durationMs: 300000 } },
    { atMs: 0, action: { kind: 'drag', from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, durationMs: 300001 } },
  ] }, revision: 1 }, /total duration/);
  assert.throws(() => validateSequence({ version: 1, actions: [
    { atMs: 2, action: { kind: 'wait', durationMs: 1 } },
    { atMs: 1, action: { kind: 'wait', durationMs: 1 } },
  ] }), /nondecreasing/);
  invalid({ action: 'run_sequence', sessionId: 's', sequence: { version: 1, actions: [] }, sequencePath: 'x.json' }, /exactly one/);
  invalid({ action: 'run_sequence', sessionId: 's' }, /exactly one/);
});

test('target-relative screenshot coordinates require a top-level revision, unlike desktop coordinates and refs', () => {
  invalid({ action: 'act', sessionId: 's', input: { kind: 'move', target: { x: 1, y: 1 } } }, /revision is required/);
  valid({ action: 'act', sessionId: 's', revision: 1, input: { kind: 'move', target: { x: 1, y: 1 } } });
  valid({ action: 'act', sessionId: 's', input: { kind: 'move', target: { x: 1, y: 1, scope: 'desktop' } } });
  valid({ action: 'act', sessionId: 's', input: { kind: 'move', target: { ref: 'e:1:0' } } });
  invalid({ action: 'run_sequence', sessionId: 's', sequence: { version: 1, actions: [{ atMs: 0, action: { kind: 'move', target: { x: 1, y: 1 } } }] } }, /revision is required/);
});

test('run_sequence accepts optional screenshot/tree/state for a trailing verification observation', () => {
  valid({ action: 'run_sequence', sessionId: 's', sequence: { version: 1, actions: [{ atMs: 0, action: { kind: 'text', text: 'x' } }] }, screenshot: true, tree: true, state: true });
  valid({ action: 'run_sequence', sessionId: 's', sequencePath: 'x.json', state: true });
  invalid({ action: 'run_sequence', sessionId: 's', sequence: { version: 1, actions: [{ atMs: 0, action: { kind: 'text', text: 'x' } }] }, input: { kind: 'focus' } }, /parameters.input/);
});
