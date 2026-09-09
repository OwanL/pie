import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import runtime from '../runtime/runtime-generations.cjs';

export const { publishRuntimeGeneration, resolveRuntimeGeneration } = runtime;
const bootstrapSource = fileURLToPath(new URL('../runtime/', import.meta.url));
const bootstrapFiles = ['bootstrap.cjs', 'runtime-generations.cjs'];

export async function hasRuntimeBootstrap(extensionDir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
    return pkg.pieRuntimeBootstrap === 1
      && typeof pkg.main === 'string'
      && /^\.\/(?:runtime|pie-bootstrap\/[0-9a-f]{64})\/bootstrap\.cjs$/u.test(pkg.main)
      && (await readFile(path.join(extensionDir, pkg.main))).length > 0
      && (await readFile(path.join(extensionDir, path.dirname(pkg.main), 'runtime-generations.cjs'))).length > 0;
  } catch {
    return false;
  }
}

/** One-time loader migration, also used for explicit loader upgrades. Never
 * replace out/ or a loaded bootstrap. Only a complete immutable loader is
 * selected by the manifest that VS Code will read at its next startup. */
export async function installRuntimeBootstrap({ extensionDir, pkg }) {
  const contents = await Promise.all(bootstrapFiles.map(name => readFile(path.join(bootstrapSource, name))));
  const hash = createHash('sha256');
  bootstrapFiles.forEach((name, index) => hash.update(name).update('\0').update(contents[index]).update('\0'));
  const generation = hash.digest('hex');
  const relativeDir = `pie-bootstrap/${generation}`;
  const destination = path.join(extensionDir, relativeDir);
  const staging = `${destination}.staging-${process.pid}`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await mkdir(staging, { recursive: true });
    await Promise.all(bootstrapFiles.map((name, index) => writeFile(path.join(staging, name), contents[index])));
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      for (let index = 0; index < bootstrapFiles.length; index++) {
        if (!(await readFile(path.join(destination, bootstrapFiles[index]))).equals(contents[index])) throw error;
      }
    }
    const installed = JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
    if (['publisher', 'name', 'version'].some(key => installed[key] !== pkg[key])) {
      throw new Error('Installed extension identity changed during bootstrap installation.');
    }
    const manifest = JSON.stringify({ ...pkg, main: `./${relativeDir}/bootstrap.cjs`, pieRuntimeBootstrap: 1 }, null, 2) + '\n';
    const manifestStaging = path.join(extensionDir, `.package-${process.pid}-${generation}.json`);
    try {
      await writeFile(manifestStaging, manifest, { flag: 'wx' });
      await rename(manifestStaging, path.join(extensionDir, 'package.json'));
    } finally {
      await rm(manifestStaging, { force: true });
    }
    return generation;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
