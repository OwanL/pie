import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { findTestBash } from './test-shell.js';
import { MarkerStripper } from '../src/warm-pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const poolUrl = pathToFileURL(path.resolve(__dirname, '../src/warm-pool.ts')).href;
const opsUrl = pathToFileURL(path.resolve(__dirname, '../src/operations.ts')).href;
const classifyUrl = pathToFileURL(path.resolve(__dirname, '../src/classifier.ts')).href;

type AnyPool = {
  exec: (o: { command: string; cwd: string; env?: NodeJS.ProcessEnv; onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number }) => Promise<{ exitCode: number | null }>;
  dispose: () => void;
};
type AnyOps = {
  exec: (command: string, cwd: string, o: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }) => Promise<{ exitCode: number | null }>;
};

async function loadPool(): Promise<new (opts: { size: number; shellPath: string; env?: NodeJS.ProcessEnv }) => AnyPool> {
  const m = await import(poolUrl);
  return m.WarmBashPool as unknown as new (opts: { size: number; shellPath: string; env?: NodeJS.ProcessEnv }) => AnyPool;
}

async function loadOps(): Promise<(o: { pool: AnyPool | null; fastPathEnabled: boolean; fallbackOps: AnyOps; metrics?: { totalFastPath: number; totalWarm: number; totalFallback: number } }) => AnyOps> {
  const m = await import(opsUrl);
  return m.createWarmBashOperations as unknown as (o: { pool: AnyPool | null; fastPathEnabled: boolean; fallbackOps: AnyOps; metrics?: { totalFastPath: number; totalWarm: number; totalFallback: number } }) => AnyOps;
}

async function loadClassify() {
  const m = await import(classifyUrl);
  return m.classify as (c: string) => { kind: 'simple' | 'shell'; rest: string };
}

