#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { abortOnProcessSignals, resolveChildProcessTimeoutMs, watchChildProcess, withProcessTreeIsolation } from '../lib/process-watchdog.mjs';
import { verificationChildEnv } from './verification-runtime.mjs';
import { createOwnerRequire } from '../lib/package-resolution.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const HELP = 'Usage: node scripts/verification/qualify-delivery.mjs [--pi-runtime <absolute artifact root>]\nBuild and qualify a new private external delivery (both headless adapters + browser).\nDefault: gated Pi compilation, then fresh delivery build. Explicit runtime: verify/reuse, no Pi compilation.\nNo installation, publication, Electron, provider prompts or browser download.';

export function parseQualificationArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  let artifactDir;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--pi-runtime' && !arg.startsWith('--pi-runtime=')) throw new Error(`Unknown delivery qualification option: ${arg}`);
    if (artifactDir !== undefined) throw new Error('--pi-runtime may be specified only once.');
    const value = arg === '--pi-runtime' ? argv[++index] : arg.slice('--pi-runtime='.length);
    if (!value || value.startsWith('--') || !path.isAbsolute(value)) throw new Error('--pi-runtime requires an absolute artifact root.');
    artifactDir = path.resolve(value);
  }
  return { artifactDir };
}

// This is command composition, not another build graph or test runner.
export function qualificationStages(root, packageRoot, artifactDir, browserExecutable) {
  return [
    ...(artifactDir === undefined ? [{ name: 'pi-compile', args: [path.join(root, 'scripts/build/pi-workspace.mjs')] }] : []),
    { name: 'delivery-build', args: [path.join(root, 'scripts/build/build.mjs'), '--delivery', '--no-sync', '--output-dir', path.join(packageRoot, 'out'),
      ...(artifactDir === undefined ? [] : ['--pi-runtime', artifactDir])] },
    { name: 'delivered-hosts', args: [path.join(root, 'scripts/verification/test-node.mjs'), 'scripts/verification/test/delivered-hosts.test.mjs'],
      env: { PIE_RUN_DELIVERED_HOST_TESTS: '1', PIE_RUN_DELIVERED_BROWSER_TESTS: '1', PIE_DELIVERED_HOST_ROOT: packageRoot,
        ...(browserExecutable === undefined ? {} : { PIE_DELIVERED_BROWSER_EXECUTABLE: browserExecutable }) } },
  ];
}

