import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPinnedNodeVersion } from '../install/toolchain.mjs';
import { watchChildProcess, withProcessTreeIsolation } from '../lib/process-watchdog.mjs';
import {
  computeNodeRuntimePayloadIdentity,
  NODE_RUNTIME_MANIFEST,
  NODE_RUNTIME_SCHEMA_VERSION,
  NODE_RUNTIME_TARGET,
  readNodeRuntimeManifest,
} from '../../lib/node-runtime/manifest.mjs';

const NODE_PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_MAX_BYTES = 8 * 1024;
const PROBE_SCRIPT = 'process.stdout.write(JSON.stringify({nodeVersion:process.versions.node,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch}))';

export function parseNodeRuntimeOption(argv, { requireDelivery = false } = {}) {
  const options = argv.filter(arg => arg === '--node-runtime' || arg.startsWith('--node-runtime='));
  if (options.length > 1) throw new Error('--node-runtime may only be supplied once.');
  if (options.length === 0) return undefined;
  if (requireDelivery && !argv.includes('--delivery')) {
    throw new Error('--node-runtime requires explicit --delivery; it is unsupported for development builds.');
  }
  if (['--watch', '--publish', '--activate'].some(option => argv.includes(option))) {
    throw new Error('--node-runtime supports only one-shot, non-publishing delivery builds.');
  }
  const option = options[0];
  const index = argv.indexOf(option);
  const value = option === '--node-runtime' ? argv[index + 1] : option.slice('--node-runtime='.length);
  if (!value || value.startsWith('--') || !path.isAbsolute(value)
    || value.split(/[\\/]/u).some(part => part === '.' || part === '..')) {
    throw new Error('--node-runtime requires an explicit absolute prepared directory without traversal.');
  }
  return path.resolve(value);
}

function fail(message) {
  throw new Error(`Node runtime payload: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} has an unsupported shape.`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

function canonicalManifestText(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value)
    || value.split(/[\\/]/u).some(part => part === '.' || part === '..')) {
    fail(`${label} must be an explicit absolute path without traversal.`);
  }
  return path.resolve(value);
}

function compareStat(left, right) {
  return [left.dev, left.ino, left.mode, left.size, left.mtimeMs, left.ctimeMs].join(':')
    === [right.dev, right.ino, right.mode, right.size, right.mtimeMs, right.ctimeMs].join(':');
}

async function assertNoSymlinkPath(candidate, label) {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail(`${label} traverses a symbolic link: ${current}.`);
    if (current !== absolute && !info.isDirectory()) fail(`${label} has a non-directory parent: ${current}.`);
  }
  return absolute;
}

