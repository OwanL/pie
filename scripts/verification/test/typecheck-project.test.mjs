import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';
import { resolveTypeScriptCompiler } from '../../lib/package-resolution.mjs';
import {
  buildTypecheckArgs,
  createTypecheckCacheKey,
  parseArgs,
  runOwnedTypecheck,
  runTypecheckLocal,
  runTypecheck,
} from '../typecheck-project.mjs';
import { runTrustedNativeLease } from '../native-test-keeper.mjs';

const compilerApi = {
  parseConfigFileTextToJson(_filename, text) {
    return { config: JSON.parse(text) };
  },
};

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function makeNativeSdkWorkspace(root) {
  const sdkPath = path.join(root, 'harness', 'pi', 'packages', 'coding-agent');
  const packageNames = [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    'typebox',
  ];
  for (const [index, name] of packageNames.entries()) {
    const packageRoot = index === 0 ? sdkPath : path.join(sdkPath, 'node_modules', ...name.split('/'));
    write(path.join(packageRoot, 'package.json'), JSON.stringify({
      name,
      type: 'module',
      exports: { '.': { types: './index.d.ts', import: './index.mjs' } },
    }));
    write(path.join(packageRoot, 'index.mjs'), 'export const sdkValue = 1;\n');
    write(path.join(packageRoot, 'index.d.ts'), 'export declare const sdkValue: number;\n');
  }
  return sdkPath;
}

function makeHeldCompilerChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('typecheck CLI accepts one config and an explicit optional SDK path', () => {
  assert.deepEqual(parseArgs(['application/tsconfig.json']), {
    config: 'application/tsconfig.json',
    help: false,
  });
  assert.deepEqual(parseArgs(['tsconfig.json', '--sdk-path=runtime/pi-coding-agent']), {
    config: 'tsconfig.json',
    sdkPath: 'runtime/pi-coding-agent',
    help: false,
  });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs([]), /project config/);
  assert.throws(() => parseArgs(['a.json', 'b.json']), /Only one/);
  assert.throws(() => parseArgs(['a.json', '--sdk-path']), /requires an SDK/);
});

test('typecheck always performs no-emit incremental checks with stable build-info location', () => {
  const args = buildTypecheckArgs('/repo/.cache/typecheck/hash/tsconfig.overlay.json', '/repo/.cache/typecheck/hash/project.tsbuildinfo');
  assert.deepEqual(args, [
    '--noEmit', '--incremental', '--project', '/repo/.cache/typecheck/hash/tsconfig.overlay.json',
    '--tsBuildInfoFile', '/repo/.cache/typecheck/hash/project.tsbuildinfo',
  ]);
  assert.equal(args.includes('--build'), false);
  assert.equal(args.includes('--skipLibCheck'), false);
});

test('incremental compiler state is reused without skipping checks', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'tsconfig.json');
  const sourcePath = path.join(root, 'src.ts');
  write(configPath, JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', types: [] },
    files: ['./src.ts'],
  }));
  write(sourcePath, 'const answer: number = 42;\n');
  const compilerPath = resolveTypeScriptCompiler();
  const first = await runTypecheck({ configPath, compilerPath, root });
  assert.equal(first.code, 0, first.output);
  assert.equal(first.cacheDirectory.startsWith(path.join(root, '.cache', 'typecheck')), true);
  assert.equal(existsSync(path.join(first.cacheDirectory, 'tsconfig.overlay.json')), true);
  assert.equal(existsSync(path.join(first.cacheDirectory, 'project.tsbuildinfo')), true);

  write(sourcePath, "const answer: number = 'wrong';\n");
  const second = await runTypecheck({ configPath, compilerPath, root });
  assert.notEqual(second.code, 0, 'source errors are rechecked with existing .tsbuildinfo');
  assert.match(second.output, /string.*not assignable.*number/u);
});

