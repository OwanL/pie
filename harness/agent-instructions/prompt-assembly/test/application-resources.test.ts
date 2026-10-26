import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CORE_EXTENSIONS, BUNDLED_EXTENSIONS, bundledExtensionsForContext } from '../../../tools/catalog/bundled-extensions.js';
import { createBundledExtensionInventory, getApplicationResourceLoaderOptions, BUNDLED_EXTENSION_INVENTORY_RELATIVE_PATH } from '../../application-resources.js';

test('curated metadata covers owned adapters with stable output IDs and exact aliases', () => {
  assert.deepEqual(CORE_EXTENSIONS.map(entry => entry.id), ['ask-user', 'computer-use', 'copilot-model-discovery', 'cwd-skills', 'deferred-triggers', 'playwright', 'safeguard', 'session-changes', 'skill-pruner', 'subagent', 'tool-result-pruner', 'warm-bash', 'web-access-guard']);
  assert.equal(new Set(CORE_EXTENSIONS.map(entry => entry.id)).size, CORE_EXTENSIONS.length);
  for (const entry of CORE_EXTENSIONS) {
    assert.equal(entry.outputFile, `${entry.id}.js`);
    assert.ok(entry.legacyPaths.includes(`extensions/${entry.id}/index.ts`));
    for (const legacy of entry.legacyPaths) {
      assert.ok(legacy.includes('/'));
      if (legacy.endsWith('/index.ts')) assert.ok(entry.legacyPaths.includes(legacy.slice(0, -'/index.ts'.length)));
      else if (!legacy.endsWith('.ts')) assert.ok(entry.legacyPaths.includes(`${legacy}/index.ts`));
    }
  }
  assert.ok(!BUNDLED_EXTENSIONS.some(entry => entry.id === 'cwd-skills'));
  assert.ok(!BUNDLED_EXTENSIONS.some(entry => entry.id === 'pi-web-access' || entry.id === 'pi-mcp-adapter'));
  assert.ok(bundledExtensionsForContext('primary').some(entry => entry.id === 'deferred-triggers'));
  assert.ok(!bundledExtensionsForContext('subagent').some(entry => entry.id === 'deferred-triggers'));
  assert.deepEqual(bundledExtensionsForContext('primary'), bundledExtensionsForContext('inventory'));
});

test('absent curated directory selections remain exact aliases without inferring wrappers or register directories', t => {
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-directory-aliases-'));
  t.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));
  const marker = path.join(moduleDir, BUNDLED_EXTENSION_INVENTORY_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  const inventory = createBundledExtensionInventory();
  fs.writeFileSync(marker, JSON.stringify(inventory));
  for (const entry of inventory.extensions) fs.writeFileSync(path.join(moduleDir, entry.entry), 'fixture only');
  const agentDir = path.join(moduleDir, 'absent-profile');
  const result = getApplicationResourceLoaderOptions({ moduleDir, agentDir, cwd: moduleDir, context: 'primary' });
  const subagent = result.defaultExtensions.find(entry => entry.path === path.join(moduleDir, 'subagent.js'))!;
  assert.equal(fs.existsSync(agentDir), false);
  assert.deepEqual(subagent.legacyPaths, [
    'extensions/subagent/index.ts', 'extensions/subagent',
    'harness/tools/subagent/index.ts', 'harness/tools/subagent',
    'harness/tools/subagent/register.ts',
  ].map(route => path.resolve(agentDir, route)));
  const pruner = result.defaultExtensions.find(entry => entry.path === path.join(moduleDir, 'skill-pruner.js'))!;
  assert.deepEqual(pruner.legacyPaths, [
    'extensions/skill-pruner/index.ts', 'extensions/skill-pruner',
    'harness/tool-and-skill-selection/lifecycle/register.ts',
  ].map(route => path.resolve(agentDir, route)));
  const aliases = result.defaultExtensions.flatMap(entry => entry.legacyPaths);
  for (const unrelated of ['subagent', 'custom/subagent', 'extensions/subagent-wrapper', 'harness/tool-and-skill-selection/lifecycle']) {
    assert.ok(!aliases.includes(path.resolve(agentDir, unrelated)));
  }
});

