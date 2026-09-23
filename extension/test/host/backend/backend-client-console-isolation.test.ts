import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { PROTOCOL_VERSION } from '../../../src/shared/protocol';

/**
 * Regression coverage for standalone Windows console isolation at backend
 * spawn. The launcher's Ctrl+C must never terminate the backend or its workers
 * before the host's stdin-close graceful drain, so the standalone composition
 * spawns the backend with windowsHide (private hidden console) on Windows.
 * These tests pin the spawn options; the native console behavior is proven by
 * the standalone integration suite in test/standalone.
 *
 * The module-level `node:child_process` binding of the CJS-transpiled client is
 * resolved at first import, so one patch serves every capture in this file
 * (the same pattern as backend-client.test.ts).
 */

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
  readonly stdout: PassThrough;
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  constructor() {
    super();
    this.stdout = new ImmediateReadyStream();
  }

  kill(): boolean {
    this.emit('exit', 0);
    return true;
  }
}

const noOrphans = async () => ({ candidates: [], reaped: [], failures: [] });

test('backend spawn options carry the scoped standalone console isolation', async () => {
  const captured: cp.SpawnOptions[] = [];
  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'node:child_process' || request === 'child_process') {
      return {
        ...cp,
        spawn: ((_command: string, _args?: readonly string[], options?: cp.SpawnOptions) => {
          captured.push(options ?? {});
          return new FakeChildProcess() as unknown as cp.ChildProcess;
        }) as typeof cp.spawn,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { BackendClient } = await import('../../../src/host/backend/client');
    const { createStandaloneBackendClient } = await import('../../../src/standalone');

    // CREATE_NO_WINDOW (own hidden console) is the isolation mechanism: console
    // stop events from the launcher can no longer reach the backend or its
    // workers, while stdio/lifetime pipes, taskkill tree termination, and
    // kernel Job containment (children of an assigned process join the Job; no
    // breakaway flags exist) are unaffected. detached (DETACHED_PROCESS |
    // CREATE_NEW_PROCESS_GROUP) is deliberately not used so backend descendants
    // keep an inheritable hidden console instead of allocating fresh visible
    // console windows, and POSIX spawns keep their current process-group
    // behavior.
    const isolated = new BackendClient({ orphanReaper: noOrphans, standaloneConsoleIsolation: true });
    await isolated.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd' });

    const vscodeShaped = new BackendClient({ editorVersion: '1.102.3-test', orphanReaper: noOrphans });
    await vscodeShaped.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd' });

    const standalone = createStandaloneBackendClient();
    await standalone.start({ nodePath: '/mock/node', backendPath: '/mock/backend.js', sdkPath: '/mock/sdk', cwd: '/mock/cwd' });

    assert.equal(captured.length, 3, 'every client start must spawn exactly once');
    const [isolatedOptions, vscodeOptions, standaloneOptions] = captured;
    const expectedHide = process.platform === 'win32' ? true : undefined;
    assert.equal(isolatedOptions.windowsHide, expectedHide);
    assert.equal(isolatedOptions.detached, undefined);
    assert.deepEqual(isolatedOptions.stdio, ['pipe', 'pipe', 'pipe', 'pipe']);

    assert.equal(vscodeOptions.windowsHide, undefined, 'the VS Code spawn options must stay unchanged');
    assert.equal(vscodeOptions.detached, undefined);

    assert.equal(standaloneOptions.windowsHide, expectedHide);
    assert.equal(standaloneOptions.detached, undefined);
    assert.equal((standaloneOptions.env as NodeJS.ProcessEnv | undefined)?.PIE_EDITOR_VERSION, undefined);
  } finally {
    moduleWithLoad._load = originalLoad;
  }
});