export async function copyPackageSkeleton(root, packageRoot) {
  const source = path.join(root, 'application/hosts/vscode');
  await mkdir(path.join(packageRoot, 'runtime'));
  await mkdir(path.join(packageRoot, 'media'));
  await copyFile(path.join(source, 'package.json'), path.join(packageRoot, 'package.json'));
  await copyFile(path.join(source, 'media/icon.svg'), path.join(packageRoot, 'media/icon.svg'));
  for (const entry of await readdir(path.join(source, 'runtime'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cjs')) {
      // Source windows-runtime-lock.cjs is a checkout-relative forwarding
      // adapter, not packageable bytes. Packaged startup loaders ship the
      // standalone neutral owner bytes (the same authority installRuntimeBootstrap
      // packages), so a relocated delivery package stays self-contained.
      const copySource = entry.name === 'windows-runtime-lock.cjs'
        ? path.join(root, 'lib/windows-runtime-lock/windows-runtime-lock.cjs')
        : path.join(source, 'runtime', entry.name);
      await copyFile(copySource, path.join(packageRoot, 'runtime', entry.name));
    }
  }
}

/** Outer completion alone is insufficient: nested failure/125 or cancellation retains evidence. */
export async function runQualificationStage(stage, { root, signal, env }, dependencies = {}) {
  signal?.throwIfAborted();
  const spawnImpl = dependencies.spawn ?? spawn;
  const watch = dependencies.watchChildProcess ?? watchChildProcess;
  const child = spawnImpl(process.execPath, stage.args, withProcessTreeIsolation({
    cwd: root, env: { ...env, ...stage.env }, stdio: 'inherit', windowsHide: true,
  }));
  let completion;
  let onClose;
  const closed = new Promise(resolve => {
    onClose = (code, childSignal) => { completion = { code, signal: childSignal }; resolve(); };
    child.once('close', onClose);
  });
  let onTerminate;
  const terminating = new Promise(resolve => { onTerminate = resolve; });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const watchdog = watch(child, { signal, timeoutMs: resolveChildProcessTimeoutMs(), label: `delivery qualification ${stage.name}`, onTerminate });
  // Identity-safe termination may finish uncertain without a close event. Do
  // not block settlement (or CLI exit) waiting for that unresolved child.
  await Promise.race([closed, terminating]);
  const tree = await watchdog.settle().catch(() => ({ gone: false, survivors: [] }));
  if (!completion) {
    child.removeListener('close', onClose);
    child.unref?.(); // stdio is inherited, so no pipe handles keep the CLI alive
  }
  const outerConfirmed = Boolean(completion) && tree.gone === true && tree.survivors?.length === 0;
  const interrupted = watchdog.aborted || watchdog.timedOut || signal?.aborted || Boolean(completion?.signal);
  // Build failures have no nested teardown protocol. Successful existing authorities
  // await their owned work; test-node reserves 125 for unconfirmed nested teardown.
  // Retain on *any* nonzero test status too: fixtures can report inner uncertainty
  // as an assertion failure, and we must not infer safety from outer extinction.
  return {
    code: spawnError || interrupted ? 1 : (completion?.code ?? 1),
    outerConfirmed,
    innerConfirmed: !spawnError && !interrupted && completion?.code === 0,
  };
}

export async function validateBrowserExecutable(executablePath) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) throw new Error('Chromium executable must be an absolute path.');
  const info = await lstat(executablePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Chromium executable must be a regular file: ${executablePath}`);
  await access(executablePath, constants.X_OK);
  return executablePath;
}

export function resolveQualificationBrowserExecutable() {
  return createOwnerRequire()('@playwright/test').chromium.executablePath();
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function qualifyDelivery(selection = {}, signal, dependencies = {}) {
  const root = dependencies.root ?? repositoryRoot;
  const status = dependencies.status ?? (message => console.log(`[qualify-delivery] ${message}`));
  const run = dependencies.runStage ?? runQualificationStage;
  const remove = dependencies.remove ?? (directory => rm(directory, { recursive: true, force: true }));
  const env = verificationChildEnv(withoutPiHarnessEnv(dependencies.env ?? process.env));
  let packageRoot;
  let safeToRemove = true;
  let completed = false;
  try {
    signal?.throwIfAborted();
    // Resolve in the invoking environment, before native tests isolate browser
    // cache roots (LOCALAPPDATA/HOME), and before any expensive compilation.
    let browserExecutable;
    try {
      browserExecutable = await validateBrowserExecutable(await (dependencies.resolveBrowserExecutable ?? resolveQualificationBrowserExecutable)());
    } catch (error) {
      throw new Error(`Delivered-browser blocker: installed VS Code-owner pinned @playwright/test Chromium is required; no download/install is attempted. ${error.message}`);
    }
    signal?.throwIfAborted();
    if (selection.artifactDir !== undefined) {
      status('pi-runtime: verifying caller artifact for reuse (Pi compilation skipped)');
      await (dependencies.verifyRuntime ?? verifyPiRuntimeArtifact)(selection.artifactDir);
      signal?.throwIfAborted();
    }
    // Compile using the existing gate/command, not an unconditional Moon prereq:
    // explicit artifact reuse must remain independent of checkout compilation.
    const stages = qualificationStages(root, '', selection.artifactDir);
    if (selection.artifactDir === undefined) {
      const stage = stages.shift();
      status(`${stage.name}: started`);
      const result = await run(stage, { root, signal, env });
      if (result.code !== 0 || !result.outerConfirmed || !result.innerConfirmed) throw new Error(`${stage.name} failed or completion is unconfirmed (exit ${result.code}).`);
      signal?.throwIfAborted();
      status(`${stage.name}: completed`);
    }
    packageRoot = await (dependencies.createPackage ?? (() => mkdtemp(path.join(os.tmpdir(), 'pie-qualify-delivery-'))))();
    // Canonical check also rejects an OS-temp override pointing into the checkout.
    const canonical = await realpath(packageRoot);
    const checkout = await realpath(root);
    if (contains(checkout, canonical) || contains(canonical, checkout)) throw new Error('Qualification package must be outside the checkout.');
    packageRoot = canonical;
    status(`package: ${packageRoot} (invocation-owned, nonpublishing)`);
    signal?.throwIfAborted();
    await (dependencies.copySkeleton ?? copyPackageSkeleton)(root, packageRoot);
    for (const stage of qualificationStages(root, packageRoot, selection.artifactDir, browserExecutable).filter(stage => stage.name !== 'pi-compile')) {
      signal?.throwIfAborted();
      status(`${stage.name}: started`);
      // Until both layers report completion, retain this package even if the
      // launcher/watchdog throws, or Ctrl+C causes the outer tree to disappear.
      safeToRemove = false;
      const result = await run(stage, { root, signal, env });
      safeToRemove = result.outerConfirmed === true && result.innerConfirmed === true && result.code === 0 && !signal?.aborted;
      if (!safeToRemove) throw new Error(`${stage.name} failed or completion is unconfirmed (exit ${result.code}); package retained.`);
      signal?.throwIfAborted();
      status(`${stage.name}: completed`);
    }
    completed = true;
    status('qualified: private built delivery, both headless adapters and browser first paint; NOT installed/published or real Electron acceptance');
    return { code: 0, packageRoot };
  } finally {
    if (packageRoot) {
      if (safeToRemove && !signal?.aborted) {
        await remove(packageRoot);
        status(`package: removed ${packageRoot}${completed ? ' after confirmed qualification completion' : ' (no uncertain child ownership)'}`);
      } else status(`package: RETAINED ${packageRoot}; completion/cancellation evidence is uncertain, no automatic deletion`);
    }
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  let selection;
  try { selection = parseQualificationArgs(argv); }
  catch (error) { console.error(error.message); return 1; }
  if (selection.help) { console.log(HELP); return 0; }
  const cancellation = (dependencies.abortOnProcessSignals ?? abortOnProcessSignals)();
  try {
    await qualifyDelivery(selection, cancellation.signal, dependencies);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally { cancellation.dispose(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
