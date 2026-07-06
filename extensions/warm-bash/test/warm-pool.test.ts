import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';

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

/** Resolve a bash binary for the test (mirrors pi's getShellConfig fallbacks). */
function findBash(): string {
  const explicit = process.env.PI_SHELL?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (process.env.SHELL && existsSync(process.env.SHELL)) return process.env.SHELL;
  if (process.platform === 'win32') {
    const where = spawnSync('where', ['bash.exe'], { encoding: 'utf8' });
    const found = where.stdout?.split(/\r?\n/).map((s) => s.trim()).find((p) => p && existsSync(p));
    if (found) return found;
    const pf = process.env.ProgramFiles;
    if (pf && existsSync(`${pf}\\Git\\bin\\bash.exe`)) return `${pf}\\Git\\bin\\bash.exe`;
  } else {
    if (existsSync('/bin/bash')) return '/bin/bash';
  }
  return 'bash';
}

/** Minimal fallback ops (fresh `bash -c`) for the operations-level tests. */
function freshBashOps(): AnyOps {
  return {
    exec: (command, cwd, { onData, signal, timeout, env }) =>
      new Promise((resolve, reject) => {
        const child = spawn(findBash(), ['-c', command], { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

const BASH = findBash();

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

  test('custom warmup + acquire timeouts are accepted (0 falls back to default)', async () => {
    // 0 → default; just verify the pool constructs and runs with the overrides.
    const pool = new Pool({ size: 1, shellPath: BASH, env: process.env, warmupTimeoutMs: 0, acquireTimeoutMs: 0 });
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