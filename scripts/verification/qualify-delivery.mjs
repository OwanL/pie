#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { abortOnProcessSignals, resolveChildProcessTimeoutMs, watchChildProcess, withProcessTreeIsolation } from '../lib/process-watchdog.mjs';
import { verificationChildEnv } from './verification-runtime.mjs';
import { createOwnerRequire } from '../lib/package-resolution.mjs';
import { copyPackageSkeleton } from '../lib/delivery-package.mjs';
export { copyPackageSkeleton } from '../lib/delivery-package.mjs';

import { extractCandidate, fingerprintCandidate, verifyCandidateIdentity } from './lib/vsix-candidate.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const HELP = 'Usage: node scripts/verification/qualify-delivery.mjs [--pi-runtime <absolute artifact root> | --vsix <absolute candidate path>]\nVSIX: qualify the exact packaged candidate without building; retain extraction and qualification evidence.\nBuild and qualify a new private external delivery (both headless adapters + browser).\nDefault: gated Pi compilation, then fresh delivery build. Explicit runtime: verify/reuse, no Pi compilation.\nNo installation, publication, Electron, provider prompts or browser download.';

export function parseQualificationArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  let artifactDir;
  let vsix;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--vsix' || arg.startsWith('--vsix=')) {
      if (vsix !== undefined) throw new Error('--vsix may be specified only once.');
      const value = arg === '--vsix' ? argv[++index] : arg.slice('--vsix='.length);
      if (!value || value.startsWith('--') || !path.isAbsolute(value)) throw new Error('--vsix requires an absolute candidate path.');
      vsix = path.resolve(value);
      continue;
    }
    if (arg !== '--pi-runtime' && !arg.startsWith('--pi-runtime=')) throw new Error(`Unknown delivery qualification option: ${arg}`);
    if (artifactDir !== undefined) throw new Error('--pi-runtime may be specified only once.');
    const value = arg === '--pi-runtime' ? argv[++index] : arg.slice('--pi-runtime='.length);
    if (!value || value.startsWith('--') || !path.isAbsolute(value)) throw new Error('--pi-runtime requires an absolute artifact root.');
    artifactDir = path.resolve(value);
  }
  if (vsix !== undefined && artifactDir !== undefined) throw new Error('--vsix and --pi-runtime are mutually exclusive.');
  return vsix === undefined ? { artifactDir } : { vsix };
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
    if (selection.vsix !== undefined && selection.artifactDir !== undefined) throw new Error('--vsix and --pi-runtime are mutually exclusive.');
    if (selection.vsix !== undefined && !path.isAbsolute(selection.vsix)) throw new Error('--vsix requires an absolute candidate path.');
    const fingerprint = selection.vsix === undefined ? undefined
      : await (dependencies.fingerprintCandidate ?? fingerprintCandidate)(selection.vsix);
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
    if (selection.vsix === undefined && selection.artifactDir === undefined) {
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
    let candidateIdentity;
    if (selection.vsix !== undefined) {
      await (dependencies.extractCandidate ?? extractCandidate)(selection.vsix, packageRoot);
      signal?.throwIfAborted();
      candidateIdentity = await (dependencies.verifyCandidateIdentity ?? verifyCandidateIdentity)(packageRoot);
    } else {
      await (dependencies.copySkeleton ?? copyPackageSkeleton)(root, packageRoot);
    }
    for (const stage of qualificationStages(root, packageRoot, selection.artifactDir, browserExecutable)
      .filter(stage => selection.vsix !== undefined ? stage.name === 'delivered-hosts' : stage.name !== 'pi-compile')) {
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
    if (selection.vsix !== undefined) {
      const after = await (dependencies.fingerprintCandidate ?? fingerprintCandidate)(selection.vsix);
      if (after.sha256 !== fingerprint.sha256 || after.size !== fingerprint.size) throw new Error('VSIX candidate changed during qualification; package retained.');
      signal?.throwIfAborted();
      const candidate = { path: selection.vsix, ...fingerprint, ...candidateIdentity };
      const evidencePath = path.join(packageRoot, 'qualification-evidence.json');
      await writeFile(evidencePath, `${JSON.stringify({ candidate, packageRoot, qualification: 'passed: private standalone and mocked VS Code adapters plus headless browser first paint', installed: false, published: false }, null, 2)}\n`, { flag: 'wx' });
      status(`qualified: exact VSIX candidate; evidence: ${evidencePath}; NOT installed/published or real Electron acceptance`);
      return { code: 0, packageRoot, evidencePath, candidate };
    }
    completed = true;
    status('qualified: private built delivery, both headless adapters and browser first paint; NOT installed/published or real Electron acceptance');
    return { code: 0, packageRoot };
  } finally {
    if (packageRoot) {
      if (selection.vsix !== undefined) {
        status(`package: RETAINED ${packageRoot}; VSIX candidate extraction and qualification evidence`);
      } else if (safeToRemove && !signal?.aborted) {
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
