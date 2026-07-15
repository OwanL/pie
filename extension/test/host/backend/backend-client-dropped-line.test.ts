import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { PROTOCOL_VERSION } from '../../../src/shared/protocol';

/**
 * Brief B — dropped-line correlation diagnostics. `handleLine` must correlate a
 * dropped (non-JSON / unrecognized) backend stdout line to a pending `req-NN`
 * and reject that request with a descriptive error (snippet + stderr tail)
 * instead of letting it time out opaquely.
 *
 * Lives in its own file so the `vscode` / `child_process` mock + dynamic
 * `BackendClient` import are isolated to this process (each `node --test` file
 * runs in a separate process — no module-cache conflict with
 * `backend-client.test.ts`).
 */

class ImmediateReadyStream extends PassThrough {
  private emitted = false;

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const result = super.on(eventName, listener);
    if (!this.emitted && eventName === 'data') {
      this.emitted = true;
      listener(
        Buffer.from(
          JSON.stringify({
            event: 'backend.ready',
            payload: {
              sdkPath: '/mock/sdk',
              agentDir: '/mock/agent',
              sdkVersion: '0.0.0-test',
              protocolVersion: PROTOCOL_VERSION,
              authPath: '/mock/auth.json',
            },
          }) + '\n',
        ),
      );
    }
    return result;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new ImmediateReadyStream();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  kill(): boolean {
    this.emit('exit', 0);
    return true;
  }
}

let lastFakeProc: FakeChildProcess;
let uninstallVscodeMock: (() => void) | undefined;

let BackendClientCtor: typeof import('../../../src/host/backend/client').BackendClient;
let extractRequestId: typeof import('../../../src/host/backend/client').extractRequestId;

function installVscodeMock(): (() => void) | undefined {
  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return {
        version: '1.102.3-test',
        EventEmitter: class<TValue> {
          private readonly emitter = new EventEmitter();

          readonly event = (listener: (value: TValue) => void) => {
            this.emitter.on('event', listener);
            return { dispose: () => this.emitter.off('event', listener) };
          };

          fire(value: TValue): void {
            this.emitter.emit('event', value);
          }

          dispose(): void {
            this.emitter.removeAllListeners();
          }
        },
      };
    }
    if (request === 'node:child_process' || request === 'child_process') {
      return {
        ...cp,
        spawn: (() => {
          // Fresh fake proc per start() — the ImmediateReadyStream's
          // backend.ready emission is one-shot, so a reused proc would hang
          // start() on the second call.
          lastFakeProc = new FakeChildProcess();
          return lastFakeProc as unknown as cp.ChildProcess;
        }) as typeof cp.spawn,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => {
    moduleWithLoad._load = originalLoad;
  };
}

test.before(async () => {
  uninstallVscodeMock = installVscodeMock();
  const { BackendClient, extractRequestId: extract } = await import('../../../src/host/backend/client');
  BackendClientCtor = BackendClient;
  extractRequestId = extract;
});

test.after(() => {
  uninstallVscodeMock?.();
});

async function startClient(): Promise<{ client: import('../../../src/host/backend/client').BackendClient; proc: FakeChildProcess }> {
  const client = new BackendClientCtor();
  await client.start({
    nodePath: '/mock/node',
    backendPath: '/mock/backend.js',
    sdkPath: '/mock/sdk',
    cwd: '/mock/cwd',
  });
  return { client, proc: lastFakeProc };
}

// ─── extractRequestId (pure) ────────────────────────────────────────────────

test('extractRequestId returns the id from a parsed-but-unrecognized envelope', () => {
  // A parsed object carrying an `id` but failing isResponseEnvelope (malformed
  // shape) — the id is recoverable directly from the parsed value.
  assert.equal(extractRequestId('{"id":"req-5"}', { id: 'req-5' }), 'req-5');
});

test('extractRequestId regex-extracts req-NN from truncated/garbled JSON', () => {
  // Non-JSON (parse failed, value undefined): fall back to a regex on the raw
  // line. Truncated JSON that still contains the id field is recovered.
  assert.equal(extractRequestId('{"id":"req-12","result":}', undefined), 'req-12');
  assert.equal(extractRequestId('garbage "id":"req-99" trailing', undefined), 'req-99');
});

test('extractRequestId returns undefined when no req id is recoverable', () => {
  // No id field, no req-NN pattern → undefined (handleLine then logs + drops).
  assert.equal(extractRequestId('totally garbage no id', undefined), undefined);
  assert.equal(extractRequestId('{"event":"message.delta"}', { event: 'message.delta' }), undefined);
  // A non-req string id is returned (the caller's reject no-ops if not pending).
  assert.equal(extractRequestId('{"id":"something"}', { id: 'something' }), 'something');
});

// ─── handleLine → pending request rejection (integration) ───────────────────

test('BackendClient rejects a pending request with a diagnostic when a dropped line carries its id', async () => {
  const { client, proc } = await startClient();
  try {
    // Issue a request (creates req-1, pending in RequestTracker).
    const reqPromise = client.request('message.send', { sessionPath: '/s', text: 'hi' });
    // Drop a malformed line carrying req-1's id (truncated JSON). handleLine
    // correlates it to the pending req-1 and rejects with a diagnostic instead
    // of letting it time out opaquely.
    proc.stdout.emit('data', Buffer.from('{"id":"req-1","result":}\n'));
    await assert.rejects(
      reqPromise,
      (err: Error) =>
        /Backend sent an unparseable response for req-1/.test(err.message) &&
        !/stderr tail:/.test(err.message), // no stderr yet
    );
  } finally {
    client.dispose();
  }
});

test('BackendClient dropped-line rejection surfaces the stderr tail when present', async () => {
  const { client, proc } = await startClient();
  try {
    // Emit stderr first so the ring buffer is populated.
    proc.stderr.emit('data', Buffer.from('backend stderr noise here\n'));
    const reqPromise = client.request('message.send', { sessionPath: '/s', text: 'hi' });
    proc.stdout.emit('data', Buffer.from('{"id":"req-1","result":}\n'));
    await assert.rejects(
      reqPromise,
      (err: Error) =>
        /Backend sent an unparseable response for req-1/.test(err.message) &&
        /stderr tail:/.test(err.message) &&
        /backend stderr noise here/.test(err.message),
    );
  } finally {
    client.dispose();
  }
});

test('BackendClient redacts credentials from dropped-line and stderr diagnostics', async () => {
  const { client, proc } = await startClient();
  try {
    proc.stderr.emit('data', Buffer.from('authorization=stderr-secret\n'));
    const reqPromise = client.request('message.send', { sessionPath: '/s', text: 'hi' });
    proc.stdout.emit('data', Buffer.from('{"id":"req-1","apiKey":"stdout-secret","result":}\n'));

    await assert.rejects(reqPromise, (error: Error) => {
      assert.match(error.message, /req-1/);
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, /stderr-secret|stdout-secret/);
      return true;
    });
  } finally {
    client.dispose();
  }
});

