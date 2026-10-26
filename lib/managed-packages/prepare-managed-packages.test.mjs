import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareManagedPackages, verifyPreparedManagedPackage } from './prepare-managed-packages.mjs';

// Pinned excerpts from scripts/install/test/managed-packages.test.mjs.
const index = 'import { runMcpScript } from "./mcp-code.ts";\n\n        executeOwner?.throwIfInactive();\n        return runMcpScript(state, params.code, params.timeoutMs, getPiTools, signal);\n';
const agentDir = 'import { join, resolve } from "node:path";\nexport function getAgentPath(...segments: string[]): string {\n  return join(getAgentDir(), ...segments);\n}';
const name = 'pi-mcp-adapter';
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'pie-prepare-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const stagingParent = path.join(base, 'stages');
  await mkdir(source);
  await mkdir(stagingParent);
  const files = { 'package.json': JSON.stringify({ name, version: '2.20.1' }), 'index.ts': index, 'agent-dir.ts': agentDir, 'mcp-code.ts': '// implementation', 'mcp-script-worker.mjs': '// worker' };
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(source, file), content);
  return { source, stagingParent, inputs: { [name]: source } };
}

test('prepares independent fully adapted copies and leaves input unchanged', async (t) => {
  const options = await fixture(t);
  const first = await prepareManagedPackages(options);
  const second = await prepareManagedPackages(options);
  assert.notEqual(first.root, second.root);
  const target = first.packages[name];
  await verifyPreparedManagedPackage(target, name);
  assert.equal(await readFile(path.join(options.source, 'index.ts'), 'utf8'), index);
  assert.match(await readFile(path.join(target, 'index.ts'), 'utf8'), /await import/);
  assert.match(await readFile(path.join(target, 'agent-dir.ts'), 'utf8'), /PIE_CACHE_DIR/);
  await writeFile(path.join(target, 'mcp-code.ts'), 'independent');
  assert.equal(await readFile(path.join(options.source, 'mcp-code.ts'), 'utf8'), '// implementation');
  assert.equal((await stat(path.join(target, 'index.ts'))).nlink, 1);
});

test('verification is read-only and rejects pristine, mixed, corrupt, and missing files', async (t) => {
  const options = await fixture(t);
  await assert.rejects(verifyPreparedManagedPackage(options.source, name), /Incomplete/);
  const { packages } = await prepareManagedPackages(options);
  const root = packages[name];
  const patched = await readFile(path.join(root, 'index.ts'), 'utf8');
  await writeFile(path.join(root, 'index.ts'), index);
  await assert.rejects(verifyPreparedManagedPackage(root, name), /Incomplete/);
  assert.equal(await readFile(path.join(root, 'index.ts'), 'utf8'), index);
  await writeFile(path.join(root, 'index.ts'), patched.replace('params.timeoutMs', '123'));
  await assert.rejects(verifyPreparedManagedPackage(root, name));
  await writeFile(path.join(root, 'index.ts'), patched);
  await rm(path.join(root, 'mcp-script-worker.mjs'));
  await assert.rejects(verifyPreparedManagedPackage(root, name));
});

for (const failure of ['wrong-version', 'wrong-name', 'malformed', 'missing', 'drift', 'duplicate', '.DELETE', 'rename-artifact', 'nested-link']) {
  test(`rejects ${failure} and cleans only owned stage`, async (t) => {
    const options = await fixture(t);
    const source = options.source;
    if (failure === 'wrong-version' || failure === 'wrong-name') await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: failure === 'wrong-name' ? 'other' : name, version: '0.0.0' }));
    if (failure === 'malformed') await writeFile(path.join(source, 'package.json'), '{');
    if (failure === 'missing') await rm(path.join(source, 'mcp-code.ts'));
    if (failure === 'drift') await writeFile(path.join(source, 'index.ts'), index.replace('params.timeoutMs', '123'));
    if (failure === 'duplicate') await writeFile(path.join(source, 'index.ts'), index + index);
    if (failure === 'rename-artifact') await writeFile(path.join(source, 'Readability.js.DELETE.hash'), 'corrupt');
    if (failure === '.DELETE') await mkdir(path.join(source, '.DELETE'));
    if (failure === 'nested-link') {
      // Junctions work without Windows developer-mode symlink privileges.
      await symlink(options.stagingParent, path.join(source, 'linked'), 'junction');
    }
    await writeFile(path.join(options.stagingParent, 'keep'), 'unrelated');
    await assert.rejects(prepareManagedPackages(options));
    assert.deepEqual(await readdir(options.stagingParent), ['keep']);
    assert.equal(await readFile(path.join(options.stagingParent, 'keep'), 'utf8'), 'unrelated');
  });
}

test('web package requires local Readability, not a hoisted sibling', async (t) => {
  const options = await fixture(t);
  const web = path.join(path.dirname(options.source), 'npm', 'node_modules', 'pi-web-access');
  await mkdir(web, { recursive: true });
  await writeFile(path.join(web, 'package.json'), JSON.stringify({ name: 'pi-web-access', version: '0.27.0' }));
  await writeFile(path.join(web, 'index.ts'), '// source');
  await writeFile(path.join(web, 'storage.ts'), '// storage');
  const hoisted = path.join(path.dirname(web), '@mozilla', 'readability');
  await mkdir(hoisted, { recursive: true });
  await writeFile(path.join(hoisted, 'Readability.js'), '// hoisted dependency');
  await assert.rejects(prepareManagedPackages({ stagingParent: options.stagingParent, inputs: { 'pi-web-access': web } }), /ENOENT/);
  assert.deepEqual(await readdir(options.stagingParent), []);
});

test('rejects unknown names, relative paths, and staging inside input', async (t) => {
  const options = await fixture(t);
  await assert.rejects(prepareManagedPackages({ ...options, inputs: { other: options.source } }), /Unsupported/);
  await assert.rejects(prepareManagedPackages({ ...options, inputs: { [name]: 'relative' } }), /absolute/);
  await assert.rejects(prepareManagedPackages({ ...options, stagingParent: options.source }), /outside/);
  assert.deepEqual(await readdir(options.stagingParent), []);
});
