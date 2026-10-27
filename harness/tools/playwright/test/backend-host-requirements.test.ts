import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PlaywrightBackend } from '../backend.mjs';

const revisionDirectory = 'C:\\prepared\\payload\\browsers\\chromium_headless_shell-1234';
const executablePath = path.win32.join(
  revisionDirectory,
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
);
const launchFailure = new Error('launch sentinel');

function backendWith(options: { platform?: string; arch?: string; executablePath?: string; packaged?: boolean } = {}) {
  const calls: Array<{ type: string; value: unknown }> = [];
  const descriptor = {
    name: 'chromium-headless-shell',
    browserName: 'chromium',
    revision: '1234',
    browserVersion: '151.0.7922.34',
    directory: revisionDirectory,
    executablePath: () => options.executablePath ?? executablePath,
  };
  const registry = {
    _executables: [descriptor],
    async _validateHostRequirements(...args: unknown[]) {
      calls.push({ type: 'validate', value: args });
    },
  };
  const runtime = {
    registry,
    revision: '1234',
    browserVersion: '151.0.7922.34',
    expectedRevisionDirectory: revisionDirectory,
    expectedExecutablePath: executablePath,
  };
  const chromium = {
    async launchServer(launchOptions: unknown) {
      calls.push({ type: 'launch', value: launchOptions });
      throw launchFailure;
    },
  };
  const backend = new PlaywrightBackend({
    chromium,
    packagedHostRuntime: () => options.packaged === false ? undefined : runtime,
    platform: options.platform ?? 'win32',
    arch: options.arch ?? 'x64',
  });
  return { backend, calls, registry };
}

async function open(backend: PlaywrightBackend): Promise<void> {
  await backend.handle('open', { sessionId: 'host-check', artifactDir: tmpdir() });
}

test('packaged open validates the exact headless-shell directory before launching that shell', async () => {
  const { backend, calls } = backendWith();

  await assert.rejects(() => open(backend), /launch sentinel/);
  assert.deepEqual(calls, [
    {
      type: 'validate',
      value: ['javascript', revisionDirectory, [], [], ['chrome-headless-shell-win64']],
    },
    { type: 'launch', value: { headless: true, executablePath } },
  ]);
});

test('packaged open preserves host validation rejection and never launches after it', async () => {
  const validationFailure = new Error('host requirements sentinel');
  const { backend, calls, registry } = backendWith();
  registry._validateHostRequirements = async (...args: unknown[]) => {
    calls.push({ type: 'validate', value: args });
    throw validationFailure;
  };

  await assert.rejects(() => open(backend), (error: unknown) => error === validationFailure);
  assert.deepEqual(calls, [{
    type: 'validate',
    value: ['javascript', revisionDirectory, [], [], ['chrome-headless-shell-win64']],
  }]);
});

test('packaged registry mismatch fails closed before validation or launch', async () => {
  const { backend, calls } = backendWith({ executablePath: 'C:\\other\\chrome-headless-shell.exe' });

  await assert.rejects(() => open(backend), /registry descriptor does not match the pinned payload shell/);
  assert.deepEqual(calls, []);
});

test('packaged open fails closed when the pinned registry API shape is unavailable', async () => {
  const { backend, calls, registry } = backendWith();
  registry._executables = undefined as unknown as typeof registry._executables;

  await assert.rejects(() => open(backend), /core registry API does not match the pinned host-check API/);
  assert.deepEqual(calls, []);
});

test('packaged open rejects unsupported host architecture before validation or launch', async () => {
  const { backend, calls } = backendWith({ platform: 'linux' });

  await assert.rejects(() => open(backend), /require win32\/x64/);
  assert.deepEqual(calls, []);
});

test('source open keeps the original launchServer options without packaged host checks', async () => {
  const { backend, calls } = backendWith({ packaged: false });
  await assert.rejects(() => open(backend), /launch sentinel/);
  assert.deepEqual(calls, [{ type: 'launch', value: { headless: true } }]);
});