async function lstatIfExists(candidate) {
  try { return await lstat(candidate); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

async function readStableFile(file, label, maxBytes = 4 * 1024 * 1024) {
  await assertNoSymlinkPath(file, label);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size > maxBytes) {
    fail(`${label} must be a bounded regular file.`);
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !compareStat(opened, before)) fail(`${label} changed while opening.`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(file);
    if (!compareStat(after, before) || !compareStat(pathAfter, before) || bytes.length !== before.size) {
      fail(`${label} changed while being read.`);
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

async function assertOrdinaryDirectory(directory, label) {
  const absolute = await assertNoSymlinkPath(directory, label);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be an ordinary directory.`);
  return { absolute, canonical: await realpath(absolute), info };
}

async function assertOrdinaryFile(file, label) {
  const absolute = await assertNoSymlinkPath(file, label);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size < 1) {
    fail(`${label} must be a nonempty regular file.`);
  }
  return { absolute, canonical: await realpath(absolute), info };
}

function parseToolchainProvenance(bytes, pinnedVersion) {
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error('Node runtime payload: toolchain manifest is not valid JSON.', { cause: error }); }
  const lock = manifest?.versions?.[pinnedVersion]?.lock;
  const expectedUrl = `https://nodejs.org/download/release/v${pinnedVersion}/node-v${pinnedVersion}-win-x64.zip`;
  const checksum = /^sha256:([a-f0-9]{64})$/u.exec(lock?.checksum ?? '');
  if (lock?.os !== 'windows' || lock.arch !== 'x64' || lock.source !== expectedUrl || !checksum) {
    fail(`toolchain manifest does not declare the official Node ${pinnedVersion} Windows x64 archive and SHA-256.`);
  }
  return {
    kind: 'local-toolchain',
    archiveUrl: lock.source,
    archiveSha256: checksum[1],
  };
}

async function readRepositoryNodePin(repositoryRoot) {
  const root = await assertOrdinaryDirectory(repositoryRoot, 'repositoryRoot');
  for (const relative of ['.node-version', '.prototools']) {
    await assertOrdinaryFile(path.join(root.absolute, relative), `repository pin ${relative}`);
  }
  let nodeVersion;
  try { nodeVersion = readPinnedNodeVersion(root.absolute); }
  catch (error) { throw new Error(`Node runtime payload: cannot resolve the repository Node pin: ${error.message}`, { cause: error }); }
  if (!/^\d+\.\d+\.\d+$/u.test(nodeVersion)) fail('repository Node pin must be an exact version.');
  return { root, nodeVersion };
}

async function readPinnedInputs(repositoryRoot, toolchainManifestPath) {
  const { root, nodeVersion } = await readRepositoryNodePin(repositoryRoot);
  const toolchainFile = await assertOrdinaryFile(toolchainManifestPath, 'toolchainManifestPath');
  const toolchainBytes = await readStableFile(toolchainFile.absolute, 'toolchain manifest');
  return {
    root,
    nodeVersion,
    toolchainFile,
    toolchainBytes,
    provenance: parseToolchainProvenance(toolchainBytes, nodeVersion),
  };
}

async function copyAndHashFile(source, destination, relativePath, mode) {
  await assertNoSymlinkPath(source, `source ${relativePath}`);
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size < 1) {
    fail(`source is not a nonempty regular file: ${relativePath}.`);
  }
  let input;
  let output;
  try {
    input = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await input.stat();
    if (!opened.isFile() || !compareStat(opened, before)) fail(`source changed while opening: ${relativePath}.`);
    output = await open(destination, 'wx', mode);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const written = await output.write(chunk, offset, chunk.length - offset, null);
        offset += written.bytesWritten;
      }
    }
    const after = await input.stat();
    const pathAfter = await lstat(source);
    await assertNoSymlinkPath(source, `source ${relativePath}`);
    if (sizeBytes !== before.size || !compareStat(after, before) || !compareStat(pathAfter, before)) {
      fail(`source changed while copying: ${relativePath}.`);
    }
    await output.sync();
    const outputStat = await output.stat();
    if (!outputStat.isFile() || outputStat.nlink !== 1 || outputStat.size !== sizeBytes) {
      fail(`copied file is not an independent regular file: ${relativePath}.`);
    }
    return { relativePath, sizeBytes, sha256: hash.digest('hex') };
  } finally {
    await Promise.allSettled([input?.close(), output?.close()].filter(Boolean));
  }
}

async function hashPayloadFile(root, relativePath) {
  const file = path.join(root, relativePath);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size < 1) {
    fail(`payload entry must be a nonempty independent regular file: ${relativePath}.`);
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !compareStat(opened, before)) fail(`payload entry changed while opening: ${relativePath}.`);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      sizeBytes += chunk.length;
      hash.update(chunk);
    }
    const after = await handle.stat();
    const pathAfter = await lstat(file);
    if (sizeBytes !== before.size || !compareStat(after, before) || !compareStat(pathAfter, before)) {
      fail(`payload entry changed while hashing: ${relativePath}.`);
    }
    return { relativePath, sizeBytes, sha256: hash.digest('hex') };
  } finally {
    await handle?.close();
  }
}

