import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';

import {
  applyStandaloneStartupLanPreference,
  installStandaloneSignalHandlers,
  main,
  STANDALONE_HELP_TEXT,
  parseStandaloneArguments,
} from '../../src/standalone';
import { createStandaloneHostRuntimePlatform, StandaloneBrowserRendererFacade } from '../../src/standalone/platform';
import { StandaloneHostStorage } from '../../src/standalone/storage';

async function tempDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pie-standalone-test-'));
}

test('standalone argument parsing requires an absolute existing workspace and preserves LAN override intent', async () => {
  const cwd = await tempDirectory();
  assert.deepEqual(parseStandaloneArguments(['--cwd', cwd]), { cwd: path.resolve(cwd) });
  assert.deepEqual(parseStandaloneArguments(['--cwd', cwd, '--lan']), { cwd: path.resolve(cwd), allowLan: true });
  assert.deepEqual(parseStandaloneArguments(['--lan', `--cwd=${cwd}`]), { cwd: path.resolve(cwd), allowLan: true });
  assert.deepEqual(parseStandaloneArguments(['--cwd', cwd, '--no-lan']), { cwd: path.resolve(cwd), allowLan: false });
  assert.throws(() => parseStandaloneArguments(['--cwd', cwd, '--lan', '--lan']), /Usage/);
  assert.throws(() => parseStandaloneArguments(['--cwd', cwd, '--lan', '--no-lan']), /Usage/);
  assert.throws(() => parseStandaloneArguments(['--cwd', 'relative']), /absolute workspace/);
  assert.throws(() => parseStandaloneArguments(['--cwd', path.join(cwd, 'missing')]), /does not exist/);
  assert.throws(() => parseStandaloneArguments(['--unknown']), /Unknown standalone argument/);
});

test('standalone CLI help documents saved-default and explicit LAN overrides', async () => {
  const chunks: string[] = [];
  const stdout = new Writable({ write: (chunk, _encoding, callback) => {
    chunks.push(String(chunk));
    callback();
  } });
  assert.equal(await main(['--help'], { output: { stdout } }), undefined);
  assert.equal(chunks.join(''), `${STANDALONE_HELP_TEXT}\n`);
  assert.match(STANDALONE_HELP_TEXT, /--lan \| --no-lan/);
  assert.match(STANDALONE_HELP_TEXT, /restores the saved LAN preference/);
});

