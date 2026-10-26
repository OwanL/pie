import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, renameSync, rmSync, cpSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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

test('curated entry facades load as factories through default JITI without losing shared named helpers', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-bundled-facades-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  for (const entry of BUNDLED_EXTENSIONS) {
    const file = path.join(root, entry.entryPath);
    mkdirSync(path.dirname(file), { recursive: true });
    const mixed = ['safeguard', 'tool-result-pruner'].includes(entry.id);
    writeFileSync(file, mixed
      ? `import { RULE_KEY_BY_NAME } from '../types';\nexport { RULE_KEY_BY_NAME } from '../types';\nexport function namedHelper() { return ${entry.id === 'safeguard' ? 40 : 2} + RULE_KEY_BY_NAME.offset; }\nexport default function factory() { return namedHelper(); }`
      : `import { combined } from '../shared-consumer';\nexport default function factory() { return { value: combined(), peer: () => import('typebox/fixture') }; }`);
  }
  writeFileSync(path.join(root, 'extensions/types.ts'), 'export const RULE_KEY_BY_NAME = { offset: 0 };');
  writeFileSync(path.join(root, 'extensions/shared-consumer.ts'), `
import { RULE_KEY_BY_NAME } from './types';
import { namedHelper as safeguard } from './safeguard/index';
import { namedHelper as pruner } from './tool-result-pruner/index';
export function combined() { return safeguard() + pruner() + RULE_KEY_BY_NAME.offset; }
`);
  await build({ ...bundledExtensionBuildOptions(root, output), configFile: false, logLevel: 'silent' });
  const relocated = path.join(root, 'relocated');
  renameSync(output, relocated);
  // Resolve the real dependency from its declaring owner, not a staged SDK or stub.
  const jitiOwner = createRequire(path.resolve('harness/pi/packages/coding-agent/package.json'));
  const jitiPackage = jitiOwner('jiti/package.json');
  assert.equal(jitiPackage.version, jitiOwner('./package.json').dependencies.jiti);
  const staticEntry = path.resolve(path.dirname(jitiOwner.resolve('jiti/package.json')), jitiPackage.exports['./static'].import);
  const { createJiti } = await import(pathToFileURL(staticEntry).href);
  const jiti = createJiti(import.meta.url); // Default tryNative behavior, like the SDK.
  for (const entry of BUNDLED_EXTENSIONS) {
    const file = path.join(relocated, entry.outputFile);
    const factory = await jiti.import(file, { default: true });
    assert.equal(typeof factory, 'function', entry.id);
    assert.equal(typeof ownerRequire(file), 'function', 'CJS entry exposes only the factory');
    const result = factory();
    assert.equal(typeof result === 'number' ? result : result.value,
      entry.id === 'safeguard' ? 40 : entry.id === 'tool-result-pruner' ? 2 : 42);
  }
  assert.ok(readFileSync(path.join(relocated, 'ask-user.js'), 'utf8').includes('typebox/fixture'), 'lazy peer remains bare/external');
});

test('actual curated source graph emits exactly default-only entry signatures without bundled peers', async t => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'pie-core-signatures-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const options = bundledExtensionBuildOptions(path.resolve('.'), output);
  let checked = false;
  await build({ ...options, configFile: false, logLevel: 'silent', plugins: [...(options.plugins ?? []), {
    name: 'assert-actual-core-entry-signatures',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
      const entries = chunks.filter(chunk => chunk.isEntry);
      assert.deepEqual(entries.map(chunk => chunk.fileName).sort(), BUNDLED_EXTENSIONS.map(entry => entry.outputFile).sort());
      for (const entry of entries) assert.deepEqual(entry.exports, ['default'], entry.fileName);
      for (const chunk of chunks) for (const id of Object.keys(chunk.modules)) {
        const normalized = id.replaceAll('\\', '/');
        assert.doesNotMatch(normalized, /(?:node_modules\/(?:@(?:earendil-works|mariozechner)\/pi-[^/]+|@sinclair\/typebox|typebox)(?:\/|$)|harness\/pi\/packages\/(?:coding-agent|agent|ai|tui)\/(?:src|dist)\/)/u, 'peer implementation bundled: ' + id);
      }
      checked = true;
    },
  }] });
  assert.ok(checked, 'actual Rollup graph must be inspected; real extension code is never imported or executed');
});