test('typecheck cache key follows base configs, SDK runtime lock, compiler, and toolchain inputs', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'tsconfig.json');
  const extendedConfig = path.join(root, 'base.json');
  const compilerPath = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const sdkPath = path.join(root, 'runtime', 'pi-runtime', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const runtimeRoot = path.resolve(sdkPath, '../../..');
  write(configPath, JSON.stringify({ extends: './base.json' }));
  write(extendedConfig, JSON.stringify({ compilerOptions: { strict: true } }));
  write(compilerPath, '/* compiler entry */');
  write(path.join(root, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3' }));
  write(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  write(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  write(path.join(sdkPath, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1' }));
  write(path.join(runtimeRoot, 'manifest.json'), JSON.stringify({ runtime: 'fixture' }));
  write(path.join(runtimeRoot, 'pnpm-lock.yaml'), 'sdk-lock: first\n');
  const options = { configPath, compilerPath, sdkPath, root, compiler: compilerApi };
  const original = createTypecheckCacheKey(options);
  assert.equal(original, createTypecheckCacheKey(options));
  assert.notEqual(original, createTypecheckCacheKey({ ...options, sdkPath: undefined }), 'SDK selection participates in cache key');

  write(extendedConfig, JSON.stringify({ compilerOptions: { strict: false } }));
  assert.notEqual(original, createTypecheckCacheKey(options), 'extended base config content participates');
  write(extendedConfig, JSON.stringify({ compilerOptions: { strict: true } }));
  write(path.join(runtimeRoot, 'pnpm-lock.yaml'), 'sdk-lock: second\n');
  assert.notEqual(original, createTypecheckCacheKey(options), 'selected runtime lock participates');
  write(path.join(runtimeRoot, 'pnpm-lock.yaml'), 'sdk-lock: first\n');
  write(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.0.0' }));
  assert.notEqual(original, createTypecheckCacheKey(options), 'toolchain manifest participates');
  write(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  write(compilerPath, '/* compiler entry changed */');
  assert.notEqual(original, createTypecheckCacheKey(options), 'compiler executable content participates');
});

test('native-workspace typecheck holds its reader through watchdog-confirmed child close', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-sdk-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdkPath = makeNativeSdkWorkspace(root);
  const workspaceRoot = path.join(root, 'harness', 'pi');
  const configPath = path.join(root, 'tsconfig.json');
  write(configPath, JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', types: [] },
    files: ['./src.ts'],
  }));
  write(path.join(root, 'src.ts'), "import { sdkValue } from '@earendil-works/pi-coding-agent';\nconst answer: number = sdkValue;\n");

  let childReady;
  const ready = new Promise((resolve) => { childReady = resolve; });
  const child = makeHeldCompilerChild();
  const running = runTypecheckLocal({
    configPath,
    sdkPath,
    root,
    compilerPath: resolveTypeScriptCompiler(),
    spawnImpl: () => {
      setImmediate(() => childReady(child));
      return child;
    },
    watchChildProcessImpl: () => ({
      timedOut: false,
      aborted: false,
      settle: async () => ({ gone: true, survivors: [] }),
    }),
  });

  await ready;
  const readersDirectory = path.join(workspaceRoot, '.cache', 'development-runtime', 'readers');
  assert.equal(readdirSync(readersDirectory).length, 1, 'reader is acquired before the compiler child can read aliases');
  await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => {
    assert.fail('Pi workspace writer must not run while tsc is held');
  }), /writer denied[\s\S]*reader/u);

  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0);
  const result = await running;
  assert.equal(result.teardownConfirmed, true);
  assert.equal(readdirSync(readersDirectory).length, 0, 'reader releases only after the watchdog settles gone');
  await withDevelopmentWriter(workspaceRoot, async () => {});
});

test('native-workspace typecheck retains reader evidence when watchdog teardown is unconfirmed', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-sdk-uncertain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdkPath = makeNativeSdkWorkspace(root);
  const workspaceRoot = path.join(root, 'harness', 'pi');
  const configPath = path.join(root, 'tsconfig.json');
  write(configPath, JSON.stringify({ compilerOptions: { strict: true, types: [] }, files: ['./src.ts'] }));
  write(path.join(root, 'src.ts'), 'export {};\n');

  let childReady;
  const ready = new Promise((resolve) => { childReady = resolve; });
  const child = makeHeldCompilerChild();
  const running = runTypecheckLocal({
    configPath,
    sdkPath,
    root,
    compilerPath: resolveTypeScriptCompiler(),
    spawnImpl: () => {
      setImmediate(() => childReady(child));
      return child;
    },
    watchChildProcessImpl: () => ({
      timedOut: false,
      aborted: false,
      settle: async () => ({ gone: false, survivors: [12345] }),
    }),
  });

  await ready;
  const readersDirectory = path.join(workspaceRoot, '.cache', 'development-runtime', 'readers');
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0);
  await assert.rejects(running, (error) => error.teardownUnconfirmed === true);
  assert.equal(readdirSync(readersDirectory).length, 1, 'unknown process-tree teardown keeps durable writer-blocking evidence');
  await assert.rejects(withDevelopmentWriter(workspaceRoot, async () => {}), /writer denied[\s\S]*reader/u);
});

