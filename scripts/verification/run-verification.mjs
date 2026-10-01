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
  const lint = JSON.parse(readFileSync(path.join(root, 'application/hosts/vscode/package.json'), 'utf8')).scripts.lint;
  const prefix = 'cd ../../.. && node ';
  // Keep the existing lint script authoritative, without a shell/npm child chain.
  if (!lint.startsWith(prefix) || /[&|<>"']/u.test(lint.slice(prefix.length))) throw new Error('Unsupported lint command shape');
  return [
    ['scripts/model-config/sync-models.mjs', '--check'],
    ['scripts/verification/run-typechecks.mjs', ...runtimeArgs(runtime)],
    lint.slice(prefix.length).split(/\s+/u),
    [mode === 'check' ? 'scripts/verification/run-affected-tests.mjs' : 'scripts/verification/run-tests.mjs',
      ...(mode === 'verify' ? ['--fast'] : []), ...runtimeArgs(runtime)],
    ...(mode === 'check' ? [] : [['scripts/build/build.mjs', '--skip-typecheck', '--no-sync', ...runtimeArgs(runtime)]]),
  ];
}

function runChild(args, signal, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, withProcessTreeIsolation({
      cwd: root, env: verificationChildEnv(withoutPiHarnessEnv(withoutGitRepositoryEnv(process.env))), stdio: 'inherit', windowsHide: true,
    }));
    const watchdog = watchChildProcess(child, { signal, timeoutMs: resolveChildProcessTimeoutMs(), label: args[0] });
    child.on('error', async (error) => { await watchdog.settle().catch(() => {}); reject(error); });
    child.on('close', async (code) => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      if (!cleanup.gone) { reject(new Error('Verification tree teardown is unconfirmed')); return; }
      resolve(watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 1));
    });
  });
}

export async function runVerification(mode, selection, signal, { root = repoRoot, run = runChild, ...dependencies } = {}) {
  // Validate mode before artifact acquisition.
  if (!['check', 'verify', 'verify:release'].includes(mode)) throw new Error(`Unknown verification mode: ${mode}`);
  return withVerificationRuntime(selection, signal, async (runtime) => {
    for (const args of verificationStages(mode, runtime, root)) {
      signal?.throwIfAborted();
      const code = await run(args, signal, root);
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
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { abort.dispose(); }
}
