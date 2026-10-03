import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { verifyPiRuntimeArtifact, type VerifiedPiRuntimeArtifact } from '../../../lib/pi-runtime/artifact.mjs';
import { resolveGenerationPiRuntime } from '../../../application/hosts/lib/pi-runtime-resolution.ts';
import { deriveTrustedSdkRoot } from '../../../application/backend/agent-connection/trusted-sdk-root.ts';
import { requestPieHostRelease } from '../../../application/hosts/lib/host-coordinator.ts';

const execFileAsync = promisify(execFile);
// The extension source/test roots remain at extension/ for now, but the
// package/toolchain owner (manifest, configs, node_modules, runtime assets)
// moved to application/hosts/vscode in the B2 relocation.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const extensionRoot = path.join(repositoryRoot, 'application', 'hosts', 'vscode');

type StandaloneWebSocket = EventEmitter & { send(data: string): void; close(): void };
const WebSocketClient = createRequire(path.join(extensionRoot, 'package.json'))('ws') as {
  new (url: string, options: { headers: Record<string, string> }): StandaloneWebSocket;
};

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolve the explicitly selected Pi runtime from the focused test wrapper.
 *
 * The wrapper (npm run test:file, run-test-files.mjs / run-tests.mjs) selects
 * one Pi runtime selection — an explicitly reused --pi-runtime artifact or, in
 * its absence, one runner acquisition — and exposes it to this test only as the
 * verified artifact paths embedded in the tsx tsconfig overlay. Reading the
 * selection through that overlay keeps it explicit command transport, never an
 * ambient environment pointer. There is no checkout/global-SDK fallback and no
 * nested acquisition: selection resolution must already have happened in the
 * wrapper.
 */
async function selectVerifiedRuntime(): Promise<VerifiedPiRuntimeArtifact> {
  const tsconfigPath = process.env.TSX_TSCONFIG_PATH;
  if (!tsconfigPath) {
    throw new Error(
      'This test requires an explicitly selected verified Pi runtime through the test wrapper '
      + '(npm run test:file ... --pi-runtime <absolute artifact root>); no wrapper tsconfig overlay was found.',
    );
  }
  const overlay = JSON.parse(await fs.readFile(path.resolve(tsconfigPath), 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const codingAgentTarget = overlay.compilerOptions?.paths?.['@earendil-works/pi-coding-agent']?.[0];
  if (!codingAgentTarget || !path.isAbsolute(codingAgentTarget)) {
    throw new Error('The wrapper tsconfig overlay must carry an absolute @earendil-works/pi-coding-agent alias.');
  }
  // Walk from the alias target to its package root; the overlay resolves into
  // the selection's SDK payload, never a checkout/installed baseline.
  let directory = path.dirname(path.resolve(codingAgentTarget));
  let packageRoot: string | undefined;
  for (let guard = 0; guard < 16 && directory !== path.dirname(directory); guard += 1) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')) as { name?: string };
      if (manifest.name === '@earendil-works/pi-coding-agent') { packageRoot = directory; break; }
    } catch {
      // Keep walking toward the candidate artifact root.
    }
    directory = path.dirname(directory);
  }
  assert.ok(packageRoot, "the wrapper overlay's SDK alias must resolve to the @earendil-works/pi-coding-agent package root");
  const artifactRoot = path.resolve(packageRoot!, '..', '..', '..');
  const verified = await verifyPiRuntimeArtifact(artifactRoot);
  assert.equal(await fs.realpath(packageRoot!), verified.sdkPath,
    "the wrapper overlay SDK alias must resolve inside the verified artifact");
  return verified;
}

function regexEscape(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

const STANDALONE_RELEASE_TIMEOUT_MS = 60_000;
const STANDALONE_EXIT_TIMEOUT_MS = 20_000;
const STANDALONE_RENDERER_READY_TIMEOUT_MS = 10_000;

function waitForStandaloneSocketMessage(
  socket: StandaloneWebSocket,
  description: string,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const finish = (error?: Error, message?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(message!);
    };
    const onMessage = (data: unknown): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data)) as unknown;
      } catch (error) {
        finish(new Error(`Browser WebSocket sent invalid JSON while waiting for ${description}.`, { cause: error }));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const message = parsed as Record<string, unknown>;
      try {
        if (predicate(message)) finish(undefined, message);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error(`Browser WebSocket closed while waiting for ${description}.`));
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
    timer = setTimeout(() => finish(new Error(`Timed out waiting for ${description}.`)), STANDALONE_RENDERER_READY_TIMEOUT_MS);
  });
}

async function allocateIsolatedLoopbackPorts(): Promise<{ coordinatorPort: number; browserPort: number }> {
  const probes = [createServer(), createServer()];
  const listen = (server: ReturnType<typeof createServer>): Promise<number> => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Ephemeral loopback port probe did not return a TCP address.'));
        return;
      }
      resolve(address.port);
    });
  });
  try {
    // Keep the first probe bound while asking the OS for the second port, so
    // the coordinator and browser fixtures are guaranteed to differ.
    const coordinatorPort = await listen(probes[0]);
    const browserPort = await listen(probes[1]);
    assert.notEqual(coordinatorPort, browserPort);
    return { coordinatorPort, browserPort };
  } finally {
    await Promise.all(probes.map((server) => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
    })));
  }
}

