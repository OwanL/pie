#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withDevelopmentSdkReader } from '../lib/development-sdk-reader.mjs';
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
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === 'NODE_PATH' || /^(?:PI|PIE)_/iu.test(name) || CREDENTIAL_OR_LIVE_ENV.test(name)) delete env[name];
  }
  delete env.XDG_CACHE_HOME;
  Object.assign(env, {
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
  });
  return { root, env };
}

function unconfirmedTeardownError(message, profileRoot, cause) {
  return Object.assign(new Error(`${message} Retaining the private profile at ${profileRoot} and its Pi workspace reader registration.`, { cause }), {
    teardownUnconfirmed: true,
    profileRoot,
  });
}

/** Run one explicitly selected workspace package's pinned Vitest CLI. */
export async function runOfflineVitest(packageName, vitestArgs, {
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
    return await runOfflineVitest(parsed.packageName, parsed.vitestArgs, {
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
