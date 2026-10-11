// Internal, opt-in source snapshot factory. No build, publication, or primary gate writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { watchChildProcess, withProcessTreeIsolation } from '../lib/process-watchdog.mjs';
import { PROTECTED_DIRECTORY_NAMES } from '../../harness/tools/execution-safety/traversal-policy.ts';
import { computePiRuntimeInputFingerprint, buildChildEnvironment, resolvePiBuildContext, run } from './pi-runtime.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const within = (root, file) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const protectedNames = PROTECTED_DIRECTORY_NAMES.map(name => new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'i'));

export function validateSnapshotPath(name) {
  check(typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes('\0'), `Unsafe snapshot path: ${name}`);
  const parts = name.split('/');
  check(parts.every(part => part && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/u.test(part)
    && !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)), `Unsafe snapshot path: ${name}`);
  return parts;
}

function selected(name, tracked) {
  const directories = validateSnapshotPath(name).slice(0, -1);
  // Exact tracked source is deliberate inventory, not broad traversal. Never
  // promote untracked dependency, generated, or runtime-user trees to source.
  if (directories.some(part => ['.git', 'node_modules'].includes(part.toLowerCase()))) return false;
  const canonicalTrackedSource = tracked && name.startsWith('harness/pi/')
    && name !== 'harness/pi/package-lock.json'
    && !directories.some(part => part === 'dist');
  if (!canonicalTrackedSource && directories.some(part => ['sessions', 'logs'].includes(part.toLowerCase()))) return false;
  return tracked || !directories.some(part => protectedNames.some(pattern => pattern.test(part)));
}

function git(root, env, args, input) {
  return execFileSync('git', args, { cwd: root, env, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true });
}

async function observe(root, env) {
  check(!git(root, env, ['ls-files', '-z', '--unmerged']), 'Unmerged source index; resolve conflicts before snapshotting');
  const cached = git(root, env, ['ls-files', '-z', '--cached']);
  const others = git(root, env, ['ls-files', '-z', '--others', '--exclude-standard']);
  const tracked = new Set(cached.split('\0').filter(Boolean));
  const inventory = JSON.stringify([cached, others]);
  const names = [...new Set([...tracked, ...others.split('\0').filter(Boolean)])].sort();
  check(names.length <= 100_000, 'Snapshot inventory exceeds bound');
  const folded = new Map();
  const records = [];
  let total = 0;
  for (const name of names) {
    if (!selected(name, tracked.has(name))) continue;
    const parts = validateSnapshotPath(name);
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      const key = prefix.toLowerCase();
      check(!folded.has(key) || folded.get(key) === prefix, `Ambiguous case-folded snapshot path: ${name}`);
      folded.set(key, prefix);
    }
    let current = root;
    let absent = false;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let info;
      try { info = await fs.lstat(current); }
      catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; break; }
      check(!info.isSymbolicLink() && await fs.realpath(current) === current, `Linked snapshot input: ${name}`);
      check(index === parts.length - 1 ? info.isFile() : info.isDirectory(), `Nonordinary snapshot input: ${name}`);
      if (index === parts.length - 1) check(info.size <= 512 * 1024 * 1024 - total, 'Snapshot source exceeds 512 MiB bound');
    }
    if (absent) { records.push([name, null]); continue; }
    const bytes = await fs.readFile(current);
    total += bytes.length;
    check(total <= 512 * 1024 * 1024, 'Snapshot source exceeds 512 MiB bound');
    records.push([name, hash(bytes), bytes]);
  }
  const proof = hash(JSON.stringify([inventory, records.map(([name, digest]) => [name, digest])]));
  return { records, proof };
}

// Traverse physical entries only: aliases must not multiply the installed graph.
async function physicalTree(root, visit) {
  async function walk(file) {
    const info = await fs.lstat(file);
    await visit(file, info);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      check(await fs.realpath(file) === file, `Unsupported dependency reparse point: ${file}`);
      for (const name of await fs.readdir(file)) {
        validateSnapshotPath(name);
        await walk(path.join(file, name));
      }
    }
  }
  await walk(root);
}

export async function assertPrivateWorkspaceTree(root) {
  check(await fs.realpath(root) === root, 'Private workspace root is linked');
  await physicalTree(root, async (file, info) => {
    if (info.isSymbolicLink()) {
      const target = await fs.realpath(file); // rejects dangling and unresolvable loops
      check(within(root, target), `Dependency link escapes private workspace: ${file}`);
    } else {
      check(info.isDirectory() || info.isFile(), `Nonordinary dependency: ${file}`);
      check(await fs.realpath(file) === file, `Unsupported dependency reparse point: ${file}`);
      if (info.isFile()) check(info.nlink === 1, `Shared private workspace file: ${file}`);
    }
  });
}