async function waitForChildExit(exit: Promise<ChildExit>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureChildStopped(child: ChildProcess, exit: Promise<ChildExit>): Promise<void> {
  // A failed spawn has no owned process to tear down. Otherwise, always wait
  // for the exit event before the owning temporary tree can be removed.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGINT'); } catch { /* Escalate below and wait for confirmed exit. */ }
  if (await waitForChildExit(exit, 20_000)) return;
  try { child.kill('SIGKILL'); } catch { /* Do not remove owned files until exit is confirmed. */ }
  await exit;
}

async function ensureStandaloneStopped(
  child: ChildProcess,
  exit: Promise<ChildExit>,
  coordinatorPort: number | undefined,
): Promise<void> {
  // On Windows, ChildProcess.kill('SIGINT') terminates the process instead of
  // delivering a catchable signal. Use the same supported loopback coordinator
  // handoff as production; force only this owned child if graceful teardown fails.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (coordinatorPort !== undefined) {
    try {
      await requestPieHostRelease(coordinatorPort, STANDALONE_RELEASE_TIMEOUT_MS);
    } catch {
      // A failed coordinator request is followed by a bounded exit wait and,
      // only if needed, termination of this test's own child below.
    }
    if (await waitForChildExit(exit, STANDALONE_EXIT_TIMEOUT_MS)) return;
  }
  try { child.kill('SIGKILL'); } catch { /* Do not remove owned files until exit is confirmed. */ }
  await exit;
}

