import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { chromium } from 'playwright';

import { PlaywrightBackend } from '../src/backend.mjs';
import { RuntimeClient } from '../src/runtime-client.js';

function browserAvailable(): boolean {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
}
const HAS_BROWSER = browserAvailable();

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitForExit(pid: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}
async function waitForState(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition timed out');
}

async function readReady(child: ReturnType<typeof spawn>, timeoutMs = 30_000): Promise<{ ownerPid: number; sidecarPid: number; browserPids: number[] }> {
  return await new Promise((resolve, reject) => {
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => reject(new Error(`owner did not become ready; stderr=${stderr}`)), timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('READY '));
      if (!line) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(line.slice('READY '.length))); } catch (error) { reject(error); }
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!stdout.includes('READY ')) reject(new Error(`owner exited before ready (${code}/${signal}); stderr=${stderr}`));
    });
  });
}

test('force-killing a live sidecar terminates its Chromium process tree and invalidates the runtime', { skip: !HAS_BROWSER, timeout: 40_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pw-tree-kill-'));
  const client = new RuntimeClient(path.join(root, 'session.jsonl'));
  try {
    await client.request('open', { sessionId: 'tree', artifactDir: path.join(root, 'artifacts'), url: 'about:blank' }, { sessionId: 'tree', timeoutMs: 30_000, allowNeedsReopen: true });
    client.markReopened();
    const pids = await client.request('debug_pids', {}, { timeoutMs: 10_000 }) as unknown as { sidecarPid: number; browserPids: number[] };
    assert.equal(pids.browserPids.length, 1);
    client.killForTesting();
    await waitForExit(pids.sidecarPid);
    await Promise.all(pids.browserPids.map((pid) => waitForExit(pid)));
    await waitForState(() => client.state === 'needs_reopen');
    await assert.rejects(() => client.request('observe', { sessionId: 'tree' }), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_REOPEN_REQUIRED');
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('run_code timeout and cancellation terminate the sidecar tree before delayed code can mutate', { skip: !HAS_BROWSER, timeout: 50_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pw-run-code-recovery-'));
  const client = new RuntimeClient(path.join(root, 'session.jsonl'));
  try {
    await client.request('open', { sessionId: 'timeout', artifactDir: path.join(root, 'timeout'), url: 'about:blank' }, { timeoutMs: 30_000, allowNeedsReopen: true });
    client.markReopened();
    const timeoutPids = await client.request('debug_pids', {}, { timeoutMs: 10_000 }) as unknown as { sidecarPid: number; browserPids: number[] };
    await assert.rejects(
      () => client.request('run_code', {
        sessionId: 'timeout', timeout: 1000,
        code: "await new Promise((resolve) => setTimeout(resolve, 5000)); await page.evaluate(() => { document.title = 'late-timeout-mutation'; }); return true;",
      }, { timeoutMs: 10_000 }),
      (error: unknown) => (error as { code?: string }).code === 'RUN_CODE_TIMEOUT',
    );
    await waitForState(() => client.state === 'needs_reopen');
    await waitForExit(timeoutPids.sidecarPid);
    await Promise.all(timeoutPids.browserPids.map((pid) => waitForExit(pid)));
    await assert.rejects(() => client.request('observe', { sessionId: 'timeout' }), (error: unknown) => (error as { code?: string }).code === 'RUNTIME_REOPEN_REQUIRED');

    await client.request('open', { sessionId: 'cancel', artifactDir: path.join(root, 'cancel'), url: 'about:blank' }, { timeoutMs: 30_000, allowNeedsReopen: true });
    client.markReopened();
    const cancelPids = await client.request('debug_pids', {}, { timeoutMs: 10_000 }) as unknown as { sidecarPid: number; browserPids: number[] };
    const controller = new AbortController();
    const request = client.request('run_code', {
      sessionId: 'cancel', timeout: 10_000,
      code: "await new Promise((resolve) => setTimeout(resolve, 5000)); await page.evaluate(() => { document.title = 'late-cancel-mutation'; }); return true;",
    }, { timeoutMs: 15_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(() => request, (error: unknown) => (error as { code?: string }).code === 'CANCELLED');
    await waitForState(() => client.state === 'needs_reopen');
    await waitForExit(cancelPids.sidecarPid);
    await Promise.all(cancelPids.browserPids.map((pid) => waitForExit(pid)));
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('backend forced browser-close fallback terminates the full browser process tree', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const owner = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000);"], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  let childPid: number | undefined;
  try {
    childPid = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('process tree helper did not report its child')), 5000);
      owner.stdout?.on('data', (chunk) => {
        output += chunk.toString();
        const parsed = Number(output.trim().split(/\r?\n/)[0]);
        if (Number.isInteger(parsed) && parsed > 0) { clearTimeout(timer); resolve(parsed); }
      });
    });
    const backend = new PlaywrightBackend({ closeGraceMs: 50 });
    const never = new Promise<void>(() => {});
    const session = backend.makeSession('forced-close', { artifactDir: tmpdir() });
    session.browser = { close: async () => await never };
    session.browserServer = { close: async () => await never, process: () => owner };
    backend.sessions.set(session.id, session);
    const closing = backend.closeSession(session);
    await waitForState(() => backend.closingSessions.has(session));
    backend.forceKillAll();
    await waitForExit(owner.pid!);
    await waitForExit(childPid);
    await closing;
  } finally {
    if (alive(owner.pid!)) owner.kill('SIGKILL');
    if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
  }
});

test('killing the owning parent without a shutdown frame leaves no sidecar or Chromium descendants', { skip: !HAS_BROWSER, timeout: 50_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pw-parent-death-'));
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testDir, '..', '..', '..');
  const ownerPath = path.join(testDir, 'fixtures', 'runtime-owner.ts');
  const owner = spawn(process.execPath, ['--import', 'tsx', ownerPath, root], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const pids = await readReady(owner);
    assert.equal(pids.ownerPid, owner.pid);
    assert.equal(pids.browserPids.length, 1);
    assert.ok(alive(pids.sidecarPid));
    assert.ok(alive(pids.browserPids[0]));
    owner.kill('SIGKILL');
    await waitForExit(pids.ownerPid);
    await waitForExit(pids.sidecarPid);
    await Promise.all(pids.browserPids.map((pid) => waitForExit(pid)));
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
