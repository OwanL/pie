import assert from 'node:assert/strict';
import test from 'node:test';
import type cp from 'node:child_process';

import { isExecTimeoutKill } from '../src/shared/exec-command';

/** Build a minimal ExecFileException-shaped object for the predicate. */
function err(overrides: Partial<cp.ExecFileException> = {}): cp.ExecFileException {
  return {
    name: 'ExecFileError',
    message: 'boom',
    killed: false,
    code: 1,
    ...overrides,
  } as cp.ExecFileException;
}

test('isExecTimeoutKill: a Node timeout kill (killed=true, numeric code) is detected', () => {
  assert.equal(isExecTimeoutKill(err({ killed: true, code: 1 })), true);
  assert.equal(isExecTimeoutKill(err({ killed: true, code: null })), true);
});

test('isExecTimeoutKill: maxBuffer overflow (killed=true, ERR_CHILD_PROCESS_STDIO_MAXBUFFER) is NOT a timeout', () => {
  assert.equal(
    isExecTimeoutKill(err({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })),
    false,
  );
});

test('isExecTimeoutKill: an external SIGTERM (killed=false) is NOT a timeout', () => {
  // An external kill leaves `killed` false; the old `signal === 'SIGTERM'`
  // branch would have mislabelled this as a timeout.
  assert.equal(isExecTimeoutKill(err({ killed: false, signal: 'SIGTERM' })), false);
});

test('isExecTimeoutKill: null / non-killed errors are not timeouts', () => {
  assert.equal(isExecTimeoutKill(null), false);
  assert.equal(isExecTimeoutKill(err({ killed: false })), false);
  assert.equal(isExecTimeoutKill(err({ killed: undefined })), false);
});
