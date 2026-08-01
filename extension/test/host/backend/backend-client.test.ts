import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { deriveTrustedSdkRoot } from '../../../src/host/backend/trusted-sdk-root';
import { PROTOCOL_VERSION } from '../../../src/shared/protocol';

test('deriveTrustedSdkRoot trusts the containing node_modules tree only', () => {
  assert.equal(
    deriveTrustedSdkRoot('C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent'),
    'C:\\tools\\node_modules',
  );
  assert.equal(deriveTrustedSdkRoot('C:\\tools\\pi-coding-agent'), undefined);
});

class ImmediateReadyStream extends PassThrough {
  private emitted = false;

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const result = super.on(eventName, listener);
    if (!this.emitted && eventName === 'data') {
      this.emitted = true;
      listener(Buffer.from(JSON.stringify({
        event: 'backend.ready',
        payload: {
          sdkPath: '/mock/sdk',
          agentDir: '/mock/agent',
          sdkVersion: '0.0.0-test',
          protocolVersion: PROTOCOL_VERSION,
          authPath: '/mock/auth.json',
        },
      }) + '\n'));
    }
    return result;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout: PassThrough = new ImmediateReadyStream();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killCount = 0;

  kill(): boolean {
    this.killCount += 1;
    this.emit('exit', 0);
    return true;
  }
}

class NeverReadyChildProcess extends FakeChildProcess {
  override readonly stdout = new PassThrough();
}

test('BackendClient.start resolves when backend.ready arrives immediately as stdout listener attaches', async () => {
  // client.start spreads process.env into the spawn env, so a stale
  // PIE_TRUSTED_SDK_ROOT inherited from the parent environment would leak
  // through when the derived trusted root is undefined. Isolate the var so
  // the assertion below is deterministic regardless of the host environment.
  const previousTrustedRoot = process.env.PIE_TRUSTED_SDK_ROOT;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  delete process.env.PIE_TRUSTED_SDK_ROOT;
  const agentDir = path.resolve('/mock/agent');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = 'data/outcomes/sessions';

  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  const fakeProc = new FakeChildProcess();
  let nextProc = fakeProc as unknown as cp.ChildProcess;
  let spawnOptions: cp.SpawnOptions | undefined;
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
        spawn: ((_command: string, _args?: readonly string[], options?: cp.SpawnOptions) => {
          spawnOptions = options;
          return nextProc;
        }) as typeof cp.spawn,
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  const { BackendClient } = await import('../../../src/host/backend/client');
  const client = new BackendClient();
  try {
    const payload = await client.start({
      nodePath: '/mock/node',
      backendPath: '/mock/backend.js',
      sdkPath: '/mock/sdk',
      cwd: '/mock/cwd',
    });

    assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
    assert.equal(payload.sdkPath, '/mock/sdk');
    assert.equal((spawnOptions?.env as NodeJS.ProcessEnv | undefined)?.PIE_EDITOR_VERSION, '1.102.3-test');
    assert.equal((spawnOptions?.env as NodeJS.ProcessEnv | undefined)?.PIE_TRUSTED_SDK_ROOT, undefined);
    const spawnedEnv = spawnOptions?.env as NodeJS.ProcessEnv | undefined;
    assert.equal(spawnedEnv?.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(spawnedEnv?.PI_CODING_AGENT_SESSION_DIR, path.join(agentDir, 'data/outcomes/sessions'));
    assert.equal(spawnedEnv?.PIE_REVIEWS_DIR, path.join(agentDir, 'data/outcomes/session-reviews'));

    Object.defineProperty(fakeProc.stdin, 'write', {
      configurable: true,
      value: () => { throw new Error('EPIPE'); },
    });
    await assert.rejects(client.request('app.ping'), /Failed to write backend request req-1: EPIPE/);

    client.dispose();
    const stalledProc = new NeverReadyChildProcess();
    nextProc = stalledProc as unknown as cp.ChildProcess;
    const stalledClient = new BackendClient({ readyTimeoutMs: 5 });
    try {
      await assert.rejects(
        stalledClient.start({
          nodePath: '/mock/node',
          backendPath: '/mock/backend.js',
          sdkPath: '/mock/sdk',
          cwd: '/mock/cwd',
        }),
        /Timed out waiting for the pie backend to become ready/,
      );
      assert.equal(stalledProc.killCount, 1, 'a startup timeout terminates the unusable child');
      await assert.rejects(stalledClient.request('app.ping'), /Backend is not running/);
    } finally {
      stalledClient.dispose();
    }
  } finally {
    client.dispose();
    moduleWithLoad._load = originalLoad;
    if (previousTrustedRoot === undefined) delete process.env.PIE_TRUSTED_SDK_ROOT;
    else process.env.PIE_TRUSTED_SDK_ROOT = previousTrustedRoot;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
  }
});
