import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';
import { main, parseArgs, runOfflineVitest, runOfflineVitestLocal } from '../test-framework-offline.mjs';
import { runTrustedNativeLease } from '../native-test-keeper.mjs';

const PINNED_VITEST = '4.1.9';
const packageNames = {
  ai: '@earendil-works/pi-ai',
  agent: '@earendil-works/pi-agent-core',
  'coding-agent': '@earendil-works/pi-coding-agent',
};

const snapshotNames = [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR',
  'PIE_DATA_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID', 'PI_SDK_PATH', 'PIE_HOST_PROFILE', 'PIE_LIVE_MODEL_ID',
  'NODE_TEST_CONTEXT', 'PI_NO_LOCAL_LLM',
];

const beforeImportSource = `
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
const names = ${JSON.stringify(snapshotNames)};
const snapshot = () => Object.fromEntries(names.map(name => [name, process.env[name]]));
let externalDenied;
try { await fetch('https://external.invalid/'); } catch (error) { externalDenied = error.code; }
const server = createServer((_request, response) => response.end('loopback-ok'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let loopback;
try {
  const address = server.address();
  loopback = await fetch('http://127.0.0.1:' + address.port).then(response => response.text());
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
appendFileSync(process.env.FRAMEWORK_IMPORT_RECORD, JSON.stringify({ phase: 'module-import', env: snapshot(), externalDenied, loopback }) + '\\n');
`;

const fakeVitestSource = `
import './before-import.mjs';
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const names = ${JSON.stringify(snapshotNames)};
const snapshot = () => Object.fromEntries(names.map(name => [name, process.env[name]]));
appendFileSync(process.env.FRAMEWORK_IMPORT_RECORD, JSON.stringify({ phase: 'cli', argv: process.argv.slice(2), env: snapshot() }) + '\\n');
const childCode = String.raw\`const fs = require('node:fs');
const names = ${JSON.stringify(snapshotNames)};
const env = Object.fromEntries(names.map(name => [name, process.env[name]]));
let externalDenied = false;
if (process.env.NODE_OPTIONS?.includes('vscode-development-stub.cjs')) {
  const http = require('node:http');
  try { http.get('http://external.invalid/'); } catch (error) { externalDenied = error.code === 'PIE_FIXTURE_EXTERNAL_NETWORK_DENIED'; }
}
fs.writeFileSync(process.env.FRAMEWORK_DESCENDANT_RECORD, JSON.stringify({ env, externalDenied }));\`;
const descendant = spawnSync(process.execPath, ['-e', childCode], { encoding: 'utf8' });
if (descendant.error || descendant.status !== 0) {
  console.error(descendant.error?.message ?? descendant.stderr);
  process.exitCode = 1;
}
if (process.argv.includes('--fixture-hang')) setInterval(() => {}, 1000);
const failure = process.argv.find(argument => argument.startsWith('--fixture-exit='));
if (failure) process.exitCode = Number(failure.slice('--fixture-exit='.length));
`;

function makeWorkspace(t, packageName = 'ai') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-framework-fixture-'));
  const workspaceRoot = path.join(root, 'harness', 'pi');
  const codingAgentRoot = path.join(workspaceRoot, 'packages', 'coding-agent');
  const packageRoot = path.join(workspaceRoot, 'packages', packageName);
  const vitestRoot = path.join(packageRoot, 'node_modules', 'vitest');
  mkdirSync(path.join(codingAgentRoot, 'dist'), { recursive: true });
  mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  mkdirSync(vitestRoot, { recursive: true });
  writeFileSync(path.join(codingAgentRoot, 'package.json'), JSON.stringify({
    name: packageNames['coding-agent'], main: './dist/index.js', type: 'module',
  }));
  writeFileSync(path.join(codingAgentRoot, 'dist', 'index.js'), 'export {}');
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageNames[packageName], main: './dist/index.js', type: 'module',
    devDependencies: { vitest: PINNED_VITEST },
  }));
  writeFileSync(path.join(packageRoot, 'dist', 'index.js'), 'export {}');
  writeFileSync(path.join(vitestRoot, 'package.json'), JSON.stringify({
    name: 'vitest', version: PINNED_VITEST, type: 'module', bin: { vitest: './vitest.mjs' },
  }));
  writeFileSync(path.join(vitestRoot, 'vitest.mjs'), fakeVitestSource);
  writeFileSync(path.join(vitestRoot, 'before-import.mjs'), beforeImportSource);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspaceRoot, packageRoot };
}

