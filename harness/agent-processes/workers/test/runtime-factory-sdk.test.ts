import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { SdkModule } from '../../lib/sdk-integration/sdk';
import { createRuntimeFactory, ServiceLoadingGate } from '../runtime-factory';

test('runtime factory preserves durable thinking on a message-empty configured session', async () => {
  // Preserve the SDK's ESM export conditions while allowing the runner's
  // explicit candidate overlay to select this package.
  const sdk = await import('@earendil-works/pi-coding-agent');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-runtime-factory-thinking-'));
  let disposeSession: (() => void) | undefined;

  try {
    const cwd = path.join(root, 'workspace');
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([
      fs.mkdir(cwd, { recursive: true }),
      fs.mkdir(agentDir, { recursive: true }),
      fs.mkdir(sessionDir, { recursive: true }),
    ]);
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultThinkingLevel: 'high' }));

    const sessionManager = sdk.SessionManager.create(cwd, sessionDir);
    sessionManager.appendModelChange('anthropic', 'claude-sonnet-4-5');
    sessionManager.appendThinkingLevelChange('low');
    const durableBeforeStartup = sessionManager.buildSessionContext?.();
    assert.deepEqual(sessionManager.getBranch().map((entry) => entry.type), [
      'model_change',
      'thinking_level_change',
    ]);
    assert.equal(durableBeforeStartup?.messages.length, 0);
    assert.equal(durableBeforeStartup?.thinkingLevel, 'low');
    assert.deepEqual(durableBeforeStartup?.model, {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });

    // The Pie facade intentionally erases SDK option bags to `unknown`; this
    // narrow adapter restores the exact public SDK parameter types at that seam.
    const factorySdk = {
      VERSION: sdk.VERSION,
      getAgentDir: sdk.getAgentDir,
      AuthStorage: sdk.AuthStorage,
      // Forward the required static facade explicitly rather than exposing the
      // SDK class prototype, whose type is wider than SdkModule's facade.
      SessionManager: {
        continueRecent: (cwd: string) => sdk.SessionManager.continueRecent(cwd),
        create: (cwd: string, sessionDir?: string) => sdk.SessionManager.create(cwd, sessionDir),
        inMemory: (cwd?: string) => sdk.SessionManager.inMemory(cwd),
        open: (sessionPath: string) => sdk.SessionManager.open(sessionPath),
        forkFrom: (sourcePath: string, targetCwd: string, sessionDir?: string) =>
          sdk.SessionManager.forkFrom(sourcePath, targetCwd, sessionDir),
        listAll: (sessionDir?: string) => sdk.SessionManager.listAll(sessionDir),
      },
      createAgentSessionServices: (options: unknown) => sdk.createAgentSessionServices(
        options as Parameters<typeof sdk.createAgentSessionServices>[0],
      ),
      createAgentSessionFromServices: (options: unknown) => sdk.createAgentSessionFromServices(
        options as Parameters<typeof sdk.createAgentSessionFromServices>[0],
      ),
      createAgentSessionRuntime: async () => {
        throw new Error('This test invokes the runtime factory directly.');
      },
    } satisfies SdkModule;
    const factory = createRuntimeFactory(
      factorySdk,
      sdk.AuthStorage.create(path.join(agentDir, 'auth.json')),
      cwd,
      new ServiceLoadingGate(),
    );
    const runtime = await factory({
      cwd,
      agentDir,
      sessionManager,
      sessionStartEvent: { type: 'session_start', reason: 'startup' },
    });
    if (!('session' in runtime)) throw new Error('The runtime factory did not return its created session.');
    const session = runtime.session;
    assert.ok(session instanceof sdk.AgentSession);
    const settingsManager = runtime.services.settingsManager;
    assert.ok(settingsManager instanceof sdk.SettingsManager);
    disposeSession = () => session.dispose();

    assert.equal(settingsManager.getDefaultThinkingLevel(), 'high');
    assert.equal(session.thinkingLevel, 'low');
    assert.equal(session.sessionManager.buildSessionContext().thinkingLevel, 'low');
  } finally {
    disposeSession?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});
