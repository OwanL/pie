#!/usr/bin/env node
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { withDevelopmentWriter } from '../../lib/development-runtime/lifetime.mjs';
import { computePiRuntimeInputFingerprint, resolvePiBuildContext } from './pi-runtime.mjs';
import { fingerprintCompiledPiOutputs } from '../../lib/development-runtime/compiled-output.mjs';
import { abortOnProcessSignals, watchChildProcess, withProcessTreeIsolation } from '../lib/process-watchdog.mjs';

async function compile(directory, signal, { repositoryRoot: root, env, dependencyOwnerRoot }) {
  const workspace = path.join(root, 'harness/pi');
  const require = createRequire(path.join(dependencyOwnerRoot, 'package.json'));
  const child = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(workspace, 'packages', directory, 'tsconfig.build.json'), '--target', 'ES2024'],
    withProcessTreeIsolation({ cwd: root, env, stdio: 'inherit', windowsHide: true }));
  const watchdog = watchChildProcess(child, { signal, timeoutMs: 120_000, label: `Pi ${directory} compiler` });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', async code => {
      const result = await watchdog.settle().catch(() => ({ gone: false }));
      if (!result.gone) return reject(Object.assign(new Error('Pi compiler teardown unconfirmed; writer gate must be retained.'), { teardownUnconfirmed: true }));
      if (code !== 0 || watchdog.aborted || watchdog.timedOut) reject(new Error(`Pi ${directory} compilation failed (${code}).`));
      else resolve();
    });
  });
}

async function copyAssets(workspace, relative, destination, extension) {
  const from = path.join(workspace, 'packages/coding-agent', relative);
  const to = path.join(workspace, 'packages/coding-agent/dist', destination);
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(extension)) await copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
}

export async function buildPiWorkspace({ context } = {}) {
  const selected = resolvePiBuildContext(context);
  const workspace = path.join(selected.repositoryRoot, 'harness/pi');
  const stamp = path.join(workspace, '.cache/build.json');
  const inputs = { repositoryRoot: selected.repositoryRoot, env: selected.env };
  const cancellation = abortOnProcessSignals();
  try {
    const current = await computePiRuntimeInputFingerprint(inputs);
    try {
      const evidence = JSON.parse(await readFile(stamp, 'utf8'));
      const complete = await Promise.all(['tui', 'ai', 'agent', 'coding-agent'].map(directory => stat(path.join(workspace, 'packages', directory, 'dist/index.js')).then(info => info.isFile(), () => false)));
      if (evidence.schema === 1 && evidence.inputFingerprint === current && complete.every(Boolean)
        && evidence.compiledSha256 === await fingerprintCompiledPiOutputs(workspace)) {
        console.log('[pi-workspace] Compiled packages are current.');
        return;
      }
    } catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
    await withDevelopmentWriter(workspace, async () => {
      // A failed build never leaves apparently-current compilation evidence.
      await rm(stamp, { force: true });
      const before = await computePiRuntimeInputFingerprint(inputs);
      for (const directory of ['tui', 'ai', 'agent', 'coding-agent']) {
        cancellation.signal.throwIfAborted();
        // Remove obsolete emissions only while all registered readers are out.
        await rm(path.join(workspace, 'packages', directory, 'dist'), { recursive: true, force: true });
        console.log(`[pi-workspace] Compile ${directory}`);
        await compile(directory, cancellation.signal, selected);
      }
      await copyAssets(workspace, 'src/modes/interactive/theme', 'modes/interactive/theme', '.json');
      await copyAssets(workspace, 'src/modes/interactive/assets', 'modes/interactive/assets', '.png');
      for (const extension of ['.html', '.css', '.js']) await copyAssets(workspace, 'src/core/export-html', 'core/export-html', extension);
      await copyAssets(workspace, 'src/core/export-html/vendor', 'core/export-html/vendor', '.js');
      if (await computePiRuntimeInputFingerprint(inputs) !== before) throw new Error('Pi inputs changed during compilation. Retry with stable inputs.');
      await mkdir(path.dirname(stamp), { recursive: true });
      await writeFile(stamp, `${JSON.stringify({ schema: 1, inputFingerprint: before, compiledSha256: await fingerprintCompiledPiOutputs(workspace), node: process.version })}\n`);
    });
  } finally { cancellation.dispose(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await buildPiWorkspace();
