// Focused unit tests for scripts/install/lib/settings-repair.mjs — the
// extension-path rewriter that points committed absolute paths at THIS
// machine's npm global prefix. Idempotency is the key invariant: a second run
// on already-repaired settings must report changed=false.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { repairExtensionPaths } from '../install/lib/settings-repair.mjs';

const POSIX = 'posix';
const WIN = 'win32';

test('rewrites an absolute node_modules path to the local npm prefix (posix)', () => {
  const settings = { extensions: ['/home/other/.npm-global/node_modules/pi-web-access'] };
  const result = repairExtensionPaths(settings, { npmPrefix: '/home/me/.npm-global', platform: POSIX, existsSync: () => false });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings.extensions, ['/home/me/.npm-global/node_modules/pi-web-access']);
  assert.equal(result.rewritten[0].pkg, 'pi-web-access');
  assert.deepEqual(result.missing, ['pi-web-access']);
});

test('rewrites a Windows-style absolute path with backslash separator', () => {
  const settings = { extensions: ['C:/Users/other/AppData/Roaming/npm/node_modules/pi-web-access'] };
  const result = repairExtensionPaths(settings, { npmPrefix: 'C:\\Users\\me\\AppData\\Roaming\\npm', platform: WIN, existsSync: () => true });
  assert.equal(result.changed, true);
  assert.equal(result.settings.extensions[0], 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\pi-web-access');
  assert.deepEqual(result.missing, []);
});

test('is idempotent: an entry already pointing at the local prefix is left untouched', () => {
  const prefix = '/home/me/.npm-global';
  const already = [`${prefix}/node_modules/pi-web-access`];
  const result = repairExtensionPaths({ extensions: already }, { npmPrefix: prefix, platform: POSIX, existsSync: () => true });
  assert.equal(result.changed, false);
  assert.deepEqual(result.settings.extensions, already);
  assert.deepEqual(result.rewritten, []);
});

test('is idempotent across slash direction and case on Windows', () => {
  const prefix = 'C:\\Users\\Me\\AppData\\Roaming\\npm';
  // Forward-slash, differently-cased user segment already resolves to the same place.
  const already = ['C:/Users/me/AppData/Roaming/npm/node_modules/pi-web-access'];
  const result = repairExtensionPaths({ extensions: already }, { npmPrefix: prefix, platform: WIN, existsSync: () => true });
  assert.equal(result.changed, false);
});

test('leaves non-absolute and non-node_modules entries untouched', () => {
  const settings = { extensions: ['npm:pi-web-access@0.27.0', 'relative/node_modules/x'] };
  const result = repairExtensionPaths(settings, { npmPrefix: '/p', platform: POSIX, existsSync: () => true });
  assert.equal(result.changed, false);
  assert.deepEqual(result.settings.extensions, ['npm:pi-web-access@0.27.0', 'relative/node_modules/x']);
});

test('is a no-op when there are no extensions or no prefix', () => {
  assert.deepEqual(repairExtensionPaths({}, { npmPrefix: '/p', platform: POSIX }), { settings: {}, changed: false, rewritten: [], missing: [] });
  assert.deepEqual(repairExtensionPaths({ extensions: [] }, { npmPrefix: '/p', platform: POSIX }), { settings: { extensions: [] }, changed: false, rewritten: [], missing: [] });
  assert.deepEqual(repairExtensionPaths({ extensions: ['/a/node_modules/x'] }, { npmPrefix: '', platform: POSIX }), { settings: { extensions: ['/a/node_modules/x'] }, changed: false, rewritten: [], missing: [] });
});

test('ignores non-string extension entries', () => {
  const settings = { extensions: [{ name: 'object-entry' }, '/p/node_modules/x'] };
  const result = repairExtensionPaths(settings, { npmPrefix: '/local', platform: POSIX, existsSync: () => true });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings.extensions[0], { name: 'object-entry' });
  assert.equal(result.settings.extensions[1], '/local/node_modules/x');
});
