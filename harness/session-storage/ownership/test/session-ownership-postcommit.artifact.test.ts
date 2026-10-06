import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import type { SdkSessionOwnershipAdapter } from '../../../agent-processes/lib/sdk-integration/sdk';
import { loadSdk } from '../../../agent-processes/lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../../agent-processes/lib/sdk-integration/test/source-fixture';
import {
  SessionOwnershipAuthority,
  SessionOwnershipFailClosedError,
} from '../session-ownership-authority';

test('a failure after transfer consumption leaves the destination retiring and the worker closed', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'pie-source-postcommit-test-')));
  try {
    // Verification and the final artifact rehash are owned by source-fixture.
    const { SessionManager, createAgentSessionRuntime } = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode) as any;
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
        isCompacting: false,
        isRetrying: false,
        isBashRunning: false,
        clearQueue: () => undefined,
        abortCompaction: () => undefined,
        abortBranchSummary: () => undefined,
        abortBash: () => undefined,
        abortRetry: () => undefined,
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
    await fs.rm(root, { recursive: true, force: true });
  }
});