test('owned typecheck entry authorizes without the token, collects output, and returns compiler state', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-owned-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'tsconfig.json');
  write(configPath, JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', types: [] },
    files: ['./src.ts'],
  }));
  write(path.join(root, 'src.ts'), 'export const answer: number = 42;\n');
  const events = [];
  let authorizeText;
  const result = await runOwnedTypecheck({ configPath }, {}, {
    async spawnTree(options) {
      assert.equal(options.env.NODE_TEST_CONTEXT, undefined, 'Node test context is stripped from the compiler environment');
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return {
        invocationId: 'invocation', rootPid: 123,
        stdout, stderr,
        completion: Promise.resolve({ code: 0 }),
        async authorizeStartup(text) {
          authorizeText = text;
          events.push('authorize');
          stdout.end('fixture compiler output\n');
        },
        async stopAndDrain() { events.push('drain'); return {
          gone: true, activeProcesses: 0, invocationId: 'invocation', rootPid: 123,
          admissionSealed: true, authority: 'open-windows-job-accounting',
        }; },
        async closeAfterRelease() {
          events.push('close');
          // Match the primitive: release close resolves after the guardian
          // exits, so both output streams have reached EOF.
          stdout.end();
          stderr.end();
        },
      };
    },
    async releaseReader(proof) {
      assert.deepEqual(proof, { teardownConfirmed: true });
      events.push('release');
    },
  });
  assert.deepEqual(events, ['authorize', 'drain', 'release', 'close']);
  assert.equal(authorizeText, '', 'ordinary tsc authorizes with an exact empty stdin close');
  assert.equal(result.code, 0);
  assert.equal(result.teardownConfirmed, true);
  assert.equal(result.output, 'fixture compiler output\n');
  assert.ok(existsSync(path.join(result.cacheDirectory, 'tsconfig.overlay.json')), 'incremental compiler state directory is returned');
});

test('owned typecheck entry releases safely when validation fails after acquisition', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-owned-bad-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(runOwnedTypecheck({ configPath: path.join(root, 'missing.json') }, {}, {}), /config not found/);
});

// Windows keeper route: the real production `runTypecheck` entry runs the
// compiler child inside the detached keeper's kernel owned driver. The writer
// gate stays denied only while the reader is held, so fixtures hold their
// children open while the assertions run; never census/WMI evidence.

const windowsRoute = { skip: process.platform !== 'win32', timeout: 120_000 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(20); }
  throw new Error('Fixture condition timed out');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function rmTree(target) {
  return async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { rmSync(target, { recursive: true, force: true }); return; } catch { await wait(50); }
    }
    rmSync(target, { recursive: true, force: true });
  };
}

async function denied(root) {
  await assert.rejects(withDevelopmentWriter(root, async () => assert.fail('writer ran')), /writer denied/);
}
async function admitted(root) { await withDevelopmentWriter(root, async () => {}); }

