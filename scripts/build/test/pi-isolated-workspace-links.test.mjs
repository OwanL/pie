import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIsolatedPiWorkspace } from '../pi-isolated-workspace.mjs';

test('outward directory links are rejected before install; primary index/gate untouched', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-links-fixture-'));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-links-external-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', '--template='], { cwd: root });
  await fs.mkdir(path.join(root, 'harness/pi/.cache/development-runtime/readers'), { recursive: true });
  const sentinel = path.join(root, 'harness/pi/.cache/development-runtime/readers/sentinel');
  await fs.writeFile(sentinel, 'live reader');
  await fs.writeFile(path.join(root, 'ordinary'), 'tracked');
  execFileSync('git', ['add', 'ordinary'], { cwd: root });
  const index = await fs.readFile(path.join(root, '.git/index'));
  await fs.writeFile(path.join(external, 'source'), 'outward');
  await fs.symlink(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  // Cached exact path ensures that Git cannot hide traversal through a link.
  execFileSync('git', ['update-index', '--add', '--cacheinfo', '100644', execFileSync('git', ['hash-object', 'ordinary'], { cwd: root, encoding: 'utf8' }).trim(), 'linked/source'], { cwd: root });
  const selectedIndex = await fs.readFile(path.join(root, '.git/index'));
  await assert.rejects(createIsolatedPiWorkspace({ repositoryRoot: root, pnpmCli: path.join(root, 'pnpm.cjs'), networkPolicy: 'offline' }, { run: () => assert.fail('must not install') }), error => {
    assert.match(error.message, /Linked snapshot input/);
    t.after(() => error.cleanup({ teardownConfirmed: true })); return true;
  });
  assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), selectedIndex);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'live reader');
  assert.ok(index.length);
});
