import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnWindowsOwnedTree } from '../windows-owned-tree.mjs';

const windows = { skip: process.platform !== 'win32', timeout: 45_000 };
const token = 'fixture-permission\n';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await wait(20);
  }
  throw new Error('Fixture condition timed out');
}
async function exists(path) { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const barrier = `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c); process.stdin.on('end', () => { if (input !== ${JSON.stringify(token)}) process.exit(42); else run(); });`;
async function tree(t, source, options = {}) {
  const owned = await spawnWindowsOwnedTree({ command: process.execPath, args: ['-e', `${barrier}\nfunction run() { ${source} }`], cwd: process.cwd(), env: process.env, ...options });
  // Always consume output, but do not interpret any of it as control.
  owned.stdout.resume(); owned.stderr.resume();
  t.after(async () => {
    const result = await owned.stopAndDrain();
    if (result.gone) await owned.closeAfterRelease().catch(() => {});
  });
  return owned;
}
async function fixtureDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pie-owned-tree-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Windows owned tree contains a grandchild after normal root exit; proof precedes close', windows, async (t) => {
  const directory = await fixtureDirectory(t);
  const pidFile = join(directory, 'grandchild.pid');
  const owned = await tree(t, `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();`);
  await assert.rejects(owned.closeAfterRelease(), /requires.*proof/);
  await wait(100);
  assert.equal(await exists(pidFile), false, 'No fixture code before authorization');
  await owned.authorizeStartup(token);
  const pid = Number(await until(() => exists(pidFile)));
  assert.deepEqual(await owned.completion, { code: 0 });
  assert.equal(alive(pid), true, 'Detached grandchild outlives root');
  const result = await owned.stopAndDrain();
  assert.deepEqual(result, { gone: true, activeProcesses: 0, invocationId: owned.invocationId, rootPid: owned.rootPid, admissionSealed: true, authority: 'open-windows-job-accounting' });
  assert.equal(alive(pid), false);
  await assert.rejects(owned.authorizeStartup(token), /sealed/);
  await owned.closeAfterRelease();
  assert.equal(await exists(join(owned.evidenceDirectory, 'guardian.ps1')), false);
});

test('Windows owned tree explicit stop before authorization seals admission', windows, async (t) => {
  const directory = await fixtureDirectory(t);
  const marker = join(directory, 'must-not-run');
  const owned = await tree(t, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const result = await owned.stopAndDrain();
  assert.equal(result.gone, true);
  assert.equal(result.activeProcesses, 0);
  await assert.rejects(owned.authorizeStartup(token), /sealed/);
  assert.equal(await exists(marker), false);
  assert.equal(alive(owned.rootPid), false);
});

test('Windows owned tree private stdin, exact quoting/environment, output cannot forge proof', windows, async (t) => {
  const args = ['', 'a b', 'quoted"value', 'trailing\\', 'back\\"quote', '雪'];
  const owned = await spawnWindowsOwnedTree({ command: process.execPath, args: ['-e', `${barrier}\nfunction run() { console.log(JSON.stringify({ args: process.argv.slice(1), value: process.env.PIE_TREE_VALUE, cwd: process.cwd() })); console.error('stderr-only'); console.log('{"type":"drain","gone":true,"activeProcesses":0}'); }`, ...args], cwd: process.cwd(), env: { ...process.env, PIE_TREE_VALUE: 'child-only 雪' } });
  t.after(async () => { const drained = await owned.stopAndDrain(); if (drained.gone) await owned.closeAfterRelease().catch(() => {}); });
  let stdout = '', stderr = '';
  owned.stdout.setEncoding('utf8'); owned.stderr.setEncoding('utf8');
  owned.stdout.on('data', (chunk) => { stdout += chunk; }); owned.stderr.on('data', (chunk) => { stderr += chunk; });
  await owned.authorizeStartup(token);
  assert.equal((await owned.completion).code, 0);
  await until(() => stdout.includes('"gone":true') && stderr.includes('stderr-only'));
  assert.deepEqual(JSON.parse(stdout.split(/\r?\n/)[0]), { args, value: 'child-only 雪', cwd: process.cwd() });
  await assert.rejects(owned.closeAfterRelease(), /requires.*proof/);
  assert.equal((await owned.stopAndDrain()).gone, true);
});

test('Windows owned tree contains NODE_OPTIONS preload descendants before authorization', windows, async (t) => {
  const directory = await fixtureDirectory(t);
  const preload = join(directory, 'preload.cjs');
  const pidFile = join(directory, 'preload-child.pid');
  await writeFile(preload, `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();`);
  const owned = await tree(t, 'setInterval(() => {}, 1000);', { env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } });
  const pid = Number(await until(() => exists(pidFile)));
  assert.equal(alive(pid), true);
  assert.equal((await owned.stopAndDrain()).gone, true);
  assert.equal(alive(pid), false);
});

