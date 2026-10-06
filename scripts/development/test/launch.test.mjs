import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareDevelopment } from '../launch.mjs';
import { withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('development preparation seeds isolated public defaults and preserves profile history', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pie-development-profile-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repository');
  await mkdir(path.join(root, 'application/hosts/vscode/media'), { recursive: true });
  await writeFile(path.join(root, 'settings.defaults.json'), JSON.stringify({ packages: ['npm:optional'], skills: [], sessionDir: 'production' }));
  await writeFile(path.join(root, 'models.json'), '{"providers":{}}');
  await writeFile(path.join(root, 'application/hosts/vscode/package.json'), JSON.stringify({ name: 'fixture', main: 'runtime/bootstrap.cjs', scripts: { build: 'unsafe' } }));
  await writeFile(path.join(root, 'application/hosts/vscode/media/icon.svg'), '<svg/>');
  const production = path.join(temp, 'production');
  const productionSettings = path.join(production, 'state/session-settings');
  const productionLegacySettings = path.join(production, 'outcomes/session-reviews');
  for (const dir of [productionSettings, productionLegacySettings]) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'system-prompt-toggles.json'), '{"private-session":["private-toggle"]}\n');
  }
  await writeFile(path.join(production, 'settings.json'), '{"private":"user settings"}\n');
  const sourceEnvironment = {
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: production,
    PIE_DATA_DIR: production,
    PIE_SESSION_SETTINGS_DIR: productionSettings,
    PIE_LEGACY_SESSION_SETTINGS_DIR: productionLegacySettings,
  };
  const prepared = await prepareDevelopment({ repositoryRoot: root, profileRoot: path.join(temp, 'profile'), sourceEnvironment });
  for (const name of ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PIE_DATA_DIR', 'PIE_SESSION_SETTINGS_DIR', 'PIE_LEGACY_SESSION_SETTINGS_DIR']) {
    assert.ok(prepared.env[name].startsWith(prepared.profile + path.sep), name);
    assert.notEqual(prepared.env[name], sourceEnvironment[name], name);
  }
  assert.equal(prepared.env.PIE_SESSION_SETTINGS_DIR, path.join(prepared.env.PIE_DATA_DIR, 'state/session-settings'));
  assert.equal(prepared.env.PIE_LEGACY_SESSION_SETTINGS_DIR, path.join(prepared.env.PI_CODING_AGENT_DIR, 'data/outcomes/session-reviews'));
  assert.deepEqual(await readdir(prepared.env.PIE_SESSION_SETTINGS_DIR), []);
  assert.deepEqual(await readdir(prepared.env.PIE_LEGACY_SESSION_SETTINGS_DIR), [], 'legacy fallback starts empty, not copied from production');
  assert.notEqual(prepared.coordinatorPort, 1996);
  const settings = JSON.parse(await readFile(path.join(prepared.env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.packages, []);
  const history = path.join(prepared.env.PI_CODING_AGENT_SESSION_DIR, 'history.jsonl');
  await writeFile(history, 'retained development history');
  const settingsPath = path.join(prepared.env.PI_CODING_AGENT_DIR, 'settings.json');
  settings.developerPreference = 'retained';
  await writeFile(settingsPath, JSON.stringify(settings));
  const sidecar = path.join(prepared.env.PIE_SESSION_SETTINGS_DIR, 'system-prompt-toggles.json');
  await writeFile(sidecar, '{"development-session":["development-toggle"]}\n');
  const repeated = await prepareDevelopment({ repositoryRoot: root, profileRoot: prepared.profile, sourceEnvironment });
  assert.equal(repeated.env.PIE_SESSION_SETTINGS_DIR, prepared.env.PIE_SESSION_SETTINGS_DIR);
  assert.equal(repeated.env.PIE_LEGACY_SESSION_SETTINGS_DIR, prepared.env.PIE_LEGACY_SESSION_SETTINGS_DIR);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), settings, 'seeded defaults and developer settings persist');
  assert.equal(await readFile(sidecar, 'utf8'), '{"development-session":["development-toggle"]}\n');
  assert.deepEqual(await readdir(prepared.env.PIE_LEGACY_SESSION_SETTINGS_DIR), []);
  for (const dir of [productionSettings, productionLegacySettings]) {
    assert.deepEqual(await readdir(dir), ['system-prompt-toggles.json']);
    assert.equal(await readFile(path.join(dir, 'system-prompt-toggles.json'), 'utf8'), '{"private-session":["private-toggle"]}\n');
  }
  assert.equal(await readFile(path.join(production, 'settings.json'), 'utf8'), '{"private":"user settings"}\n');
  assert.equal(await readFile(history, 'utf8'), 'retained development history');
  await assert.rejects(readFile(path.join(prepared.env.PI_CODING_AGENT_AUTH_DIR, 'auth.json')), { code: 'ENOENT' });
});

test('isolated compiled standalone startup owns a reader until graceful shutdown', { timeout: 90_000 }, async t => {
  if (process.env.PIE_RUN_DEVELOPMENT_HOST_TESTS !== '1') return t.skip('Explicit fixture-controlled compiled host qualification.');
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pie-development-host-'));
  const sourceEnvironment = { ...process.env };
  // This qualification must never make paid/live provider calls. This is a
  // test invocation boundary, not a developer offline-provider policy.
  for (const name of Object.keys(sourceEnvironment)) if (/API_KEY|TOKEN|SECRET|CREDENTIAL|LIVE_TEST|LIVE_MODEL/u.test(name)) delete sourceEnvironment[name];
  const prepared = await prepareDevelopment({ repositoryRoot, profileRoot: profile, sourceEnvironment });
  const workspace = path.join(repositoryRoot, 'harness/pi');
  const readers = path.join(workspace, '.cache/development-runtime/readers');
  const before = await readdir(readers).catch(() => []);
  const child = spawn(process.execPath, [path.join(prepared.extension, 'standalone.cjs')], { cwd: repositoryRoot, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  let closed = false;
  const completion = new Promise(resolve => child.once('close', code => { closed = true; resolve(code); }));
  t.after(async () => {
    if (!closed && child.connected) child.send('development:stop');
    let timer;
    const code = await Promise.race([completion, new Promise(resolve => { timer = setTimeout(() => resolve('uncertain'), 20_000); })]);
    clearTimeout(timer);
    if (code === 'uncertain') throw new Error(`Owned development process teardown unconfirmed; profile and reader evidence retained. ${output}`);
    await rm(profile, { recursive: true, force: true });
  });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && !closed) {
    try {
      const response = await fetch(`http://127.0.0.1:${prepared.browserPort}/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, output);
  const html = await (await fetch(`http://127.0.0.1:${prepared.browserPort}/`)).text();
  assert.match(html, /assets\/panel-/u);
  let writerStarted = false;
  await assert.rejects(withDevelopmentWriter(workspace, async () => { writerStarted = true; }), /writer denied/u);
  assert.equal(writerStarted, false);
  child.send('development:stop');
  assert.equal(await completion, 0, output);
  assert.deepEqual(await readdir(readers), before, 'confirmed complete owned shutdown releases only its reader');
  await withDevelopmentWriter(workspace, async () => {});
});
