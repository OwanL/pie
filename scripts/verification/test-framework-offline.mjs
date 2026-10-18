#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDevelopmentSdkWorkspaceRoot, withDevelopmentSdkReader } from '../lib/development-sdk-reader.mjs';
import { runInNativeTrustedKeeper } from './native-test-keeper.mjs';
import { runOwnedTestDriver } from './owned-test-driver.mjs';
import { createOwnerRequire } from '../lib/package-resolution.mjs';
import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import {
  abortOnProcessSignals,
  resolveChildProcessTimeoutMs,
  watchChildProcess,
  withProcessTreeIsolation,
} from '../lib/process-watchdog.mjs';
import { verificationChildEnv } from './verification-runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageDirectories = Object.freeze({
  ai: ['harness', 'pi', 'packages', 'ai'],
  agent: ['harness', 'pi', 'packages', 'agent'],
  'coding-agent': ['harness', 'pi', 'packages', 'coding-agent'],
});
const packageNames = Object.freeze({
  ai: '@earendil-works/pi-ai',
  agent: '@earendil-works/pi-agent-core',
  'coding-agent': '@earendil-works/pi-coding-agent',
});
const TEARDOWN_UNCONFIRMED_EXIT_CODE = 125;
const CREDENTIAL_OR_LIVE_ENV = /(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|CREDENTIAL|AUTH|PASSWORD|BEARER|COOKIE|PRIVATE_KEY|LIVE|PRODUCTION)/iu;
const networkDenialPreloader = path.join(repositoryRoot, 'scripts', 'development', 'test', 'vscode-development-stub.cjs');

export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  let index = 0;
  let packageName;
  if (argv[index] === '--package') {
    packageName = argv[index + 1];
    index += 2;
  } else if (argv[index]?.startsWith('--package=')) {
    packageName = argv[index].slice('--package='.length);
    index += 1;
  } else {
    throw new Error('Expected --package ai|agent|coding-agent.');
  }
  if (!Object.hasOwn(packageDirectories, packageName)) {
    throw new Error(`Unsupported Pi package "${packageName}"; choose ai, agent, or coding-agent.`);
  }
  if (argv[index] !== '--') throw new Error('Separate Vitest arguments with --.');
  return { packageName, vitestArgs: argv.slice(index + 1) };
}

