import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { SdkModule } from '../../lib/sdk-integration/sdk';
import { createRuntimeFactory, ServiceLoadingGate } from '../runtime-factory';

test('runtime factory preserves durable thinking on a message-empty configured session', async () => {
  const sdkUrl = new URL(
    '../../../../application/hosts/vscode/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    import.meta.url,
  );
  const sdk = await import(sdkUrl.href) as unknown as SdkModule;
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

    const factory = createRuntimeFactory(
      sdk,
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
    const session = runtime.session as {
      thinkingLevel: string;
      sessionManager: {
        buildSessionContext: () => { messages: unknown[]; thinkingLevel: string };
      };
      dispose: () => void;
    };
    const services = runtime.services as unknown as {
      settingsManager: { getDefaultThinkingLevel: () => string | undefined };
    };
    disposeSession = () => session.dispose();

    assert.equal(services.settingsManager.getDefaultThinkingLevel(), 'high');
    assert.equal(session.thinkingLevel, 'low');
    assert.equal(session.sessionManager.buildSessionContext().thinkingLevel, 'low');
  } finally {
    disposeSession?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});