test('BackendClient redacts a stderr credential across every chunk split', async () => {
  const { client, proc } = await startClient();
  try {
    const credentialLine = 'authorization=stderr-supersecret';
    for (let split = 1; split < credentialLine.length; split += 1) {
      proc.stderr.emit('data', Buffer.from(credentialLine.slice(0, split)));
      proc.stderr.emit('data', Buffer.from(`${credentialLine.slice(split)}\n`));
    }
    const reqPromise = client.request('message.send', { sessionPath: '/s', text: 'hi' });
    proc.stdout.emit('data', Buffer.from('{"id":"req-1","result":}\n'));

    await assert.rejects(reqPromise, (error: Error) => {
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, /stderr-supersecret|supersecret/);
      return true;
    });
  } finally {
    client.dispose();
  }
});

test('BackendClient does not reject an unrelated pending request when a dropped line has no recoverable id', async () => {
  // A dropped line with no req-NN must NOT reject a pending request — it is
  // logged and dropped, and the pending request stays pending. Dispose rejects
  // it via the exit handler ("Backend exited unexpectedly"), NOT with an
  // "unparseable response" error — proving the dropped-line path did not
  // correlate it. Dispose BEFORE awaiting so the 10s `message.send` timeout
  // cannot win the race.
  const { client, proc } = await startClient();
  try {
    const reqPromise = client.request('message.send', { sessionPath: '/s', text: 'hi' });
    proc.stdout.emit('data', Buffer.from('totally garbage no id\n'));
    // Let the line reader process the dropped line.
    await new Promise<void>((r) => setTimeout(r, 5));
    client.dispose();
    await assert.rejects(
      reqPromise,
      (err: Error) =>
        !/unparseable response/.test(err.message) &&
        /(Backend exited unexpectedly|Backend client disposed)/.test(err.message),
    );
  } finally {
    client.dispose();
  }
});
