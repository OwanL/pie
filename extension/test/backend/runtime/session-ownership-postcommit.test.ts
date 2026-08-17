import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import type { SdkSessionOwnershipAdapter } from '../../../src/backend/sdk';
import { ensureSdkPatchBarrier } from '../../../src/backend/sdk-patch-barrier';
import {
  SessionOwnershipAuthority,
  SessionOwnershipFailClosedError,
} from '../../../src/backend/session-ownership-authority';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sdkPath = path.join(extensionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent');

test('a failure after transfer consumption leaves the destination retiring and the worker closed', async () => {
  const root = await fs.mkdtemp(path.join(extensionRoot, '.pie-phase4-postcommit-test-'));
  const previousTrustedRoot = process.env.PIE_TRUSTED_SDK_ROOT;
  process.env.PIE_TRUSTED_SDK_ROOT = extensionRoot;
  try {
    await ensureSdkPatchBarrier(sdkPath);
    const nonce = Date.now();
    const { SessionManager } = await import(`${pathToFileURL(path.join(sdkPath, 'dist', 'core', 'session-manager.js')).href}?postcommit=${nonce}`);
    const { createAgentSessionRuntime } = await import(`${pathToFileURL(path.join(sdkPath, 'dist', 'core', 'agent-session-runtime.js')).href}?postcommit=${nonce}`);
    const sessionDir = path.join(root, 'sessions');
    const source = SessionManager.create(root, sessionDir);
    const authority = new SessionOwnershipAuthority();
    const owner = { coordinatorGeneration: 1, workerId: 'postcommit-worker', workerGeneration: 1 };
    const lease = await authority.registerHot(source.getSessionFile(), owner);
    const base = authority.createAdapter(owner);
    let transferredPath: string | undefined;
    const adapter: SdkSessionOwnershipAdapter = {
      ...base,
      consumeTransferAuthorization: async (authorization, destinationPath) => {
        transferredPath = destinationPath;
        await base.consumeTransferAuthorization(authorization, destinationPath);
        throw new Error('injected destination activation failure');
      },
    };
    const runtime = await createAgentSessionRuntime(async (options: any) => ({
      session: {
        sessionManager: options.sessionManager,
        sessionFile: options.sessionManager.getSessionFile(),
        isStreaming: false,
        agent: { state: { messages: [] }, waitForIdle: async () => undefined },
        extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
        abort: async () => undefined,
        dispose: () => undefined,
        createReplacedSessionContext: () => ({}),
      },
      services: { cwd: options.cwd, agentDir: options.agentDir },
      diagnostics: [],
    }), {
      cwd: root,
      agentDir: root,
      sessionManager: source,
      ownershipAdapter: adapter,
      writeLease: lease,
    });

    await assert.rejects(runtime.newSession(), SessionOwnershipFailClosedError);
    assert.ok(transferredPath);
    assert.equal((await authority.inspect(transferredPath!))?.state, 'retiring');
    await assert.rejects(runtime.newSession(), /failed closed/i);
  } finally {
    if (previousTrustedRoot === undefined) delete process.env.PIE_TRUSTED_SDK_ROOT;
    else process.env.PIE_TRUSTED_SDK_ROOT = previousTrustedRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});
