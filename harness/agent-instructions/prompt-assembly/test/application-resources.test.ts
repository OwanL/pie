import test, { type TestContext } from 'node:test';
// @ts-expect-error Public JavaScript fixture helper has no declaration file.
import { pristineSources as s } from '../../../../lib/managed-packages/bundled-resources-fixture.mjs';
import { adaptManagedPackageSources, MANAGED_PACKAGE_REQUIREMENTS } from '../../../../lib/managed-packages/managed-package-contract.mjs';
import { createBundledManagedInventory, BUNDLED_MANAGED_ROOT_RELATIVE_PATH } from '../../../../lib/managed-packages/bundled-resources.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CORE_EXTENSIONS, BUNDLED_EXTENSIONS, bundledExtensionsForContext } from '../../../tools/catalog/bundled-extensions.js';
import { createBundledExtensionInventory, getApplicationResourceLoaderOptions, BUNDLED_EXTENSION_INVENTORY_RELATIVE_PATH } from '../../application-resources.js';

function managedFixture(t: TestContext) {
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-managed-options-'));
  t.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));
  const root = path.join(moduleDir, BUNDLED_MANAGED_ROOT_RELATIVE_PATH);
  const write = (relative: string, value: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const runtimeIdentity = 'a'.repeat(64);
  write('manifest.json', JSON.stringify(createBundledManagedInventory({ runtimeIdentity, closureInventorySha256: 'b'.repeat(64), qualificationRecipeSha256: 'c'.repeat(64), target: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules! } })));
  for (const pin of MANAGED_PACKAGE_REQUIREMENTS) {
    const files = pin.name === 'pi-web-access' ? { index: s.webIndex, storage: s.storage } : { index: s.mcpIndex, agentDir: s.agentDir };
    const adapted = adaptManagedPackageSources(pin.name, files);
    for (const relative of pin.requiredFiles.filter((file: string) => !file.startsWith('node_modules/'))) write(`node_modules/${pin.name}/${relative}`, '// fixture');
    write(`node_modules/${pin.name}/package.json`, JSON.stringify({ name: pin.name, version: pin.version }));
    write(`node_modules/${pin.name}/index.ts`, adapted.index!);
    write(`node_modules/${pin.name}/${pin.name === 'pi-web-access' ? 'storage.ts' : 'agent-dir.ts'}`, adapted.storage ?? adapted.agentDir!);
  }
  write('node_modules/@mozilla/readability/Readability.js', '// hoist');
  const coreMarker = path.join(moduleDir, BUNDLED_EXTENSION_INVENTORY_RELATIVE_PATH);
  const inventory = createBundledExtensionInventory();
  fs.writeFileSync(coreMarker, JSON.stringify(inventory));
  for (const entry of inventory.extensions) fs.writeFileSync(path.join(moduleDir, entry.entry), '// fixture');
  return { root, coreMarker, write, options: { moduleDir, agentDir: path.join(moduleDir, 'absent-profile'), cwd: moduleDir, context: 'primary' as const, expectedRuntimeIdentity: runtimeIdentity } };
}

test('managed defaults append exact native aliases in all contexts without MCP skill injection', t => {
  const f = managedFixture(t);
  for (const context of ['primary', 'inventory', 'subagent'] as const) {
    const result = getApplicationResourceLoaderOptions({ ...f.options, context });
    assert.equal(result.defaultExtensions.length, context === 'subagent' ? 13 : 14);
    assert.equal(result.defaultExtensions.some(entry => entry.path.endsWith('deferred-triggers.js')), context !== 'subagent');
    assert.ok(!result.defaultExtensions.some(entry => entry.path.endsWith('cwd-skills.js')));
    for (const [index, name] of ['pi-web-access', 'pi-mcp-adapter'].entries()) {
      assert.deepEqual(result.defaultExtensions.at(-2 + index), {
        path: path.join(f.root, 'node_modules', name, 'index.ts'),
        legacyPaths: [path.join(f.options.agentDir, 'npm', 'node_modules', name), path.join(f.options.agentDir, 'npm', 'node_modules', name, 'index.ts')],
        legacyPackageSources: [`npm:${name}`],
      });
    }
    assert.ok(result.additionalUserSkillPaths.every(file => !file.includes('managed-integrations')));
    assert.equal(fs.existsSync(f.options.agentDir), false);
  }
  for (const expectedRuntimeIdentity of ['bad', 'd'.repeat(64)]) assert.throws(() => getApplicationResourceLoaderOptions({ ...f.options, expectedRuntimeIdentity }), /runtime identity mismatch/);
});

for (const mutation of ['no-core', 'invalid-core', 'malformed', 'incomplete', 'pristine-web', 'mixed-storage', 'pristine-mcp', 'mixed-agent']) {
  test(`managed payload fails before loader: ${mutation}`, t => {
    const f = managedFixture(t);
    if (mutation === 'no-core') fs.unlinkSync(f.coreMarker);
    if (mutation === 'invalid-core') fs.writeFileSync(f.coreMarker, '{}');
    if (mutation === 'malformed') f.write('manifest.json', '{');
    if (mutation === 'incomplete') fs.unlinkSync(path.join(f.root, 'node_modules/pi-mcp-adapter/mcp-code.ts'));
    if (mutation === 'pristine-web') f.write('node_modules/pi-web-access/index.ts', s.webIndex);
    if (mutation === 'mixed-storage') f.write('node_modules/pi-web-access/storage.ts', s.storage);
    if (mutation === 'pristine-mcp') f.write('node_modules/pi-mcp-adapter/index.ts', s.mcpIndex);
    if (mutation === 'mixed-agent') f.write('node_modules/pi-mcp-adapter/agent-dir.ts', s.agentDir);
    assert.throws(() => getApplicationResourceLoaderOptions(f.options));
  });
}

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
