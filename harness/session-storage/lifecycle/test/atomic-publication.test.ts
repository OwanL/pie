import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { retryAtomicPublication } from '../atomic-publication';

const delays = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000];

function renameFailure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error('fixture rename denial'), { code, syscall: 'rename' });
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`atomic publication yields and retries ${code} with the existing bounded budget`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const failure = renameFailure(code);
    const pending = retryAtomicPublication(() => { attempts++; throw failure; });
    const rejected = assert.rejects(pending, (error) => error === failure);
    assert.equal(attempts, 1, 'the first fenced attempt is synchronous');
    for (const [index, delay] of delays.entries()) {
      t.mock.timers.tick(delay - 1);
      await Promise.resolve();
      assert.equal(attempts, index + 1);
      t.mock.timers.tick(1);
      await Promise.resolve();
      assert.equal(attempts, index + 2);
    }
    await rejected;
    assert.equal(attempts, 10);
  });
}

test('a timer can release a transient denial without repeating successful publication', async () => {
  let locked = true;
  let attempts = 0;
  const timer = setTimeout(() => { locked = false; }, 1);
  try {
    const result = await retryAtomicPublication(() => {
      attempts++;
      if (locked) throw renameFailure('EPERM');
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.equal(attempts, 2);
  } finally {
    clearTimeout(timer);
  }
});

test('permanent and non-rename errors are not retried', async () => {
  for (const error of [renameFailure('EIO'), Object.assign(new Error('read denied'), { code: 'EPERM', syscall: 'open' }), new Error('ownership revoked')]) {
    let attempts = 0;
    await assert.rejects(retryAtomicPublication(() => { attempts++; throw error; }), (caught) => caught === error);
    assert.equal(attempts, 1);
  }
});

test('real Windows delete-sharing denial releases during publication backoff', { skip: process.platform !== 'win32', timeout: 25_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-publication-sharing-'));
  const target = path.join(root, 'session.jsonl');
  const source = path.join(root, 'session.tmp');
  const script = path.join(root, 'hold.ps1');
  fs.writeFileSync(target, 'old\n');
  fs.writeFileSync(source, 'new\n');
  fs.writeFileSync(script, `$f = [IO.File]::Open($args[0], 'Open', 'Read', 'ReadWrite')\n[Console]::Out.WriteLine('READY')\n[Console]::Out.Flush()\ntry { [Console]::In.ReadLine() | Out-Null } finally { $f.Dispose() }\n`);
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, target], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let closed = false;
  const close = new Promise<void>((resolve) => child.once('close', () => { closed = true; resolve(); }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const startup = setTimeout(() => reject(new Error('sharing-lock child readiness timed out')), 15_000);
      let output = '';
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('READY')) { clearTimeout(startup); resolve(); }
      };
      child.stdout.on('data', onData);
      child.once('error', (error) => { clearTimeout(startup); reject(error); });
      child.once('close', () => { clearTimeout(startup); if (!output.includes('READY')) reject(new Error('sharing-lock child exited before readiness')); });
    });
    let attempts = 0;
    const pending = retryAtomicPublication(() => {
      attempts++;
      fs.renameSync(source, target);
    });
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old\n');
    timer = setTimeout(() => child.stdin.end('\n'), 1);
    await pending;
    assert.ok(attempts >= 2, 'the real locked destination rejected the first rename');
    assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
  } finally {
    clearTimeout(timer);
    child.stdin.end('\n');
    const kill = setTimeout(() => { if (!closed) child.kill(); }, 5000);
    try { await close; } finally { clearTimeout(kill); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
