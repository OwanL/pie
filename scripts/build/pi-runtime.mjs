#!/usr/bin/env node
// Private source-to-artifact builder. Never installs into the checkout or publishes.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { acquireDevelopmentReader } from '../../lib/development-runtime/lifetime.mjs';
import { watchChildProcess, withProcessTreeIsolation } from '../lib/process-watchdog.mjs';
import { PI_RUNTIME_PACKAGES, writePiRuntimeManifest, verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';
import { readPinnedPiSourceVersion } from '../lib/sdk-version.mjs';
import { fingerprintCompiledPiOutputs } from '../../lib/development-runtime/compiled-output.mjs';

const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE = path.join(REPOSITORY, 'harness/pi');
const PACKAGE_DIRS = ['tui', 'ai', 'agent', 'coding-agent'];
const WORKSPACE_PACKAGE_DIRS = Object.fromEntries(PACKAGE_DIRS.map((dir, index) => [PI_RUNTIME_PACKAGES[index], `harness/pi/packages/${dir}`]));
const DEPLOY_METADATA = new Set(['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json']);
const UPSTREAM = '2b3fda9921b5590f285165287bd442a25817f17b';
const sha = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const jsonText = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const check = (condition, message) => { if (!condition) throw new Error(message); };

/** Resolve the required helper for the current native target; Linux has none. */
export function resolveNativeModifierHelper(runtimeRoot, platform, arch, fileExists = existsSync) {
  if (platform === 'linux') return undefined;
  if (platform !== 'win32' && platform !== 'darwin') {
    throw new Error(`Unsupported native modifier helper platform: ${platform}`);
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported native modifier helper target: ${platform}-${arch}`);
  }
  const filename = platform === 'win32' ? 'win32-console-mode.node' : 'darwin-modifiers.node';
  const helper = path.join(runtimeRoot, 'node_modules', '@earendil-works', 'pi-tui', 'native', platform,
    'prebuilds', `${platform}-${arch}`, filename);
  if (!fileExists(helper)) throw new Error(`Required native modifier helper missing for ${platform}-${arch}: ${helper}`);
  return helper;
}

function validateManifests(manifests, expectedVersion = readPinnedPiSourceVersion(REPOSITORY)) {
  check(manifests.length === 4 && JSON.stringify(manifests.map(m => m.name).sort()) === JSON.stringify([...PI_RUNTIME_PACKAGES].sort()), 'Expected exactly four local Pi manifests');
  for (const manifest of manifests) check(manifest.version === expectedVersion, `Unexpected ${manifest.name} version; expected in-tree Pi source version ${expectedVersion}`);
}
const isWithin = (file, root) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
/** New, explicitly addressed private output only; never overwrite an existing directory. */
export function assertPrivateOutput(output, repositoryRoot = REPOSITORY) {
  check(typeof output === 'string' && path.isAbsolute(output), 'Output must be an explicit absolute private path');
  const absolute = path.resolve(output);
  const home = os.homedir();
  const forbidden = [repositoryRoot, path.join(home, 'Documents'), path.join(home, '.vscode'), path.join(home, '.vscode-insiders'),
    path.join(home, '.pi'), path.join(home, '.config'), 'C:/dev/data'];
  check(!forbidden.some(root => isWithin(absolute, path.resolve(root))), 'Output is inside a protected live location');
  check(!/(?:^|[\\/])(?:node_modules|out|settings|data)(?:[\\/]|$)/i.test(absolute), 'Output must not target shared dependencies/output/data/settings');
  check(absolute !== path.parse(absolute).root && absolute !== path.resolve(home), 'Output must not be a root/home directory');
  check(isWithin(absolute, path.resolve(os.tmpdir())) && absolute !== path.resolve(os.tmpdir()), 'Output must be a new directory beneath OS temporary storage');
  let current = absolute;
  while (true) {
    if (existsSync(current)) check(!lstatSync(current).isSymbolicLink(), `Symlink/junction output ancestor: ${current}`);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  check(!existsSync(absolute), 'Output already exists; choose a new private output');
}

/** Only process/toolchain essentials survive. No inherited provider credentials or Pie/npm overrides. */
export function buildChildEnvironment(parent, privateRoot) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive',
    'lang', 'lc_all', 'http_proxy', 'https_proxy', 'no_proxy', 'ssl_cert_file', 'node_extra_ca_certs']);
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) => allowed.has(key.toLowerCase())));
  return { ...env, HOME: path.join(privateRoot, 'home'), USERPROFILE: path.join(privateRoot, 'home'),
    APPDATA: path.join(privateRoot, 'home', 'AppData', 'Roaming'), LOCALAPPDATA: path.join(privateRoot, 'home', 'AppData', 'Local'),
    TEMP: path.join(privateRoot, 'temp'), TMP: path.join(privateRoot, 'temp'), TMPDIR: path.join(privateRoot, 'temp'),
    npm_config_cache: path.join(privateRoot, 'npm-cache') };
}

function forwardChildOutput(source, destination) {
  if (!source) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let pendingWrites = 0;
    let ended = false;
    let settled = false;
    const finish = () => {
      if (ended && pendingWrites === 0 && !settled) { settled = true; resolve(); }
    };
    source.on('data', chunk => {
      source.pause();
      pendingWrites += 1;
      destination.write(chunk, error => {
        pendingWrites -= 1;
        if (error && !settled) { settled = true; reject(error); return; }
        if (!ended) source.resume();
        finish();
      });
    });
    source.once('end', () => { ended = true; finish(); });
    source.once('close', () => {
      if (!ended && !settled) { settled = true; reject(new Error('Child output stream closed before reaching EOF.')); }
    });
    source.once('error', error => { if (!settled) { settled = true; reject(error); } });
    source.resume();
  });
}

export async function run(executable, args, cwd, env, label, dependencies = {}) {
  console.log(`[pi-runtime] ${label}`);
  const spawnChild = dependencies.spawn ?? spawn;
  const watch = dependencies.watchChildProcess ?? watchChildProcess;
  const child = spawnChild(executable, args, withProcessTreeIsolation({ cwd, env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true }));
  const drains = [forwardChildOutput(child.stdout, process.stdout), forwardChildOutput(child.stderr, process.stderr)]
    .map(promise => promise.then(() => undefined, error => error));
  const watchdog = watch(child, { label });
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const drainErrors = (await Promise.all(drains)).filter(Boolean);
    if (drainErrors.length > 0) throw drainErrors[0];
  } catch (error) {
    try {
      const teardown = await watchdog.settle();
      if (!teardown.gone) throw new Error(`Owned process tree remains: ${teardown.survivors.join(', ')}`);
    } catch (teardownError) {
      throw Object.assign(new Error(`${label} teardown is unconfirmed; retaining the Pi workspace reader.`, { cause: teardownError }), { teardownUnconfirmed: true });
    }
    throw error;
  }

  let teardown;
  try { teardown = await watchdog.settle(); }
  catch (error) {
    throw Object.assign(new Error(`${label} teardown is unconfirmed; retaining the Pi workspace reader.`, { cause: error }), { teardownUnconfirmed: true });
  }
  if (!teardown.gone) {
    throw Object.assign(new Error(`${label} teardown is unconfirmed; owned process tree remains (${teardown.survivors.join(', ')}); retaining the Pi workspace reader.`), { teardownUnconfirmed: true });
  }
  if (watchdog.timedOut || watchdog.aborted || result.code !== 0) {
    throw new Error(`${label} failed (${result.signal ?? result.code})${watchdog.timedOut ? ' after timeout' : ''}${watchdog.aborted ? ' after cancellation' : ''}`);
  }
}
async function copyTree(source, destination, exclude = []) {
  const entries = (await readdir(source, { withFileTypes: true })).filter(entry => !exclude.includes(entry.name));
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    check(!entry.isSymbolicLink(), `Refusing copy-through link: ${path.join(source, entry.name)}`);
    if (entry.isDirectory()) await copyTree(path.join(source, entry.name), path.join(destination, entry.name), exclude);
    else { check(entry.isFile(), 'Unsupported file type'); await copyFile(path.join(source, entry.name), path.join(destination, entry.name)); }
  }
}

/** Copy pnpm's production node_modules into ordinary independent files, dropping only layout metadata. */
export async function materializeDeployedNodeModules(source, destination, piLicenseFile) {
  const sourceInfo = await lstat(source);
  check(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink(), `Expected a real deployed node_modules directory: ${source}`);
  check(!existsSync(destination), `Runtime node_modules destination already exists: ${destination}`);
  const licenseInfo = await lstat(piLicenseFile);
  check(licenseInfo.isFile() && !licenseInfo.isSymbolicLink(), `Expected an ordinary Pi license file: ${piLicenseFile}`);
  await mkdir(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (DEPLOY_METADATA.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = await lstat(from);
    check(!info.isSymbolicLink(), `Refusing pnpm deployment symlink: ${from}`);
    if (info.isDirectory()) await copyTree(from, to, [...DEPLOY_METADATA]);
    else { check(info.isFile(), `Unsupported pnpm deployment entry: ${from}`); await copyFile(from, to); }
  }
  for (const name of PI_RUNTIME_PACKAGES) {
    const packageDir = path.join(destination, name);
    const info = await lstat(packageDir);
    check(info.isDirectory() && !info.isSymbolicLink(), `Missing deployed Pi package directory: ${name}`);
    await copyFile(piLicenseFile, path.join(packageDir, 'LICENSE'));
  }
  await assertIndependentTree(destination);
  return destination;
}

export async function assertIndependentTree(root) {
  const rootInfo = await lstat(root);
  check(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), `Expected a real materialized runtime directory: ${root}`);
  const pending = [root];
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index];
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const info = await lstat(file);
      check(!info.isSymbolicLink(), `Materialized runtime contains a symlink: ${file}`);
      if (info.isDirectory()) pending.push(file);
      else check(info.isFile() && info.nlink === 1, `Materialized runtime contains a non-file or shared hardlink: ${file}`);
    }
  }
}

function ordinaryPiSourceFile(repositoryRoot, relative) {
  const segments = ['harness', 'pi', ...relative.split('/')];
  let current = repositoryRoot;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let info;
    try { info = lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    check(!info.isSymbolicLink(), `Not an ordinary source file: ${current}`);
    check(index === segments.length - 1 ? info.isFile() : info.isDirectory(), `Not an ordinary source file: ${current}`);
  }
  return current;
}

/** Only observed source mutation is retryable; invalid inputs and access failures are not. */
export class PiRuntimeSourceInstabilityError extends Error {
  constructor(relative, options) {
    super(`Source changed while snapshotting: ${relative}; retry with stable inputs`, options);
    this.name = 'PiRuntimeSourceInstabilityError';
  }
}

async function readObservedSource(file, relative, read = readFile) {
  try { return await read(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw new PiRuntimeSourceInstabilityError(relative, { cause: error });
    throw error;
  }
}

async function sourceTreeSha256(repositoryRoot = REPOSITORY, env = process.env, destination, dependencies = {}) {
  // Git-aware inventory includes current tracked modifications and nonignored new source,
  // never traversing mutable dist/node_modules. Read-only Git, no index mutations.
  const inventory = dependencies.inventory ?? execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'harness/pi'], { cwd: repositoryRoot, env, encoding: 'utf8' });
  const names = [...new Set(inventory.split('\0').filter(Boolean))].sort();
  const records = [];
  for (const name of names) {
    const relative = name.slice('harness/pi/'.length);
    check(name.startsWith('harness/pi/') && relative.length > 0, `Unexpected Pi source inventory entry: ${name}`);
    // Retained npm metadata is not an input to the shared pnpm graph.
    // Nested examples metadata remains part of the source payload.
    if (relative === 'package-lock.json') continue;
    check(!relative.split('/').some(part => ['node_modules', 'dist', '.git'].includes(part)), `Generated source inventory entry: ${name}`);
    const original = ordinaryPiSourceFile(repositoryRoot, relative);
    if (!original) continue; // A tracked deletion is absent from the current source tree.
    const bytes = await readObservedSource(original, relative, dependencies.readSource);
    if (destination) {
      const target = path.join(destination, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    }
    records.push([relative, sha(bytes)]);
  }
  check(records.length > 0, 'Imported Pi source is missing');
  for (const [relative, digest] of records) {
    const original = ordinaryPiSourceFile(repositoryRoot, relative);
    if (!original || sha(await readObservedSource(original, relative, dependencies.readSource)) !== digest) {
      throw new PiRuntimeSourceInstabilityError(relative);
    }
  }
  return sha(JSON.stringify(records));
}
async function readWorkspaceDeployInputs(repositoryRoot) {
  const paths = {
    packageManifest: path.join(repositoryRoot, 'package.json'),
    mainLock: path.join(repositoryRoot, 'pnpm-lock.yaml'),
    workspace: path.join(repositoryRoot, 'pnpm-workspace.yaml'),
    protoTools: path.join(repositoryRoot, '.prototools'),
    npmrc: path.join(repositoryRoot, '.npmrc'),
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([name, file]) => [name, await readFile(file)]));
  const bytes = Object.fromEntries(entries);
  const packageManifest = JSON.parse(bytes.packageManifest.toString('utf8'));
  const lock = parseYaml(bytes.mainLock.toString('utf8'));
  const workspace = parseYaml(bytes.workspace.toString('utf8'));
  const pinnedPackageManager = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(packageManifest.packageManager ?? '')?.[1];
  const protoToolsText = bytes.protoTools.toString('utf8');
  const pinnedProtoPnpm = /^\s*pnpm\s*=\s*["']([^"']+)["']\s*$/mu.exec(protoToolsText)?.[1];
  const pinnedNodeVersion = /^\s*node\s*=\s*["']([^"']+)["']\s*$/mu.exec(protoToolsText)?.[1];
  check(packageManifest.name === 'pi-config' && packageManifest.private === true, 'Expected the private pi-config workspace root');
  check(pinnedPackageManager, 'Root package.json must pin pnpm with packageManager');
  check(pinnedProtoPnpm === pinnedPackageManager, 'Root packageManager and .prototools pnpm pins must match');
  check(pinnedNodeVersion, '.prototools must pin the Node build toolchain');
  check(/^\s*node-linker\s*=\s*hoisted\s*$/mu.test(bytes.npmrc.toString('utf8')), 'Production deploy requires the checked-in hoisted pnpm layout');
  check(/^\s*ignore-scripts\s*=\s*true\s*$/mu.test(bytes.npmrc.toString('utf8')), 'Production deploy requires scripts-disabled pnpm settings');
  check(workspace?.injectWorkspacePackages === true && lock?.settings?.injectWorkspacePackages === true, 'Workspace injection must be enabled in pnpm configuration and lock');
  check(lock?.lockfileVersion === '9.0' && lock.importers?.['.'], 'Expected the locked pnpm v9 root importer');
  const rootDependencies = packageManifest.dependencies ?? {};
  const lockDependencies = lock.importers['.'].dependencies ?? {};
  for (const name of PI_RUNTIME_PACKAGES) {
    const relative = WORKSPACE_PACKAGE_DIRS[name];
    check(rootDependencies[name] === 'workspace:*', `Root production dependencies must include ${name} as a workspace package`);
    const version = lockDependencies[name]?.version;
    // pnpm 10 injection records file paths with optional peer-resolution suffixes.
    // Match the whole local path, not a prefix; the raw lock bytes remain fingerprinted.
    const injectedPath = typeof version === 'string'
      ? /^file:([^()]+)(?:\([^()]+\))*$/u.exec(version)?.[1] : undefined;
    check(lockDependencies[name]?.specifier === 'workspace:*' &&
      (version === `link:${relative}` || injectedPath === relative),
      `Main pnpm lock must resolve ${name} to ${relative}`);
  }
  const workspaceDirectories = new Set(workspace.packages ?? []);
  for (const relative of Object.values(WORKSPACE_PACKAGE_DIRS)) {
    check(workspaceDirectories.has(relative), `pnpm-workspace.yaml must include ${relative}`);
  }
  const digests = Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha(value)]));
  const toolchainSha256 = sha(JSON.stringify(canonical({
    packageManager: packageManifest.packageManager,
    protoTools: digests.protoTools,
    npmrc: digests.npmrc,
  })));
  const lockSha256 = sha(JSON.stringify(canonical({
    main: { packageManifest: digests.packageManifest, pnpmLock: digests.mainLock, workspace: digests.workspace },
    toolchain: toolchainSha256,
  })));
  return {
    ...digests,
    packageManifest,
    pnpmVersion: pinnedPackageManager,
    pinnedNodeVersion,
    mainLockSha256: digests.mainLock,
    toolchainSha256,
    lockSha256,
  };
}

async function capturePiRuntimeInputs({
  repositoryRoot = REPOSITORY,
  env = process.env,
  target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
  nodeVersion = process.version,
} = {}, dependencies = {}) {
  check(target && typeof target.platform === 'string' && typeof target.arch === 'string' && typeof target.nodeAbi === 'string', 'Invalid Pi runtime fingerprint target');
  check(typeof nodeVersion === 'string', 'Invalid Pi runtime fingerprint Node version');
  const workspaceRoot = dependencies.workspaceRepositoryRoot ?? (dependencies.inventory !== undefined ? REPOSITORY : repositoryRoot);
  const [sourceTreeDigest, workspace] = await Promise.all([
    sourceTreeSha256(repositoryRoot, env, undefined, dependencies),
    readWorkspaceDeployInputs(workspaceRoot),
  ]);
  return { sourceTreeSha256: sourceTreeDigest, ...workspace, target: { platform: target.platform, arch: target.arch, nodeAbi: target.nodeAbi }, nodeVersion };
}
function fingerprintPiRuntimeInputs(inputs) {
  return sha(JSON.stringify(canonical({
    sourceTreeSha256: inputs.sourceTreeSha256,
    lockSha256: inputs.lockSha256,
    target: inputs.target,
    nodeVersion: inputs.nodeVersion,
  })));
}

/** Fingerprint the exact source, shared workspace lock, toolchain and target inputs.
 * The second argument injects source inventory/reads for deterministic private-fixture races only.
 */
export async function computePiRuntimeInputFingerprint(options = {}, dependencies = {}) {
  return fingerprintPiRuntimeInputs(await capturePiRuntimeInputs(options, dependencies));
}

/** Require the shared Pi workspace compiler's evidence to match current inputs and Node. */
export async function assertPiWorkspaceBuildStamp({ workspaceRoot = SOURCE, inputFingerprint, nodeVersion = process.version } = {}) {
  check(typeof inputFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(inputFingerprint), 'Expected a valid current Pi runtime input fingerprint');
  const stampPath = path.join(workspaceRoot, '.cache', 'build.json');
  let stamp;
  try {
    const info = await lstat(stampPath);
    check(info.isFile() && info.nlink === 1, `Pi workspace build evidence must be an ordinary file: ${stampPath}`);
    stamp = await readJson(stampPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing Pi workspace build evidence at ${stampPath}; run node scripts/build/pi-workspace.mjs first`, { cause: error });
    if (error instanceof SyntaxError) throw new Error(`Invalid Pi workspace build evidence at ${stampPath}`, { cause: error });
    throw error;
  }
  check(stamp && !Array.isArray(stamp) && stamp.schema === 1, `Unsupported Pi workspace build evidence schema at ${stampPath}`);
  check(stamp.inputFingerprint === inputFingerprint, `Stale Pi workspace dist: build evidence does not match current source/lock/toolchain inputs; run node scripts/build/pi-workspace.mjs`);
  check(stamp.node === nodeVersion, `Stale Pi workspace dist: build evidence was produced by Node ${String(stamp.node)}, current Node is ${nodeVersion}; run node scripts/build/pi-workspace.mjs`);
  check(typeof stamp.compiledSha256 === 'string' && stamp.compiledSha256 === await fingerprintCompiledPiOutputs(workspaceRoot),
    'Stale Pi workspace dist: compiled bytes differ from build evidence; rebuild the Pi workspace');
  return stamp;
}

