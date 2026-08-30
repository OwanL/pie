import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { killShellOnly } from '../src/kill.js';
import { findTestBash } from './test-shell.js';

const RUN_INTEGRATION_TESTS = process.env.PIE_RUN_INTEGRATION_TESTS === '1';

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), 'condition did not become true before the deadline');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('killShellOnly terminates through the child handle without a synchronous helper', () => {
  const signals: NodeJS.Signals[] = [];
  const child = {
    pid: 2_147_483_647,
    kill: (signal: NodeJS.Signals) => {
      signals.push(signal);
      return true;
    },
  } as unknown as ChildProcess;

  killShellOnly(child);

  assert.deepEqual(signals, ['SIGKILL']);
});

test('killShellOnly leaves a background child alive', {
  skip: RUN_INTEGRATION_TESTS ? false : 'set PIE_RUN_INTEGRATION_TESTS=1 to run real-shell integration tests',
  timeout: 10_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'warm-bash-kill-'));
  const sentinel = path.join(dir, 'survived.txt');
  const bashSentinel = sentinel.replace(/\\/g, '/');
  const shell = spawn(findTestBash(), ['--norc', '--noprofile'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });

  try {
    let stdout = '';
    const ready = new Promise<void>((resolve, reject) => {
      shell.once('error', reject);
      shell.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
        if (stdout.includes('__READY__')) resolve();
      });
    });
    shell.stdin?.write(`parent=$$; (while kill -0 "$parent" 2>/dev/null; do sleep 0.02; done; printf survived > "${bashSentinel}") &\nprintf __READY__\\n\n`);
    await withTimeout(ready, 3_000);

    const exited = new Promise<void>((resolve) => shell.once('exit', () => resolve()));
    killShellOnly(shell);
    await withTimeout(exited, 3_000);
    await waitUntil(() => existsSync(sentinel));
  } finally {
    try { shell.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
