import assert from 'node:assert/strict';
import test from 'node:test';

import { focusWindowNative } from '../src/win32-focus.mjs';

test('native focus invokes bounded hidden PowerShell with only numeric PID/HWND data', async () => {
  let invocation: any;
  const result = await focusWindowNative({
    pid: 42,
    windowId: 99,
    timeoutMs: 1234,
    execFileImpl(command: string, args: string[], options: any, callback: (error: Error | null, stdout: string) => void) {
      invocation = { command, args, options };
      callback(null, 'FOCUSED\r\n');
    },
  });
  assert.equal(result, true);
  assert.equal(invocation.command, 'powershell.exe');
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.timeout, 1234);
  assert.ok(invocation.args.includes('-EncodedCommand'));
  const encoded = invocation.args.at(-1);
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /\$expectedPid = \[uint32\]42/);
  assert.match(script, /\$hwnd = \[IntPtr\]\[Int64\]99/);
  assert.match(script, /GetWindowThreadProcessId/);
  assert.match(script, /SetForegroundWindow/);
});

test('native focus reports false for timeout, identity mismatch, or unproved foreground', async () => {
  for (const error of [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), new Error('identity mismatch')]) {
    const result = await focusWindowNative({
      pid: 42,
      windowId: 99,
      execFileImpl(_command: string, _args: string[], _options: any, callback: (error: Error | null, stdout: string) => void) {
        callback(error, 'IDENTITY_MISMATCH');
      },
    });
    assert.equal(result, false);
  }
});

test('native focus preserves cancellation before launch and while PowerShell is in flight', async () => {
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(
    () => focusWindowNative({ pid: 42, windowId: 99, signal: alreadyAborted.signal }),
    (error: any) => error.name === 'AbortError' && error.code === 'ABORT_ERR',
  );

  const inFlight = new AbortController();
  const pending = focusWindowNative({
    pid: 42,
    windowId: 99,
    signal: inFlight.signal,
    execFileImpl(_command: string, _args: string[], options: any, callback: (error: Error | null, stdout: string) => void) {
      options.signal.addEventListener('abort', () => {
        callback(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }), '');
      }, { once: true });
    },
  });
  inFlight.abort();
  await assert.rejects(
    () => pending,
    (error: any) => error.name === 'AbortError' && error.code === 'ABORT_ERR',
  );
});
