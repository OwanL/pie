import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildSource = path.join(checkout, 'scripts/build/build.mjs');
const runtimeContextSource = path.join(checkout, 'scripts/lib/pi-runtime-context.mjs');

function write(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function makeFixture(t, { webviewFails = true, uncertainClose = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pie-build-lifecycle-'));
  t.after(() => {
    // Cancellation/acquisition failures intentionally retain owned scratch in
    // production. Remove only private invocation directories recorded here.
    if (existsSync(trace)) {
      const records = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      for (const record of records.filter(item => item.event === 'acquire-start' && item.output)) {
        const owned = path.dirname(record.output);
        assert.equal(path.dirname(owned), os.tmpdir());
        assert.ok(path.basename(owned).startsWith('pie-pi-runtime-invocation-'));
        rmSync(owned, { recursive: true, force: true });
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const repo = path.join(directory, 'repository');
  const owner = path.join(repo, 'application/hosts/vscode');
  const trace = path.join(directory, 'trace.jsonl');
  const fingerprintFile = path.join(directory, 'pi-source.txt');
  const controls = path.join(directory, 'controls');
  const installed = path.join(directory, 'installed-extension');
  mkdirSync(controls);
  mkdirSync(installed);
  write(repo, 'package.json', '{"type":"module"}\n');
  write(owner, 'package.json', '{"name":"fixture","publisher":"fixture","version":"1.0.0"}\n');
  write(owner, 'tsconfig.json', '{"compilerOptions":{}}\n');
  writeFileSync(fingerprintFile, 'source-v1\n');
  let build = readFileSync(buildSource, 'utf8').replace(
    "import { watch as fsWatch, mkdirSync } from 'node:fs';",
    "import { mkdirSync } from 'node:fs';\nimport { watch as fsWatch } from './fixture-watch.mjs';",
  );
  build = build.replace(
    "import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';",
    "import { appendFile, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';",
  ).replace(
    'Promise.all(children.map(({ completion }) => completion)),',
    "Promise.all(children.map(({ completion }) => completion)).then(async () => { if (process.env.PIE_BUILD_TEST_TRACE) await appendFile(process.env.PIE_BUILD_TEST_TRACE, JSON.stringify({ event: 'drain-complete', childPids: children.map(({ child }) => child.pid) }) + '\\n'); }),",
  );
  build = build.replace(
    'const startPoll = () => { polling = poll(); };',
    "const startPoll = () => { process.env.PIE_BUILD_TEST_POLL = '1'; polling = poll().finally(async () => { delete process.env.PIE_BUILD_TEST_POLL; await appendFile(process.env.PIE_BUILD_TEST_TRACE, JSON.stringify({ event: 'poll-complete' }) + '\\n'); }); };",
  );
  if (uncertainClose) {
    assert.ok(build.includes('record.closed = true;\n    resolve();'));
    build = build.replace('record.closed = true;\n    resolve();', 'record.closed = true;\n    // Simulate a missing close acknowledgement.');
    build = build.replace("retaining Pi artifact.')), 5000);", "retaining Pi artifact.')), 50);");
  }
  if (process.platform === 'win32') {
    build = build.replace(
      "process.once('SIGTERM', cancel);",
      "process.once('SIGTERM', cancel);\nprocess.on('message', message => { if (message === 'fixture:SIGTERM') { process.emit('SIGTERM'); process.disconnect(); } });",
    );
  }
  write(repo, 'scripts/build/build.mjs', build);
  write(repo, 'scripts/build/fixture-watch.mjs', fakeOutputWatcher());
  write(repo, 'scripts/lib/pi-runtime-context.mjs', readFileSync(runtimeContextSource));
  write(repo, 'scripts/lib/pi-runtime-artifact.mjs', fakeVerifier(trace));
  write(repo, 'scripts/lib/package-resolution.mjs', packageResolver());
  write(repo, 'scripts/build/pi-runtime.mjs', fakeRuntimeModule({ trace, fingerprintFile, controls }));
  write(repo, 'scripts/build/publication.mjs', fakePublicationModule(trace, installed));
  write(repo, 'scripts/build/runtime-publication.mjs', fakeRuntimePublicationModule(trace));
  write(owner, 'node_modules/vite/bin/vite.js', fakeVite(trace, owner, webviewFails));
  write(owner, 'node_modules/typescript/bin/tsc', fakeTsc(trace));
  write(owner, 'node_modules/vite/package.json', '{"name":"vite"}\n');
  write(owner, 'node_modules/typescript/package.json', '{"name":"typescript"}\n');
  return { directory, repo, owner, trace, fingerprintFile, controls, installed, identityFile: path.join(directory, 'identity.txt') };
}

function fakeOutputWatcher() {
  return `
    import { readdirSync, statSync } from 'node:fs';
    import path from 'node:path';
    export function watch(root, _options, listener) {
      const snapshot = () => {
        const rows = [];
        function visit(dir, prefix = '') {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const relative = prefix ? prefix + '/' + entry.name : entry.name;
            const absolute = path.join(dir, entry.name);
            const info = statSync(absolute);
            rows.push(relative + ':' + info.mtimeMs + ':' + info.size);
            if (entry.isDirectory()) visit(absolute, relative);
          }
        }
        visit(root);
        return rows.sort().join('\\n');
      };
      let last = snapshot();
      const timer = setInterval(() => {
        try { const next = snapshot(); if (next !== last) { last = next; listener('change', 'fixture-output'); } }
        catch (error) { listener('error', error); }
      }, 25);
      timer.unref();
      return { on() { return this; }, close() { clearInterval(timer); } };
    }
  `;
}

function packageResolver() {
  return `
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const owner = path.join(repo, 'application/hosts/vscode');
    export function resolvePackageRoots() { return { repositoryRoot: repo, distributionRoot: owner }; }
    export function resolveOwnerModule(name) { if (name !== 'vite/package.json') throw Error(name); return path.join(owner, 'node_modules/vite/package.json'); }
    export function resolveTypeScriptCompiler() { return path.join(owner, 'node_modules/typescript/bin/tsc'); }
    export function createTsconfigOverlay(configPath) { return { configPath, dispose() {} }; }
  `;
}

function fakeVerifier(trace) {
  return `
    import { createHash } from 'node:crypto';
    import { readdir, readFile, stat } from 'node:fs/promises';
    import path from 'node:path';
    const hash = value => createHash('sha256').update(value).digest('hex');
    export async function verifyPiRuntimeArtifact(artifactDir) {
      const root = path.resolve(artifactDir);
      const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
      const files = [];
      async function walk(dir, prefix = '') {
        for (const name of await readdir(dir)) {
          const relative = prefix ? prefix + '/' + name : name;
          const absolute = path.join(dir, name);
          if ((await stat(absolute)).isDirectory()) await walk(absolute, relative);
          else if (relative !== 'manifest.json') files.push([relative, hash(await readFile(absolute))]);
        }
      }
      await walk(root);
      files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      if (JSON.stringify(files) !== JSON.stringify(manifest.files) || hash(JSON.stringify(files)) !== manifest.identity) {
        throw new Error('Invalid fixture runtime: incomplete or changed payload');
      }
      const sdkPath = path.join(root, 'node_modules/@earendil-works/pi-coding-agent');
      if (!files.some(([name]) => name === 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')) {
        throw new Error('Invalid fixture runtime: incomplete SDK');
      }
      return { artifactDir: root, sdkPath, identity: manifest.identity, manifest };
    }
  `;
}

function fakeRuntimeModule({ trace, fingerprintFile, controls }) {
  return `
    import { createHash } from 'node:crypto';
    import { appendFile, mkdir, readFile, writeFile, access, unlink } from 'node:fs/promises';
    import path from 'node:path';
    import { computePiRuntimeInputFingerprint as realFingerprint, PiRuntimeSourceInstabilityError } from ${JSON.stringify(new URL('../pi-runtime.mjs', import.meta.url).href)};
    export { PiRuntimeSourceInstabilityError };
    const trace = ${JSON.stringify(trace)};
    const fingerprintFile = ${JSON.stringify(fingerprintFile)};
    const controls = ${JSON.stringify(controls)};
    const hash = value => createHash('sha256').update(value).digest('hex');
    const events = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
    async function injectSourceRace(stage) {
      for (const kind of ['edit', 'delete', 'permission', 'invalid']) {
        const control = path.join(controls, 'race-' + stage + '-' + kind);
        if (!(await access(control).then(() => true, () => false))) continue;
        await unlink(control);
        const root = path.join(controls, 'source-race');
        const file = path.join(root, 'harness/pi/input.ts');
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'before');
        await appendFile(trace, JSON.stringify({ event: 'source-race', stage, kind }) + '\\n');
        let reads = 0;
        await realFingerprint({ repositoryRoot: root }, {
          inventory: kind === 'invalid' ? 'harness/pi/dist/input.ts\\0' : 'harness/pi/input.ts\\0',
          readSource: async original => {
            reads += 1;
            if (kind === 'permission') throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
            if (kind === 'delete') await unlink(original);
            const bytes = await readFile(original);
            if (kind === 'edit' && reads === 1) await writeFile(original, 'after');
            return bytes;
          },
        });
      }
    }
    let fingerprintReading = false;
    export async function computePiRuntimeInputFingerprint() {
      if (fingerprintReading) throw new Error('Concurrent fingerprint inventory');
      fingerprintReading = true;
      try {
        await injectSourceRace(process.env.PIE_BUILD_TEST_POLL ? 'polling' : 'publication');
        if (await access(path.join(controls, 'hold-fingerprint')).then(() => true, () => false)) {
          await appendFile(trace, JSON.stringify({ event: 'fingerprint-held' }) + '\\n');
          while (!(await access(path.join(controls, 'release-fingerprint')).then(() => true, () => false))) await new Promise(resolve => setTimeout(resolve, 15));
          await appendFile(trace, JSON.stringify({ event: 'fingerprint-released' }) + '\\n');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        return hash(await readFile(fingerprintFile));
      } finally { fingerprintReading = false; }
    }
    export async function buildPiRuntime({ output }) {
      const prior = await events();
      const completed = prior.filter(item => item.event === 'acquire-complete');
      const lastArtifact = completed.at(-1)?.artifactDir;
      let count = 0;
      try { count = Number(await readFile(${JSON.stringify(path.join(path.dirname(trace), 'acquisitions.txt'))}, 'utf8')); } catch {}
      count += 1;
      await writeFile(${JSON.stringify(path.join(path.dirname(trace), 'acquisitions.txt'))}, String(count));
      const starts = prior.filter(item => item.event === 'child-start');
      const closes = new Set(prior.filter(item => item.event === 'child-close').map(item => item.pid));
      const lastDrain = prior.filter(item => item.event === 'drain-complete').at(-1);
      await appendFile(trace, JSON.stringify({ event: 'acquire-start', count, output, priorOpenChildren: starts.filter(item => !closes.has(item.pid)).length, drainedChildPids: lastDrain?.childPids ?? [], previousArtifactExists: lastArtifact ? await access(lastArtifact).then(() => true, () => false) : false }) + '\\n');
      if (await access(path.join(controls, 'hold-' + count)).then(() => true, () => false)) {
        while (!(await access(path.join(controls, 'release-' + count)).then(() => true, () => false))) await new Promise(resolve => setTimeout(resolve, 15));
      }
      await injectSourceRace('acquisition');
      const artifactDir = path.join(output, 'pi-runtime');
      const sdk = path.join(artifactDir, 'node_modules/@earendil-works/pi-coding-agent');
      await mkdir(path.join(sdk, 'dist'), { recursive: true });
      await writeFile(path.join(artifactDir, 'payload.txt'), String(await readFile(fingerprintFile)) + ' acquisition-' + count);
      await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: 'fixture' }));
      await writeFile(path.join(sdk, 'LICENSE'), 'fixture license');
      await writeFile(path.join(sdk, 'dist/index.js'), 'export const fixture = true;');
      const names = ['payload.txt', 'node_modules/@earendil-works/pi-coding-agent/LICENSE', 'node_modules/@earendil-works/pi-coding-agent/dist/index.js', 'node_modules/@earendil-works/pi-coding-agent/package.json'].sort();
      const files = await Promise.all(names.map(async name => [name, hash(await readFile(path.join(artifactDir, name)))]));
      const identity = hash(JSON.stringify(files));
      await writeFile(path.join(artifactDir, 'manifest.json'), JSON.stringify({ identity, files }));
      if (await access(path.join(controls, 'invalid-artifact')).then(() => true, () => false)) {
        await writeFile(path.join(artifactDir, 'payload.txt'), 'corrupted after manifest');
      }
      await appendFile(trace, JSON.stringify({ event: 'acquire-complete', count, artifactDir, identity }) + '\\n');
      return { artifactDir };
    }
  `;
}

function fakeVite(trace, owner, webviewFails) {
  return `
    const fs = require('node:fs');
    const path = require('node:path');
    const trace = ${JSON.stringify(trace)};
    const output = process.env.PIE_BUILD_OUTPUT_DIR || path.join(${JSON.stringify(owner)}, 'out');
    const args = process.argv.slice(2);
    const watch = args.includes('--watch');
    const modeAt = args.indexOf('--mode');
    const nodeMode = modeAt >= 0 && args[modeAt + 1] === 'node';
    const label = nodeMode ? 'vite-node' : 'vite-webview';
    const sdk = process.env.PIE_BUILD_PI_RUNTIME_SDK_PATH;
    const artifactDir = sdk ? path.resolve(sdk, '../../..') : '';
    const event = (name, fields = {}) => fs.appendFileSync(trace, JSON.stringify({ event: name, label, pid: process.pid, artifactDir, artifactExists: !!artifactDir && fs.existsSync(artifactDir), ...fields }) + '\\n');
    function emit() {
      const id = fs.existsSync(${JSON.stringify(path.join(path.dirname(trace), 'identity.txt'))}) ? fs.readFileSync(${JSON.stringify(path.join(path.dirname(trace), 'identity.txt'))}, 'utf8').trim() : '0123456789abcdefabcd';
      fs.mkdirSync(output, { recursive: true });
      if (nodeMode) {
        for (const name of ['extension.js', 'backend.js', 'worker-entry.js', 'analytics-recorder-worker.js', 'analytics-query-worker.js']) fs.writeFileSync(path.join(output, name), 'fixture');
        fs.writeFileSync(path.join(output, 'pie-build-id.txt'), id + '\\n');
      } else {
        const web = path.join(output, 'webview/panel');
        fs.mkdirSync(path.join(web, '.vite'), { recursive: true });
        fs.writeFileSync(path.join(web, '.vite/manifest.json'), '{}');
        fs.writeFileSync(path.join(web, 'pie-build-id.txt'), id + '\\n');
      }
    }
    event('child-start', { watch });
    emit();
    if (watch) {
      process.on('SIGTERM', () => setTimeout(() => { event('child-close', { signal: 'SIGTERM' }); process.exit(0); }, 100));
      setInterval(() => {}, 1000);
    } else {
      const code = ${webviewFails ? '!nodeMode ? 7 : 0' : '0'};
      setTimeout(() => { event('child-close', { code }); process.exit(code); }, nodeMode ? 250 : 30);
    }
  `;
}

function fakeTsc(trace) {
  return `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const watch = args.includes('--watch');
    const event = (name, fields = {}) => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ event: name, label: 'tsc', pid: process.pid, watch, ...fields }) + '\\n');
    event('child-start');
    if (watch) {
      process.on('SIGTERM', () => setTimeout(() => { event('child-close', { signal: 'SIGTERM' }); process.exit(0); }, 100));
      setInterval(() => {}, 1000);
    } else { event('child-close', { code: 0 }); }
  `;
}

function fakePublicationModule(trace, installed) {
  return `
    export async function findCompatibleInstalledExtensionDir() { return ${JSON.stringify(installed)}; }
    export async function publishRendererGeneration({ sourceDir }) {
      const fs = await import('node:fs/promises');
      const path = (await import('node:path')).default;
      const output = path.resolve(sourceDir, '../..');
      const host = (await fs.readFile(path.join(output, 'pie-build-id.txt'), 'utf8')).trim();
      const web = (await fs.readFile(path.join(sourceDir, 'pie-build-id.txt'), 'utf8')).trim();
      if (host !== web) throw new Error('fixture publisher received mismatched identity');
      await fs.appendFile(${JSON.stringify(trace)}, JSON.stringify({ event: 'renderer-publication', hostIdentity: host }) + '\\n');
      return { generation: 'fixture-renderer' };
    }
  `;
}

function fakeRuntimePublicationModule(trace) {
  return `
    import { verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';
    import path from 'node:path';
    import { appendFile } from 'node:fs/promises';
    export async function hasRuntimeBootstrap() { return false; }
    export async function installRuntimeBootstrap() {}
    export async function resolveRuntimeGeneration() { return null; }
    export async function publishRuntimeGeneration({ sourceOutDir }) {
      const artifact = await verifyPiRuntimeArtifact(path.join(sourceOutDir, 'pi-runtime'));
      await appendFile(${JSON.stringify(trace)}, JSON.stringify({ event: 'runtime-publication', identity: artifact.identity, files: artifact.manifest.files.length }) + '\\n');
      return { generation: 'fixture-runtime' };
    }
  `;
}

async function makePinnedArtifact(fixture, artifactDir, payload = 'pinned-source\\n') {
  const sdk = path.join(artifactDir, 'node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(path.join(sdk, 'dist'), { recursive: true });
  writeFileSync(path.join(artifactDir, 'payload.txt'), payload);
  writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: 'fixture' }));
  writeFileSync(path.join(sdk, 'LICENSE'), 'fixture license');
  writeFileSync(path.join(sdk, 'dist/index.js'), 'export const fixture = true;');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const files = await Promise.all([
    'payload.txt', 'node_modules/@earendil-works/pi-coding-agent/LICENSE',
    'node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    'node_modules/@earendil-works/pi-coding-agent/package.json',
  ].sort().map(async name => [name, hash(readFileSync(path.join(artifactDir, name)))]));
  const identity = hash(JSON.stringify(files));
  writeFileSync(path.join(artifactDir, 'manifest.json'), JSON.stringify({ identity, files }));
  return identity;
}

function events(fixture) {
  if (!existsSync(fixture.trace)) return [];
  return readFileSync(fixture.trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function runBuild(fixture) {
  return spawnSync(process.execPath, [path.join(fixture.repo, 'scripts/build/build.mjs'), '--skip-typecheck', '--no-sync'], {
    cwd: fixture.owner, encoding: 'utf8', timeout: 15_000,
  });
}

function startWatch(fixture, args) {
  const child = spawn(process.execPath, [path.join(fixture.repo, 'scripts/build/build.mjs'), ...args], {
    cwd: fixture.owner, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PIE_BUILD_TEST_TRACE: fixture.trace },
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8').on('data', text => { child.stdoutText += text; });
  child.stderr.setEncoding('utf8').on('data', text => { child.stderrText += text; });
  return child;
}

async function waitFor(predicate, child, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label}: build exited ${child.exitCode ?? child.signalCode}; ${child.stdoutText}\n${child.stderrText}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${label}: timed out; ${child.stdoutText}\n${child.stderrText}`);
}

export { events, makeFixture, makePinnedArtifact, startWatch, waitFor };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
test('failed sibling bundle drains the surviving child before private artifact removal', (t) => {
  const fixture = makeFixture(t);
  const result = runBuild(fixture);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const trace = events(fixture);
  const starts = trace.filter(item => item.event === 'child-start' && !item.watch);
  const closes = trace.filter(item => item.event === 'child-close' && !item.watch);
  assert.equal(starts.length, 2);
  assert.deepEqual(closes.map(item => item.label).sort(), ['vite-node', 'vite-webview']);
  assert.ok(closes.every(item => item.artifactExists), 'both bundles close while their selected private artifact still exists');
  const artifactDir = trace.find(item => item.event === 'acquire-complete').artifactDir;
  assert.equal(existsSync(artifactDir), false, 'the artifact is removed only after both children have closed');
});

test('uncertain child-close acknowledgement retains the private artifact', (t) => {
  const fixture = makeFixture(t, { uncertainClose: true });
  const result = runBuild(fixture);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Child teardown uncertain; retaining Pi artifact/u);
  const artifactDir = events(fixture).find(item => item.event === 'acquire-complete').artifactDir;
  assert.equal(existsSync(artifactDir), true, 'callback failure cannot stand in for child completion');
});

test('SIGTERM drains watch children but retains the private Pi artifact', async (t) => {
  const fixture = makeFixture(t);
  const child = startWatch(fixture, ['--watch', '--no-sync']);
  t.after(async () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32' && child.connected) child.send('fixture:SIGTERM');
    else child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  await waitFor(() => events(fixture).filter(item => item.event === 'child-start' && item.watch).length === 3, child, 'watchers start');
  const artifactDir = events(fixture).find(item => item.event === 'acquire-complete').artifactDir;
  assert.equal(existsSync(artifactDir), true);

  if (process.platform === 'win32') child.send('fixture:SIGTERM');
  else child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, child, 'SIGTERM teardown');
  assert.equal(child.exitCode, 0, `${child.stdoutText}\n${child.stderrText}`);
  const closes = events(fixture).filter(item => item.event === 'child-close' && item.watch);
  if (process.platform !== 'win32') {
    assert.equal(closes.length, 3, 'both Vite processes and the TypeScript watcher drained');
    assert.ok(closes.every(item => item.artifactExists), 'each child closed before cleanup could remove its selected artifact');
  }
  assert.equal(existsSync(artifactDir), true, 'withPiRuntime retains an owned artifact after cancellation');
});
}