function resolveFrameworkInvocation(packageName, root) {
  const relativePackage = packageDirectories[packageName];
  if (!relativePackage) throw new Error(`Unsupported Pi package "${packageName}".`);
  const packageRoot = path.resolve(root, ...relativePackage);
  const manifestPath = path.join(packageRoot, 'package.json');
  if (!existsSync(manifestPath)) throw new Error(`Pi package manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== packageNames[packageName]) {
    throw new Error(`Expected ${packageNames[packageName]} at ${manifestPath}, found ${manifest.name ?? '(unnamed package)'}.`);
  }
  const pinnedVitest = manifest.devDependencies?.vitest;
  if (typeof pinnedVitest !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(pinnedVitest)) {
    throw new Error(`${manifest.name ?? packageName} must declare an exact devDependency pin for Vitest.`);
  }
  if (typeof manifest.main !== 'string') throw new Error(`${manifest.name ?? packageName} has no compiled package entry.`);
  const compiledEntry = path.resolve(packageRoot, manifest.main);
  if (!existsSync(compiledEntry)) {
    throw new Error(`Pi package is not compiled; expected ${compiledEntry}. Build the Pi workspace separately before this test-only invocation.`);
  }

  // Resolve from the selected Pi package's own dependency context, never cwd or
  // Pie's application dependency owner, then verify the resolved CLI matches its pin.
  const packageRequire = createOwnerRequire({ dependencyOwnerRoot: packageRoot });
  let vitestManifestPath;
  try {
    vitestManifestPath = packageRequire.resolve('vitest/package.json');
  } catch (error) {
    throw new Error(`Could not resolve the pinned Vitest package from ${manifest.name ?? packageName}: ${error.message}`, { cause: error });
  }
  const actualVitest = JSON.parse(readFileSync(vitestManifestPath, 'utf8'));
  if (actualVitest.version !== pinnedVitest) {
    throw new Error(`${manifest.name ?? packageName} pins Vitest ${pinnedVitest}, but its package context resolves ${actualVitest.version ?? '(unknown)'}.`);
  }
  const cliEntry = typeof actualVitest.bin === 'string' ? actualVitest.bin : actualVitest.bin?.vitest;
  if (typeof cliEntry !== 'string') throw new Error(`Resolved Vitest ${pinnedVitest} does not declare its vitest CLI bin.`);
  const cliPath = path.resolve(path.dirname(vitestManifestPath), cliEntry);
  if (!existsSync(cliPath)) throw new Error(`Resolved Vitest CLI entry is missing: ${cliPath}`);
  return { packageRoot, cliPath, packageName };
}

async function createPrivateProfile(sourceEnv) {
  if (!existsSync(networkDenialPreloader)) {
    throw new Error(`Offline test network-denial preloader is missing: ${networkDenialPreloader}`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-framework-offline-'));
  const directories = Object.fromEntries([
    'home', 'config', 'agent', 'auth', 'sessions', 'data', 'temp',
    'xdg-config', 'xdg-data', 'appdata', 'localappdata',
  ].map((name) => [name, path.join(root, name)]));
  try {
    await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true })));
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  const env = verificationChildEnv(withoutPiHarnessEnv(withoutGitRepositoryEnv(sourceEnv)));
  // Windows names are case-insensitive. Read and write through the key casing
  // already present so fallback/profile insertion cannot add a duplicate that
  // the owned-tree CreateProcess environment rejects. Other platforms retain
  // exact-name lookup and assignment semantics.
  const windows = process.platform === 'win32';
  const findEnvKey = windows ? (source, name) => {
    const normalized = name.toLowerCase();
    return Object.keys(source).find((key) => key.toLowerCase() === normalized);
  } : undefined;
  const readEnv = windows ? (source, name) => {
    const key = findEnvKey(source, name);
    return key === undefined ? undefined : source[key];
  } : (source, name) => source[name];
  const writeEnv = windows ? (name, value) => {
    const key = findEnvKey(env, name);
    if (key === undefined) env[name] = value;
    else env[key] = value;
  } : (name, value) => { env[name] = value; };
  const deleteEnv = windows ? (name) => {
    const key = findEnvKey(env, name);
    if (key !== undefined) delete env[key];
  } : (name) => { delete env[name]; };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === 'NODE_PATH' || /^(?:PI|PIE)_/iu.test(name) || CREDENTIAL_OR_LIVE_ENV.test(name)) delete env[name];
  }
  deleteEnv('XDG_CACHE_HOME');
  // Private user state is isolated above; standard Windows system variables
  // are not user state. Kernel-contained children fail Node initialization
  // without SystemRoot (the CSPRNG provider cannot load), so absent base
  // system variables are preserved from this owning process instead.
  for (const name of ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATH', 'PATHEXT']) {
    if (readEnv(env, name) !== undefined) continue;
    const base = readEnv(sourceEnv, name) ?? readEnv(process.env, name);
    if (base !== undefined) writeEnv(name, base);
  }
  for (const [name, value] of Object.entries({
    HOME: directories.home,
    USERPROFILE: directories.home,
    APPDATA: directories.appdata,
    LOCALAPPDATA: directories.localappdata,
    TEMP: directories.temp,
    TMP: directories.temp,
    TMPDIR: directories.temp,
    XDG_CONFIG_HOME: directories['xdg-config'],
    XDG_DATA_HOME: directories['xdg-data'],
    // Upstream local-model suites auto-enable when Ollama is on PATH. This
    // explicit offline invocation must not start it, pull models, or call it.
    PI_NO_LOCAL_LLM: '1',
    PI_CONFIG_DIR: directories.config,
    PI_CODING_AGENT_DIR: directories.agent,
    PI_CODING_AGENT_AUTH_DIR: directories.auth,
    PI_CODING_AGENT_SESSION_DIR: directories.sessions,
    PIE_DATA_DIR: directories.data,
    // The existing development preloader supplies network denial and permits
    // loopback; it is a standalone Node preload and does not launch VS Code.
    NODE_OPTIONS: `--require ${JSON.stringify(networkDenialPreloader.replaceAll('\\', '/'))}`,
  })) writeEnv(name, value);
  return { root, env };
}

function unconfirmedTeardownError(message, profileRoot, cause) {
  return Object.assign(new Error(`${message} Retaining the private profile at ${profileRoot} and its Pi workspace reader registration.`, { cause }), {
    teardownUnconfirmed: true,
    profileRoot,
  });
}

/** Keeper-process workspace admission check for the offline facade: the
 * coding-agent package is the canonical reader identity for the whole Pi
 * workspace, including invocations targeting its ai and agent packages. */
export function resolveOfflineWorkspaceRoot(root = repositoryRoot) {
  return resolveDevelopmentSdkWorkspaceRoot(path.resolve(root, ...packageDirectories['coding-agent']), { root });
}

/** Keeper-process offline entry. The lease has acquired the workspace reader
 * before this validation/profile work began; the pinned Vitest child runs
 * through the single kernel owned driver and its reader is released only on
 * that driver's verified matching tree-empty proof. Vitest children wait on no
 * ownership preload (the Job already contains their whole tree), so startup
 * authorization is a no-token stdin close, and child output keeps the
 * `inherit` parity of the local route by forwarding to the keeper console. */
export async function runOwnedOfflineVitest(invocation, options = {}, owner = {}) {
  const root = path.resolve(options.root ?? options.repoRoot ?? repositoryRoot);
  const framework = resolveFrameworkInvocation(invocation.packageName, root);
  const profile = await createPrivateProfile(options.env ?? process.env);
  await owner.writeLifetime?.({ profileRoot: profile.root, packageRoot: framework.packageRoot, cliPath: framework.cliPath, packageName: framework.packageName });
  owner.markAdmission?.();
  const result = await runOwnedTestDriver({
    configRoot: profile.root,
    args: [framework.cliPath, '--run', ...invocation.vitestArgs],
    // Confirmed cleanup removes the private profile like the local route's
    // teardown-confirmed path does; uncertain teardown retains it.
    dispose() { rmSync(profile.root, { recursive: true, force: true }); },
  }, {
    cwd: framework.packageRoot,
    env: profile.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? resolveChildProcessTimeoutMs(),
    authorizationText: '',
    onTerminate: ({ reason }) => {
      console.error(`\nPi ${framework.packageName} Vitest ${reason === 'timeout' ? 'timed out' : 'was cancelled'}; terminating its process tree.`);
    },
  }, { ...owner });
  // Reserve 125 for unconfirmed teardown, just as the local route does.
  return { ...result, code: result.code === TEARDOWN_UNCONFIRMED_EXIT_CODE ? 1 : result.code };
}

/** Explicit local seam for non-contained callers and isolated unit tests;
 * native Windows workspace readers must be held by the keeper via the shared
 * kernel owned driver instead. */
export async function runOfflineVitestLocal(packageName, vitestArgs, {
  root = repositoryRoot,
  env = process.env,
  signal,
  spawnImpl = spawn,
  watchChildProcessImpl = watchChildProcess,
  timeoutMs = resolveChildProcessTimeoutMs(),
} = {}) {
  // The coding-agent package is the canonical reader identity for the whole Pi
  // workspace, including invocations targeting its ai and agent packages.
  const codingAgentPath = path.resolve(root, ...packageDirectories['coding-agent']);
  const result = await withDevelopmentSdkReader(codingAgentPath, async () => {
    const invocation = resolveFrameworkInvocation(packageName, root);
    const profile = await createPrivateProfile(env);
    let teardownConfirmed = true;
    let childLaunched = false;
    try {
      const child = spawnImpl(process.execPath, [invocation.cliPath, '--run', ...vitestArgs], withProcessTreeIsolation({
        cwd: invocation.packageRoot,
        env: profile.env,
        stdio: 'inherit',
        windowsHide: true,
      }));
      childLaunched = true;
      teardownConfirmed = false;

      let spawnError;
      child.on('error', (error) => { spawnError = error; });
      const closed = new Promise((resolve) => child.once('close', (code, signalName) => resolve({ code, signalName })));
      let watchdog;
      try {
        watchdog = watchChildProcessImpl(child, {
          timeoutMs,
          signal,
          label: `Pi ${packageName} Vitest`,
          onTerminate: ({ reason }) => {
            console.error(`\nPi ${packageName} Vitest ${reason === 'timeout' ? 'timed out' : 'was cancelled'}; terminating its process tree.`);
          },
        });
      } catch (error) {
        throw unconfirmedTeardownError('Vitest child started but its process-tree watchdog could not be established.', profile.root, error);
      }

      const result = await closed;
      let cleanup;
      try {
        cleanup = await watchdog.settle();
      } catch (error) {
        throw unconfirmedTeardownError('Vitest process-tree teardown could not be confirmed.', profile.root, error);
      }
      if (!cleanup?.gone) {
        const detail = cleanup?.diagnostics?.join('; ') || `survivors: ${(cleanup?.survivors ?? []).join(', ') || 'unknown'}`;
        throw unconfirmedTeardownError(`Vitest process-tree teardown is unconfirmed (${detail}).`, profile.root);
      }
      teardownConfirmed = true;
      if (spawnError) console.error(`Pi ${packageName} Vitest could not start: ${spawnError.message}`);
      const childCode = spawnError ? 1 : (result.code ?? 1);
      const code = watchdog.timedOut || watchdog.aborted || childCode === TEARDOWN_UNCONFIRMED_EXIT_CODE
        ? 1 : childCode;
      return { code, teardownConfirmed: true };
    } catch (error) {
      if (error?.teardownUnconfirmed === true) teardownConfirmed = false;
      else if (childLaunched && !teardownConfirmed) {
        throw unconfirmedTeardownError('Vitest child ended before its process-tree teardown could be confirmed.', profile.root, error);
      }
      throw error;
    } finally {
      if (teardownConfirmed) await rm(profile.root, { recursive: true, force: true });
    }
  }, { root });
  return result.code;
}

/** Run one explicitly selected workspace package's pinned Vitest CLI. On
 * Windows against this repository's native Pi workspace the reader lifetime is
 * delegated to the detached keeper (which acquires before validation/profile
 * and releases only on the shared kernel owned driver's matching tree-empty
 * proof); materialized and non-Windows selections keep the local watchdog
 * lifetime. */
export async function runOfflineVitest(packageName, vitestArgs, options = {}) {
  const { root = repositoryRoot, runInKeeper, ...localOptions } = options;
  const resolvedRoot = path.resolve(root);
  if (process.platform === 'win32' && resolveOfflineWorkspaceRoot(resolvedRoot)) {
    // Delegate BEFORE acquisition/validation/profile. The local runner
    // injections (spawnImpl/watchChildProcessImpl) are local-route seams and
    // must never silently bypass production containment.
    const result = await (runInKeeper ?? runInNativeTrustedKeeper)('offline', { packageName, vitestArgs }, {
      repoRoot: resolvedRoot,
      cwd: repositoryRoot,
      root: resolvedRoot,
      env: localOptions.env ?? process.env,
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return result.code;
  }
  return runOfflineVitestLocal(packageName, vitestArgs, { ...localOptions, root: resolvedRoot });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) {
      console.log('Usage: node scripts/verification/test-framework-offline.mjs --package ai|agent|coding-agent -- [Vitest args]');
      console.log('Runs the package-pinned Vitest CLI once, with private Pi state and invocation-only network denial.');
      return 0;
    }
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const abort = (dependencies.abortOnProcessSignals ?? abortOnProcessSignals)();
  try {
    return await (dependencies.runOfflineVitest ?? runOfflineVitest)(parsed.packageName, parsed.vitestArgs, {
      ...(dependencies.runOptions ?? {}),
      signal: abort.signal,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error?.teardownUnconfirmed === true ? TEARDOWN_UNCONFIRMED_EXIT_CODE : 1;
  } finally {
    abort.dispose();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
