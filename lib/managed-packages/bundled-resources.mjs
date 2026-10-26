// Public, read-only bundle boundary. Whole-payload identity and qualification
// belong to the build/delivery owner, not this lightweight pre-factory check.
import fs from 'node:fs';
import path from 'node:path';
import { MANAGED_PACKAGE_REQUIREMENTS, adaptManagedPackageSources } from './managed-package-contract.mjs';

export const BUNDLED_MANAGED_ROOT_RELATIVE_PATH = 'resources/managed-integrations';
export const BUNDLED_MANAGED_INVENTORY_RELATIVE_PATH = `${BUNDLED_MANAGED_ROOT_RELATIVE_PATH}/manifest.json`;
const fail = message => { throw new Error(`Bundled managed resources: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const currentTarget = () => ({ platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules });
function validateBindings(value) {
  if (!object(value) || !['runtimeIdentity', 'closureInventorySha256', 'qualificationRecipeSha256'].every(key => sha(value[key]))) fail('invalid identity/hash binding');
  const t = value.target;
  if (!keys(t, ['platform', 'arch', 'nodeAbi']) || !['platform', 'arch'].every(key => typeof t[key] === 'string' && /^[a-z0-9_-]+$/.test(t[key])) || typeof t.nodeAbi !== 'string' || !/^[0-9]+$/.test(t.nodeAbi)) fail('invalid target');
}
/** Pure shape serializer only. Only the build/delivery owner may emit this
 * marker after externally verifying qualification; it confers no readiness. */
export function createBundledManagedInventory(bindings) {
  validateBindings(bindings);
  return {
    schemaVersion: 1,
    runtimeIdentity: bindings.runtimeIdentity,
    closureInventorySha256: bindings.closureInventorySha256,
    qualificationRecipeSha256: bindings.qualificationRecipeSha256,
    target: { ...bindings.target },
    packages: MANAGED_PACKAGE_REQUIREMENTS.map(({ name, version }) => ({ name, version, entry: `node_modules/${name}/index.ts` })),
  };
}
// Check only explicit required paths, including every ancestor. No inventory walk.
function checkedPath(file, directory = false) {
  let current = path.parse(file).root;
  const parts = path.relative(current, file).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const st = fs.lstatSync(current);
    const dir = i < parts.length - 1 || directory;
    if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) fail('linked/special required path');
  }
  return file;
}
function read(file) { return fs.readFileSync(checkedPath(file), 'utf8'); }
export function readBundledManagedResources(moduleDir, { expectedRuntimeIdentity, target = currentTarget() } = {}) {
  if (typeof moduleDir !== 'string' || !path.isAbsolute(moduleDir)) fail('absolute moduleDir required');
  const root = path.resolve(moduleDir, BUNDLED_MANAGED_ROOT_RELATIVE_PATH);
  const marker = path.join(root, 'manifest.json');
  // Only marker absence enables source/development fallback; dangling links are present.
  try { fs.lstatSync(marker); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const manifest = JSON.parse(read(marker));
  if (!keys(manifest, ['schemaVersion', 'runtimeIdentity', 'closureInventorySha256', 'qualificationRecipeSha256', 'target', 'packages']) || manifest.schemaVersion !== 1) fail('invalid manifest schema');
  const canonical = createBundledManagedInventory(manifest);
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== canonical.packages.length || manifest.packages.some((p, i) => !keys(p, ['name', 'version', 'entry']) || Object.keys(canonical.packages[i]).some(k => p[k] !== canonical.packages[i][k]))) fail('invalid package pins/entries');
  validateBindings({ ...manifest, target });
  if (['platform', 'arch', 'nodeAbi'].some(k => target[k] !== manifest.target[k])) fail('target mismatch');
  if (expectedRuntimeIdentity !== undefined && (!sha(expectedRuntimeIdentity) || expectedRuntimeIdentity !== manifest.runtimeIdentity)) fail('runtime identity mismatch');
  const nodeModulesRoot = checkedPath(path.join(root, 'node_modules'), true);
  const packages = MANAGED_PACKAGE_REQUIREMENTS.map(pin => {
    const packageRoot = checkedPath(path.join(nodeModulesRoot, pin.name), true);
    const pkg = JSON.parse(read(path.join(packageRoot, 'package.json')));
    if (pkg.name !== pin.name || pkg.version !== pin.version) fail('package manifest pin mismatch');
    for (const relative of pin.requiredFiles) {
      let file = path.join(packageRoot, relative);
      // Explicit closure-local hoist only; never Node/global/ancestor resolution.
      if (relative === 'node_modules/@mozilla/readability/Readability.js') {
        try { checkedPath(file); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          file = path.join(nodeModulesRoot, '@mozilla/readability/Readability.js');
        }
      }
      checkedPath(file);
    }
    const files = pin.name === 'pi-web-access'
      ? { index: read(path.join(packageRoot, 'index.ts')), storage: read(path.join(packageRoot, 'storage.ts')) }
      : { index: read(path.join(packageRoot, 'index.ts')), agentDir: read(path.join(packageRoot, 'agent-dir.ts')) };
    const adapted = adaptManagedPackageSources(pin.name, files);
    if (Object.keys(files).some(key => files[key] !== adapted[key])) fail('incomplete package adaptation');
    return { name: pin.name, version: pin.version, extensionPath: path.join(packageRoot, 'index.ts'), packageRoot };
  });
  return { root, nodeModulesRoot, manifest, packages };
}