test('absent marker preserves source discovery; skill roots and priorities use explicit authorities', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-resource-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'profile');
  const cwd = path.join(root, 'project');
  const moduleDir = path.join(root, 'relocated');
  const instructionsRoot = path.join(root, 'authored-fixture');
  const result = getApplicationResourceLoaderOptions({ agentDir, cwd, moduleDir, instructionsRoot, context: 'primary' });
  assert.deepEqual(result.defaultExtensions, []);
  assert.deepEqual(result.additionalUserSkillPaths, [path.join(agentDir, 'harness', 'agent-instructions', 'skills'), path.join(instructionsRoot, 'skills')]);
  assert.deepEqual(result.additionalProjectSkillPaths, [path.join(cwd, 'skills')]);
  const priority = result.skillPathPriority;
  assert.equal(priority({ path: path.join(instructionsRoot, 'skills', 'x', 'SKILL.md'), sourceInfo: { scope: 'project' } }), 0);
  assert.equal(priority({ path: path.join(instructionsRoot, 'skills', 'x', 'SKILL.md'), sourceInfo: { scope: 'user' } }), 2);
  assert.equal(priority({ path: path.join(instructionsRoot, 'skills-other', 'SKILL.md'), sourceInfo: { scope: 'temporary' } }), 1);
  assert.equal(priority({ path: path.join(agentDir, 'skills', 'x', 'SKILL.md'), sourceInfo: { scope: 'user' } }), 1);
});

test('complete relocated inventory enables defaults independent of profile/cwd, partial or invalid payload fails closed', t => {
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-bundled-inventory-'));
  t.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));
  const marker = path.join(moduleDir, BUNDLED_EXTENSION_INVENTORY_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  const inventory = createBundledExtensionInventory();
  const options = { moduleDir, agentDir: path.join(moduleDir, 'neutral-profile'), cwd: path.join(moduleDir, 'unrelated-project'), context: 'primary' as const };
  fs.writeFileSync(marker, JSON.stringify(inventory));
  assert.throws(() => getApplicationResourceLoaderOptions(options), /Invalid bundled extension payload/);
  for (const entry of inventory.extensions) fs.writeFileSync(path.join(moduleDir, entry.entry), 'fixture only');
  const result = getApplicationResourceLoaderOptions(options);
  assert.deepEqual(result.defaultExtensions.map(entry => path.basename(entry.path)), inventory.extensions.map(entry => entry.entry));
  for (const entry of result.defaultExtensions) {
    assert.equal(path.dirname(entry.path), moduleDir);
    assert.ok(entry.legacyPaths.every(legacy => legacy.startsWith(options.agentDir + path.sep)));
  }
  const child = getApplicationResourceLoaderOptions({ ...options, context: 'subagent' });
  assert.equal(child.defaultExtensions.length, result.defaultExtensions.length - 1);
  assert.ok(!child.defaultExtensions.some(entry => entry.path.endsWith('deferred-triggers.js')));
  for (const invalid of ['not json', JSON.stringify({ ...inventory, version: 2 }), JSON.stringify({ ...inventory, extensions: inventory.extensions.slice(1) }), JSON.stringify({ ...inventory, extensions: inventory.extensions.map((entry, index) => index === 0 ? { ...entry, entry: '../ask-user.js' } : entry) }), JSON.stringify({ ...inventory, extensions: inventory.extensions.map((entry, index) => index === 0 ? inventory.extensions[1] : entry) })]) {
    fs.writeFileSync(marker, invalid);
    assert.throws(() => getApplicationResourceLoaderOptions(options), /Invalid bundled extension payload/);
  }
});
