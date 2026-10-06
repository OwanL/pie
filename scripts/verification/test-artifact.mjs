#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { withPiRuntime } from '../lib/pi-runtime-context.mjs';
import { abortOnProcessSignals, resolveChildProcessTimeoutMs, watchChildProcess, withProcessTreeIsolation } from '../lib/process-watchdog.mjs';
import { extractRuntimeArgs, verificationChildEnv } from './verification-runtime.mjs';
import { parseArgs, resolveTestFiles, TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE } from './test-node.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const testNode = path.join(repoRoot, 'scripts/verification/test-node.mjs');
export const ARTIFACT_TEST_GLOB = '**/*.artifact.test.*';
export const DEFAULT_ARTIFACT_SELECTORS = Object.freeze([
  'harness/agent-processes', 'harness/session-storage',
  'harness/tool-and-skill-selection', 'harness/tools/playwright',
  'scripts/install/test', 'scripts/lib/test', 'scripts/development/test', 'test/integration',
]);

export function buildChildArgs(parsed, sdkPath, selectors = parsed.selectors) {
  if (parsed.sdkPath !== undefined) throw new Error('The artifact test runner selects its SDK; do not pass --sdk-path.');
  const args = ['--sdk-path', sdkPath];
  if (parsed.tsconfig !== undefined) args.push('--tsconfig', parsed.tsconfig);
  for (const glob of parsed.excludeGlobs ?? []) args.push('--exclude', glob);
  args.push('--include', ARTIFACT_TEST_GLOB, ...selectors);
  if (parsed.nodeFlags.length) args.push('--', ...parsed.nodeFlags);
  return args;
}

function runChild(args, signal, dependencies = {}) {
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  const watch = dependencies.watchChildProcessImpl ?? watchChildProcess;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(process.execPath, [testNode, ...args], withProcessTreeIsolation({
        cwd: repoRoot,
        env: verificationChildEnv(withoutPiHarnessEnv(process.env)),
        stdio: 'inherit', windowsHide: true,
      }));
    } catch (cause) {
      reject(Object.assign(new Error(cause instanceof Error ? cause.message : String(cause), { cause }), { noChildLaunched: true }));
      return;
    }
    let watchdog;
    try {
      const timeoutMs = resolveChildProcessTimeoutMs();
      watchdog = watch(child, { signal, timeoutMs, label: 'artifact node tests' });
    } catch (cause) {
      reject(Object.assign(new Error('Artifact test watchdog setup failed; process-tree teardown is unconfirmed.'), {
        cause, teardownUnconfirmed: true,
      }));
      return;
    }
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.on('close', async code => {
      const cleanup = await watchdog.settle().catch(() => ({ gone: false }));
      if (!cleanup.gone) {
        reject(Object.assign(new Error('Artifact test process-tree teardown is unconfirmed.'), { teardownUnconfirmed: true }));
      } else if (spawnError) {
        reject(Object.assign(new Error(spawnError.message, { cause: spawnError }), { childTeardownConfirmed: true }));
      } else if (code === TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE) {
        reject(Object.assign(new Error('Artifact test child reported unconfirmed process-tree teardown (exit code 125).'), {
          teardownUnconfirmed: true,
        }));
      } else resolve({ code: watchdog.timedOut || watchdog.aborted ? 1 : (code ?? 1), teardownConfirmed: true });
    });
  });
}

export async function runArtifactTests(selection, signal, dependencies = {}) {
  const parse = dependencies.parseArgs ?? parseArgs;
  const discover = dependencies.resolveTestFiles ?? resolveTestFiles;
  const parsed = parse(selection.args);
  if (parsed.sdkPath !== undefined) throw new Error('The artifact test runner selects its SDK; do not pass --sdk-path.');
  if (parsed.includeGlobs.length > 0) throw new Error('The artifact test runner owns --include.');
  const selectors = parsed.selectors.length ? parsed.selectors : [...DEFAULT_ARTIFACT_SELECTORS];
  const files = discover(dependencies.repoRoot ?? repoRoot, selectors, {
    includeGlobs: [ARTIFACT_TEST_GLOB], excludeGlobs: parsed.excludeGlobs,
  });
  if (files.length === 0) throw new Error(`No artifact tests found under: ${selectors.join(', ')}`);

  const acquire = dependencies.withPiRuntime ?? withPiRuntime;
  return acquire({ artifactDir: selection.artifactDir, signal }, async context => {
    try {
      const result = await (dependencies.runChild ?? runChild)(buildChildArgs(parsed, context.sdkPath, selectors), signal, dependencies);
      if (result.teardownConfirmed) context.confirmChildCompletion();
      return result.code;
    } catch (error) {
      if (error.noChildLaunched || error.childTeardownConfirmed) context.confirmChildCompletion();
      throw error;
    }
  }, dependencies.runtimeDependencies);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('Usage: node scripts/verification/test-artifact.mjs [--pi-runtime <absolute artifact root>] [test-node options] [selectors...] [-- <Node test flags>]');
    return;
  }
  let selection;
  try { selection = extractRuntimeArgs(argv); }
  catch (error) { console.error(error.message); process.exitCode = 1; return; }
  const abort = (dependencies.abortOnProcessSignals ?? abortOnProcessSignals)();
  try { process.exitCode = await runArtifactTests(selection, abort.signal, dependencies); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  finally { abort.dispose(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