test('relocated CJS entries and shared chunks preserve module paths and agent-root resources', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-bundled-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  const source = (relative: string) => JSON.stringify(path.resolve(relative).replaceAll('\\', '/'));
  writeFileSync(path.join(root, 'shared.ts'), `export const sharedMeta = { dirname: import.meta.dirname, filename: import.meta.filename, url: import.meta.url };`);
  const input = Object.fromEntries(['first', 'second'].map(name => {
    const file = path.join(root, `${name}.ts`);
    writeFileSync(file, `
export { sharedMeta } from './shared';
export const entryMeta = { dirname: import.meta.dirname, filename: import.meta.filename, url: import.meta.url };
export * as warm from ${source('harness/tools/warm-bash/logger.ts')};
export * as result from ${source('harness/tools/result-processing/logger.ts')};
export * as config from ${source('harness/tools/result-processing/config.ts')};
`);
    return [name, file];
  }));
  await build({ ...bundledExtensionBuildOptions(root, output, input), configFile: false, logLevel: 'silent' });
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    for (const explicit of [true, false]) {
      // Three ancestors remain disposable even when exercising the legacy fallback.
      const install = path.join(root, explicit ? 'selected' : 'fallback');
      const relocated = path.join(install, 'a', 'b', 'out');
      cpSync(output, relocated, { recursive: true });
      const agent = path.join(install, 'private-agent');
      mkdirSync(agent);
      writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ toolResultPruning: { enabled: false, profile: 'security' } }));
      writeFileSync(path.join(install, 'settings.json'), JSON.stringify({ toolResultPruning: { enabled: true, profile: 'default' } }));
      if (explicit) process.env.PI_CODING_AGENT_DIR = agent;
      else delete process.env.PI_CODING_AGENT_DIR;
      const first = ownerRequire(path.join(relocated, 'first.js'));
      const second = ownerRequire(path.join(relocated, 'second.js'));
      for (const [name, entry] of [['first', first], ['second', second]] as const) {
        assert.equal(entry.entryMeta.dirname, relocated);
        assert.equal(entry.entryMeta.filename, path.join(relocated, `${name}.js`));
        assert.equal(entry.entryMeta.url, pathToFileURL(entry.entryMeta.filename).href);
        assert.equal(entry.sharedMeta.dirname, relocated);
        assert.equal(path.dirname(entry.sharedMeta.filename), relocated);
        assert.notEqual(entry.sharedMeta.filename, entry.entryMeta.filename);
        assert.equal(entry.sharedMeta.url, pathToFileURL(entry.sharedMeta.filename).href);
      }
      assert.deepEqual(first.sharedMeta, second.sharedMeta);
      assert.equal(first.config.loadConfig().enabled, !explicit);
      assert.equal(first.config.loadConfig().profile, explicit ? 'security' : 'default');
      first.warm.logAutoPruneRewrite('fixture', 'before', 'after');
      first.result.recordPruning({ event: 'tool_result_pruned', sessionId: 'fixture', toolName: 'bash', rules: [], beforeTokens: 2, afterTokens: 1, tokensSaved: 1, timestamp: '2026-01-01T00:00:00Z' });
      await Promise.all([first.warm.flushLog(), first.result.flushLog()]);
      const selected = explicit ? agent : install;
      const unselected = explicit ? install : agent;
      for (const log of ['warm-bash.jsonl', 'tool-result-pruning.jsonl']) {
        assert.equal(JSON.parse(readFileSync(path.join(selected, 'data', log), 'utf8')).sessionId, 'fixture');
        assert.equal(existsSync(path.join(unselected, 'data', log)), false);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
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
