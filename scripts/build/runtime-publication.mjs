import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import runtime from '../../application/hosts/vscode/runtime/runtime-generations.cjs';

export const { publishRuntimeGeneration, resolveRuntimeGeneration } = runtime;
// The runtime bootstrap assets moved with the host package owner (planned
// distribution root application/hosts/vscode).
const bootstrapSource = fileURLToPath(new URL('../../application/hosts/vscode/runtime/', import.meta.url));
const bootstrapFiles = ['bootstrap.cjs', 'runtime-generations.cjs'];
const require = createRequire(import.meta.url);

/** Read capabilities only from the selected, content-bound installed helper.
 * Never execute bootstrap.cjs: it is the activation entrypoint. */
export async function assertRuntimeBootstrapSupportsSchema({ extensionDir, schema }) {
  try {
    const [pkg, sourcePkg] = await Promise.all([
      readFile(path.join(extensionDir, 'package.json'), 'utf8').then(JSON.parse),
      readFile(path.join(bootstrapSource, '..', 'package.json'), 'utf8').then(JSON.parse),
    ]);
    if (['publisher', 'name', 'version'].some(key => pkg[key] !== sourcePkg[key])) {
      throw new Error('Installed extension identity does not match the source package.');
    }
    if (pkg.pieRuntimeBootstrap !== 1 || typeof pkg.main !== 'string'
      || !/^\.\/(?:runtime|pie-bootstrap\/[0-9a-f]{64})\/bootstrap\.cjs$/u.test(pkg.main)) {
      throw new Error('Installed startup loader selection is not canonical.');
    }
    let supported = [1];
    if (pkg.main !== './runtime/bootstrap.cjs') {
      const directory = path.join(extensionDir, path.dirname(pkg.main));
      const contents = await Promise.all(bootstrapFiles.map(name => readFile(path.join(directory, name))));
      const hash = createHash('sha256');
      bootstrapFiles.forEach((name, index) => hash.update(name).update('\0').update(contents[index]).update('\0'));
      if (hash.digest('hex') !== path.basename(directory)) throw new Error('Installed startup loader hash mismatch.');
      supported = require(path.join(directory, 'runtime-generations.cjs')).SUPPORTED_MANIFEST_SCHEMAS ?? [1];
    }
    if (!Array.isArray(supported) || !supported.includes(schema)) {
      throw new Error(`Installed startup loader does not support runtime manifest schema ${schema}.`);
    }
  } catch (error) {
    throw new Error(`${error.message} Use --activate to upgrade the startup loader before publication.`, { cause: error });
  }
}

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
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.staging-`);
  try {
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
    const manifestStaging = path.join(extensionDir, `.package-${randomUUID()}.json`);
    let ownsManifestStaging = false;
    try {
      const manifestHandle = await open(manifestStaging, 'wx');
      ownsManifestStaging = true;
      try {
        await manifestHandle.writeFile(manifest);
      } finally {
        await manifestHandle.close();
      }
      const manifestPath = path.join(extensionDir, 'package.json');
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(manifestStaging, manifestPath);
          break;
        } catch (error) {
          if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
          // Windows can refuse replacement while another invocation reads or
          // selects the same manifest. An identical selection is already done.
          if (await readFile(manifestPath, 'utf8') === manifest) break;
          if (attempt === 9) throw error;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    } finally {
      if (ownsManifestStaging) await rm(manifestStaging, { force: true });
    }
    return generation;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