function frameworkEnv(directory) {
  return {
    HOME: path.join(directory, 'real-home'),
    OPENAI_API_KEY: 'must-not-leak',
    AWS_ACCESS_KEY_ID: 'must-not-leak-either',
    PI_SDK_PATH: 'must-not-leak',
    PIE_HOST_PROFILE: 'production',
    PIE_LIVE_MODEL_ID: 'real-live-model',
    NODE_OPTIONS: '--inspect=127.0.0.1:9229',
    NODE_PATH: 'must-not-leak-node-module-path',
    XDG_CACHE_HOME: path.join(directory, 'real-xdg-cache'),
    NODE_TEST_CONTEXT: 'parent-test-context',
    FRAMEWORK_IMPORT_RECORD: path.join(directory, 'import.jsonl'),
    FRAMEWORK_DESCENDANT_RECORD: path.join(directory, 'descendant.json'),
  };
}

function readJsonLines(filePath) {
  return readFileSync(filePath, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line));
}

function readerEntries(workspaceRoot) {
  const directory = path.join(workspaceRoot, '.cache', 'development-runtime', 'readers');
  if (!existsSync(directory)) return [];
  return readdirSync(directory);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

test('the facade selects only Pi ai, agent, or coding-agent and forwards only after --', () => {
  for (const packageName of ['ai', 'agent', 'coding-agent']) {
    assert.deepEqual(parseArgs(['--package', packageName, '--', '--run', 'src/example.test.ts']), {
      packageName,
      vitestArgs: ['--run', 'src/example.test.ts'],
    });
  }
  assert.throws(() => parseArgs(['--package', '../arbitrary', '--']), /Unsupported Pi package/u);
  assert.throws(() => parseArgs(['--package', 'ai', 'src/test.ts']), /Separate Vitest arguments/u);
  assert.deepEqual(parseArgs(['--package', 'ai', '--', '--package', 'agent']), {
    packageName: 'ai',
    vitestArgs: ['--package', 'agent'],
  }, 'arguments after -- are Vitest passthrough, not wrapper selectors');
});

test('private environment and network denial are active before Vitest import and in descendants', async t => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const code = await runOfflineVitest('ai', ['--fixture-flag', 'two words'], {
    root: fixture.root,
    env: sourceEnv,
  });
  assert.equal(code, 0);
  const [importRecord, cliRecord] = readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  assert.equal(importRecord.phase, 'module-import');
  assert.equal(importRecord.externalDenied, 'PIE_FIXTURE_EXTERNAL_NETWORK_DENIED');
  assert.equal(importRecord.loopback, 'loopback-ok', 'loopback must remain permitted');
  assert.deepEqual(cliRecord.argv, ['--run', '--fixture-flag', 'two words']);

  const profileRoot = path.dirname(importRecord.env.HOME);
  for (const name of [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PI_CONFIG_DIR',
    'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR',
    'PIE_DATA_DIR',
  ]) assert.ok(isWithin(profileRoot, importRecord.env[name]), `${name} must be private`);
  for (const name of ['OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'PI_SDK_PATH', 'PIE_HOST_PROFILE', 'PIE_LIVE_MODEL_ID', 'NODE_TEST_CONTEXT', 'NODE_PATH', 'XDG_CACHE_HOME']) {
    assert.equal(importRecord.env[name], undefined, `${name} must be removed before import`);
  }
  assert.match(importRecord.env.NODE_OPTIONS, /vscode-development-stub\.cjs/u);
  assert.equal(cliRecord.env.NODE_OPTIONS, importRecord.env.NODE_OPTIONS);
  assert.equal(importRecord.env.PI_NO_LOCAL_LLM, '1', 'offline invocation disables automatic local-model startup and downloads');

  const descendant = JSON.parse(readFileSync(sourceEnv.FRAMEWORK_DESCENDANT_RECORD, 'utf8'));
  assert.equal(descendant.externalDenied, true, 'the invocation-only preload must reach Node descendants');
  assert.equal(descendant.env.NODE_OPTIONS, importRecord.env.NODE_OPTIONS);
  assert.equal(descendant.env.PI_CODING_AGENT_AUTH_DIR, importRecord.env.PI_CODING_AGENT_AUTH_DIR);
  assert.equal(existsSync(profileRoot), false, 'confirmed completion removes the private profile');
  assert.deepEqual(readerEntries(fixture.workspaceRoot), [], 'confirmed completion releases the workspace reader');
  await withDevelopmentWriter(path.join(fixture.workspaceRoot), async () => {});
});

test('ordinary Vitest failures preserve their code and still clean profile and reader', async t => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const code = await runOfflineVitest('ai', ['--fixture-exit=7'], { root: fixture.root, env: sourceEnv });
  assert.equal(code, 7);
  const records = readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  const profileRoot = path.dirname(records[0].env.HOME);
  assert.equal(existsSync(profileRoot), false);
  assert.deepEqual(readerEntries(fixture.workspaceRoot), []);
});

