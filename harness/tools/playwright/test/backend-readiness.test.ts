import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { PlaywrightBackend } from '../backend.mjs';

function backendWithLaunchError(launchError: Error & { code?: string }) {
  const launchOptions: unknown[] = [];
  const chromium = {
    executablePath() {
      assert.fail('readiness must be resolved by Playwright launch, not the full-Chromium path');
    },
    async launchServer(options: unknown) {
      launchOptions.push(options);
      throw launchError;
    },
    async connect() {
      assert.fail('connect must not run when launchServer fails');
    },
  };
  return { backend: new PlaywrightBackend({ chromium }), launchOptions };
}

async function assertOpenFailure(
  backend: PlaywrightBackend,
  sessionId: string,
  code: string,
  message: RegExp,
): Promise<void> {
  await assert.rejects(
    () => backend.handle('open', { sessionId, artifactDir: tmpdir() }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, code);
      assert.match((error as Error).message, message);
      return true;
    },
  );
  assert.equal(backend.sessions.size, 0, 'failed open releases session ownership');
  assert.equal(backend.closingSessions.size, 0, 'failed open cleanup completes before rejection');
}

test('open resolves headless-shell readiness through Playwright and classifies a missing executable', async () => {
  const { backend, launchOptions } = backendWithLaunchError(
    new Error("browserType.launchServer: Executable doesn't exist at C:\\playwright\\chromium_headless_shell.exe"),
  );

  await assertOpenFailure(backend, 'missing-shell', 'BROWSER_NOT_INSTALLED', /--only-shell chromium/);
  assert.deepEqual(launchOptions, [{ headless: true }]);
});

test('open preserves launch failures that are not missing-browser errors', async () => {
  const { backend, launchOptions } = backendWithLaunchError(new Error('browser process exited unexpectedly'));

  await assertOpenFailure(backend, 'launch-failure', 'BROWSER_LAUNCH_FAILED', /browser process exited unexpectedly/);
  assert.deepEqual(launchOptions, [{ headless: true }]);
});
