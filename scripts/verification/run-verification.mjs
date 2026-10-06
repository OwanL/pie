#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { abortOnProcessSignals, watchChildProcess, withProcessTreeIsolation, resolveChildProcessTimeoutMs } from '../lib/process-watchdog.mjs';
import { extractRuntimeArgs, runtimeArgs, verificationChildEnv, withVerificationRuntime } from './verification-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function verificationStages(mode, runtime, root = repoRoot) {
  if (!['check', 'verify', 'verify:release'].includes(mode)) throw new Error(`Unknown verification mode: ${mode}`);
  if (mode !== 'verify:release') {
    return [['proto', 'run', 'moon', '--', 'run', 'root:models', ':typecheck', ':test',
      ...(mode === 'check' ? ['--affected', '--include-relations'] : ['vscode:build'])]];
  }
  const lint = JSON.parse(readFileSync(path.join(root, 'application/hosts/vscode/package.json'), 'utf8')).scripts.lint;
  const prefix = 'cd ../../.. && node ';
  // Keep the existing lint script authoritative, without a shell/npm child chain.
  if (!lint.startsWith(prefix) || /[&|<>"']/u.test(lint.slice(prefix.length))) throw new Error('Unsupported lint command shape');
  return [
    ['scripts/model-config/sync-models.mjs', '--check'],
    ['scripts/verification/run-typechecks.mjs', ...runtimeArgs(runtime)],
    lint.slice(prefix.length).split(/\s+/u),
    ['scripts/verification/run-tests.mjs', ...runtimeArgs(runtime)],
    ['scripts/build/build.mjs', '--skip-typecheck', '--no-sync', ...runtimeArgs(runtime)],
  ];
}

function unconfirmedTeardown(message, cause) {
  return Object.assign(new Error(message, { cause }), { teardownUnconfirmed: true });
}

export async function runChild(args, signal, root, { spawnImpl = spawn, watchChildProcessImpl = watchChildProcess } = {}) {
    const native = args[0] === 'proto';
    const child = spawnImpl(native ? 'proto' : process.execPath, native ? args.slice(1) : args, withProcessTreeIsolation({
      cwd: root, env: verificationChildEnv(withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env))), stdio: 'inherit', windowsHide: true,
    }));
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
    let watchdog;
    try {
      watchdog = watchChildProcessImpl(child, { signal, timeoutMs: resolveChildProcessTimeoutMs(), label: args[0] });
    } catch (error) {
      throw unconfirmedTeardown('Verification child launched without a process-tree watchdog', error);
    }
    const code = await closed;
    let cleanup;
    try { cleanup = await watchdog.settle(); }
    catch (error) { throw unconfirmedTeardown('Verification tree teardown could not be confirmed', error); }
    if (!cleanup.gone) throw unconfirmedTeardown(`Verification tree teardown is unconfirmed: ${(cleanup.diagnostics ?? []).join('; ')}; survivors: ${(cleanup.survivors ?? []).join(', ') || 'unknown'}`);
    if (code === 125) throw unconfirmedTeardown('Nested verification tree teardown is unconfirmed');
    return spawnError || watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 1);
}

export async function runVerification(mode, selection, signal, { root = repoRoot, run = runChild, ...dependencies } = {}) {
  // Validate mode before artifact acquisition.
  if (!['check', 'verify', 'verify:release'].includes(mode)) throw new Error(`Unknown verification mode: ${mode}`);
  if (mode !== 'verify:release') {
    if (selection.artifactDir || selection.sdkPath) {
      throw new Error('--pi-runtime/--sdk-path is not used by native check/verify; omit it, or use verify:release for artifact-backed coverage verification');
    }
    signal?.throwIfAborted();
    return run(verificationStages(mode)[0], signal, root);
  }
  return withVerificationRuntime(selection, signal, async (runtime) => {
    for (const args of verificationStages(mode, runtime, root)) {
      signal?.throwIfAborted();
      const code = await run(args, signal, root);
      // A clean outer census cannot prove an inner runner's retained lifetime.
      if (code === 125) throw unconfirmedTeardown('Nested verification tree teardown is unconfirmed');
      if (code !== 0) return code;
    }
    return 0;
  }, dependencies);
}

const directlyInvoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (directlyInvoked) {
  const abort = abortOnProcessSignals();
  try {
    const selection = extractRuntimeArgs(process.argv.slice(2));
    if (selection.args.some((arg) => ['--help', '-h', '--list'].includes(arg))) {
      console.log('Usage: run-verification.mjs <check|verify|verify:release> [--pi-runtime <absolute artifact root>]');
    } else {
      if (selection.args.length !== 1) throw new Error('Expected one verification mode');
      process.exitCode = await runVerification(selection.args[0], selection, abort.signal);
    }
  } catch (error) { console.error(error.message); process.exitCode = error.teardownUnconfirmed === true ? 125 : 1; }
  finally { abort.dispose(); }
}
