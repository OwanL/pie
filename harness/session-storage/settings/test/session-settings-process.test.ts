import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const file = 'system-prompt-toggles.json';

test('directory kernel exclusion preserves competing updates and recovers owner death', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-settings-process-'));
  const children: ChildProcess[] = [];
  const queues = new Map<ChildProcess, Array<{ kind: string; error?: string }>>();
  async function wait(child: ChildProcess, kind: string) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const queue = queues.get(child)!;
      const failed = queue.find(message => message.kind === 'failed');
      if (failed) throw new Error(failed.error);
      const index = queue.findIndex(message => message.kind === kind);
      if (index !== -1) return queue.splice(index, 1)[0];
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('child exited before ' + kind);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('child timed out: ' + kind);
  }
  async function spawn(current?: string, legacy?: string) {
    const env = { ...process.env };
    delete env.PIE_SESSION_SETTINGS_DIR;
    delete env.PIE_LEGACY_SESSION_SETTINGS_DIR;
    if (current) env.PIE_SESSION_SETTINGS_DIR = current;
    if (legacy) env.PIE_LEGACY_SESSION_SETTINGS_DIR = legacy;
    const child = fork(path.join(__dirname, 'session-settings-child.cjs'), [], { env, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child);
    queues.set(child, []);
    child.on('message', message => queues.get(child)!.push(message as { kind: string }));
    await wait(child, 'ready');
    return child;
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('owned child did not exit')), 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  try {
    for (const layout of ['same', 'shared-legacy', 'legacy-only']) {
      const base = path.join(root, layout);
      const legacy = path.join(base, 'legacy');
      const current = path.join(base, 'current');
      const other = path.join(base, 'other');
      for (const dir of [legacy, current, other]) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(legacy, file), JSON.stringify({ seed: ['seed'], a: ['old-a'], b: ['old-b'] }));
      if (layout === 'same') await fs.writeFile(path.join(current, file), '{}');
      const a = await spawn(current, legacy);
      const b = await spawn(layout === 'same' ? current : layout === 'shared-legacy' ? other : undefined, legacy);
      a.send({ kind: 'write', session: 'a', pause: true, pauseFile: path.join(layout === 'same' ? current : legacy, file) });
      await wait(a, 'read'); // A holds all locks with its whole-map snapshot loaded.
      b.send({ kind: 'write', session: 'b' });
      await wait(b, 'started');
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.ok(!queues.get(b)!.some(message => message.kind === 'done'), 'competitor must wait for the overlapping directory');
      a.send({ kind: 'resume' });
      await Promise.all([wait(a, 'done'), wait(b, 'done')]);
      const first = JSON.parse(await fs.readFile(path.join(current, file), 'utf8'));
      assert.deepEqual(first.a, ['a']);
      if (layout === 'same') assert.deepEqual(first.b, ['b']);
      else {
        const second = JSON.parse(await fs.readFile(path.join(layout === 'shared-legacy' ? other : legacy, file), 'utf8'));
        assert.deepEqual(second.b, ['b']);
        assert.equal(second.a, undefined, 'the second mutation must see the first legacy scrub');
        assert.deepEqual(second.seed, ['seed']);
      }
      await Promise.all([stop(a), stop(b)]);
    }
    const directory = path.join(root, 'death');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, file), '{}');
    const owner = await spawn(directory);
    owner.send({ kind: 'write', session: 'abandoned', pause: true, pauseFile: path.join(directory, file) });
    await wait(owner, 'read');
    const successor = await spawn(directory);
    successor.send({ kind: 'write', session: 'survivor' });
    await wait(successor, 'started');
    await stop(owner);
    await wait(successor, 'done');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')), { survivor: ['survivor'] });
  } finally {
    await Promise.all(children.map(stop));
    await fs.rm(root, { recursive: true, force: true });
  }
});
