import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sourceFixture } from './source-fixture.js';

const { piRoot, packageRoots } = sourceFixture;
const approvedPackages: Readonly<Record<string, string>> = {
  '@earendil-works/pi-ai': packageRoots.ai,
  '@earendil-works/pi-agent-core': packageRoots.agent,
  '@earendil-works/pi-tui': packageRoots.tui,
  '@earendil-works/pi-coding-agent': packageRoots.codingAgent,
};
const isWithin = (file: string, root: string): boolean => file.startsWith(`${root}${path.sep}`);

// Load only the verified private candidate graph in this process. The installed
// prior reader runs separately, without a Pie host or the SDK startup patch.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (isBuiltin(specifier)) return result;

    assert.ok(result.url.startsWith('file:'), `Unexpected non-file runtime dependency: ${specifier} -> ${result.url}`);
    const resolved = realpathSync(fileURLToPath(result.url));
    if (specifier.startsWith('@earendil-works/')) {
      const packageName = Object.keys(approvedPackages).find((name) => (
        specifier === name || specifier.startsWith(`${name}/`)
      ));
      const expectedRoot = packageName ? approvedPackages[packageName] : undefined;
      assert.ok(expectedRoot, `Unapproved private SDK package import: ${specifier}`);
      assert.ok(isWithin(resolved, expectedRoot), `Private SDK package graph escape for ${specifier}: ${resolved}`);
      return result;
    }

    assert.ok(isWithin(resolved, realpathSync(piRoot)), `Private SDK runtime graph escape for ${specifier}: ${resolved}`);
    return result;
  },
});

const optIn = process.env.PIE_TEST_LEGACY_READER === '1';
const expectedLegacyReaderSha256 = 'fec6f884356e2375302f6c17114b398455cfd162cc0ec1b30a6baf06d064b358';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
const legacyPackageRoot = path.join(
  repoRoot,
  'application/hosts/vscode/node_modules/@earendil-works/pi-coding-agent',
);
const legacyManifestPath = path.join(legacyPackageRoot, 'package.json');
const legacyReaderPath = path.join(legacyPackageRoot, 'dist/core/session-manager.js');

function projection(manager: any): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    header: manager.getHeader(),
    activeBranch: manager.getBranch(),
    tree: manager.getTree(),
    context: manager.buildSessionContext(),
  })) as Record<string, unknown>;
}

