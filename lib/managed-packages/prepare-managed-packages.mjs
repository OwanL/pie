import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MANAGED_PACKAGE_REQUIREMENTS, adaptManagedPackageSources } from './managed-package-contract.mjs';

function requirement(name) {
  const result = MANAGED_PACKAGE_REQUIREMENTS.find((entry) => entry.name === name);
  if (!result) throw new Error(`Unsupported managed package: ${name}`);
  return result;
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Expected absolute package/staging path');
  return value;
}

// Deliberately walk only the explicitly supplied owned tree, including its local
// dependencies. Never follow links or discover dependencies outside that tree.
async function walk(root, destination) {
  const stat = await lstat(root);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`Unsupported managed package file type: ${root}`);
  }
  if (path.basename(root) === '.DELETE' || /\.DELETE\..+$/.test(path.basename(root))) throw new Error(`Forbidden .DELETE entry: ${root}`);
  if (stat.isDirectory()) {
    if (destination) await mkdir(destination);
    for (const name of await readdir(root)) {
      await walk(path.join(root, name), destination && path.join(destination, name));
    }
  } else if (destination) {
    await copyFile(root, destination);
  }
}

async function sources(root, name, nodeModulesRoot) {
  if (nodeModulesRoot !== undefined) {
    absolute(nodeModulesRoot);
    const rel = path.relative(nodeModulesRoot, root);
    if (path.basename(nodeModulesRoot) !== 'node_modules' || !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Package must belong to explicit closure node_modules root');
    let current = nodeModulesRoot;
    for (const part of ['', ...rel.split(path.sep)]) {
      if (part) current = path.join(current, part);
      const st = await lstat(current);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Invalid owned closure directory');
    }
  }
  const pin = requirement(name);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== pin.version) {
    throw new Error(`Incorrect managed package manifest: ${name}`);
  }
  for (const file of pin.requiredFiles) {
    let target = path.join(root, file);
    try { await lstat(target); } catch (error) {
      if (error.code !== 'ENOENT' || !nodeModulesRoot || !file.startsWith('node_modules/')) throw error;
      target = path.join(nodeModulesRoot, file.slice('node_modules/'.length));
      let current = nodeModulesRoot;
      for (const part of path.relative(nodeModulesRoot, target).split(path.sep)) {
        current = path.join(current, part);
        const st = await lstat(current);
        if (st.isSymbolicLink()) throw new Error('Invalid owned closure dependency link');
      }
    }
    const st = await lstat(target);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Missing local package file: ${file}`);
  }
  const files = { index: await readFile(path.join(root, 'index.ts'), 'utf8') };
  if (name === 'pi-web-access') files.storage = await readFile(path.join(root, 'storage.ts'), 'utf8');
  else files.agentDir = await readFile(path.join(root, 'agent-dir.ts'), 'utf8');
  return files;
}

/** Read-only structural and complete-adaptation verification. Throws on failure. */
export async function verifyPreparedManagedPackage(root, name, { nodeModulesRoot } = {}) {
  absolute(root);
  requirement(name);
  await walk(root);
  const files = await sources(root, name, nodeModulesRoot);
  const adapted = adaptManagedPackageSources(name, files);
  for (const key of Object.keys(files)) {
    if (files[key] !== adapted[key]) throw new Error(`Incomplete managed package adaptation: ${name}/${key}`);
  }
}

/**
 * Copy only supplied owned package trees into an independent disposable stage.
 * This is not dependency-closure packaging: callers must supply fully materialized
 * local dependencies and own any later closure qualification/packaging.
 */
export async function prepareManagedPackages({ inputs, stagingParent }) {
  absolute(stagingParent);
  const parentStat = await lstat(stagingParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Staging parent must be an existing private directory');
  const entries = Object.entries(inputs);
  for (const [name, root] of entries) {
    requirement(name);
    absolute(root);
    const relative = path.relative(root, stagingParent);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Staging parent must be outside input package trees');
    }
  }
  const root = await mkdtemp(path.join(stagingParent, 'managed-packages-'));
  const packages = {};
  try {
    for (const [name, source] of entries) {
      const target = path.join(root, name);
      await walk(source, target);
      packages[name] = target;
      const files = await sources(target, name);
      const adapted = adaptManagedPackageSources(name, files);
      for (const [key, relative] of [['index', 'index.ts'], ['storage', 'storage.ts'], ['agentDir', 'agent-dir.ts']]) {
        if (files[key] !== undefined) await writeFile(path.join(target, relative), adapted[key], 'utf8');
      }
    }
    // Finish every transformation before performing final verification.
    for (const [name, target] of Object.entries(packages)) await verifyPreparedManagedPackage(target, name);
    return { root, packages };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
