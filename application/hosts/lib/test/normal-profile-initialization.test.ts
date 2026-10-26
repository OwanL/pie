import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { initializeNormalProfile } from '../normal-profile-initialization';
import type { ResolvedAgentDir } from '../agent-dir-resolution';

function fixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-neutral-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const selection = (agentDir: string, source: ResolvedAgentDir['source'] = 'normal'): ResolvedAgentDir => ({ agentDir, source, rejections: [] });

test('fresh normal home gets only neutral settings; repeat startup preserves user files', (t) => {
  const root = fixture(t);
  const home = path.join(root, 'pie');
  initializeNormalProfile(selection(home));
  assert.deepEqual(fs.readdirSync(home), ['settings.json']);
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), '{}');
  for (const [name, content] of [['settings.json', '{"user":true}'], ['auth.json', 'credentials'], ['history.jsonl', 'history']]) {
    fs.writeFileSync(path.join(home, name), content);
  }
  initializeNormalProfile(selection(home));
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), '{"user":true}');
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), 'credentials');
  assert.equal(fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8'), 'history');
});

test('malformed settings and existing non-file markers are never repaired', (t) => {
  const root = fixture(t);
  const marker = path.join(root, 'settings.json');
  fs.writeFileSync(marker, '{broken');
  initializeNormalProfile(selection(root));
  assert.equal(fs.readFileSync(marker, 'utf8'), '{broken');
  fs.unlinkSync(marker);
  fs.mkdirSync(marker);
  initializeNormalProfile(selection(root));
  assert.ok(fs.statSync(marker).isDirectory());
});

test('explicit and checkout selections are no-write, including absent roots', (t) => {
  const root = fixture(t);
  for (const source of ['setting', 'env', 'extension-relative'] as const) {
    initializeNormalProfile(selection(path.join(root, source), source));
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('creation failure propagates without falling back or modifying other state', (t) => {
  const root = fixture(t);
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, 'unchanged');
  assert.throws(() => initializeNormalProfile(selection(path.join(blocked, 'pie'))));
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'unchanged');
  assert.deepEqual(fs.readdirSync(root), ['blocked']);
});

test('concurrent exclusive creation keeps the competing writer bytes', async (t) => {
  const root = fixture(t);
  const home = path.join(root, 'pie');
  // Compete with independent writers using the same exclusive filesystem
  // primitive, without relying on a process-local initialization lock.
  const writers = Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(`
      const fs = require('node:fs');
      const { workerData } = require('node:worker_threads');
      fs.mkdirSync(workerData, { recursive: true });
      try { fs.writeFileSync(require('node:path').join(workerData, 'settings.json'), '{}', { flag: 'wx' }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    `, { eval: true, workerData: home });
    worker.once('error', reject);
    worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)));
  }));
  initializeNormalProfile(selection(home));
  await Promise.all(writers);
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(home), ['settings.json']);
});
