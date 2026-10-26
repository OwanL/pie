import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackendStartupPlatform, prepareBackendEnvironment } from '../backend-startup';

const host = {
  extensionPath: path.join(os.tmpdir(), 'installed-pie-fixture'),
  getRuntimeOutputDirectory: () => '',
  getSetting: <T,>(_key: string): T | undefined => undefined,
};

test('normal startup selects application home without writing or deriving it from auth', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-startup-Zoë '));
  try {
    const env = {
      LOCALAPPDATA: root,
      PI_CODING_AGENT_AUTH_DIR: path.join(root, 'separate-auth'),
      PIE_DATA_DIR: path.join(root, 'separate-data'),
      PI_CODING_AGENT_SESSION_DIR: path.join(root, 'separate-history'),
    };
    const before = { ...env };
    prepareBackendEnvironment(host, () => assert.fail('unexpected notice'), env);
    assert.deepEqual(env, { ...before, PI_CODING_AGENT_DIR: path.join(root, 'pie') });
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh normal fallback advises clearing the stale setting rather than selecting an unseeded root', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-notice '));
  try {
    const stale = path.join(root, 'missing-explicit');
    const notices: string[] = [];
    const env: NodeJS.ProcessEnv = { LOCALAPPDATA: root };
    prepareBackendEnvironment({
      ...host,
      getSetting: <T,>(key: string): T | undefined => key === 'agentDir' ? stale as T : undefined,
    }, (notice) => notices.push(notice), env);
    assert.equal(env.PI_CODING_AGENT_DIR, path.join(root, 'pie'));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Clear the stale pie\.agentDir setting to use the application default/);
    assert.doesNotMatch(notices[0], /Set pie\.agentDir to this path|re-run the installer/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('admitted startup initializes the original normal selection once before later spawn preparation', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-admitted '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = ['LOCALAPPDATA', 'PI_CODING_AGENT_DIR', 'PIE_DEVELOPMENT_PROFILE_DIR', 'PIE_HOST_PROFILE', 'PIE_DEVELOPMENT_PI_WORKSPACE', 'PIE_DEVELOPMENT_PI_RUNTIME', 'PIE_ALLOW_IN_TREE_AUTH'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  for (const key of keys) delete process.env[key];
  process.env.LOCALAPPDATA = root;
  let configured = path.join(root, 'rejected');
  const notices: string[] = [];
  const startup = createBackendStartupPlatform({ ...host, getSetting: <T,>(key: string) => key === 'agentDir' ? configured as T : undefined });
  startup.prepareDevelopmentEnvironment((notice) => notices.push(notice));
  const selected = path.join(root, 'pie');
  assert.equal(process.env.PI_CODING_AGENT_DIR, selected);
  assert.equal(fs.readFileSync(path.join(selected, 'settings.json'), 'utf8'), '{}');
  assert.equal(fs.existsSync(configured), false);
  assert.equal(notices.length, 1);
  configured = path.join(root, 'later-explicit');
  fs.mkdirSync(configured);
  fs.writeFileSync(path.join(configured, 'settings.json'), '{broken');
  startup.prepareBackendEnvironment(() => assert.fail('selection must not run twice'));
  assert.equal(process.env.PI_CODING_AGENT_DIR, selected);
  assert.equal(fs.readFileSync(path.join(configured, 'settings.json'), 'utf8'), '{broken');
});

test('normal startup fails closed when its environment has no application home', () => {
  const env: NodeJS.ProcessEnv = {};
  assert.throws(() => prepareBackendEnvironment(host, () => {}, env), /LOCALAPPDATA|Windows-only/);
  assert.deepEqual(env, {});
});

test('private startup selects its own empty root ahead of normal settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-private '));
  try {
    const env: NodeJS.ProcessEnv = { PIE_DEVELOPMENT_PROFILE_DIR: root, LOCALAPPDATA: path.join(root, 'personal') };
    prepareBackendEnvironment(host, () => assert.fail('unexpected notice'), env);
    assert.equal(env.PI_CODING_AGENT_DIR, path.join(root, 'agent'));
    assert.equal(env.PI_CODING_AGENT_AUTH_DIR, path.join(root, 'auth'));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid private selections throw before routing to normal configuration or changing environment', () => {
  for (const privateEnv of [
    { PIE_DEVELOPMENT_PROFILE_DIR: '' },
    { PIE_DEVELOPMENT_PROFILE_DIR: 'relative' },
    { PIE_HOST_PROFILE: 'private-fixture' },
  ]) {
    const env = { LOCALAPPDATA: 'C:\\personal', ...privateEnv };
    const before = { ...env };
    assert.throws(() => prepareBackendEnvironment(host, () => {}, env), /PIE_DEVELOPMENT_PROFILE_DIR/);
    assert.deepEqual(env, before);
  }
});
