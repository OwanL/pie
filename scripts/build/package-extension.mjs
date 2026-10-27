#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOwnerRequire } from '../lib/package-resolution.mjs';
import { stageExtensionForPackaging } from '../lib/delivery-package.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const execFileAsync = promisify(execFile);

function resolveOutputArguments(argv, hostRoot) {
  const args = [...argv];
  let explicitOutput;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '--out' || arg === '-o') {
      if (i + 1 < args.length) {
        explicitOutput = path.resolve(hostRoot, args[i + 1]);
        args[i + 1] = explicitOutput;
        i += 1;
      } else {
        explicitOutput = '';
      }
    } else if (arg.startsWith('--out=') || arg.startsWith('-o=')) {
      const separator = arg.indexOf('=');
      const value = arg.slice(separator + 1);
      explicitOutput = value ? path.resolve(hostRoot, value) : '';
      args[i] = `${arg.slice(0, separator + 1)}${explicitOutput}`;
    }
  }
  return { args, explicitOutput };
}

function defaultResolveVsce(hostRoot) {
  return createOwnerRequire({ dependencyOwnerRoot: hostRoot }).resolve('@vscode/vsce/vsce');
}

async function defaultRunVsce(vsce, args, { cwd }) {
  return execFileAsync(process.execPath, [vsce, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

function forwardOutput(result, stagedRoot, hostRoot) {
  if (result?.stdout) process.stdout.write(result.stdout.replaceAll(stagedRoot, hostRoot));
  if (result?.stderr) process.stderr.write(result.stderr.replaceAll(stagedRoot, hostRoot));
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Package the existing delivery output without rebuilding or changing host sources. */
export async function packageExtension(argv = process.argv.slice(2), deps = {}) {
  const root = path.resolve(deps.root ?? repositoryRoot);
  const hostRoot = path.resolve(deps.hostRoot ?? path.join(root, 'application/hosts/vscode'));
  const outputBuildDir = path.join(hostRoot, 'out');
  const { args: forwardedArgs, explicitOutput } = resolveOutputArguments(argv, hostRoot);
  const createTemp = deps.createTemp ?? (() => mkdtemp(path.join(os.tmpdir(), 'pie-package-extension-')));
  const tempRoot = await createTemp();
  try {
    if (isWithin(root, tempRoot) || isWithin(tempRoot, root)) {
      throw new Error('Packaging scratch must be outside the checkout.');
    }
    const stagedRoot = path.join(tempRoot, 'extension');
    await (deps.stagePackage ?? stageExtensionForPackaging)(root, outputBuildDir, stagedRoot);
    const vsce = await (deps.resolveVsce ?? defaultResolveVsce)(hostRoot);
    const args = ['package', '--no-dependencies', '--allow-missing-repository', ...forwardedArgs];
    let result;
    try {
      result = await (deps.runVsce ?? defaultRunVsce)(vsce, args, { cwd: stagedRoot });
    } catch (error) {
      forwardOutput(error, stagedRoot, hostRoot);
      throw error;
    }
    forwardOutput(result, stagedRoot, hostRoot);

    if (explicitOutput !== undefined) return { output: explicitOutput || undefined, tempRoot };

    const artifacts = (await readdir(stagedRoot, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.vsix'));
    if (artifacts.length !== 1) {
      throw new Error(`Expected vsce to create exactly one default .vsix artifact in its private stage; found ${artifacts.length}.`);
    }
    const output = path.join(hostRoot, artifacts[0].name);
    await copyFile(path.join(stagedRoot, artifacts[0].name), output);
    return { output, tempRoot };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await packageExtension().catch(error => {
    console.error(`[package-extension] ${error.message}`);
    process.exitCode = 1;
  });
}
