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