// Imported before SDK code, denies JS network/process escape points. Child's credential-free
// home is private; Node permissions additionally prohibit writes and subprocesses.
const DENY_NETWORK = `import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns'; import dgram from 'node:dgram'; import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{throw new Error('Network denied in Pi artifact smoke');};
net.connect=net.createConnection=net.Socket.prototype.connect=tls.connect=http.request=http.get=https.request=https.get=dgram.createSocket=deny;
for(const key of ['lookup','resolve','resolve4','resolve6']){dns[key]=deny;dns.promises[key]=deny;}
globalThis.fetch=deny;globalThis.WebSocket=class{constructor(){deny();}};syncBuiltinESMExports();\n`;
const SMOKE = `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import {realpathSync,existsSync} from 'node:fs'; import path from 'node:path'; import {pathToFileURL,fileURLToPath} from 'node:url';
${resolveNativeModifierHelper.toString()}
assert.throws(()=>fetch('https://network-denied.invalid'),/Network denied/);
const root=path.resolve(process.argv[2]), require=createRequire(path.join(root,'smoke-owner.cjs'));
const resolve=(name,from=root)=>fileURLToPath(import.meta.resolve(name,pathToFileURL(path.join(from,'smoke-owner.mjs')).href));
const names=${JSON.stringify(PI_RUNTIME_PACKAGES)};const loaded={};
for(const name of [...names,'@earendil-works/pi-ai/compat','@earendil-works/pi-ai/oauth','@earendil-works/pi-ai/providers/openai','typebox','typebox/compile','typebox/value']){const entry=resolve(name);assert.ok(entry.startsWith(root+path.sep),entry);loaded[name]=await import(pathToFileURL(entry).href);}
const sdk=path.join(root,'node_modules/@earendil-works/pi-coding-agent');
const schema=realpathSync(resolve('typebox'));
for(const name of names){const from=path.join(root,'node_modules',name);for(const dep of names){assert.equal(realpathSync(resolve(dep,from)),realpathSync(resolve(dep)));}assert.equal(realpathSync(resolve('typebox',from)),schema);}
assert.ok(loaded['@earendil-works/pi-ai/compat'].getModel('openai','gpt-4o-mini'));
loaded['@earendil-works/pi-coding-agent'].initTheme('dark',false);
for(const rel of ['dist/core/agent-session.js','dist/core/session-manager.js','dist/core/agent-session-runtime.js','dist/core/compaction/compaction.js'])await import(pathToFileURL(path.join(sdk,rel)).href);
const photon=require('@silvia-odwyer/photon-node');const image=new photon.PhotonImage(new Uint8Array([255,0,0,255]),1,1);assert.equal(image.get_width(),1);image.free();
assert.ok(existsSync(path.join(sdk,'dist/core/export-html/vendor/marked.min.js')));
const nativeHelper=resolveNativeModifierHelper(root,process.platform,process.arch);if(nativeHelper)require(nativeHelper);
console.log('Pi runtime offline import/identity/theme/Photon/native smoke passed');\n`;
async function smoke(runtime, work, env) {
  const deny = path.join(work, 'deny-network.mjs'); const entry = path.join(work, 'smoke.mjs');
  await writeFile(deny, DENY_NETWORK); await writeFile(entry, SMOKE);
  const flags = ['--experimental-import-meta-resolve', '--permission', `--allow-fs-read=${work}`, `--allow-fs-read=${runtime}`, '--allow-addons', '--import', pathToFileURL(deny).href];
  await run(process.execPath, [...flags, entry, runtime], work, env, 'network-denied artifact imports/assets/native smoke');
  await run(process.execPath, [...flags, path.join(runtime, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--offline', '--version'], work, env, 'network-denied source-built local CLI --version');
}

/** Explicit output owns all scratch and artifact bytes. A failed build is retained for diagnosis. */
export async function buildPiRuntime({ output, refreshLock } = {}) {
  check(refreshLock === undefined, 'The npm --refresh-lock route is retired; use the shared pnpm lock');
  assertPrivateOutput(output);
  await mkdir(output, { recursive: true });
  const work = path.join(output, 'work'); await mkdir(work);
  const env = buildChildEnvironment(process.env, work);
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'npm_config_cache']) await mkdir(env[key], { recursive: true });
  const reader = await acquireDevelopmentReader(SOURCE);
  let teardownConfirmed = true;
  try {
  const piSourceVersion = readPinnedPiSourceVersion(REPOSITORY);
  const manifests = await Promise.all(PACKAGE_DIRS.map(dir => readJson(path.join(SOURCE, 'packages', dir, 'package.json'))));
  validateManifests(manifests, piSourceVersion);
  const inputEvidence = await capturePiRuntimeInputs();
  check(inputEvidence.pinnedNodeVersion === process.version.slice(1), `Run the pinned Node ${inputEvidence.pinnedNodeVersion} toolchain (current ${process.version})`);
  const compilation = await assertPiWorkspaceBuildStamp({ inputFingerprint: fingerprintPiRuntimeInputs(inputEvidence) });
  for (const dir of PACKAGE_DIRS) {
    check(existsSync(path.join(SOURCE, 'packages', dir, 'dist')), `Missing shared Pi ${dir}/dist output; run node scripts/build/pi-workspace.mjs before production deploy`);
  }

  const deploy = path.join(work, 'deploy-staging');
  await run('proto', ['run', 'pnpm', '--', '--filter', 'pi-config', 'deploy', '--prod', deploy], REPOSITORY, process.env,
    'pnpm production workspace deploy (locked, scripts-disabled project settings)');
  const runtime = path.join(output, 'pi-runtime'); await mkdir(runtime);
  await materializeDeployedNodeModules(path.join(deploy, 'node_modules'), path.join(runtime, 'node_modules'), path.join(SOURCE, 'LICENSE'));
  check(await fingerprintCompiledPiOutputs(SOURCE, { runtimeRoot: runtime }) === compilation.compiledSha256,
    'Deployed Pi compiled bytes do not match the selected workspace compilation');
  await smoke(runtime, work, env);
  await assertPiWorkspaceBuildStamp({ inputFingerprint: fingerprintPiRuntimeInputs(inputEvidence) });

  const afterDeploy = await capturePiRuntimeInputs();
  check(fingerprintPiRuntimeInputs(inputEvidence) === fingerprintPiRuntimeInputs(afterDeploy),
    'Pi source/shared lock/toolchain/target changed during deploy; retain output and retry with stable inputs');
  const verified = await writePiRuntimeManifest(runtime, { upstreamVersion: piSourceVersion, upstreamCommit: UPSTREAM,
    sourceTreeSha256: inputEvidence.sourceTreeSha256, lockSha256: inputEvidence.lockSha256, target: inputEvidence.target });
  await verifyPiRuntimeArtifact(runtime);
  await writeFile(path.join(output, 'build-evidence.json'), jsonText({ identity: verified.identity, sdkPath: verified.sdkPath,
    sourceTreeSha256: inputEvidence.sourceTreeSha256, mainLockSha256: inputEvidence.mainLockSha256,
    lockSha256: inputEvidence.lockSha256, compiledSha256: compilation.compiledSha256,
    toolchainSha256: inputEvidence.toolchainSha256, node: process.version, pnpm: inputEvidence.pnpmVersion, offlineSmoke: true }));
  console.log(`[pi-runtime] Verified ${verified.identity}\n${runtime}`);
  return verified;
  } catch (error) {
    if (error?.teardownUnconfirmed === true) teardownConfirmed = false;
    throw error;
  } finally {
    await reader.release({ teardownConfirmed });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('node scripts/build/pi-runtime.mjs --output <new-absolute-private-directory>\nLocked pnpm production deploy/materialize/offline smoke/verify (requires current harness/pi/.cache/build.json evidence; run scripts/build/pi-workspace.mjs first).');
  else {
    const outputIndex = args.indexOf('--output');
    check(outputIndex >= 0 && args[outputIndex + 1], 'Required --output <new-absolute-private-directory>');
    const valid = args.filter((_, i) => i !== outputIndex && i !== outputIndex + 1);
    check(valid.length === 0, 'Unknown builder argument (the npm --refresh-lock route is retired)');
    buildPiRuntime({ output: args[outputIndex + 1] }).catch(error => { console.error(error); process.exitCode = 1; });
  }
}
