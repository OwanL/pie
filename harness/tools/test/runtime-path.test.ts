import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { prepareToolRuntimeEntry, resolveToolRuntimeEntry } from '../runtime-path.js';

for (const owner of ['computer-use', 'playwright'] as const) {
  test(`${owner}: source keeps colocated sidecar without cwd authority`, () => {
    const module = pathToFileURL(path.join(os.tmpdir(), 'source', owner, 'runtime-client.ts')).href;
    const expected = path.join(os.tmpdir(), 'source', owner, 'sidecar.mjs');
    assert.equal(resolveToolRuntimeEntry(owner, module), expected);
    assert.equal(prepareToolRuntimeEntry(owner, module), expected);
  });

  test(`${owner}: unrelated ancestor markers are ignored`, (t) => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'pie-runtime-ancestor-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'resources', 'tool-runtimes');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'manifest.json'), 'malformed unrelated marker');
    const module = pathToFileURL(path.join(temporary, 'source', owner, 'runtime-client.ts')).href;
    const expected = path.join(temporary, 'source', owner, 'sidecar.mjs');
    assert.equal(resolveToolRuntimeEntry(owner, module), expected);
    assert.equal(prepareToolRuntimeEntry(owner, module), expected);
  });

  test(`${owner}: packaged entry is explicit and code-only preparation refuses before spawn`, (t) => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'pie-runtime-path-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const out = path.join(temporary, 'out');
    const root = path.join(out, 'resources', 'tool-runtimes');
    mkdirSync(root, { recursive: true });
    const entries = {
      'computer-use': 'harness/tools/computer-use/sidecar.mjs',
      playwright: 'harness/tools/playwright/sidecar.mjs',
    };
    const marker = path.join(root, 'manifest.json');
    writeFileSync(marker, JSON.stringify({ version: 1, codeOnly: true, entries, files: Object.values(entries) }));
    const module = pathToFileURL(path.join(out, 'worker.mjs')).href;
    assert.throws(() => resolveToolRuntimeEntry(owner, module), /sidecar asset is missing/);
    const expected = path.join(root, entries[owner]);
    mkdirSync(path.dirname(expected), { recursive: true });
    writeFileSync(expected, '// code only');
    assert.equal(resolveToolRuntimeEntry(owner, module), expected);
    assert.throws(() => prepareToolRuntimeEntry(owner, module), /preparation unavailable.*no prepared native dependency owner/);
    rmSync(marker);
    assert.throws(() => resolveToolRuntimeEntry(owner, module), /manifest is missing/);
    rmSync(root, { recursive: true });
    writeFileSync(path.join(out, 'resources', 'bundled-extensions.json'), '{}');
    assert.throws(() => resolveToolRuntimeEntry(owner, module), /manifest is missing/);
    mkdirSync(root, { recursive: true });
    writeFileSync(marker, JSON.stringify({ version: 1, codeOnly: true, entries: { ...entries, [owner]: '../sidecar.mjs' }, files: [] }));
    assert.throws(() => resolveToolRuntimeEntry(owner, module), /Invalid packaged tool runtime manifest/);
  });
}