test('local route normalizes an actual child 125 to an ordinary failure with confirmed cleanup', async t => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const code = await runOfflineVitestLocal('ai', ['--fixture-exit=125'], { root: fixture.root, env: sourceEnv });
  assert.equal(code, 1, 'child 125 is an ordinary failure on the local route; 125 stays reserved for teardown unknown');
  const records = readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  const profileRoot = path.dirname(records[0].env.HOME);
  assert.equal(existsSync(profileRoot), false, 'confirmed completion removes the private profile');
  assert.deepEqual(readerEntries(fixture.workspaceRoot), [], 'confirmed completion releases the workspace reader');
  await withDevelopmentWriter(fixture.workspaceRoot, async () => {});
});

test('unconfirmed descendant teardown returns reserved 125 and retains profile plus reader', async t => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  let childOptions;
  const spawnImpl = (_command, _args, options) => {
    childOptions = options;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  const dependencies = {
    root: fixture.root,
    env: sourceEnv,
    spawnImpl,
    watchChildProcessImpl: () => ({
      timedOut: false,
      aborted: false,
      settle: async () => ({ gone: false, survivors: [4242], diagnostics: ['fixture survivor'] }),
    }),
  };
  const exitCode = await main(['--package', 'ai', '--', '--run'], {
    abortOnProcessSignals: () => ({ signal: undefined, dispose() {} }),
    runOfflineVitest: (packageName, vitestArgs, options) => runOfflineVitestLocal(packageName, vitestArgs, options),
    runOptions: dependencies,
  });
  assert.equal(exitCode, 125);
  const profileRoot = path.dirname(childOptions.env.HOME);
  t.after(() => rmSync(profileRoot, { recursive: true, force: true }));
  assert.equal(existsSync(profileRoot), true);
  assert.equal(readerEntries(fixture.workspaceRoot).length, 1);
  await assert.rejects(withDevelopmentWriter(fixture.workspaceRoot, async () => {}), /writer denied[\s\S]*reader/u);
});