test('node build and package allowlist declare the stable worker entry artifact', async () => {
  const vite = await fs.readFile(path.join(extensionRoot, 'vite.config.ts'), 'utf8');
  const vscodeIgnore = await fs.readFile(path.join(extensionRoot, '.vscodeignore'), 'utf8');
  assert.match(vite, /(?:['"]backend['"]|backend)\s*:\s*path\.join\(repoDir, ['"]harness['"], ['"]agent-processes['"], ['"]coordinator['"], ['"]index\.ts['"]\)/);
  assert.match(vite, /['"]worker-entry['"]:\s*path\.join\(repoDir, ['"]harness['"], ['"]agent-processes['"], ['"]workers['"], ['"]worker-entry\.ts['"]\)/);
  assert.match(vite, /['"]initial-context-estimate-worker['"]:\s*path\.join\(repoDir, ['"]harness['"], ['"]agent-processes['"], ['"]context-inventory['"], ['"]initial-context-estimate-worker\.ts['"]\)/);
  assert.match(vite, /['"]cold-browse-helper-entry['"]:\s*path\.join\(repoDir, ['"]harness['"], ['"]agent-processes['"], ['"]cold-browse-helper['"], ['"]cold-browse-helper-entry\.ts['"]\)/);
  assert.match(vite, /['"]phase4-worker-command-extension['"]:\s*path\.join\(repoDir, ['"]harness['"], ['"]agent-processes['"], ['"]lib['"], ['"]sdk-integration['"], ['"]test['"], ['"]fixtures['"], ['"]phase4-worker-command-extension\.ts['"]\)/);
  assert.match(vite, /entryFileNames:\s*['"]\[name\]\.js['"]/);
  // ws's optional native deps must stay runtime requires: Vite stubs
  // unresolvable optional peer deps with empty objects, which defeats ws's
  // try/catch fallback and crashes on masked frames >= 32 bytes.
  assert.match(vite, /id\s*===\s*['"]bufferutil['"]/);
  assert.match(vite, /id\s*===\s*['"]utf-8-validate['"]/);
  assert.match(vscodeIgnore, /!out\/\*\.js/);
  // The verified source Pi runtime must ship inside the VSIX: the packaged
  // backend resolves its SDK from the unpacked artifact, never a checkout or
  // globally installed copy.
  assert.match(vscodeIgnore, /!out\/pi-runtime\/\*\*/);
});

async function copyTree(source: string, destination: string, excludedNames?: ReadonlySet<string>): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (excludedNames?.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Staged packaging refuses to copy a symlink: ${from}`);
    if (entry.isDirectory()) {
      await copyTree(from, to);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Staged packaging refused a non-regular entry: ${from}`);
    await fs.copyFile(from, to);
  }
}

/**
 * Stage a fresh temporary extension tree for vsce: only owned static assets,
 * the host manifest, the bootstrap runtime files, and the isolated build's
 * verified output (`out/`, including its materialized Pi runtime). No shared
 * out, no checkout source, no dependencies, and no prepackage/publication step.
 */
async function stageExtensionForPackaging(
  outputBuildDir: string,
  stagedRoot: string,
): Promise<void> {
  for (const required of ['media', 'runtime', 'package.json', '.vscodeignore']) {
    await fs.access(path.join(extensionRoot, required));
  }
  await fs.mkdir(stagedRoot);
  await fs.copyFile(path.join(extensionRoot, 'package.json'), path.join(stagedRoot, 'package.json'));
  await fs.copyFile(path.join(extensionRoot, '.vscodeignore'), path.join(stagedRoot, '.vscodeignore'));
  await copyTree(path.join(extensionRoot, 'media'), path.join(stagedRoot, 'media'));
  await fs.mkdir(path.join(stagedRoot, 'runtime'));
  for (const entry of await fs.readdir(path.join(extensionRoot, 'runtime'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cjs')) {
      await fs.copyFile(path.join(extensionRoot, 'runtime', entry.name), path.join(stagedRoot, 'runtime', entry.name));
    } else if (!entry.isFile()) {
      throw new Error(`Staged packaging expects regular runtime files only: ${path.join(extensionRoot, 'runtime', entry.name)}`);
    }
  }
  await copyTree(outputBuildDir, path.join(stagedRoot, 'out'), new Set(['.cache']));
  await fs.access(path.join(stagedRoot, 'out', 'pi-runtime', 'manifest.json'));
}

test('packaging staging uses the isolated output root and creates runtime asset directories', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-packaging-stage-'));
  try {
    const output = path.join(temp, 'build-output');
    await fs.mkdir(path.join(output, 'pi-runtime'), { recursive: true });
    await fs.writeFile(path.join(output, 'pi-runtime', 'manifest.json'), '{}');
    await fs.writeFile(path.join(output, 'backend.js'), '// fixture');
    await fs.mkdir(path.join(output, '.cache'));
    await fs.writeFile(path.join(output, '.cache', 'fixture'), 'not shipped');
    const staged = path.join(temp, 'extension');
    await stageExtensionForPackaging(output, staged);
    await fs.access(path.join(staged, 'runtime', 'bootstrap.cjs'));
    await fs.access(path.join(staged, 'out', 'backend.js'));
    await fs.access(path.join(staged, 'out', 'pi-runtime', 'manifest.json'));
    assert.equal(await fs.access(path.join(staged, 'out', '.cache')).then(() => true, () => false), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('packaged isolated source-artifact backend drives public message.send extension commands through replacement and retirement', {
  skip: process.env.PIE_TEST_BUILT_WORKER !== '1',
  timeout: 900_000,
}, async () => {
  // Explicit wrapper selection: one verified Pi runtime selection reused
  // everywhere below; the isolated build reuses it via --pi-runtime and never
  // acquires, installs, or publishes on its own.
  const selectedRuntime = await selectVerifiedRuntime();

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-packaged-worker-'));
  const vsixPath = path.join(temp, 'pie-phase2.vsix');
  const unpacked = path.join(temp, 'unpacked');
  let standaloneChild: ChildProcess | undefined;
  let standaloneProcessExit: Promise<ChildExit> | undefined;
  let standaloneCoordinatorPort: number | undefined;
  let startupTimer: NodeJS.Timeout | undefined;
  let backendChild: ChildProcess | undefined;
  let backendProcessExit: Promise<ChildExit> | undefined;
  let backendTimer: NodeJS.Timeout | undefined;
  try {
    await fs.mkdir(unpacked);
    // New absolute OS-temp isolated output directory for the build. build.mjs
    // validates that the leaf is new/exclusive and outside the checkout,
    // node_modules, and installed extension trees; --skip-typecheck keeps the
    // packaging smoke focused (typechecks own their own gates).
    const outputBuildDir = path.join(temp, 'build');
    const buildResult = await execFileAsync(process.execPath, [
      path.join(repositoryRoot, 'scripts', 'build', 'build.mjs'),
      '--output-dir', outputBuildDir,
      '--pi-runtime', selectedRuntime.artifactDir,
      '--skip-typecheck',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
      windowsHide: true,
    });
    const copiedRuntimeDir = path.join(outputBuildDir, 'pi-runtime');
    assert.ok(
      new RegExp(`Materialized verified Pi runtime ${regexEscape(selectedRuntime.identity)}`, 'u')
        .test(buildResult.stdout),
      'the isolated build must materialize the explicitly selected verified Pi runtime identity',
    );
    assert.equal(
      (await verifyPiRuntimeArtifact(copiedRuntimeDir)).identity,
      selectedRuntime.identity,
      'the isolated build output binds exactly the selected verified Pi runtime',
    );
    assert.equal(await fs.access(path.join(outputBuildDir, 'sdk-local-path.json')).then(() => true, () => false),
      false, 'an isolated source-bound build must not write a checkout SDK pointer');

    // Temporary extension staging for vsce packaging: fresh tree, owned static
    // assets/manifest/runtime plus the isolated out only. The staged manifest
    // declares no vscode:prepublish hook, so vsce executes no npm prepackage
    // step; packaging reads nothing from the shared out or checkout.
    const stagedRoot = path.join(temp, 'staged-extension');
    await stageExtensionForPackaging(outputBuildDir, stagedRoot);
    const stagedManifest = JSON.parse(await fs.readFile(path.join(stagedRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      main?: string;
    };
    assert.equal(stagedManifest.scripts?.['vscode:prepublish'], undefined);
    await execFileAsync(process.execPath, [
      path.join(extensionRoot, 'node_modules', '@vscode', 'vsce', 'vsce'),
      'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', vsixPath,
    ], {
      cwd: stagedRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
      windowsHide: true,
    });
    assert.equal((await fs.stat(vsixPath)).isFile(), true, 'the opt-in test creates a real VSIX');

    const tar = process.platform === 'win32'
      ? path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    await execFileAsync(tar, ['-xf', vsixPath, '-C', unpacked], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    const packagedExtension = path.join(unpacked, 'extension');
    const packageManifest = JSON.parse(await fs.readFile(path.join(packagedExtension, 'package.json'), 'utf8')) as {
      main?: string;
    };
    assert.equal(packageManifest.main, './runtime/bootstrap.cjs');

    const packagedFiles: string[] = [];
    async function collectFiles(directory: string, prefix = ''): Promise<void> {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await collectFiles(path.join(directory, entry.name), relativePath);
        else packagedFiles.push(relativePath);
      }
    }
    await collectFiles(packagedExtension);
    for (const required of [
      'runtime/bootstrap.cjs',
      'runtime/runtime-generations.cjs',
      'media/icon.svg',
      'out/extension.js',
      'out/standalone.js',
      'out/backend.js',
      'out/worker-entry.js',
      'out/initial-context-estimate-worker.js',
      'out/cold-browse-helper-entry.js',
      'out/phase4-worker-command-extension.js',
      'out/analytics-recorder-worker.js',
      'out/analytics-query-worker.js',
      'out/pie-build-id.txt',
      'out/webview/panel/.vite/manifest.json',
      'out/webview/panel/pie-build-id.txt',
      // The verified source Pi runtime ships inside the VSIX.
      'out/pi-runtime/manifest.json',
      'out/pi-runtime/node_modules/@earendil-works/pi-coding-agent/package.json',
    ]) {
      assert.ok(packagedFiles.includes(required), `missing packaged runtime asset: ${required}`);
    }
    assert.equal(packagedFiles.includes('out/sdk-local-path.json'), false,
      'the VSIX must not carry a checkout/global SDK pointer');
    assert.equal(packagedFiles.includes('out/.cache/vite-node/package.json'), false,
      'the VSIX must not carry build cache output');
    const retiredRoots = ['src', 'tools', 'shared', 'agents', 'skills', 'analysis'];
    const leakedPaths = packagedFiles.filter((file) => retiredRoots.some((root) => file.startsWith(`${root}/`)));
    assert.deepEqual(leakedPaths, [], `retired source paths leaked into the VSIX: ${leakedPaths.join(', ')}`);

    const packageRequire = createRequire(path.join(packagedExtension, 'package.json'));
    assert.equal(packageRequire.resolve(String(packageManifest.main)), path.resolve(packagedExtension, String(packageManifest.main)),
      'the packaged manifest main resolves in isolation');
    assert.equal(packageRequire.resolve(path.join(packagedExtension, 'out', 'extension.js')),
      path.join(packagedExtension, 'out', 'extension.js'),
      'the packaged runtime delegate resolves in isolation');
    const packagedMain = packageRequire(String(packageManifest.main)) as { activate?: unknown; deactivate?: unknown };
    assert.equal(typeof packagedMain.activate, 'function');
    assert.equal(typeof packagedMain.deactivate, 'function');

    const backendEntry = path.join(packagedExtension, 'out', 'backend.js');
    const workerEntry = path.join(packagedExtension, 'out', 'worker-entry.js');
    const coldBrowseHelperEntry = path.join(packagedExtension, 'out', 'cold-browse-helper-entry.js');
    const commandExtension = path.join(packagedExtension, 'out', 'phase4-worker-command-extension.js');
    assert.equal((await fs.stat(backendEntry)).isFile(), true);
    assert.equal((await fs.stat(workerEntry)).isFile(), true);
    assert.equal((await fs.stat(coldBrowseHelperEntry)).isFile(), true);
    assert.equal((await fs.stat(commandExtension)).isFile(), true);

    // The packaged backend's sdkPath, trusted root, and source descriptor are
    // resolved from the VERIFIED unpacked out/pi-runtime, never from the
    // checkout or a globally installed SDK.
    const packagedBackendTarget = {
      platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
    } as const;
    const descriptor = await resolveGenerationPiRuntime({
      runtimeOutDir: path.join(packagedExtension, 'out'),
      target: packagedBackendTarget,
    });
    assert.equal(descriptor.identity, selectedRuntime.identity,
      'the unpacked VSIX Pi runtime must bind exactly the selected verified artifact');
    assert.ok(containsPath(await fs.realpath(packagedExtension), descriptor.artifactDir)
      && !containsPath(extensionRoot, descriptor.artifactDir),
      'the packaged SDK must come from the unpacked out/pi-runtime, not the checkout or a global install');
    const trustedRoot = deriveTrustedSdkRoot(descriptor.sdkPath);
    assert.equal(trustedRoot, path.join(descriptor.artifactDir, 'node_modules'),
      'the trusted root is the unpacked artifact\'s node_modules owner');

    // Exercise the packaged standalone from this same isolated VSIX and
    // verified source artifact. The temporary wrapper calls its exported main
    // with the supported browserServerSettings seam to avoid fixed port 1997;
    // clean shutdown uses the production host-coordinator release protocol.
    const standaloneEntry = path.join(packagedExtension, 'out', 'standalone.js');
    assert.equal((await fs.stat(standaloneEntry)).isFile(), true);
    const standaloneDescriptor = await resolveGenerationPiRuntime({
      runtimeOutDir: path.join(packagedExtension, 'out'),
      target: packagedBackendTarget,
    });
    assert.equal(standaloneDescriptor.identity, selectedRuntime.identity,
      'the standalone package resolves the explicitly selected verified runtime identity');
    assert.equal(await fs.realpath(standaloneDescriptor.sdkPath), await fs.realpath(descriptor.sdkPath),
      'standalone and backend resolve the same SDK from the unpacked VSIX artifact');
    assert.ok(containsPath(await fs.realpath(packagedExtension), standaloneDescriptor.artifactDir),
      'standalone runtime resolution remains inside the unpacked VSIX');

    const standaloneWorkspace = path.join(temp, 'standalone-workspace');
    const standaloneAgentDir = path.join(temp, 'standalone-agent');
    const standaloneDataDir = path.join(temp, 'standalone-data');
    const standaloneAuthDir = path.join(temp, 'standalone-auth');
    const standaloneSessionDir = path.join(temp, 'standalone-sessions');
    const standaloneHome = path.join(temp, 'standalone-home');
    const standaloneTmp = path.join(temp, 'standalone-tmp');
    await Promise.all([
      standaloneWorkspace,
      standaloneAgentDir,
      standaloneDataDir,
      standaloneAuthDir,
      standaloneSessionDir,
      standaloneHome,
      standaloneTmp,
    ].map((directory) => fs.mkdir(directory, { recursive: true })));
    const standaloneSettings = {
      extensions: [],
      packages: [],
      skills: [],
      prompts: [],
      themes: [],
      enableInstallTelemetry: false,
    };
    await Promise.all([
      fs.writeFile(path.join(standaloneAgentDir, 'settings.json'), `${JSON.stringify(standaloneSettings, null, 2)}\n`),
      fs.copyFile(path.resolve(repositoryRoot, 'models.json'), path.join(standaloneAgentDir, 'models.json')),
      fs.writeFile(path.join(standaloneAgentDir, 'auth.json'), '{}\n'),
      fs.writeFile(path.join(standaloneAuthDir, 'auth.json'), '{}\n'),
    ]);
    for (const isolatedPath of [
      standaloneWorkspace,
      standaloneAgentDir,
      standaloneDataDir,
      standaloneAuthDir,
      standaloneSessionDir,
      standaloneHome,
      standaloneTmp,
    ]) {
      assert.ok(containsPath(temp, isolatedPath), `standalone user/runtime path must remain disposable: ${isolatedPath}`);
    }
    const standaloneEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PI_NODE_PATH: process.execPath,
      PI_CODING_AGENT_DIR: standaloneAgentDir,
      PI_CODING_AGENT_AUTH_DIR: standaloneAuthDir,
      PI_CODING_AGENT_SESSION_DIR: standaloneSessionDir,
      PIE_DATA_DIR: standaloneDataDir,
      PIE_TRUSTED_SDK_ROOT: trustedRoot,
      PIE_LIVE_PIPELINE_TRACE_DIR: path.join(temp, 'standalone-live-pipeline-traces'),
      PIE_PROVIDER_TRAFFIC_LOG: '0',
      PI_DIAG: '0',
      PI_BOOT_LOG: '0',
      PI_OFFLINE: '1',
      HOME: standaloneHome,
      USERPROFILE: standaloneHome,
      APPDATA: path.join(standaloneHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(standaloneHome, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(standaloneHome, '.config'),
      XDG_DATA_HOME: path.join(standaloneHome, '.local', 'share'),
      XDG_CACHE_HOME: path.join(standaloneHome, '.cache'),
      TMP: standaloneTmp,
      TEMP: standaloneTmp,
      TMPDIR: standaloneTmp,
    };
    // Do not let the launching user's development override, storage-cutoff
    // authorization, or in-tree auth policy change standalone resolution.
    delete standaloneEnv.PIE_DEVELOPMENT_PI_RUNTIME;
    delete standaloneEnv.PIE_ALLOW_DEVELOPMENT_RUNTIME;
    delete standaloneEnv.PIE_STORAGE_CUTOFF_AUTHORIZATION;
    delete standaloneEnv.PIE_ALLOW_IN_TREE_AUTH;
    delete standaloneEnv.NODE_PATH;
    delete standaloneEnv.NODE_OPTIONS;
    const { coordinatorPort, browserPort } = await allocateIsolatedLoopbackPorts();
    standaloneCoordinatorPort = coordinatorPort;
    const standaloneWrapper = path.join(temp, 'standalone-entry-wrapper.cjs');
    await fs.writeFile(standaloneWrapper, [
      `const { main } = require(${JSON.stringify(standaloneEntry)});`,
      "void main(['--cwd', process.argv[2], '--no-lan'], { browserServerSettings: { port: Number(process.argv[3]), requirePreferredPort: true }, process, output: { stdout: process.stdout, stderr: process.stderr } }).catch((error) => {",
      "  process.stderr.write('pie standalone failed: ' + (error instanceof Error ? error.message : String(error)) + '\\n');",
      '  process.exitCode = 1;',
      '});',
      '',
    ].join('\n'));
    standaloneEnv.PIE_HOST_COORDINATOR_PORT = String(coordinatorPort);
    const runningStandalone = spawn(process.execPath, [standaloneWrapper, standaloneWorkspace, String(browserPort)], {
      cwd: temp,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: standaloneEnv,
    });
    standaloneChild = runningStandalone;
    standaloneProcessExit = new Promise<ChildExit>((resolve) => {
      runningStandalone.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let standaloneStdout = '';
    let standaloneStderr = '';
    runningStandalone.stdout.setEncoding('utf8');
    runningStandalone.stderr.setEncoding('utf8');
    runningStandalone.stdout.on('data', (chunk) => { standaloneStdout += chunk; });
    runningStandalone.stderr.on('data', (chunk) => { standaloneStderr += chunk; });
    const standaloneExit = new Promise<ChildExit>((resolve, reject) => {
      runningStandalone.once('error', reject);
      runningStandalone.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let standaloneUrl: string;
    startupTimer = setTimeout(() => {
      void ensureStandaloneStopped(runningStandalone, standaloneProcessExit!, coordinatorPort);
    }, 90_000);
    startupTimer.unref?.();
    try {
      standaloneUrl = await Promise.race([
        new Promise<string>((resolve, reject) => {
          const checkOutput = (): void => {
            // URL line extraction below avoids depending on incidental output formatting.
            const urlLine = standaloneStdout.split(String.fromCharCode(10)).map((line) => line.trim()).find((line) => line.startsWith('http://127.0.0.1:'));
            if (urlLine) resolve(urlLine);
          };
          runningStandalone.stdout.on('data', checkOutput);
          runningStandalone.once('error', reject);
          checkOutput();
        }),
        standaloneExit.then(({ code, signal }) => {
          throw new Error(`packaged standalone exited before reporting its browser URL (${signal ?? code}): ${standaloneStderr}`);
        }),
      ]);
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
      const standaloneAddress = new URL(standaloneUrl);
      assert.equal(standaloneAddress.protocol, 'http:');
      assert.equal(standaloneAddress.hostname, '127.0.0.1', 'standalone defaults to loopback without --lan');
      assert.equal(Number(standaloneAddress.port), browserPort, 'standalone binds only its isolated fixture browser port');
      const pageResponse = await fetch(standaloneUrl);
      assert.equal(pageResponse.status, 200, 'the packaged standalone serves its startup page over HTTP');
      assert.ok((pageResponse.headers.get('content-type') ?? '').includes('text/html'));
      const pageHtml = await pageResponse.text();
      // Extract the single module entry URL from the page shell.
      const scriptSourceMarker = 'src="';
      const scriptSourceStart = pageHtml.indexOf(scriptSourceMarker);
      assert.notEqual(scriptSourceStart, -1, 'the startup page references its manifest-derived frontend entry');
      const scriptSourceValueStart = scriptSourceStart + scriptSourceMarker.length;
      const scriptSourceEnd = pageHtml.indexOf('"', scriptSourceValueStart);
      const entryAssetUrl = pageHtml.slice(scriptSourceValueStart, scriptSourceEnd);
      assert.ok(entryAssetUrl.endsWith('.js'), 'the startup page references a JavaScript frontend entry');
      const manifest = JSON.parse(await fs.readFile(path.join(packagedExtension, 'out', 'webview', 'panel', '.vite', 'manifest.json'), 'utf8')) as Record<string, { file: string; isEntry?: boolean }>;
      const manifestEntry = Object.values(manifest).find((chunk) => chunk.isEntry);
      assert.ok(manifestEntry, 'the packaged frontend manifest declares an entry');
      assert.ok(manifestEntry.file.startsWith('assets/'));
      assert.equal(entryAssetUrl, `/assets/${manifestEntry.file.slice('assets/'.length)}`, 'the HTTP shell references the verified package manifest entry');

      const entryResponse = await fetch(new URL(entryAssetUrl, standaloneUrl));
      assert.equal(entryResponse.status, 200, 'the packaged frontend JavaScript loads through the standalone asset server');
      assert.ok((entryResponse.headers.get('content-type') ?? '').includes('javascript'));
      assert.equal(
        await entryResponse.text(),
        await fs.readFile(path.join(packagedExtension, 'out', 'webview', 'panel', manifestEntry.file), 'utf8'),
        'the HTTP entry response is the frontend asset shipped in the unpacked VSIX',
      );

      const websocketUrl = new URL('/ws', standaloneAddress);
      websocketUrl.protocol = 'ws:';
      let browserSocket: StandaloneWebSocket | undefined;
      const readinessObservations: unknown[] = [];
      try {
        browserSocket = new WebSocketClient(websocketUrl.href, {
          headers: { Origin: standaloneAddress.origin },
        });
        const hello = await waitForStandaloneSocketMessage(
          browserSocket,
          'rendererHello',
          (message) => message.type === 'rendererHello',
        );
        assert.equal(typeof hello.buildId, 'string', 'rendererHello carries the renderer build id');
        assert.equal(typeof hello.viewGeneration, 'number', 'rendererHello carries the view generation');
        browserSocket.send(JSON.stringify({
          type: 'ready',
          buildId: hello.buildId,
          viewGeneration: hello.viewGeneration,
        }));
        const readySnapshot = await waitForStandaloneSocketMessage(
          browserSocket,
          'a snapshot with backendReady=true',
          (message) => {
            if (message.type !== 'state') return false;
            const state = message.state;
            const backendReady = state && typeof state === 'object' && !Array.isArray(state)
              ? (state as Record<string, unknown>).backendReady
              : undefined;
            readinessObservations.push(backendReady);
            return backendReady === true;
          },
        );
        assert.equal(
          (readySnapshot.state as { backendReady?: unknown }).backendReady,
          true,
          'the public renderer snapshot confirms packaged standalone backend readiness',
        );
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        throw new Error(
          `packaged standalone backend readiness handshake failed: ${failure}\n`
          + `Observed backendReady values: ${JSON.stringify(readinessObservations)}\n`
          + `Startup stderr:\n${standaloneStderr.trim() || '(empty)'}`,
          { cause: error },
        );
      } finally {
        browserSocket?.close();
      }

      const releaseAccepted = await requestPieHostRelease(coordinatorPort, STANDALONE_RELEASE_TIMEOUT_MS);
      assert.equal(releaseAccepted, true,
        'the isolated coordinator accepted graceful handoff and closed its release listener');
      let shutdownTimer: NodeJS.Timeout | undefined;
      const shutdown = await Promise.race([
        standaloneExit,
        new Promise<'timeout'>((resolve) => {
          shutdownTimer = setTimeout(() => resolve('timeout'), STANDALONE_EXIT_TIMEOUT_MS);
          shutdownTimer.unref?.();
        }),
      ]).finally(() => {
        if (shutdownTimer) clearTimeout(shutdownTimer);
      });
      assert.notEqual(shutdown, 'timeout', 'standalone clean shutdown completes within its bounded lifecycle');
      assert.deepEqual(shutdown, { code: 143, signal: null },
        `coordinator handoff completes graceful standalone teardown with the SIGTERM exit code; stderr: ${standaloneStderr}`);
      assert.doesNotMatch(standaloneStderr, /standalone shutdown failed/iu);
      const listenerRemainsOpen = await fetch(standaloneUrl).then(() => true, () => false);
      assert.equal(listenerRemainsOpen, false, 'clean shutdown closes the packaged browser HTTP listener');
    } finally {
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
      await ensureStandaloneStopped(runningStandalone, standaloneProcessExit, coordinatorPort);
    }

    const agentDir = path.join(temp, 'agent');
    const commandResultPath = path.join(temp, 'phase4-extension-command-result.json');
    const commandTracePath = path.join(temp, 'phase4-extension-command-trace.jsonl');
    await fs.mkdir(agentDir, { recursive: true });
    // Do not inherit the user's settings: packages can trigger installs on worker
    // startup, and other discovered resources can change command dispatch.
    const settings = {
      extensions: [commandExtension],
      packages: [],
      skills: [],
      prompts: [],
      themes: [],
      enableInstallTelemetry: false,
    };
    await Promise.all([
      fs.writeFile(path.join(agentDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`),
      fs.copyFile(path.resolve(repositoryRoot, 'models.json'), path.join(agentDir, 'models.json')),
      fs.writeFile(path.join(agentDir, 'auth.json'), '{}\n'),
    ]);
    const runningBackend = spawn(process.execPath, [
      backendEntry,
      '--sdkPath', descriptor.sdkPath,
      '--sourceArtifactDescriptor', JSON.stringify(descriptor),
      '--cwd', temp,
    ], {
      cwd: temp,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...standaloneEnv,
        PIE_PHASE2_PACKAGE_SMOKE: '1',
        PIE_HOST_COORDINATOR_PORT: String(coordinatorPort),
        PIE_PROVIDER_TRAFFIC_LOG: '0',
        // Disable inherited diagnostics and confine any dynamically enabled traces
        // to the disposable tree removed by this test's finally block.
        PI_DIAG: '0',
        PIE_LIVE_PIPELINE_TRACE_DIR: path.join(temp, 'live-pipeline-traces'),
        PI_OFFLINE: '1',
        PIE_PHASE4_EXTENSION_FIXTURE_RESULT: commandResultPath,
        PIE_PHASE4_EXTENSION_FIXTURE_TRACE: commandTracePath,
        PI_CODING_AGENT_DIR: agentDir,
        // The isolated VSIX resolves its SDK from the unpacked verified
        // out/pi-runtime only; trust only that boundary.
        PIE_TRUSTED_SDK_ROOT: trustedRoot,
        PIE_DATA_DIR: path.join(temp, 'data'),
        PI_CODING_AGENT_AUTH_DIR: path.join(temp, 'auth'),
        PI_CODING_AGENT_SESSION_DIR: path.join(temp, 'sessions'),
      },
    });
    backendChild = runningBackend;
    backendProcessExit = new Promise<ChildExit>((resolve) => {
      runningBackend.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let stdout = '';
    let stderr = '';
    runningBackend.stdout.setEncoding('utf8');
    runningBackend.stderr.setEncoding('utf8');
    runningBackend.stdout.on('data', (chunk) => { stdout += chunk; });
    runningBackend.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = new Promise<ChildExit>((resolve, reject) => {
      runningBackend.once('error', reject);
      runningBackend.once('exit', (code, signal) => resolve({ code, signal }));
    });
    backendTimer = setTimeout(() => runningBackend.kill('SIGKILL'), 45_000);
    backendTimer.unref?.();
    const result = await exit.finally(() => {
      if (backendTimer) { clearTimeout(backendTimer); backendTimer = undefined; }
    });
    assert.equal(result.code, 0, `packaged coordinator failed (${result.signal ?? 'no signal'}):\n${stderr}`);
    assert.match(stdout, /backend\.ready/);
    assert.match(stderr, /phase4-package-smoke:promoted-command-retired/);

    const commandResult = JSON.parse(await fs.readFile(commandResultPath, 'utf8')) as {
      sourcePaths: string[];
      finalPath: string;
    };
    assert.equal(commandResult.sourcePaths.length, 3, 'new, switch, and fork each release one source');
    assert.notEqual(commandResult.finalPath, commandResult.sourcePaths.at(-1));
    const durableDestination = await fs.readFile(commandResult.finalPath, 'utf8');
    assert.match(durableDestination, /phase4-extension-durable/);

    const publicRecords = stdout.split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        event?: string;
        payload?: {
          session?: { path?: string };
          replacesSessionPath?: string;
          sessionPath?: string;
          busy?: boolean;
        };
      });
    const publicOpened = publicRecords
      .filter((record) => record.event === 'session.opened');
    const replacementOpened = publicOpened.filter((record) => record.payload?.replacesSessionPath);
    assert.deepEqual(
      replacementOpened.map((record) => [record.payload?.replacesSessionPath, record.payload?.session?.path]),
      [
        [commandResult.sourcePaths[0], commandResult.sourcePaths[1]],
        [commandResult.sourcePaths[1], commandResult.sourcePaths[2]],
        [commandResult.sourcePaths[2], commandResult.finalPath],
      ],
      'public session.opened is published once per coordinator-rekeyed replacement and in command order',
    );

    const busyByPath = new Map<string, boolean>();
    for (const record of publicRecords) {
      if (record.event !== 'busy.changed' || typeof record.payload?.sessionPath !== 'string'
          || typeof record.payload.busy !== 'boolean') continue;
      busyByPath.set(record.payload.sessionPath, record.payload.busy);
    }
    for (const sessionPath of [...commandResult.sourcePaths, commandResult.finalPath]) {
      const finalBusy = busyByPath.get(sessionPath);
      assert.notEqual(
        finalBusy,
        true,
        `public message.send lifecycle must not leave busy=true for ${sessionPath}`,
      );
    }
    const preflightFailurePaths = publicRecords
      .filter((record) => record.event === 'preflight.failed')
      .map((record) => record.payload?.sessionPath);
    assert.ok(
      preflightFailurePaths.includes(commandResult.sourcePaths[0]),
      'ordinary no-agent extension command must publish a terminal preflight failure',
    );
    for (const sourcePath of commandResult.sourcePaths.slice(1)) {
      assert.ok(
        preflightFailurePaths.includes(sourcePath),
        `replacement extension command must terminalize its source request: ${sourcePath}`,
      );
    }
    const lifecycle = (await fs.readFile(commandTracePath, 'utf8')).trim().split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { kind: string; sessionPath?: string });
    const commandDestinationIndex = lifecycle.findIndex((entry) => (
      entry.kind === 'command_destination' && entry.sessionPath === commandResult.finalPath
    ));
    assert.ok(commandDestinationIndex >= 0);
    const commandWindow = lifecycle.slice(0, commandDestinationIndex + 1);
    assert.deepEqual(
      commandWindow.filter((entry) => entry.kind === 'session_start').map((entry) => entry.sessionPath),
      [...commandResult.sourcePaths, commandResult.finalPath],
      'each command replacement receives exactly one fresh extension binding',
    );
    assert.equal(commandWindow.filter((entry) => entry.kind === 'session_shutdown').length, 3,
      'each replaced source retains exactly one shutdown subscription');
    assert.equal(
      lifecycle.filter((entry) => entry.kind === 'session_shutdown').length,
      lifecycle.filter((entry) => entry.kind === 'session_start').length,
      'source-reuse, truncate, and final retirement preserve extension shutdown handlers',
    );
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
    if (backendTimer) clearTimeout(backendTimer);
    if (standaloneChild && standaloneProcessExit) {
      await ensureStandaloneStopped(standaloneChild, standaloneProcessExit, standaloneCoordinatorPort);
    }
    if (backendChild && backendProcessExit) await ensureChildStopped(backendChild, backendProcessExit);
    await fs.rm(temp, { recursive: true, force: true });
  }
});