/** Minimal fallback ops (fresh `bash -c`) for the operations-level tests. */
function freshBashOps(): AnyOps {
  return {
    exec: (command, cwd, { onData, signal, timeout, env }) =>
      new Promise((resolve, reject) => {
        const child = spawn(findTestBash(), ['-c', command], { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let timer: NodeJS.Timeout | undefined;
        if (timeout && timeout > 0) timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, timeout * 1000);
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
        child.on('close', (code) => { if (timer) clearTimeout(timer); if (signal?.aborted) { reject(new Error('aborted')); return; } resolve({ exitCode: code }); });
      }),
  };
}

/** Collect all onData buffers into a string. */
function sink() {
  const chunks: Buffer[] = [];
  const onData = (b: Buffer) => chunks.push(b);
  const text = () => Buffer.concat(chunks).toString('utf8');
  return { onData, text };
}

const BASH = findTestBash();

describe('warm-bash pool (real bash round-trip)', { concurrency: false }, () => {
  // Loaded dynamically (tsx) — typed loosely; the assertions guard behaviour.
  let Pool: any;
  let createOps: any;
  let tmp: string;

  async function makePool(): Promise<any> {
    const p = new Pool({ size: 1, shellPath: BASH, env: process.env });
    await p.ready();
    return p;
  }

  test.before(async () => {
    Pool = await loadPool();
    createOps = await loadOps();
    tmp = mkdtempSync(path.join(tmpdir(), 'warm-bash-test-'));
  });
  test.after(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  test('echo via warm worker', async () => {
    const pool = await makePool();
    try {
      const { onData, text } = sink();
      const res = await pool.exec({ command: 'echo hello', cwd: tmp, env: process.env, onData });
      assert.equal(res.exitCode, 0);
      assert.equal(text().trim(), 'hello');
    } finally {
      pool.dispose();
    }
  });

  test('exit code propagates (false -> 1)', async () => {
    const pool = await makePool();
    try {
      const { onData } = sink();
      const res = await pool.exec({ command: 'false', cwd: tmp, env: process.env, onData });
      assert.equal(res.exitCode, 1);
    } finally {
      pool.dispose();
    }
  });

  test('exit code propagates (exit 7 -> process-close path)', async () => {
    const pool = await makePool();
    try {
      const { onData } = sink();
      // `exit` replaces the shell → marker never prints → process-close path.
      const res = await pool.exec({ command: 'exit 7', cwd: tmp, env: process.env, onData });
      assert.equal(res.exitCode, 7);
    } finally {
      pool.dispose();
    }
  });

  test('pipe works through warm worker', async () => {
    const pool = await makePool();
    try {
      const { onData, text } = sink();
      const res = await pool.exec({ command: 'echo foo | grep -o o', cwd: tmp, env: process.env, onData });
      assert.equal(res.exitCode, 0);
      assert.equal(text().trim(), 'o\no');
    } finally {
      pool.dispose();
    }
  });

  test('heredoc works through warm worker', async () => {
    const pool = await makePool();
    try {
      const { onData, text } = sink();
      const res = await pool.exec({
        command: 'cat <<EOF\nhello heredoc\nEOF',
        cwd: tmp, env: process.env, onData,
      });
      assert.equal(res.exitCode, 0);
      assert.equal(text(), 'hello heredoc\n');
      assert.ok(!text().includes('__PI_EXIT_'), 'marker must be stripped');
    } finally {
      pool.dispose();
    }
  });

  test('marker is never leaked into output', async () => {
    const pool = await makePool();
    try {
      const { onData, text } = sink();
      await pool.exec({ command: 'printf "line1\\nline2\\n"', cwd: tmp, env: process.env, onData });
      assert.ok(!text().includes('__PI_EXIT_'));
      assert.equal(text(), 'line1\nline2\n');
    } finally {
      pool.dispose();
    }
  });

  test('cwd is applied (pwd reflects the working directory)', async () => {
    const pool = await makePool();
    try {
      const { onData, text } = sink();
      await pool.exec({ command: 'pwd', cwd: tmp, env: process.env, onData });
      // Git Bash may report a /tmp/... MSYS path; just check the basename matches.
      assert.ok(text().includes(path.basename(tmp)), `pwd=${text()} tmp=${tmp}`);
    } finally {
      pool.dispose();
    }
  });

  test('operations: simple command fast-paths without a shell (echo in-process)', async () => {
    const classify = await loadClassify();
    const c = classify('echo ready');
    assert.equal(c.kind, 'simple');
    const ops = createOps({ pool: null, fastPathEnabled: true, fallbackOps: freshBashOps() });
    const { onData, text } = sink();
    const res = await ops.exec('echo ready', tmp, { onData });
    assert.equal(res.exitCode, 0);
    assert.equal(text(), 'ready\n');
  });

  test('operations: real binary fast-paths (node --version, no shell)', async () => {
    const ops = createOps({ pool: null, fastPathEnabled: true, fallbackOps: freshBashOps() });
    const { onData, text } = sink();
    const res = await ops.exec('node --version', tmp, { onData });
    assert.equal(res.exitCode, 0);
    assert.match(text(), /^v\d/);
  });

  test('operations: abort propagates (terminal, no fallback)', async () => {
    const ops = createOps({ pool: null, fastPathEnabled: true, fallbackOps: freshBashOps() });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(ops.exec('node --version', tmp, { onData: () => {}, signal: ac.signal }), /aborted/);
  });

  test('operations: timeout propagates and kills the tree', async () => {
    const ops = createOps({ pool: null, fastPathEnabled: true, fallbackOps: freshBashOps() });
    await assert.rejects(
      ops.exec('node -e "setTimeout(()=>{},30000)"', tmp, { onData: () => {}, timeout: 1 }),
      /timeout:1/,
    );
  });

  test('warm pool: timeout kills the worker and rejects', async () => {
    const pool = new Pool({ size: 1, shellPath: BASH, env: process.env });
    try {
      await pool.ready();
      await assert.rejects(
        pool.exec({ command: 'sleep 30', cwd: tmp, env: process.env, onData: () => {}, timeout: 1 }),
        /timeout:1/,
      );
    } finally {
      pool.dispose();
    }
  });

  test('warm pool: an already-aborted call never starts a command', async () => {
    const pool = await makePool();
    const controller = new AbortController();
    controller.abort();
    try {
      await assert.rejects(
        pool.exec({ command: 'echo must-not-run', cwd: tmp, env: process.env, onData: () => {}, signal: controller.signal }),
        /aborted/,
      );
    } finally {
      pool.dispose();
    }
  });

  test('parallel overflow falls back immediately instead of queueing behind the warm idle target', async () => {
    const pool = await makePool();
    const metrics = { totalFastPath: 0, totalWarm: 0, totalFallback: 0 };
    let fallbackCalls = 0;
    const fallbackOps: AnyOps = {
      exec: async () => {
        fallbackCalls++;
        return { exitCode: 0 };
      },
    };
    const ops = createOps({ pool, fastPathEnabled: false, fallbackOps, metrics });
    try {
      let firstDone = false;
      const first = ops.exec('sleep 0.3 && echo warm', tmp, { onData: () => {} }).finally(() => { firstDone = true; });
      assert.equal(pool.getStats().ready, 0, 'the first call synchronously consumes the only warm worker');
      await ops.exec('echo overflow | cat', tmp, { onData: () => {} });
      assert.equal(firstDone, false, 'overflow must not wait for the warm command to finish');
      assert.equal(fallbackCalls, 1);
      await first;
      assert.equal(metrics.totalWarm, 1);
      assert.equal(metrics.totalFallback, 1);
    } finally {
      pool.dispose();
    }
  });

  test('operations: shell command uses warm pool then falls back if unavailable', async () => {
    // pool=null forces the warm miss → fallback (fresh bash -c). Verifies the
    // degradation path produces correct output.
    const ops = createOps({ pool: null, fastPathEnabled: false, fallbackOps: freshBashOps() });
    const { onData, text } = sink();
    const res = await ops.exec('echo via-fallback | tr a-z A-Z', tmp, { onData });
    assert.equal(res.exitCode, 0);
    assert.equal(text().trim(), 'VIA-FALLBACK');
  });

  test('pool reuses across sequential calls (size 2 keeps a spare warm)', async () => {
    const pool = new Pool({ size: 2, shellPath: BASH, env: process.env });
    try {
      await pool.ready();
      for (let i = 0; i < 5; i++) {
        const { onData, text } = sink();
        const res = await pool.exec({ command: `echo iter${i}`, cwd: tmp, env: process.env, onData });
        assert.equal(res.exitCode, 0);
        assert.equal(text().trim(), `iter${i}`);
      }
    } finally {
      pool.dispose();
    }
  });

  test('getStats reports pool size, ready workers, and warmup failures', async () => {
    const pool = new Pool({ size: 2, shellPath: BASH, env: process.env });
    try {
      await pool.ready();
      // ready() waits for at least one warm worker; size 2 → at least 1 ready.
      const before = pool.getStats();
      assert.equal(before.poolSize, 2);
      assert.ok(before.ready >= 1, `ready>=1, got ${before.ready}`);
      assert.equal(before.totalWarmupFailures, 0);
      assert.equal(before.disposed, false);

      const { onData } = sink();
      await pool.exec({ command: 'echo counted', cwd: tmp, env: process.env, onData });
      const after = pool.getStats();
      // warm-exec count is owned by the operations layer (metrics), not the pool;
      // the pool only reports pool size / ready / warming / warmup failures.
      assert.ok(after.ready >= 1, `ready>=1 after exec, got ${after.ready}`);
    } finally {
      pool.dispose();
    }
  });

  test('getStats reports disposed state and zeros after dispose', async () => {
    const pool = new Pool({ size: 1, shellPath: BASH, env: process.env });
    await pool.ready();
    pool.dispose();
    const s = pool.getStats();
    assert.equal(s.disposed, true);
    assert.equal(s.ready, 0);
    assert.equal(s.warming, 0);
  });

  test('custom warmup timeout is accepted (0 falls back to default)', async () => {
    // 0 → default; just verify the pool constructs and runs with the override.
    const pool = new Pool({ size: 1, shellPath: BASH, env: process.env, warmupTimeoutMs: 0 });
    try {
      await pool.ready();
      const { onData, text } = sink();
      const res = await pool.exec({ command: 'echo timeout-cfg', cwd: tmp, env: process.env, onData });
      assert.equal(res.exitCode, 0);
      assert.equal(text().trim(), 'timeout-cfg');
    } finally {
      pool.dispose();
    }
  });

  /** Poll pool stats until `readyCheck` is satisfied (or `deadlineMs` elapses). */
  async function settle(pool: any, readyCheck: (s: any) => boolean, deadlineMs = 8000): Promise<any> {
    const deadline = Date.now() + deadlineMs;
    let s = pool.getStats();
    while (!readyCheck(s) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      s = pool.getStats();
    }
    return s;
  }

  test('setTarget(n) kills excess idle workers down to the new (lower) target', async () => {
    const pool = new Pool({ size: 4, shellPath: BASH, env: process.env });
    try {
      await pool.ready();
      // Lower the target to 1; warming workers that land afterwards must be
      // killed by deliver rather than parked above the target.
      pool.setTarget(1);
      const s = await settle(pool, (x) => x.warming === 0 && x.ready <= 1);
      assert.equal(s.warming, 0, `warming should drain, got ${s.warming}`);
      assert.ok(s.ready <= 1, `ready<=1 after lowering, got ${s.ready}`);
      assert.equal(s.poolSize, 1);
    } finally {
      pool.dispose();
    }
  });

  test('setTarget(n) spawns up to the new (higher) target when raised', async () => {
    const pool = new Pool({ size: 1, shellPath: BASH, env: process.env });
    try {
      await pool.ready();
      pool.setTarget(3);
      const s = await settle(pool, (x) => x.ready >= 3);
      assert.ok(s.ready >= 3, `ready>=3 after raising, got ${s.ready}`);
      assert.equal(s.poolSize, 3);
    } finally {
      pool.dispose();
    }
  });

  test('setTarget(0) drains the pool to zero idle without disposing', async () => {
    const pool = new Pool({ size: 3, shellPath: BASH, env: process.env });
    try {
      await pool.ready();
      pool.setTarget(0);
      const s = await settle(pool, (x) => x.warming === 0 && x.ready === 0);
      assert.equal(s.ready, 0, `ready should drain to 0, got ${s.ready}`);
      assert.equal(s.warming, 0);
      assert.equal(s.disposed, false, 'setTarget(0) must not dispose the pool object');
      assert.equal(s.poolSize, 0);
    } finally {
      pool.dispose();
    }
  });

  test('setTarget then exec still serves a command correctly', async () => {
    const pool = new Pool({ size: 3, shellPath: BASH, env: process.env });
    try {
      await pool.ready();
      pool.setTarget(1);
      await settle(pool, (x) => x.warming === 0 && x.ready <= 1);
      const { onData, text } = sink();
      const res = await pool.exec({ command: 'echo after-shrink', cwd: tmp, env: process.env, onData });
      assert.equal(res.exitCode, 0);
      assert.equal(text().trim(), 'after-shrink');
    } finally {
      pool.dispose();
    }
  });

  test('operations: metrics count fast-path, warm, and fallback executions distinctly', async () => {
    // Fast path: simple command, no shell, no pool.
    const fast = { totalFastPath: 0, totalWarm: 0, totalFallback: 0 };
    const opsFast = createOps({ pool: null, fastPathEnabled: true, fallbackOps: freshBashOps(), metrics: fast });
    await opsFast.exec('echo fast', tmp, { onData: () => {} });
    assert.equal(fast.totalFastPath, 1);
    assert.equal(fast.totalWarm, 0);
    assert.equal(fast.totalFallback, 0);

    // Fallback: pool null + fast path off + shell command (pipe) → fresh spawn.
    const fb = { totalFastPath: 0, totalWarm: 0, totalFallback: 0 };
    const opsFb = createOps({ pool: null, fastPathEnabled: false, fallbackOps: freshBashOps(), metrics: fb });
    await opsFb.exec('echo via-fallback | tr a-z A-Z', tmp, { onData: () => {} });
    assert.equal(fb.totalFastPath, 0);
    assert.equal(fb.totalWarm, 0);
    assert.equal(fb.totalFallback, 1);

    // Warm path: pool present + shell command (pipe) → warm pool.
    const pool = new Pool({ size: 1, shellPath: BASH, env: process.env });
    try {
      await pool.ready();
      const warm = { totalFastPath: 0, totalWarm: 0, totalFallback: 0 };
      const opsWarm = createOps({ pool, fastPathEnabled: true, fallbackOps: freshBashOps(), metrics: warm });
      await opsWarm.exec('echo warm | cat', tmp, { onData: () => {} });
      assert.equal(warm.totalFastPath, 0);
      assert.equal(warm.totalWarm, 1);
      assert.equal(warm.totalFallback, 0);
      // The three counters sum to exactly one distinct command per scenario.
      assert.equal(warm.totalFastPath + warm.totalWarm + warm.totalFallback, 1);
    } finally {
      pool.dispose();
    }
  });
});

describe('MarkerStripper', () => {
  test('strips complete marker and parses exit code from a single chunk', () => {
    const chunks: Buffer[] = [];
    const stripper = new MarkerStripper('abc123', (b) => chunks.push(b));
    stripper.push(Buffer.from('hello\n__PI_EXIT_abc123__42__\n'));
    assert.equal(stripper.done, true);
    assert.equal(stripper.exitCode, 42);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello');
  });

  test('strips marker split at every possible boundary and parses the exit code', () => {
    const token = 'deadbeef';
    const marker = `\n__PI_EXIT_${token}__7__\n`;
    const data = `output line${marker}tail`;
    for (let splitAt = 0; splitAt <= data.length; splitAt++) {
      const chunks: Buffer[] = [];
      const stripper = new MarkerStripper(token, (b) => chunks.push(b));
      stripper.push(Buffer.from(data.slice(0, splitAt)));
      // If the first chunk already contains the complete marker, skip the second push.
      if (!stripper.done) {
        stripper.push(Buffer.from(data.slice(splitAt)));
      }
      assert.equal(stripper.done, true, `splitAt=${splitAt}: must be done`);
      assert.equal(stripper.exitCode, 7, `splitAt=${splitAt}: exit code`);
      assert.equal(Buffer.concat(chunks).toString('utf8'), 'output line', `splitAt=${splitAt}: stripped output`);
    }
  });

  test('multi-digit exit code is parsed correctly', () => {
    const chunks: Buffer[] = [];
    const stripper = new MarkerStripper('tok', (b) => chunks.push(b));
    stripper.push(Buffer.from('x\n__PI_EXIT_tok__123__\n'));
    assert.equal(stripper.exitCode, 123);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'x');
  });

  test('trailing data after the marker is ignored once done', () => {
    const chunks: Buffer[] = [];
    const stripper = new MarkerStripper('tok', (b) => chunks.push(b));
    stripper.push(Buffer.from('hello\n__PI_EXIT_tok__0__\nignored'));
    assert.equal(stripper.done, true);
    assert.equal(stripper.exitCode, 0);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello');
  });

  test('flushRemaining emits an incomplete marker as data', () => {
    const chunks: Buffer[] = [];
    const stripper = new MarkerStripper('tok', (b) => chunks.push(b));
    stripper.push(Buffer.from('data\n__PI_EXIT_tok__'));
    assert.equal(stripper.done, false);
    stripper.flushRemaining();
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'data\n__PI_EXIT_tok__');
  });

  test('output without a marker passes through unchanged', () => {
    const chunks: Buffer[] = [];
    const stripper = new MarkerStripper('tok', (b) => chunks.push(b));
    stripper.push(Buffer.from('plain output\n'));
    stripper.flushRemaining();
    assert.equal(stripper.done, false);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'plain output\n');
  });
});