test('cancellation tears down the child under the same reader lifetime and cleans confirmed state', async t => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const controller = new AbortController();
  const running = runOfflineVitest('ai', ['--fixture-hang'], {
    root: fixture.root,
    env: sourceEnv,
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  await waitForFile(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  assert.equal(readerEntries(fixture.workspaceRoot).length, 1, 'reader remains registered throughout the child lifetime');
  controller.abort(new Error('fixture cancellation'));
  assert.equal(await running, 1);
  const records = readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  const profileRoot = path.dirname(records[0].env.HOME);
  assert.equal(existsSync(profileRoot), false);
  assert.deepEqual(readerEntries(fixture.workspaceRoot), []);
  await withDevelopmentWriter(fixture.workspaceRoot, async () => {});
});

// Windows keeper route: the real production `runOfflineVitest` entry runs the
// pinned Vitest CLI inside the detached keeper's kernel owned driver. These
// cases cover the remaining route scenarios; normal completion and mid-run
// cancellation are already covered above by the entry-route tests that take
// the keeper delegation on Windows.

const windowsRoute = { skip: process.platform !== 'win32', timeout: 120_000 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(20); }
  throw new Error('Fixture condition timed out');
}

function denied(workspaceRoot) {
  return assert.rejects(withDevelopmentWriter(workspaceRoot, async () => assert.fail('writer ran')), /writer denied/);
}
function admitted(workspaceRoot) { return withDevelopmentWriter(workspaceRoot, async () => {}); }

function writeLauncher(t, fixture, sourceEnv, vitestArgs) {
  const launcherSource = [
    'import { runOfflineVitest } from ' + JSON.stringify(new URL('../test-framework-offline.mjs', import.meta.url).href) + ';',
    'try {',
    '  const code = await runOfflineVitest(' + JSON.stringify('ai') + ', ' + JSON.stringify(vitestArgs) + ', { root: ' + JSON.stringify(fixture.root) + ', env: ' + JSON.stringify(sourceEnv) + ' });',
    "  console.log('RESULT', String(code));",
    '} catch (error) {',
    "  console.error('ERROR', error.message, error.diagnosticPath);",
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  const launcherFile = path.join(fixture.root, 'launcher.mjs');
  writeFileSync(launcherFile, launcherSource);
  const launcher = spawn(process.execPath, [launcherFile], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  launcher.stdout.on('data', (chunk) => { output += chunk; });
  launcher.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(launcher, 'exit');
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
    await exited;
    for (const record of readerRecordFiles(fixture.workspaceRoot)) rmSync(record.file, { force: true });
    for (const record of readerEntries(fixture.workspaceRoot)) removeOfflineEvidence(record);
  });
  return { launcher, exited, output: () => output };
}

function readerRecordFiles(workspaceRoot) {
  const readersDirectory = path.join(workspaceRoot, '.cache', 'development-runtime', 'readers');
  if (!existsSync(readersDirectory)) return [];
  return readdirSync(readersDirectory).map((name) => ({
    name,
    file: path.join(readersDirectory, name),
    record: JSON.parse(readFileSync(path.join(readersDirectory, name), 'utf8')),
  }));
}

function removeOfflineEvidence(record) {
  if (typeof record !== 'object' || record === null) return;
  const directory = record.metadata?.evidence ?? record.evidence;
  if (!directory) return;
  for (const name of ['lifetime.json', 'owned-tree.json']) {
    const file = path.join(directory, name);
    if (!existsSync(file)) continue;
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    const candidates = [evidence.profileRoot, evidence.evidenceDirectory];
    for (const candidate of candidates) {
      if (candidate && (/^pie-framework-offline-/u.test(path.basename(candidate)) || /^pie-windows-owned-tree-/u.test(path.basename(candidate)))) {
        rmSync(candidate, { recursive: true, force: true });
      }
    }
    break;
  }
  rmSync(directory, { recursive: true, force: true });
}

test('Windows offline launcher hard death during execution drains the Vitest tree and releases', windowsRoute, async (t) => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const run = writeLauncher(t, fixture, sourceEnv, ['--run', '--fixture-hang']);
  await until(() => readerEntries(fixture.workspaceRoot).length === 1);
  const importRecord = waitForFile(sourceEnv.FRAMEWORK_IMPORT_RECORD).then(() => readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD));
  assert.equal((await importRecord)[0].phase, 'module-import', 'fixture executed the import phase');
  run.launcher.kill('SIGKILL');
  await run.exited;
  await until(() => readerEntries(fixture.workspaceRoot).length === 0);
  await admitted(fixture.workspaceRoot);
});

test('Windows offline route succeeds with synchronous WMI/census execution unavailable', windowsRoute, async (t) => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = () => { throw new Error('WMI/process census unavailable'); };
  syncBuiltinESMExports();
  try {
    const result = await runTrustedNativeLease('offline', { packageName: 'ai', vitestArgs: ['--run', 'fixture.test.ts'] }, {
      repoRoot: fixture.root, env: sourceEnv,
    });
    assert.deepEqual(result, { code: 0, teardownConfirmed: true });
    const records = readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD);
    assert.equal(records[0].phase, 'module-import', 'actual fixture executed');
    assert.equal(existsSync(sourceEnv.FRAMEWORK_DESCENDANT_RECORD), true);
    assert.deepEqual(readerEntries(fixture.workspaceRoot), []);
    await admitted(fixture.workspaceRoot);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
});

test('Windows offline owned route normalizes an actual child 125 with confirmed cleanup', windowsRoute, async (t) => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const result = await runTrustedNativeLease('offline', { packageName: 'ai', vitestArgs: ['--run', '--fixture-exit=125'] }, {
    repoRoot: fixture.root, env: sourceEnv,
  });
  assert.deepEqual(result, { code: 1, teardownConfirmed: true }, '125 remains reserved for unconfirmed teardown, not ordinary child failure');
  const records = readJsonLines(sourceEnv.FRAMEWORK_IMPORT_RECORD);
  const profileRoot = path.dirname(records[0].env.HOME);
  assert.equal(existsSync(profileRoot), false, 'confirmed completion removes the private profile');
  assert.deepEqual(readerEntries(fixture.workspaceRoot), [], 'confirmed completion releases the workspace reader');
  await admitted(fixture.workspaceRoot);
});