test('standalone startup LAN flags override and persist saved preference while no flag restores it', async () => {
  for (const scenario of [
    { saved: true, args: ['--cwd', '<cwd>', '--no-lan'], expected: false },
    { saved: false, args: ['--cwd', '<cwd>', '--lan'], expected: true },
    { saved: true, args: ['--cwd', '<cwd>'], expected: true },
    { saved: false, args: ['--cwd', '<cwd>'], expected: false },
  ]) {
    const root = await tempDirectory();
    try {
      const storage = new StandaloneHostStorage({ stateDir: root, workspaceCwd: root });
      const platform = createStandaloneHostRuntimePlatform({
        workspaceCwd: root,
        extensionPath: root,
        runtimeOutputDirectory: root,
        dataPaths: {
          rootDir: root,
          analyticsDir: root,
          sessionsDir: root,
          artifactsDir: root,
          stateDir: root,
          cacheDir: root,
        },
        dependencies: { nodePath: process.execPath, sdkPath: root },
        storage,
        getBrowserServer: () => undefined,
      });
      await storage.update('pie.browserServer.allowLan', scenario.saved);
      const args = scenario.args.map((argument) => argument === '<cwd>' ? root : argument);
      const { allowLan } = parseStandaloneArguments(args);
      await applyStandaloneStartupLanPreference(platform, allowLan);

      assert.equal(storage.get<boolean>('pie.browserServer.allowLan'), scenario.expected,
        `${scenario.args.at(-1)} persists the startup setting before server startup`);
      assert.equal(platform.getBrowserServerSettings().allowLan, scenario.expected,
        'the runtime getter reads the persisted preference');

      await platform.setBrowserServerLanEnabled(!scenario.expected);
      assert.equal(platform.getBrowserServerSettings().allowLan, !scenario.expected,
        'runtime UI changes remain visible through the storage-backed getter');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('standalone never offers stopping the sole UI: the listener switch seam rejects and the capability stays off', async () => {
  const root = await tempDirectory();
  try {
    const storage = new StandaloneHostStorage({ stateDir: root, workspaceCwd: root });
    const platform = createStandaloneHostRuntimePlatform({
      workspaceCwd: root,
      extensionPath: root,
      runtimeOutputDirectory: root,
      dataPaths: {
        rootDir: root,
        analyticsDir: root,
        sessionsDir: root,
        artifactsDir: root,
        stateDir: root,
        cacheDir: root,
      },
      dependencies: { nodePath: process.execPath, sdkPath: root },
      storage,
      getBrowserServer: () => undefined,
    });

    assert.equal(platform.supportsBrowserServerToggle, undefined,
      'the standalone composition never claims an independent renderer surface');
    await assert.rejects(
      () => platform.setBrowserServerEnabled!(false),
      /only UI|browser server/i,
      'a direct start/stop command must fail closed instead of stopping the sole UI',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('standalone host storage updates are atomic and cross-update safe', async () => {
  const root = await tempDirectory();
  const storage = new StandaloneHostStorage({ stateDir: root, workspaceCwd: path.join(root, 'workspace') });
  await Promise.all([
    storage.update('openTabPaths', ['a.ts']),
    storage.update('activeSessionPath', 'session.jsonl'),
    storage.update('prefs', { pruning: true }),
  ]);
  assert.deepEqual(storage.get<string[]>('openTabPaths'), ['a.ts']);
  assert.equal(storage.get<string>('activeSessionPath'), 'session.jsonl');
  assert.deepEqual(storage.get<{ pruning: boolean }>('prefs'), { pruning: true });
  const text = await fs.readFile(storage.filePath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(text));
  await storage.update('activeSessionPath', undefined);
  assert.equal(storage.get('activeSessionPath'), undefined);
});

test('browser renderer facade routes state, detail, refresh, and attention through one server', () => {
  const calls: string[] = [];
  const server = {
    scheduleState: () => calls.push('schedule-state'),
    scheduleSelectionState: () => calls.push('schedule-selection'),
    requestState: (rendererId: string) => calls.push(`request:${rendererId}`),
    postImperative: (_message: unknown, rendererId: string) => calls.push(`detail:${rendererId}`),
    isRendererOwnerCurrent: () => true,
    getHub: () => ({
      requestState: (target: string) => calls.push(`hub-request:${target}`),
      postImperative: (_message: unknown, target = 'all') => calls.push(`hub-imperative:${target}`),
    }),
  };
  const facade = new StandaloneBrowserRendererFacade(() => server);
  facade.postState();
  facade.postSelectionState();
  facade.scheduleState();
  facade.requestState();
  facade.requestState('renderer-1');
  facade.postImperative({ type: 'rendererNotice', message: 'done', kind: 'info' });
  facade.postImperativeToRenderer('renderer-1', { type: 'rendererNotice', message: 'done', kind: 'info' });
  assert.deepEqual(calls, [
    'hub-request:all',
    'schedule-selection',
    'schedule-state',
    'hub-request:all',
    'request:renderer-1',
    'hub-imperative:all',
    'detail:renderer-1',
  ]);
  assert.equal(facade.isRendererOwnerCurrent('renderer-1', 1, 1), true);
  assert.match(facade.getHostInstanceId(), /^[0-9a-f-]{36}$/);
});

test('standalone signals are idempotent and set a conventional exit code', async () => {
  let shutdownCount = 0;
  let sigint: (() => void) | undefined;
  let sigterm: (() => void) | undefined;
  const processLike = {
    exitCode: undefined as number | undefined,
    once: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      if (event === 'SIGINT') sigint = listener;
      else sigterm = listener;
    },
    removeListener: () => undefined,
  };
  const application = {
    shutdown: async () => {
      shutdownCount += 1;
    },
  } as never;
  const remove = installStandaloneSignalHandlers(application, processLike, { forceExit: false });
  assert.ok(sigint);
  assert.ok(sigterm);
  sigint!();
  sigint!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownCount, 1);
  assert.equal(processLike.exitCode, 130);
  remove();
});

test('standalone signal failure retains the process instead of force-exiting without a confirmed backend stop', async () => {
  let sigterm: (() => void) | undefined;
  let forcedExitCode: number | undefined;
  const processLike = {
    exitCode: undefined as number | undefined,
    once: (_event: 'SIGINT' | 'SIGTERM', listener: () => void) => { sigterm = listener; },
    exit: (code?: number) => { forcedExitCode = code; },
  };
  const stderr = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  const application = {
    shutdown: async () => { throw new Error('backend exit unconfirmed; ownership retained'); },
  } as never;
  const remove = installStandaloneSignalHandlers(application, processLike, { forceExit: true, stderr });
  assert.ok(sigterm);
  sigterm!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(processLike.exitCode, 1);
  assert.equal(forcedExitCode, undefined, 'process.exit would close the coordinator listener and drop fail-closed ownership');
  remove();
});

test('standalone signal success may force-exit after owned teardown completes', async () => {
  let sigterm: (() => void) | undefined;
  let forcedExitCode: number | undefined;
  const processLike = {
    exitCode: undefined as number | undefined,
    once: (_event: 'SIGINT' | 'SIGTERM', listener: () => void) => { sigterm = listener; },
    exit: (code?: number) => { forcedExitCode = code; },
  };
  const application = { shutdown: async () => undefined } as never;
  const remove = installStandaloneSignalHandlers(application, processLike, { forceExit: true });
  assert.ok(sigterm);
  sigterm!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(processLike.exitCode, 143);
  assert.equal(forcedExitCode, 143);
  remove();
});