async function inventoryPayloadFiles(root, { manifestPresent = false } = {}) {
  const entries = await readdir(root);
  const folded = new Map();
  for (const name of entries) {
    const lower = name.toLowerCase();
    const previous = folded.get(lower);
    if (previous && previous !== name) fail(`payload contains case-colliding entries: ${previous} and ${name}.`);
    folded.set(lower, name);
  }
  const expected = manifestPresent ? ['LICENSE', NODE_RUNTIME_MANIFEST, 'node.exe'] : ['LICENSE', 'node.exe'];
  if (entries.length !== expected.length || expected.some(name => !entries.includes(name))) {
    fail(`payload directory must contain exactly ${manifestPresent ? 'manifest.json, ' : ''}node.exe and LICENSE.`);
  }
  const files = await Promise.all(['LICENSE', 'node.exe'].map(name => hashPayloadFile(root, name)));
  return files;
}

function validateProbeResult(result, pinnedVersion) {
  exactKeys(result, ['nodeVersion', 'nodeAbi', 'platform', 'arch'], 'Node probe result');
  if (result.nodeVersion !== pinnedVersion) fail(`probed Node version ${String(result.nodeVersion)} does not match repository pin ${pinnedVersion}.`);
  if (result.platform !== NODE_RUNTIME_TARGET.platform || result.arch !== NODE_RUNTIME_TARGET.arch
    || result.nodeAbi !== NODE_RUNTIME_TARGET.nodeAbi) {
    fail('probed Node ABI/platform/architecture does not match the supported win32 x64 ABI 137 target.');
  }
  return {
    nodeVersion: result.nodeVersion,
    target: { platform: result.platform, arch: result.arch, nodeAbi: result.nodeAbi },
  };
}

function probeEnvironment(privateRoot) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive', 'lang', 'lc_all']);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string'));
  const home = path.join(privateRoot, 'home');
  const temp = path.join(privateRoot, 'temp');
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
  };
}

