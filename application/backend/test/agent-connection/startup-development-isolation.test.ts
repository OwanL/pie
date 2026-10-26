import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { startSessionBackend } from '../../agent-connection/startup';
import { createBackendStartupPlatform } from '../../../hosts/lib/backend-startup';

const ENV_KEYS = [
  'PIE_DEVELOPMENT_PROFILE_DIR',
  'PIE_HOST_PROFILE',
  'PIE_HOST_COORDINATOR_PORT',
  'PIE_DEVELOPMENT_PI_WORKSPACE',
  'PIE_DEVELOPMENT_PI_RUNTIME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_AUTH_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PIE_DATA_DIR',
  'PIE_ALLOW_IN_TREE_AUTH',
  'LOCALAPPDATA',
] as const;

function preserveEnvironment(): () => void {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  return () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('backend startup ignores the production agentDir setting for an isolated development profile', async (t) => {
  const restoreEnvironment = preserveEnvironment();
  t.after(restoreEnvironment);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-dev-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const agentDir = path.join(root, 'agent');
  const authDir = path.join(root, 'auth');
  const dataDir = path.join(root, 'data');
  const sessionDir = path.join(dataDir, 'sessions');
  const productionAgentDir = path.resolve(root, '..', 'production-agent');
  process.env.PIE_DEVELOPMENT_PROFILE_DIR = root;
  process.env.PIE_HOST_PROFILE = 'local-development';
  process.env.PIE_HOST_COORDINATOR_PORT = '23147';
  // Simulate a persisted production setting while the dev launcher supplies
  // isolated environment paths.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_AUTH_DIR = authDir;
  process.env.PIE_DATA_DIR = dataDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;

  const settings: Record<string, unknown> = { agentDir: productionAgentDir };
  const backendStartup = createBackendStartupPlatform({
    extensionPath: path.join(root, 'checkout', 'application', 'hosts', 'vscode'),
    getRuntimeOutputDirectory: () => path.join(root, 'out'),
    getSetting: <T>(key: string) => settings[key] as T | undefined,
  });
  backendStartup.prepareDevelopmentEnvironment();
  backendStartup.prepareBackendEnvironment(() => undefined);

  assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir,
    'the dev backend uses the root-derived agent directory, never pie.agentDir');
  assert.equal(process.env.PI_CODING_AGENT_AUTH_DIR, authDir);
  assert.equal(process.env.PIE_DATA_DIR, dataDir);
  assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, sessionDir);
  assert.notEqual(process.env.PI_CODING_AGENT_DIR, settings.agentDir);
  assert.deepEqual(await fs.readdir(root), [], 'private startup must not seed settings or other state');
});

test('backend startup requires the explicit development profile root before loading settings', async (t) => {
  const restoreEnvironment = preserveEnvironment();
  t.after(restoreEnvironment);
  process.env.PIE_DEVELOPMENT_PI_WORKSPACE = path.resolve('pi-workspace');
  process.env.PIE_HOST_PROFILE = 'local-development';
  process.env.PIE_HOST_COORDINATOR_PORT = '23147';
  process.env.PI_CODING_AGENT_DIR = path.resolve('production-agent');
  let settingsLoaded = false;
  let rendered = false;
  const events: Array<{ kind: string; notice?: string }> = [];

  const platform = {
    getWorkspaceCwd: () => process.cwd(),
    backendStartup: createBackendStartupPlatform({
      extensionPath: process.cwd(),
      getRuntimeOutputDirectory: () => process.cwd(),
      getSetting: () => undefined,
    }),
  };
  await startSessionBackend({
    platform,
    backend: {} as never,
    scheduleRender: () => { rendered = true; },
    events: {} as never,
    state: { resetRuntimeState: () => undefined } as never,
    service: {
      loadPruningSettings: async () => { settingsLoaded = true; },
      loadToolResultPruningSettings: async () => { settingsLoaded = true; },
      loadSessionTitlesSettings: async () => { settingsLoaded = true; },
      schedulePrivateSessionCleanup: () => undefined,
    },
    openSession: () => undefined,
    getArchState: () => { throw new Error('must not load settings without a profile'); },
    dispatchArch: (event: { kind: string; notice?: string }) => { events.push(event); },
  } as never);

  assert.equal(settingsLoaded, false, 'startup must not touch production-backed settings before isolation validates');
  assert.equal(rendered, true);
  assert.match(events.find((event) => event.kind === 'NoticeShown')?.notice ?? '', /PIE_DEVELOPMENT_PROFILE_DIR is required/u);
});

for (const failCreation of [false, true]) {
  test(`normal profile ${failCreation ? 'failure blocks' : 'initialization precedes'} settings-family reads`, { skip: process.platform !== 'win32' }, async (t) => {
    const restoreEnvironment = preserveEnvironment();
    t.after(restoreEnvironment);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-normal-order-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    process.env.LOCALAPPDATA = root;
    const home = path.join(root, 'pie');
    if (failCreation) await fs.writeFile(home, 'blocked');
    const calls: string[] = [];
    const notices: string[] = [];
    const stop = new Error('stop after settings reads');
    const readSettings = (name: string) => async () => {
      calls.push(name);
      assert.equal(process.env.PI_CODING_AGENT_DIR, home);
      assert.equal(await fs.readFile(path.join(home, 'settings.json'), 'utf8'), '{}');
      throw stop;
    };
    const run = startSessionBackend({
      platform: {
        getWorkspaceCwd: () => root,
        storage: { get: () => { calls.push('stored-prefs'); return undefined; } },
        backendStartup: createBackendStartupPlatform({
          extensionPath: path.join(root, 'installed-extension'),
          getRuntimeOutputDirectory: () => root,
          getSetting: () => undefined,
        }),
      },
      backend: {} as never,
      scheduleRender: () => undefined,
      events: {} as never,
      state: { resetRuntimeState: () => undefined } as never,
      service: {
        loadPruningSettings: readSettings('pruning'),
        loadToolResultPruningSettings: readSettings('tool-results'),
        loadSessionTitlesSettings: readSettings('titles'),
      },
      getArchState: () => { throw new Error('must stop before restore'); },
      dispatchArch: (event: { kind: string; notice?: string }) => {
        if (event.notice) notices.push(event.notice);
      },
    } as never);
    if (failCreation) {
      await run;
      assert.deepEqual(calls, []);
      assert.match(notices[0], /pie setup error/);
      assert.equal(await fs.readFile(home, 'utf8'), 'blocked');
    } else {
      await assert.rejects(run, (error) => error === stop);
      assert.deepEqual(calls, ['stored-prefs', 'pruning', 'tool-results', 'titles']);
      assert.deepEqual(notices, []);
    }
  });
}