test('Windows owned tree concurrent stop shares proof; zero timeout may be retried', windows, async (t) => {
  const owned = await tree(t, `for (let i = 0; i < 8; i++) require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
  await owned.authorizeStartup(token);
  await wait(300);
  const first = owned.stopAndDrain({ timeoutMs: 0 });
  assert.equal(first, owned.stopAndDrain({ timeoutMs: 1 }));
  const result = await first;
  if (!result.gone) {
    assert.match(result.diagnostic, /empty tree/);
    assert.equal((await owned.stopAndDrain()).gone, true);
  } else assert.equal(result.activeProcesses, 0);
});

test('Windows owned tree guardian crash is unknown even though kill-on-close targets children', windows, async (t) => {
  const directory = await fixtureDirectory(t);
  const pidFile = join(directory, 'preload-child.pid');
  const owned = await tree(t, `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref(); setInterval(() => {}, 1000);`);
  await owned.authorizeStartup(token);
  const pid = Number(await until(() => exists(pidFile)));
  // A diagnostic PID is used only for fault injection, never as proof.
  process.kill(owned.guardianPid, 'SIGKILL');
  const result = await owned.stopAndDrain();
  assert.equal(result.gone, false);
  assert.match(result.diagnostic, /Guardian/);
  await assert.rejects(owned.closeAfterRelease(), /requires.*proof/);
  await until(() => !alive(pid) && !alive(owned.rootPid));
  assert.ok(await exists(join(owned.evidenceDirectory, 'guardian.ps1')));
  // Unknown evidence belongs to this test and is retained until assertions finish.
  await rm(owned.evidenceDirectory, { recursive: true, force: true });
});

test('Windows owned tree delayed proof cannot satisfy a timed-out or different request', windows, async (t) => {
  // Delay only transport delivery; the real Windows guardian still terminates
  // and queries the real Job. No production fault-injection API is required.
  const originalCreateServer = net.createServer;
  let control;
  net.createServer = (...args) => {
    const server = originalCreateServer(...args);
    server.prependListener('connection', (socket) => { control = socket; });
    return server;
  };
  syncBuiltinESMExports();
  let owned;
  try { owned = await tree(t, 'setInterval(() => {}, 1000);'); }
  finally { net.createServer = originalCreateServer; syncBuiltinESMExports(); }
  control.pause();
  t.after(() => control.resume());
  const result = await owned.stopAndDrain({ timeoutMs: 0 });
  assert.equal(result.gone, false);
  assert.match(result.diagnostic, /acknowledgement timed out/);
  assert.equal(alive(owned.rootPid), false, 'Termination happened while proof delivery was delayed');
  control.resume();
  await wait(100);
  await assert.rejects(owned.closeAfterRelease(), /requires.*proof/);
  assert.equal((await owned.stopAndDrain()).gone, true, 'A fresh matching accounting response is required');
});

test('Windows owned tree owner exit produces control EOF and best-effort drain', windows, async (t) => {
  const directory = await fixtureDirectory(t);
  const pidFile = join(directory, 'grandchild.pid');
  const source = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();`;
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawnWindowsOwnedTree } from ${JSON.stringify(new URL('../windows-owned-tree.mjs', import.meta.url).href)};
    const owned = await spawnWindowsOwnedTree({ command: process.execPath, args: ['-e', ${JSON.stringify(`${barrier}\nfunction run() { ${source} }`)}], cwd: process.cwd(), env: process.env });
    owned.stdout.resume(); owned.stderr.resume();
    await owned.authorizeStartup(${JSON.stringify(token)});
    await owned.completion;
    process.stdout.write(JSON.stringify({ rootPid: owned.rootPid, guardianPid: owned.guardianPid, evidenceDirectory: owned.evidenceDirectory }), () => process.exit(0));
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  launcher.stdout.on('data', (chunk) => { stdout += chunk; }); launcher.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(launcher, 'exit'); assert.equal(code, 0, stderr);
  const metadata = JSON.parse(stdout);
  const pid = Number(await until(() => exists(pidFile)));
  await until(() => !alive(pid) && !alive(metadata.rootPid) && !alive(metadata.guardianPid));
  // Caller death supplied no accounting proof; script/evidence must remain.
  assert.ok(await exists(join(metadata.evidenceDirectory, 'guardian.ps1')));
  await rm(metadata.evidenceDirectory, { recursive: true, force: true });
});

test('Windows owned tree filters a >64KiB ambient environment but passes intended child values', windows, async (t) => {
  const extra = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`PIE_OWNED_TREE_LARGE_${i}`, 'x'.repeat(12_000)]));
  const previous = Object.fromEntries(Object.keys(extra).map((key) => [key, process.env[key]]));
  Object.assign(process.env, extra);
  let owned;
  try {
    owned = await tree(t, `for (let i = 0; i < 6; i++) if (process.env['PIE_OWNED_TREE_LARGE_' + i]?.length !== 12000) process.exit(23);`, { env: { ...process.env, ...extra } });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  await owned.authorizeStartup(token);
  assert.equal((await owned.completion).code, 0);
  assert.equal((await owned.stopAndDrain()).gone, true);
});

test('Windows owned tree startup timeout/abort retains evidence and tears down guardian', windows, async () => {
  for (const createOptions of [() => ({ startupTimeoutMs: 0 }), () => ({ signal: AbortSignal.timeout(10) })]) {
    let error;
    try { await spawnWindowsOwnedTree({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, ...createOptions() }); } catch (caught) { error = caught; }
    assert.ok(error?.evidenceDirectory, String(error));
    const diagnostic = JSON.parse(await readFile(join(error.evidenceDirectory, 'diagnostic.json'), 'utf8'));
    assert.equal(alive(diagnostic.guardianPid), false);
    if (diagnostic.rootPid) assert.equal(alive(diagnostic.rootPid), false);
    await rm(error.evidenceDirectory, { recursive: true, force: true });
  }
});

test('Windows owned tree failed executable creation is not proof and leaves no guardian', windows, async () => {
  let error;
  try { await spawnWindowsOwnedTree({ command: 'C:\\pie-fixture-does-not-exist.exe', args: [], cwd: process.cwd(), env: process.env }); } catch (caught) { error = caught; }
  assert.ok(error?.evidenceDirectory);
  const diagnostic = JSON.parse(await readFile(join(error.evidenceDirectory, 'diagnostic.json'), 'utf8'));
  assert.equal(alive(diagnostic.guardianPid), false);
  assert.match(diagnostic.diagnostic, /CreateProcess/);
  await rm(error.evidenceDirectory, { recursive: true, force: true });
});