export async function materializePrivateWorkspace(from, to) {
  check(await fs.realpath(from) === from, 'Dependency source root is linked');
  const links = [];
  const counts = { files: 0, directories: 0, links: 0, bytes: 0 };
  await physicalTree(from, async (file, info) => {
    const destination = path.join(to, path.relative(from, file));
    if (info.isSymbolicLink()) {
      const target = await fs.realpath(file);
      check(within(from, target), `Dependency link escapes owned source snapshot: ${file}`);
      const targetInfo = await fs.stat(target);
      check(targetInfo.isDirectory() || targetInfo.isFile(), `Nonordinary dependency target: ${file}`);
      links.push({ destination, target: path.join(to, path.relative(from, target)), directory: targetInfo.isDirectory() });
      counts.links++;
    } else if (info.isDirectory()) {
      await fs.mkdir(destination);
      counts.directories++;
    } else {
      check(info.isFile() && await fs.realpath(file) === file, `Nonordinary dependency: ${file}`);
      await fs.copyFile(file, destination, fs.constants.COPYFILE_EXCL);
      counts.files++; counts.bytes += info.size;
    }
  });
  for (const { destination, target, directory } of links) {
    const junction = process.platform === 'win32' && directory;
    await fs.symlink(junction ? target : path.relative(path.dirname(destination), target), destination, junction ? 'junction' : directory ? 'dir' : 'file');
  }
  await assertPrivateWorkspaceTree(to);
  return counts;
}

/**
 * createIsolatedPiWorkspace({ repositoryRoot, pnpmCli, networkPolicy: 'offline'|'allow', env?, signal? }, dependencies?)
 * -> { context, provenance, scratchRoot, cleanup({teardownConfirmed}) }.
 * pnpmCli is an existing absolute JS entrypoint, executed by the pinned Node;
 * version is checked before install. No acquisition/global changes are allowed.
 * Failures carry scratchRoot and cleanup; uncertain children permanently retain it.
 * dependencies.run/version/afterCapture are narrow offline test seams, never inventory overrides.
 */