async function assertContainedOfflineExecution(fixture, importRecordPath, descendantRecordPath) {
  const records = readJsonLines(importRecordPath);
  assert.equal(records[0].phase, 'module-import', 'actual fixture executed the import phase');
  assert.equal(records[1].phase, 'cli', 'actual fixture executed the CLI phase');
  assert.equal(existsSync(descendantRecordPath), true, 'actual fixture executed its descendant');
  const profileRoot = path.dirname(records[0].env.HOME);
  for (const name of [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PI_CONFIG_DIR',
    'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_AUTH_DIR', 'PI_CODING_AGENT_SESSION_DIR',
    'PIE_DATA_DIR',
  ]) assert.ok(isWithin(profileRoot, records[0].env[name]), `${name} must be private`);
  assert.equal(records[0].env.XDG_CACHE_HOME, undefined, 'XDG_CACHE_HOME must be removed case-insensitively on Windows');
  assert.equal(existsSync(profileRoot), false, 'confirmed completion removes the private profile');
  assert.deepEqual(readerEntries(fixture.workspaceRoot), [], 'confirmed completion releases the workspace reader');
  await admitted(fixture.workspaceRoot);
}

test('Windows offline default process environment executes the contained fixture without duplicate keys', windowsRoute, async (t) => {
  const fixture = makeWorkspace(t);
  const importRecordPath = path.join(fixture.root, 'default-import.jsonl');
  const descendantRecordPath = path.join(fixture.root, 'default-descendant.json');
  const names = ['FRAMEWORK_IMPORT_RECORD', 'FRAMEWORK_DESCENDANT_RECORD'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  process.env.FRAMEWORK_IMPORT_RECORD = importRecordPath;
  process.env.FRAMEWORK_DESCENDANT_RECORD = descendantRecordPath;
  const code = await runOfflineVitest('ai', ['--run', 'default.test.ts'], { root: fixture.root });
  assert.equal(code, 0);
  await assertContainedOfflineExecution(fixture, importRecordPath, descendantRecordPath);
});

test('Windows offline mixed-case environment executes the contained fixture without duplicate keys', windowsRoute, async (t) => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  delete sourceEnv.HOME;
  delete sourceEnv.XDG_CACHE_HOME;
  Object.assign(sourceEnv, {
    SYSTEMROOT: process.env.SystemRoot,
    windir: process.env.windir,
    SystemDrive: process.env.SystemDrive,
    comspec: process.env.ComSpec,
    Path: process.env.Path,
    pathext: process.env.PATHEXT,
    Home: path.join(fixture.root, 'real-home'),
    UserProfile: path.join(fixture.root, 'real-userprofile'),
    AppData: path.join(fixture.root, 'real-appdata'),
    LocalAppData: path.join(fixture.root, 'real-localappdata'),
    Temp: path.join(fixture.root, 'real-temp'),
    Tmp: path.join(fixture.root, 'real-tmp'),
    Xdg_Cache_Home: path.join(fixture.root, 'real-xdg-cache'),
  });
  const code = await runOfflineVitest('ai', ['--run', 'mixed-case.test.ts'], { root: fixture.root, env: sourceEnv });
  assert.equal(code, 0);
  await assertContainedOfflineExecution(fixture, sourceEnv.FRAMEWORK_IMPORT_RECORD, sourceEnv.FRAMEWORK_DESCENDANT_RECORD);
});

test('Windows offline keeper loss retains the reader on the common unknown path', windowsRoute, async (t) => {
  const fixture = makeWorkspace(t);
  const sourceEnv = frameworkEnv(fixture.root);
  const run = writeLauncher(t, fixture, sourceEnv, ['--run', '--fixture-hang']);
  await until(() => readerEntries(fixture.workspaceRoot).length === 1);
  const record = readerRecordFiles(fixture.workspaceRoot)[0].record;
  process.kill(record.pid, 'SIGKILL');
  await run.exited;
  assert.deepEqual(await until(async () => readerEntries(fixture.workspaceRoot).length === 1), undefined, 'common unknown retention keeps the durable record');
  assert.ok(existsSync(record.metadata.evidence), 'evidence directory retained');
  await denied(fixture.workspaceRoot);
  // Task-owned cleanup of the synthetic unknown-tenured state.
  const recordFiles = readerRecordFiles(fixture.workspaceRoot);
  for (const { file } of recordFiles) rmSync(file, { force: true });
  removeOfflineEvidence(record);
  await admitted(fixture.workspaceRoot);
});
