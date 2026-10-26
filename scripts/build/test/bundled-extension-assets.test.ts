import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const ownerRequire = createRequire(path.resolve('application/hosts/vscode/package.json'));
const { build } = ownerRequire('vite') as typeof import('vite');
import { BUNDLED_EXTENSIONS } from '../../../harness/tools/catalog/bundled-extensions.js';
import { BUNDLED_EXTENSION_PEERS, bundledExtensionBuildOptions, bundledExtensionPeerAliases, bundledExtensionInputs, isBundledExtensionPeer } from '../bundled-extension-assets.js';

test('all twelve curated wrappers and peer subpaths remain explicit', () => {
  assert.equal(BUNDLED_EXTENSIONS.length, 12);
  assert.deepEqual(bundledExtensionInputs('/fixture'), BUNDLED_EXTENSIONS.map(entry => path.join('/fixture', entry.entryPath)));
  for (const peer of BUNDLED_EXTENSION_PEERS) {
    assert.ok(isBundledExtensionPeer(peer));
    assert.ok(isBundledExtensionPeer(`${peer}/subpath`));
    assert.equal(isBundledExtensionPeer(`${peer}-other`), false);
  }
});

test('tiny CJS extension entries retain bare peers, inventory and relocated chunks', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-bundled-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  mkdirSync(output);
  writeFileSync(path.join(output, 'pie-build-id.txt'), 'host-id');
  const shared = path.join(root, 'shared.ts');
  writeFileSync(shared, 'export const value = 42;');
  const input = Object.fromEntries(BUNDLED_EXTENSIONS.map(entry => {
    const file = path.join(root, `${entry.id}.ts`);
    writeFileSync(file, `export { value } from './shared';\n${BUNDLED_EXTENSION_PEERS.map((peer, i) => `import * as p${i} from '${peer}/fixture';`).join('\n')}\nexport const peers = [${BUNDLED_EXTENSION_PEERS.map((_, i) => `p${i}`).join(',')}];`);
    return [entry.id, file];
  }));
  const options = bundledExtensionBuildOptions(root, output, input);
  await build({ ...options, configFile: false, logLevel: 'silent',
    resolve: { alias: [...bundledExtensionPeerAliases(), { find: 'typebox', replacement: '/must-not-resolve' }] } });
  const relocated = path.join(root, 'relocated');
  renameSync(output, relocated);
  assert.equal(readFileSync(path.join(relocated, 'pie-build-id.txt'), 'utf8'), 'host-id');
  const inventory = JSON.parse(readFileSync(path.join(relocated, 'resources/bundled-extensions.json'), 'utf8'));
  assert.deepEqual(inventory.extensions, BUNDLED_EXTENSIONS.map(entry => ({ id: entry.id, entry: entry.outputFile })));
  for (const entry of BUNDLED_EXTENSIONS) {
    const code = readFileSync(path.join(relocated, entry.outputFile), 'utf8');
    for (const peer of BUNDLED_EXTENSION_PEERS) assert.ok(code.includes(`${peer}/fixture`));
    const chunks = [...code.matchAll(/require\(["'](\.\/[^"']+\.js)["']\)/gu)];
    assert.ok(chunks.length > 0);
    for (const chunk of chunks) assert.ok(readFileSync(path.join(relocated, chunk[1]), 'utf8').includes('42'));
  }
});