export async function createIsolatedPiWorkspace({ repositoryRoot, pnpmCli, networkPolicy, env = process.env, signal } = {}, dependencies = {}) {
  check(['offline', 'allow'].includes(networkPolicy), 'Explicit dependency networkPolicy is required');
  check(typeof pnpmCli === 'string' && path.isAbsolute(pnpmCli), 'An existing absolute pnpm JS entrypoint is required');
  const root = await fs.realpath(repositoryRoot);
  const scratchRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pie-isolated-sdk-')));
  check(!within(root, scratchRoot), 'Scratch must be outside primary checkout');
  const token = randomUUID();
  const marker = path.join(scratchRoot, 'ownership.json');
  await fs.writeFile(marker, JSON.stringify({ token }), { flag: 'wx' });
  let uncertain = false;
  let removed = false;
  const cleanup = async ({ teardownConfirmed } = {}) => {
    check(typeof teardownConfirmed === 'boolean', 'cleanup requires explicit teardownConfirmed');
    if (!teardownConfirmed || uncertain || removed) return false;
    check(await fs.realpath(scratchRoot) === scratchRoot && !(await fs.lstat(marker)).isSymbolicLink()
      && (await fs.lstat(marker)).nlink === 1 && JSON.parse(await fs.readFile(marker, 'utf8')).token === token, 'Scratch ownership changed; retained');
    await fs.rm(scratchRoot, { recursive: true }); removed = true; return true;
  };
  try {
    const childEnv = buildChildEnvironment(env, scratchRoot);
    for (const directory of ['home', 'temp', 'npm-cache', 'store', 'cache', 'state']) await fs.mkdir(path.join(scratchRoot, directory));
    const emptyConfig = path.join(scratchRoot, 'empty-config'); await fs.writeFile(emptyConfig, '');
    Object.assign(childEnv, { XDG_CACHE_HOME: path.join(scratchRoot, 'cache'), XDG_CONFIG_HOME: path.join(scratchRoot, 'home'), XDG_DATA_HOME: path.join(scratchRoot, 'state'),
      npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0' });
    const captured = await observe(root, childEnv);
    let snapshot = path.join(scratchRoot, 'repository'); await fs.mkdir(snapshot);
    for (const [name, digest, bytes] of captured.records) {
      if (digest === null) continue;
      const destination = path.join(snapshot, ...validateSnapshotPath(name));
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: 'wx' });
    }
    await dependencies.afterCapture?.({ scratchRoot, snapshot });
    check((await observe(root, childEnv)).proof === captured.proof, 'Source inventory/bytes changed during snapshot');
    git(snapshot, childEnv, ['init', '--quiet', '--template=']);
    git(snapshot, childEnv, ['update-index', '--add', '-z', '--stdin'], captured.records.filter(([, digest]) => digest !== null).map(([name]) => name).join('\0') + '\0');
    // Delegate required-source selection to the canonical fingerprint authority.
    // Full-repository support files are additional inputs, never a substitute.
    const fingerprint = await computePiRuntimeInputFingerprint({ repositoryRoot: root, env: childEnv });
    check(await computePiRuntimeInputFingerprint({ repositoryRoot: snapshot, env: childEnv }) === fingerprint, 'Snapshot canonical input fingerprint mismatch');
    const tools = await fs.readFile(path.join(snapshot, '.prototools'), 'utf8');
    const node = /^\s*node\s*=\s*["']([^"']+)["']\s*$/mu.exec(tools)?.[1];
    const pnpm = /^\s*pnpm\s*=\s*["']([^"']+)["']\s*$/mu.exec(tools)?.[1];
    check(node === process.versions.node && pnpm && JSON.parse(await fs.readFile(path.join(snapshot, 'package.json'), 'utf8')).packageManager === `pnpm@${pnpm}`, 'Pinned toolchain mismatch');
    // The existing watchdog runner owns every install descendant and reports
    // teardown uncertainty. Signal forwarding uses its supported watch seam.
    const execute = dependencies.run ?? run;
    const runnerDependencies = { watchChildProcess: (child, options) => watchChildProcess(child, { ...options, signal, timeoutMs: 20 * 60 * 1000 }) };
    const version = await (dependencies.version ?? readPnpmVersion)(pnpmCli, snapshot, childEnv, signal);
    check(version === pnpm, 'pnpm executable does not match toolchain authority');
    await execute(process.execPath, [pnpmCli, 'install', '--frozen-lockfile', '--ignore-scripts', '--package-import-method=copy', '--store-dir', path.join(scratchRoot, 'store'), ...(networkPolicy === 'offline' ? ['--offline'] : [])], snapshot, childEnv, 'isolated SDK dependencies', runnerDependencies);
    const ordinary = path.join(scratchRoot, 'ordinary-repository');
    await materializePrivateWorkspace(snapshot, ordinary);
    await fs.rm(snapshot, { recursive: true });
    // Keep the destination stable: Windows junctions use native absolute targets.
    snapshot = ordinary;
    await assertPrivateWorkspaceTree(snapshot);
    check((await observe(root, childEnv)).proof === captured.proof, 'Primary source/lock changed during dependency installation');
    // The installed snapshot's source is observed using its private Git index;
    // ignored installation outputs are not an alternate fingerprint authority.
    const after = await observe(snapshot, childEnv);
    check(JSON.stringify(after.records.map(([name, digest]) => [name, digest])) === JSON.stringify(captured.records.filter(([, digest]) => digest !== null).map(([name, digest]) => [name, digest])), 'Snapshot source/lock changed during installation');
    check(await computePiRuntimeInputFingerprint({ repositoryRoot: snapshot, env: childEnv }) === fingerprint, 'Snapshot canonical input fingerprint changed during installation');
    const context = resolvePiBuildContext({ repositoryRoot: snapshot, dependencyOwnerRoot: snapshot, env: childEnv });
    return { context, scratchRoot, provenance: { schema: 1, sourceRoot: root, inventorySha256: captured.proof, files: captured.records.length, node, pnpm }, cleanup };
  } catch (error) {
    uncertain = error.teardownUnconfirmed === true;
    Object.assign(error, { scratchRoot, cleanup }); throw error;
  }
}

// Keep the root live until the watchdog has completed its synchronous Windows
// ownership census. A short --version command can otherwise exit between the
// census and its root verification. Execute the CLI in this same owned process.
const versionLauncher = `process.stdin.resume(); process.stdin.once('end', () => {
  const cli = process.argv[1]; process.argv = [process.execPath, cli, '--version'];
  require(cli);
});`;

export async function readPnpmVersion(cli, cwd, env, signal, dependencies = {}) {
  const child = (dependencies.spawn ?? spawn)(process.execPath, ['-e', versionLauncher, cli], withProcessTreeIsolation({ cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
  // Register completion before any synchronous ownership capture or release.
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  child.stdin.on('error', () => {}); // completion/teardown remain authoritative
  let output = '';
  child.stdout.on('data', bytes => { if (output.length < 4096) output += bytes; });
  const watchdog = (dependencies.watchChildProcess ?? watchChildProcess)(child, { signal, timeoutMs: 30_000, label: 'private pnpm version' });
  let code;
  try {
    if (!watchdog.terminationStarted) child.stdin.end();
    code = await completion;
  } finally {
    let tree;
    try { tree = await watchdog.settle(); }
    catch (error) { tree = { gone: false, diagnostics: [error.message] }; }
    if (tree?.gone !== true) throw Object.assign(new Error('pnpm version teardown unconfirmed'), { teardownUnconfirmed: true, teardown: tree });
  }
  check(code === 0 && !watchdog.aborted && !watchdog.timedOut, 'pnpm version check failed');
  return output.trim();
}