/** Task-owned cleanup after an unknown-retention assertion: also removes the
 * synthetic reader record file itself, since the dead keeper can never release. */
function removeUnknownReaderRecord(ws, record) {
  const readersDirectory = path.join(ws.workspaceRoot, '.cache', 'development-runtime', 'readers');
  if (!existsSync(readersDirectory)) return;
  for (const name of readdirSync(readersDirectory)) {
    const file = path.join(readersDirectory, name);
    let contents;
    try { contents = readFileSync(file, 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = JSON.parse(contents); } catch { continue; }
    if (parsed?.id === record?.id || parsed?.invocation === record?.invocation) rmSync(file, { force: true });
  }
}

function removeTypecheckEvidence(record) {
  const directory = record?.metadata?.evidence;
  if (!directory) return;
  for (const name of ['lifetime.json', 'owned-tree.json']) {
    const file = path.join(directory, name);
    if (!existsSync(file)) continue;
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    const candidate = evidence.evidenceDirectory; // the owned tree's primitive temp tree
    if (candidate && /^pie-windows-owned-tree-/u.test(path.basename(candidate))) {
      rmSync(candidate, { recursive: true, force: true });
    }
    break;
  }
  rmSync(directory, { recursive: true, force: true });
}

/** Real-route synthetic workspace: SDK stub graph + config + a plain Node
 * "compiler" fixture standing in for tsc. Fixture markers prove the contained
 * child actually executed; the owned driver receives the fixture compiler
 * through the unchanged public `runTypecheck` surface. */
function keeperTypecheckWorkspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-keeper-'));
  t.after(rmTree(root));
  const sdkPath = makeNativeSdkWorkspace(root);
  const configPath = path.join(root, 'tsconfig.json');
  write(configPath, JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', types: [] },
    files: ['./src.ts'],
  }));
  write(path.join(root, 'src.ts'), "import { sdkValue } from '@earendil-works/pi-coding-agent';\nconst answer: number = sdkValue;\n");
  const workspaceRoot = realpathSync.native(path.join(root, 'harness', 'pi'));
  const readerDirectory = path.join(workspaceRoot, '.cache', 'development-runtime', 'readers');
  const records = () => existsSync(readerDirectory)
    ? readdirSync(readerDirectory).map((name) => JSON.parse(readFileSync(path.join(readerDirectory, name), 'utf8')))
    : [];
  return { root, sdkPath, configPath, workspaceRoot, records };
}

function writeFixtureCompiler(root, markerPath, {
  mode = 'complete', releasePath, exitPath, pidPath, grandchildPath, exitCode = 0,
} = {}) {
  const compilerPath = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  mkdirSync(path.dirname(compilerPath), { recursive: true });
  const source = [
    "const { spawn } = require('node:child_process');",
    "const { existsSync, writeFileSync } = require('node:fs');",
    'process.stdout.write(' + JSON.stringify('fixture compiler output\n') + ');',
    'writeFileSync(' + JSON.stringify(markerPath) + ", 'ran');",
    ...(pidPath ? ['writeFileSync(' + JSON.stringify(pidPath) + ', String(process.pid));'] : []),
    ...(grandchildPath ? [
      'try {',
      "  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { detached: true, stdio: 'ignore' });",
      '  grandchild.unref();',
      '  writeFileSync(' + JSON.stringify(grandchildPath) + ', String(grandchild.pid));',
      "} catch (error) {",
      "  writeFileSync(" + JSON.stringify(grandchildPath) + ", 'spawn-error: ' + error.message);",
      '}',
    ] : []),
    ...(mode === 'hold'
      // Held compilers run until their release file appears or the Job kills
      // them; complete compilers exit with the fixture code immediately.
      ? ['const releaseFile = ' + JSON.stringify(releasePath) + ';',
         'const exitFile = ' + JSON.stringify(exitPath) + ';',
         '(function waitToDie() {',
         '  if (existsSync(releaseFile)) { process.exit(existsSync(exitFile) ? 7 : ' + JSON.stringify(exitCode) + '); }',
         '  setTimeout(waitToDie, 20);',
         '})();']
      : ['process.exit(' + JSON.stringify(exitCode) + ');']),
  ].join('\n');
  writeFileSync(compilerPath, source, 'utf8');
  return compilerPath;
}

