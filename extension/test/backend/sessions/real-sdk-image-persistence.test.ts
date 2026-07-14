import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadSdk } from '../../../src/backend/sdk';
import { mapTranscript } from '../../../src/backend/transcript';

const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cY9sAAAAASUVORK5CYII=';

declare const __dirname: string;

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-real-sdk-image-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function resolveRealSdkPath(): string {
  const configured = process.env['PIE_REAL_SDK_PATH']?.trim();
  if (configured) {
    return configured;
  }

  if (process.platform === 'win32' && process.env['APPDATA']) {
    return path.join(process.env['APPDATA'], 'npm', 'node_modules', '@mariozechner', 'pi-coding-agent');
  }

  const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return path.join(npmRoot, '@mariozechner', 'pi-coding-agent');
}

test('real SDK persists committed user images in canonical session history', { timeout: 240_000 }, async (t) => {
  if (process.env['PIE_RUN_REAL_SDK_TESTS'] !== '1') {
    t.skip('Set PIE_RUN_REAL_SDK_TESTS=1 to run the real SDK image persistence verification.');
    return;
  }

  await withTempDir(async (tempDir) => {
    const sdk = await loadSdk(resolveRealSdkPath());
    const agentDir = path.join(tempDir, 'agent');
    const cwd = path.join(tempDir, 'workspace');
    const sessionDir = path.join(agentDir, 'sessions');
    const authSource = path.resolve(__dirname, '..', '..', '..', '..', 'auth.json');

    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.copyFile(authSource, path.join(agentDir, 'auth.json'));
    await fs.writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'github-copilot',
        defaultModel: 'claude-haiku-4.5',
        defaultThinkingLevel: 'minimal',
      }, null, 2),
      'utf8',
    );

    const authStorage = sdk.AuthStorage.create(path.join(agentDir, 'auth.json'));
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
      const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
        authStorage,
        resourceLoaderOptions: {},
      });
      const created = await sdk.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      });
      return Object.assign({ services }, created as Record<string, unknown>);
    };

    const sessionManager = sdk.SessionManager.create(cwd);
    const runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });

    try {
      const availableModels = runtime.services.modelRegistry.getAvailable();
      const imageModel = availableModels.find((model) => Array.isArray(model.input) && model.input.includes('image'));
      assert.ok(imageModel, 'expected at least one image-capable model from the real SDK');

      if (runtime.session.model?.id !== imageModel?.id && typeof runtime.session.setModel === 'function') {
        const resolvedModel = runtime.services.modelRegistry.find(imageModel!.provider, imageModel!.id);
        assert.ok(resolvedModel, 'expected to resolve the selected image-capable model from the registry');
        await runtime.session.setModel(resolvedModel);
      }
      runtime.session.setThinkingLevel?.('minimal');

      let preflightAccepted = false;
      const waitForAgentEnd = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for agent_end from the real SDK session.')), 180_000);
        const unsubscribe = runtime.session.subscribe((event) => {
          if (event.type === 'agent_end') {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        });
      });

      await runtime.session.prompt('Reply with exactly the single word ok and do not use tools.', {
        images: [{
          type: 'image',
          data: PNG_1X1_BASE64,
          mimeType: 'image/png',
        }],
        source: 'rpc',
        preflightResult: (success) => {
          preflightAccepted = success;
        },
      });

      await waitForAgentEnd;
      assert.equal(preflightAccepted, true, 'the real SDK prompt should pass preflight acceptance');

      const sessionFile = runtime.session.sessionFile ?? runtime.session.sessionManager.getSessionFile();
      assert.ok(sessionFile, 'the real SDK session should persist to a session file');
      const raw = await fs.readFile(sessionFile!, 'utf8');
      assert.match(raw, /"type":"image"/, 'session JSONL should contain a committed image content block');
      assert.match(raw, /"mimeType":"image\/png"/, 'session JSONL should retain the image mime type');
      assert.ok(raw.includes(PNG_1X1_BASE64), 'session JSONL should retain the committed image bytes');

      await runtime.dispose();

      const reopenedManager = sdk.SessionManager.open(sessionFile!);
      const reopenedTranscript = mapTranscript(reopenedManager.getBranch() as any);
      const reopenedUserMessage = reopenedTranscript.find((message) =>
        message.role === 'user'
        && message.userParts?.some((part) => part.kind === 'image'),
      );

      assert.ok(reopenedUserMessage, 'reopened canonical transcript should restore the committed user image');
      const restoredImagePart = reopenedUserMessage?.userParts?.find((part) => part.kind === 'image');
      assert.equal(restoredImagePart?.kind, 'image');
      if (restoredImagePart?.kind === 'image') {
        assert.equal(restoredImagePart.mimeType, 'image/png');
        assert.equal(restoredImagePart.dataBase64, PNG_1X1_BASE64);
      }
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  });
});