async function runNodeVersionProbe({ executablePath, cwd, env, timeoutMs }) {
  const child = spawn(executablePath, ['-e', PROBE_SCRIPT], withProcessTreeIsolation({
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }));
  const watchdog = watchChildProcess(child, {
    timeoutMs: Math.min(NODE_PROBE_TIMEOUT_MS, timeoutMs),
    label: 'Node runtime payload probe',
    gracefulMs: 100,
    forceMs: 1_000,
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow;
  const collect = (stream, chunks, channel) => stream?.on('data', chunk => {
    if (overflow) return;
    const size = (channel === 'stdout' ? stdoutBytes : stderrBytes) + chunk.length;
    if (size > PROBE_OUTPUT_MAX_BYTES) {
      overflow = new Error('Node runtime payload: Node probe output exceeded its byte bound.');
      child.kill();
      return;
    }
    chunks.push(chunk);
    if (channel === 'stdout') stdoutBytes = size;
    else stderrBytes = size;
  });
  collect(child.stdout, stdout, 'stdout');
  collect(child.stderr, stderr, 'stderr');

  let outcome;
  try {
    outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    try { await watchdog.settle(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw new Error(`Node runtime payload: could not probe the copied Node executable: ${error.message}`, { cause: error });
  }
  const teardown = await watchdog.settle();
  if (!teardown.gone) fail(`Node probe teardown is unconfirmed (${teardown.survivors.join(', ')}).`);
  if (watchdog.timedOut) fail(`Node executable probe exceeded ${NODE_PROBE_TIMEOUT_MS} ms.`);
  if (overflow) throw overflow;
  if (outcome.code !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').trim();
    fail(`Node executable probe failed (${outcome.signal ?? outcome.code})${detail ? `: ${detail}` : ''}.`);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(stdout).toString('utf8')); }
  catch (error) { throw new Error('Node runtime payload: Node executable probe returned invalid JSON.', { cause: error }); }
  return result;
}

function attachCleanupError(primary, cleanupError) {
  try { Object.defineProperty(primary, 'cleanupError', { value: cleanupError, configurable: true }); }
  catch { try { console.error('Node runtime payload staging cleanup failed:', cleanupError); } catch { /* preserve primary */ } }
}

/**
 * Prepare an immutable private Node payload from explicit local toolchain files.
 * The Node version is always derived from the repository's .node-version/.prototools pins.
 */
export async function prepareNodeRuntimePayload(options, dependencies = {}) {
  exactKeys(options, ['repositoryRoot', 'executablePath', 'licensePath', 'toolchainManifestPath', 'destinationDirectory'], 'prepareNodeRuntimePayload arguments');
  const repositoryRoot = assertAbsolute(options.repositoryRoot, 'repositoryRoot');
  const executablePath = assertAbsolute(options.executablePath, 'executablePath');
  const licensePath = assertAbsolute(options.licensePath, 'licensePath');
  const toolchainManifestPath = assertAbsolute(options.toolchainManifestPath, 'toolchainManifestPath');
  const destinationDirectory = assertAbsolute(options.destinationDirectory, 'destinationDirectory');
  const inputs = await readPinnedInputs(repositoryRoot, toolchainManifestPath);
  const executable = await assertOrdinaryFile(executablePath, 'executablePath');
  const license = await assertOrdinaryFile(licensePath, 'licensePath');
  const pinnedToolchainDirectory = path.join(path.dirname(inputs.toolchainFile.canonical), inputs.nodeVersion);
  if (path.basename(executable.absolute).toLowerCase() !== 'node.exe' || path.basename(license.absolute) !== 'LICENSE'
    || path.dirname(executable.canonical) !== path.dirname(license.canonical)
    || path.dirname(executable.canonical) !== pinnedToolchainDirectory) {
    fail('executablePath and licensePath must be node.exe and the full LICENSE from the repository-pinned local toolchain directory.');
  }
  const parent = await assertOrdinaryDirectory(path.dirname(destinationDirectory), 'destinationDirectory parent');
  const existing = await lstatIfExists(destinationDirectory);
  if (existing) fail('destinationDirectory already exists; Node payloads are immutable and never overwritten.');
  const canonicalDestination = path.join(parent.canonical, path.basename(destinationDirectory));
  const inputRoots = [inputs.root.canonical, path.dirname(executable.canonical), path.dirname(inputs.toolchainFile.canonical),
    executable.canonical, license.canonical, inputs.toolchainFile.canonical];
  if (inputRoots.some(input => within(input, canonicalDestination) || within(canonicalDestination, input))) {
    fail('destinationDirectory must be new and must not overlap the repository or any source input.');
  }

  const staging = path.join(parent.canonical, `.${path.basename(destinationDirectory)}.staging-${randomUUID()}`);
  if (await lstatIfExists(staging)) fail('private staging path unexpectedly already exists.');
  let stagingCreated = false;
  let primaryError;
  try {
    await mkdir(staging, { mode: 0o700 });
    stagingCreated = true;
    const copied = [];
    copied.push(await copyAndHashFile(executable.absolute, path.join(staging, 'node.exe'), 'node.exe', 0o755));
    copied.push(await copyAndHashFile(license.absolute, path.join(staging, 'LICENSE'), 'LICENSE', 0o644));
    copied.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);

    const probeRoot = path.join(staging, '.probe-private');
    const cwd = path.join(probeRoot, 'cwd');
    const env = probeEnvironment(probeRoot);
    for (const directory of [cwd, env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) await mkdir(directory, { recursive: true, mode: 0o700 });
    const probe = dependencies.probeRuntime ?? runNodeVersionProbe;
    if (typeof probe !== 'function') fail('probeRuntime dependency must be a function.');
    const rawProbe = await probe({
      executablePath: path.join(staging, 'node.exe'),
      cwd,
      env,
      timeoutMs: NODE_PROBE_TIMEOUT_MS,
    });
    const actual = validateProbeResult(rawProbe, inputs.nodeVersion);
    await rm(probeRoot, { recursive: true, force: true });
    const afterProbe = await inventoryPayloadFiles(staging);
    if (JSON.stringify(afterProbe) !== JSON.stringify(copied)) fail('payload files changed during the Node executable probe.');

    const currentInputs = await readPinnedInputs(repositoryRoot, toolchainManifestPath);
    if (currentInputs.nodeVersion !== inputs.nodeVersion || !currentInputs.toolchainBytes.equals(inputs.toolchainBytes)) {
      fail('repository Node pin or toolchain manifest changed while preparing the payload.');
    }
    const manifestWithoutIdentity = {
      schemaVersion: NODE_RUNTIME_SCHEMA_VERSION,
      kind: 'node-runtime',
      nodeVersion: actual.nodeVersion,
      target: actual.target,
      executable: 'node.exe',
      inventory: afterProbe,
      provenance: inputs.provenance,
    };
    const manifest = {
      ...manifestWithoutIdentity,
      payloadIdentity: computeNodeRuntimePayloadIdentity(manifestWithoutIdentity),
    };
    await writeFile(path.join(staging, NODE_RUNTIME_MANIFEST), canonicalManifestText(manifest), { flag: 'wx', mode: 0o644 });
    const verified = await validateNodeRuntimePayload({ directory: staging, repositoryRoot });

    const finalParent = await assertOrdinaryDirectory(path.dirname(destinationDirectory), 'destinationDirectory parent');
    if (finalParent.canonical !== parent.canonical) fail('destinationDirectory parent changed during preparation.');
    if (await lstatIfExists(destinationDirectory)) fail('destinationDirectory appeared during preparation; immutable Node payloads are never overwritten.');
    await rename(staging, canonicalDestination);
    stagingCreated = false;
    return { ...verified, directory: canonicalDestination };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (stagingCreated) {
      try { await rm(staging, { recursive: true, force: true }); }
      catch (cleanupError) {
        if (primaryError) attachCleanupError(primaryError, cleanupError);
        else throw cleanupError;
      }
    }
  }
}

/** Validate a relocated Node payload by metadata and hashing only; never executes node.exe. */
export async function validateNodeRuntimePayload(options) {
  exactKeys(options, ['directory', 'repositoryRoot'], 'validateNodeRuntimePayload arguments');
  const directory = assertAbsolute(options.directory, 'directory');
  const repositoryRoot = assertAbsolute(options.repositoryRoot, 'repositoryRoot');
  const { nodeVersion: pinnedVersion } = await readRepositoryNodePin(repositoryRoot);
  const manifest = await readNodeRuntimeManifest(directory);
  const root = (await assertOrdinaryDirectory(directory, 'directory')).canonical;
  if (manifest.nodeVersion !== pinnedVersion) {
    fail(`manifest Node version ${manifest.nodeVersion} does not match repository pin ${pinnedVersion}.`);
  }
  const before = await lstat(root);
  if (!before.isDirectory() || before.isSymbolicLink()) fail('payload root must be an ordinary directory.');
  const entries = await readdir(root);
  const folded = new Map();
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (folded.has(lower) && folded.get(lower) !== name) fail(`payload contains case-colliding entries: ${folded.get(lower)} and ${name}.`);
    folded.set(lower, name);
  }
  const expected = ['LICENSE', NODE_RUNTIME_MANIFEST, 'node.exe'];
  if (entries.length !== expected.length || expected.some(name => !entries.includes(name))) {
    fail('payload directory must contain exactly manifest.json, node.exe and LICENSE.');
  }
  const actual = await inventoryPayloadFiles(root, { manifestPresent: true });
  if (JSON.stringify(canonicalize(actual)) !== JSON.stringify(canonicalize(manifest.inventory))) fail('payload files are missing, extra, or mutated.');
  const after = await lstat(root);
  if (!compareStat(before, after)) fail('payload directory changed while being validated.');
  const latestManifest = await readNodeRuntimeManifest(root);
  if (latestManifest.payloadIdentity !== manifest.payloadIdentity) fail('manifest changed while validating the payload.');
  return { directory: root, manifest, identity: manifest.payloadIdentity };
}