function readonlyChildProjection(sessionFile: string, sessionDir: string, cwd: string, fixtureRoot: string): Record<string, unknown> {
  const legacySupportFiles = [
    legacyManifestPath,
    legacyReaderPath,
    path.join(legacyPackageRoot, 'dist/config.js'),
    path.join(legacyPackageRoot, 'dist/utils/paths.js'),
    path.join(legacyPackageRoot, 'dist/utils/child-process.js'),
    path.join(legacyPackageRoot, 'dist/core/messages.js'),
  ];
  for (const file of legacySupportFiles) {
    assert.ok(existsSync(file), `Opted-in prior reader support file is unavailable: ${file}`);
  }
  // Node 24 Windows denies existsSync(sessionDir) against the namespaced
  // resource even when that exact child directory is allowlisted. Grant only
  // this disposable fixture root so its session/cwd descendants resolve via a
  // stable ancestor without opening the surrounding TEMP tree or user files.
  const readAllowlist = [...new Set([...legacySupportFiles, fixtureRoot].flatMap((file) => {
    const canonical = realpathSync(file);
    // Windows fs APIs may use namespaced paths while TEMP uses an 8.3 alias.
    return [file, canonical, path.toNamespacedPath(file), path.toNamespacedPath(canonical)];
  }))];
  // The prior module imports these only to create IDs or spawn utilities; v3
  // open/context projection uses neither. Throwing stubs keep the reader proof
  // isolated from unrelated installed dependency graphs and process creation.
  const coreStubUrl = `data:text/javascript,${encodeURIComponent(
    'export function uuidv7() { throw new Error("UUID generation is forbidden in this read-only reader proof"); }',
  )}`;
  const processSpawnStubUrl = `data:text/javascript,${encodeURIComponent(
    'function forbidden() { throw new Error("process spawning is forbidden in this reader proof"); } forbidden.sync = forbidden; export default forbidden;',
  )}`;
  const readerUrl = pathToFileURL(legacyReaderPath).href;
  const childProgram = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import tls from 'node:tls';
    import http from 'node:http';
    import https from 'node:https';
    import dns from 'node:dns';
    import dgram from 'node:dgram';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    if (!process.permission || process.permission.has('fs.write')) {
      throw new Error('Legacy reader subprocess must have Node filesystem permissions enabled and no fs.write grant.');
    }
    if (process.permission.has('child') || process.permission.has('worker')) {
      throw new Error('Legacy reader subprocess must deny child-process and worker launches.');
    }
    const denyNetwork = () => { throw new Error('Network denied in this read-only reader proof.'); };
    net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect =
      http.request = http.get = https.request = https.get = dgram.createSocket = denyNetwork;
    for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
      dns[key] = denyNetwork;
      dns.promises[key] = denyNetwork;
    }
    globalThis.fetch = denyNetwork;
    globalThis.WebSocket = class { constructor() { denyNetwork(); } };
    syncBuiltinESMExports();
    for (const [name, operation] of [
      ['net.connect', () => net.connect(9, 'network-denied.invalid')],
      ['net.createConnection', () => net.createConnection(9, 'network-denied.invalid')],
      ['net.Socket.prototype.connect', () => new net.Socket().connect(9, 'network-denied.invalid')],
      ['tls.connect', () => tls.connect(443, 'network-denied.invalid')],
      ['http.request', () => http.request('http://network-denied.invalid')],
      ['http.get', () => http.get('http://network-denied.invalid')],
      ['https.request', () => https.request('https://network-denied.invalid')],
      ['https.get', () => https.get('https://network-denied.invalid')],
      ['dns.lookup', () => dns.lookup('network-denied.invalid')],
      ['dns.promises.lookup', () => dns.promises.lookup('network-denied.invalid')],
      ['dgram.createSocket', () => dgram.createSocket('udp4')],
      ['fetch', () => fetch('https://network-denied.invalid')],
      ['WebSocket', () => new WebSocket('wss://network-denied.invalid')],
    ]) {
      assert.throws(operation, /Network denied in this read-only reader proof/u, name);
    }
    const coreStub = ${JSON.stringify(coreStubUrl)};
    const processSpawnStub = ${JSON.stringify(processSpawnStubUrl)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@earendil-works/pi-agent-core') return { url: coreStub, shortCircuit: true };
      if (specifier === 'cross-spawn') return { url: processSpawnStub, shortCircuit: true };
      return nextResolve(specifier, context);
    }});
    const { SessionManager } = await import(${JSON.stringify(readerUrl)});
    const manager = SessionManager.open(process.argv[1], process.argv[2]);
    const snapshot = JSON.parse(JSON.stringify({
      header: manager.getHeader(),
      activeBranch: manager.getBranch(),
      tree: manager.getTree(),
      context: manager.buildSessionContext(),
    }));
    process.stdout.write(JSON.stringify(snapshot));
  `;
  const args = [
    '--permission',
    ...readAllowlist.map((file) => `--allow-fs-read=${file}`),
    '--input-type=module',
    '--eval',
    childProgram,
    sessionFile,
    sessionDir,
  ];
  const child = spawnSync(process.execPath, args, {
    cwd: sessionDir,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
      NODE_OPTIONS: '',
      PI_PACKAGE_DIR: legacyPackageRoot,
    },
  });
  assert.equal(child.error, undefined, `Legacy reader subprocess failed to start: ${child.error?.message ?? ''}`);
  assert.equal(child.signal, null, `Legacy reader subprocess was terminated by ${child.signal}`);
  assert.equal(child.status, 0, `Legacy reader subprocess failed: ${child.stderr}`);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

test('opt-in installed prior reader opens a candidate v3 session without changing its bytes', { skip: !optIn }, async (t) => {
  assert.ok(existsSync(legacyManifestPath), `Opted-in prior SDK manifest is unavailable: ${legacyManifestPath}`);
  assert.ok(existsSync(legacyReaderPath), `Opted-in prior session reader is unavailable: ${legacyReaderPath}`);
  const manifest = JSON.parse(readFileSync(legacyManifestPath, 'utf8')) as { name?: string; version?: string };
  assert.equal(manifest.name, '@earendil-works/pi-coding-agent');
  assert.equal(manifest.version, '0.80.6', 'the explicitly selected prior reader must be installed SDK 0.80.6');
  const resolvedReader = realpathSync(legacyReaderPath);
  assert.equal(resolvedReader, legacyReaderPath, 'the reader must be the explicitly selected installed distribution file');
  const readerHash = createHash('sha256').update(readFileSync(resolvedReader)).digest('hex');
  assert.equal(readerHash, expectedLegacyReaderSha256, 'the Pie-patched prior reader must match the recorded file hash');
  t.diagnostic(
    `Prior reader evidence: ${resolvedReader}; manifest version=${manifest.version}; sha256=${readerHash}; ` +
      'Pie-patched installed reader, not claimed pristine upstream; no generation-rollback claim.',
  );

  const { SessionManager } = await import(pathToFileURL(
    path.join(packageRoots.codingAgent, 'dist/core/session-manager.js'),
  ).href);
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-legacy-reader-compatibility-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd');
  const sessionDir = path.join(root, 'sessions');
  mkdirSync(cwd);
  mkdirSync(sessionDir);

  const manager = SessionManager.create(cwd, sessionDir, { id: 'rollback-reader-proof' });
  const originalRequestId = manager.appendMessage({ role: 'user', content: 'original branch request', timestamp: 1 });
  const abandonedReplyId = manager.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'abandoned branch reply' }],
    api: 'fixture-api', provider: 'abandoned-provider', model: 'abandoned-model',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    stopReason: 'stop', timestamp: 2,
  });
  manager.appendCompaction('original branch compaction', originalRequestId, 20);

  const branchSummaryId = manager.branchWithSummary(originalRequestId, 'alternate branch summary', {
    source: 'bounded-legacy-reader-proof',
  });
  manager.appendModelChange('fixture-provider', 'fixture-model');
  manager.appendThinkingLevelChange('high');
  manager.appendMessage({ role: 'user', content: 'alternate branch retained request', timestamp: 3 });
  const activeCompactionId = manager.appendCompaction(
    'latest compaction on the active branch', branchSummaryId, 90,
    { source: 'bounded-legacy-reader-proof', branch: 'active' },
  );

  // Put a later-in-file compaction on the abandoned branch, then resume the
  // alternate branch and append a leaf. The active branch's latest compaction
  // is therefore not selected by simply taking the final compaction row.
  manager.branch(abandonedReplyId);
  const laterAbandonedCompactionId = manager.appendCompaction(
    'later file-order compaction on abandoned branch', originalRequestId, 120,
    { source: 'bounded-legacy-reader-proof', branch: 'abandoned' },
  );
  manager.branch(activeCompactionId);
  manager.appendMessage({ role: 'user', content: 'alternate branch current request', timestamp: 4 });

  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile, 'candidate fixture must be durably written');
  const candidateProjection = projection(manager);
  const activeBranch = manager.getBranch();
  assert.equal(manager.getHeader()?.version, 3);
  assert.ok(activeBranch.some((entry: any) => entry.type === 'branch_summary'));
  assert.ok(activeBranch.some((entry: any) => entry.id === activeCompactionId));
  assert.equal(activeBranch.some((entry: any) => entry.id === laterAbandonedCompactionId), false);
  assert.equal(manager.getEntries().at(-2)?.id, laterAbandonedCompactionId,
    'the abandoned branch contains a later-in-file compaction than the active one');
  const candidateContext = manager.buildSessionContext();
  assert.deepEqual(candidateContext.model, { provider: 'fixture-provider', modelId: 'fixture-model' });
  assert.equal(candidateContext.thinkingLevel, 'high');
  assert.equal(candidateContext.messages[0]?.role, 'compactionSummary');
  assert.equal(candidateContext.messages[0]?.summary, 'latest compaction on the active branch');
  assert.equal(candidateContext.messages.some((message: any) => (
    message.summary === 'later file-order compaction on abandoned branch'
  )), false);

  // Freeze a byte-for-byte image before the legacy process sees the disposable
  // file. Strings and digests are immutable; compare both after the subprocess.
  const frozenBytes = readFileSync(sessionFile, 'utf8');
  const frozenHash = createHash('sha256').update(frozenBytes).digest('hex');
  const priorProjection = readonlyChildProjection(sessionFile, sessionDir, cwd, root);
  assert.deepEqual(priorProjection, candidateProjection,
    'the installed prior reader must preserve candidate header, active branch/tree, and provider context/model/thinking');
  const bytesAfterRead = readFileSync(sessionFile, 'utf8');
  assert.equal(bytesAfterRead, frozenBytes, 'the legacy reader changed candidate-written session bytes');
  assert.equal(createHash('sha256').update(bytesAfterRead).digest('hex'), frozenHash,
    'the immutable candidate fixture digest changed after the read-only subprocess');
});
