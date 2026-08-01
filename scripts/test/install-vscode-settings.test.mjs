// Focused unit tests for scripts/install/lib/vscode-settings.mjs — the VS Code
// User settings directory resolver and pie.agentDir merge helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeAgentDirSetting, resolveVscodeSettingsDirs } from '../install/lib/vscode-settings.mjs';

test('resolveVscodeSettingsDirs returns APPDATA/Code/User on Windows', () => {
  const dirs = resolveVscodeSettingsDirs({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, homedir: '/home/me' });
  assert.deepEqual(dirs, ['C:\\Users\\me\\AppData\\Roaming\\Code\\User']);
});

test('resolveVscodeSettingsDirs returns empty list on Windows when APPDATA is unset', () => {
  assert.deepEqual(resolveVscodeSettingsDirs({ platform: 'win32', env: {}, homedir: '/h' }), []);
});

test('resolveVscodeSettingsDirs returns the three POSIX candidates (XDG, macOS, Code - OSS)', () => {
  const dirs = resolveVscodeSettingsDirs({ platform: 'posix', env: {}, homedir: '/home/me' });
  assert.deepEqual(dirs, [
    '/home/me/.config/Code/User',
    '/home/me/Library/Application Support/Code/User',
    '/home/me/.config/Code - OSS/User',
  ]);
});

test('resolveVscodeSettingsDirs honours XDG_CONFIG_HOME when set', () => {
  const dirs = resolveVscodeSettingsDirs({ platform: 'posix', env: { XDG_CONFIG_HOME: '/custom/xdg' }, homedir: '/h' });
  assert.equal(dirs[0], '/custom/xdg/Code/User');
  assert.equal(dirs[2], '/custom/xdg/Code - OSS/User');
});

test('mergeAgentDirSetting sets pie.agentDir when missing or different', () => {
  assert.deepEqual(mergeAgentDirSetting({}, '/repo').settings, { 'pie.agentDir': '/repo' });
  const { settings, changed } = mergeAgentDirSetting({ 'pie.agentDir': '/other' }, '/repo');
  assert.equal(changed, true);
  assert.equal(settings['pie.agentDir'], '/repo');
  // Other keys preserved.
  assert.deepEqual(mergeAgentDirSetting({ foo: 1 }, '/repo').settings, { foo: 1, 'pie.agentDir': '/repo' });
});

test('mergeAgentDirSetting is idempotent when already set correctly', () => {
  const { settings, changed } = mergeAgentDirSetting({ 'pie.agentDir': '/repo', other: 2 }, '/repo');
  assert.equal(changed, false);
  assert.equal(settings['pie.agentDir'], '/repo');
  assert.equal(settings.other, 2);
});