function typecheckLauncher(t, ws, { fixtureMarker, pidPath, grandchildPath, releasePath, exitPath }) {
  const launcherSource = [
    'import { runTypecheck } from ' + JSON.stringify(new URL('../typecheck-project.mjs', import.meta.url).href) + ';',
    'try {',
    '  const result = await runTypecheck({ configPath: ' + JSON.stringify(ws.configPath)
      + ', sdkPath: ' + JSON.stringify(ws.sdkPath)
      + ', root: ' + JSON.stringify(ws.root)
      + ', compilerPath: ' + JSON.stringify(writeFixtureCompiler(ws.root, fixtureMarker, {
      pidPath, grandchildPath, mode: 'hold', releasePath, exitPath,
    })) + ' });',
    "  console.log('RESULT', JSON.stringify(result));",
    '} catch (error) {',
    "  console.error('ERROR', error.message, error.diagnosticPath);",
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  const launcherFile = path.join(ws.root, 'launcher.mjs');
  writeFileSync(launcherFile, launcherSource);
  const launcher = spawn(process.execPath, [launcherFile], {
    cwd: ws.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  launcher.stdout.on('data', (chunk) => { output += chunk; });
  launcher.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(launcher, 'exit');
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
    await exited;
    for (const record of ws.records()) removeTypecheckEvidence(record);
    for (const file of [pidPath, grandchildPath].filter(Boolean)) {
      if (existsSync(file) && alive(Number(readFileSync(file, 'utf8')))) process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
    }
  });
  return { launcher, exited, output: () => output };
}

test('Windows typecheck route runs its fixture compiler through the keeper gate and releases at matching proof', windowsRoute, async (t) => {
  const ws = keeperTypecheckWorkspace(t);
  const marker = path.join(ws.root, 'compiler-ran');
  const compilerPath = writeFixtureCompiler(ws.root, marker, { mode: 'hold', releasePath: path.join(ws.root, 'release') });
  const running = runTypecheck({
    configPath: ws.configPath,
    sdkPath: ws.sdkPath,
    root: ws.root,
    compilerPath,
  });
  await until(() => ws.records().length === 1);
  const midrun = ws.records()[0];
  assert.notEqual(midrun.pid, process.pid, 'the keeper, not the launcher, acquired the reader');
  await denied(ws.workspaceRoot);
  // Release the held compiler; the reader stays held through child completion
  // and the kernel drain, then releases at the verified proof only.
  writeFileSync(path.join(ws.root, 'release'), 'go');
  const result = await running;
  assert.equal(result.code, 0, result.output);
  assert.equal(result.teardownConfirmed, true);
  assert.match(result.output, /fixture compiler output/u);
  assert.ok(existsSync(path.join(result.cacheDirectory, 'tsconfig.overlay.json')), 'incremental compiler state directory is returned');
  assert.equal(ws.records().length, 0, 'matching empty-tree proof releases the reader');
  await admitted(ws.workspaceRoot);
});

test('Windows typecheck cancellation mid-run drains without authorizing the fixture again and still proves release', windowsRoute, async (t) => {
  const ws = keeperTypecheckWorkspace(t);
  const marker = path.join(ws.root, 'compiler-ran');
  const pidPath = path.join(ws.root, 'compiler.pid');
  const grandchildPath = path.join(ws.root, 'grandchild.pid');
  const compilerPath = writeFixtureCompiler(ws.root, marker, { pidPath, grandchildPath, mode: 'hold' });
  const controller = new AbortController();
  const running = runTypecheck({
    configPath: ws.configPath,
    sdkPath: ws.sdkPath,
    root: ws.root,
    compilerPath,
    signal: controller.signal,
  });
  await until(() => existsSync(pidPath));
  const pid = Number(readFileSync(pidPath, 'utf8'));
  await until(() => existsSync(grandchildPath));
  const grandchild = Number(readFileSync(grandchildPath, 'utf8'));
  assert.equal(alive(pid), true);
  assert.equal(alive(grandchild), true);
  controller.abort(new Error('fixture cancellation'));
  const result = await running;
  assert.equal(result.code, 1);
  assert.equal(result.teardownConfirmed, true);
  assert.match(result.output, /Typecheck process was aborted[^\n]*terminating its process tree\./u);
  await until(() => !alive(pid) && !alive(grandchild));
  assert.equal(ws.records().length, 0, 'verified kernel drain releases the reader');
  await admitted(ws.workspaceRoot);
});

test('Windows typecheck launcher hard death during execution drains the compiler tree and releases', windowsRoute, async (t) => {
  const ws = keeperTypecheckWorkspace(t);
  const pidPath = path.join(ws.root, 'compiler.pid');
  const grandchildPath = path.join(ws.root, 'grandchild.pid');
  const run = typecheckLauncher(t, ws, {
    fixtureMarker: path.join(ws.root, 'compiler-ran'),
    pidPath, grandchildPath,
    releasePath: path.join(ws.root, 'release'), exitPath: path.join(ws.root, 'exit'),
  });
  await until(() => ws.records().length === 1);
  await until(() => existsSync(pidPath));
  const pid = Number(readFileSync(pidPath, 'utf8'));
  await until(() => existsSync(grandchildPath));
  const grandchild = Number(readFileSync(grandchildPath, 'utf8'));
  assert.equal(alive(pid), true);
  assert.equal(alive(grandchild), true);
  run.launcher.kill('SIGKILL');
  await run.exited;
  await until(() => ws.records().length === 0 && !alive(pid) && !alive(grandchild));
  await admitted(ws.workspaceRoot);
});

test('Windows typecheck keeper loss retains the reader on the common unknown path', windowsRoute, async (t) => {
  const ws = keeperTypecheckWorkspace(t);
  const pidPath = path.join(ws.root, 'compiler.pid');
  const run = typecheckLauncher(t, ws, {
    fixtureMarker: path.join(ws.root, 'compiler-ran'),
    pidPath,
    releasePath: path.join(ws.root, 'release'), exitPath: path.join(ws.root, 'exit'),
  });
  await until(() => ws.records().length === 1);
  const record = ws.records()[0];
  await until(() => existsSync(pidPath));
  const pid = Number(readFileSync(pidPath, 'utf8'));
  assert.equal(alive(pid), true);
  process.kill(record.pid, 'SIGKILL');
  await run.exited;
  await until(() => !alive(pid));
  assert.equal(ws.records().length, 1, 'common unknown retention keeps the durable record');
  assert.ok(existsSync(record.metadata.evidence), 'evidence directory retained');
  await denied(ws.workspaceRoot);
  removeUnknownReaderRecord(ws, ws.records()[0]);
  removeTypecheckEvidence(ws.records()[0]);
});

test('Windows typecheck route succeeds with synchronous WMI/census execution unavailable', windowsRoute, async (t) => {
  const ws = keeperTypecheckWorkspace(t);
  const marker = path.join(ws.root, 'compiler-ran');
  const compilerPath = writeFixtureCompiler(ws.root, marker);
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = () => { throw new Error('WMI/process census unavailable'); };
  syncBuiltinESMExports();
  try {
    const result = await runTrustedNativeLease('typecheck', { configPath: ws.configPath }, {
      repoRoot: ws.root, sdkPath: ws.sdkPath, compilerPath,
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(result.teardownConfirmed, true);
    assert.match(result.output, /fixture compiler output/u);
    assert.equal(readFileSync(marker, 'utf8'), 'ran', 'actual fixture compiler body executed');
    assert.equal(existsSync(path.join(result.cacheDirectory, 'tsconfig.overlay.json')), true);
    assert.equal(ws.records().length, 0);
    await admitted(ws.workspaceRoot);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
});