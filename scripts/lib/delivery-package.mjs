import { access, copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

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

async function requireRegularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Staged packaging refused a non-regular entry: ${file}`);
}

async function copyTree(source, destination, excluded = new Set(), existing = false) {
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Staged packaging refused a non-regular directory: ${source}`);
  if (!existing) await mkdir(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new Error(`Staged packaging refused a non-regular entry: ${from}`);
    }
    if (excluded.has(entry.name)) continue;
    if (entry.isDirectory()) await copyTree(from, to, excluded);
    else {
      await requireRegularFile(from);
      await copyFile(from, to);
    }
  }
}

/** Stage only owned assets and isolated build output; never execute package hooks. */
export async function stageExtensionForPackaging(root, outputBuildDir, stagedRoot) {
  const source = path.join(root, 'application/hosts/vscode');
  for (const name of ['package.json', '.vscodeignore', 'media/icon.svg']) {
    await requireRegularFile(path.join(source, name));
  }
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (Object.hasOwn(manifest.scripts ?? {}, 'vscode:prepublish')) {
    throw new Error('Staged packaging refuses manifest vscode:prepublish; packaging must never execute build hooks.');
  }
  for (const directory of ['media', 'runtime']) {
    const directoryPath = path.join(source, directory);
    const info = await lstat(directoryPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Staged packaging refused a non-regular directory: ${directoryPath}`);
  }
  for (const entry of await readdir(path.join(source, 'runtime'), { withFileTypes: true })) {
    await requireRegularFile(path.join(source, 'runtime', entry.name));
    if (entry.name === 'windows-runtime-lock.cjs') {
      await requireRegularFile(path.join(root, 'lib/windows-runtime-lock/windows-runtime-lock.cjs'));
    }
  }
  await mkdir(stagedRoot);
  await copyPackageSkeleton(root, stagedRoot);
  await copyFile(path.join(source, '.vscodeignore'), path.join(stagedRoot, '.vscodeignore'));
  await copyTree(path.join(source, 'media'), path.join(stagedRoot, 'media'), new Set(), true);
  await copyTree(outputBuildDir, path.join(stagedRoot, 'out'), new Set(['.cache']));
  await access(path.join(stagedRoot, 'out', 'pi-runtime', 'manifest.json'));
}
