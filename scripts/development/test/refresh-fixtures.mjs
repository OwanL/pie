import { copyFile, cp, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { findPackageJSON } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveOwnerModule } from '../../lib/package-resolution.mjs';
import { acquireDevelopmentReader } from '../../../lib/development-runtime/lifetime.mjs';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const localPackages = ['tui', 'ai', 'agent', 'coding-agent'];
const localNames = ['pi-tui', 'pi-ai', 'pi-agent-core', 'pi-coding-agent'];

// Exact compiled trees only: never copy sessions, gate registrations, auth,
// caches, source dependencies, or the installed extension. Non-Pi dependencies
// remain read-only links to their existing owner installations.
export async function createRefreshRepository(directory) {
  const snapshotReader = await acquireDevelopmentReader(path.join(repositoryRoot, 'harness/pi'));
  try {
    return await copyRefreshRepository(directory);
  } finally {
    // Only filesystem-copy ownership remains; no SDK runtime or process is
    // started under this short snapshot reader.
    await snapshotReader.release({ teardownConfirmed: true });
  }
}

async function copyRefreshRepository(directory) {
  const root = path.join(directory, 'repository');
  for (const relative of ['settings.defaults.json', 'models.json', 'application/hosts/vscode/package.json', 'application/hosts/vscode/media/icon.svg', 'harness/pi/package.json', 'harness/pi/.cache/build.json']) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repositoryRoot, relative), destination);
  }
  await cp(path.join(repositoryRoot, 'application/hosts/vscode/out-dev'), path.join(root, 'application/hosts/vscode/out-dev'), { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const directoryName of localPackages) {
    const relative = `harness/pi/packages/${directoryName}`;
    const source = path.join(repositoryRoot, relative);
    const destination = path.join(root, relative);
    await mkdir(destination, { recursive: true });
    await copyFile(path.join(source, 'package.json'), path.join(destination, 'package.json'));
    await cp(path.join(source, 'dist'), path.join(destination, 'dist'), { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const localIndex = localNames.indexOf(name.replace('@earendil-works/', ''));
      const target = localIndex < 0
        ? await realpath(path.dirname(findPackageJSON(name, pathToFileURL(path.join(source, 'dist/index.js')).href)))
        : path.join(root, 'harness/pi/packages', localPackages[localIndex]);
      const link = path.join(destination, 'node_modules', name);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(target, link, linkType);
    }
  }
  // Build aliases require the same TypeBox root from all four package owners,
  // including tui (which does not declare it directly).
  const typebox = path.dirname(findPackageJSON('typebox', pathToFileURL(path.join(repositoryRoot, 'harness/pi/packages/coding-agent/dist/index.js')).href));
  await mkdir(path.join(root, 'harness/pi/node_modules'), { recursive: true });
  await symlink(await realpath(typebox), path.join(root, 'harness/pi/node_modules/typebox'), linkType);
  // Empty skills are intentional: qualification makes no provider prompts.
  await mkdir(path.join(root, 'harness/agent-instructions/skills'), { recursive: true });
  return root;
}

export function offlineEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|CREDENTIAL|AUTH|PASSWORD|BEARER|COOKIE|PRIVATE_KEY|LIVE_TEST|LIVE_MODEL/iu.test(name)) delete env[name];
  delete env.NODE_OPTIONS;
  return env;
}

// Real production Vite config, private destination, no Pi workspace build.
export async function rebuildPrivateOutput(output, mode, rendererInput) {
  const names = ['PIE_BUILD_OUTPUT_DIR', 'PIE_BUILD_PI_RUNTIME_SDK_PATH', 'PIE_BUILD_PI_RUNTIME_IDENTITY', 'PIE_BUILD_DEVELOPMENT'];
  const previous = names.map(name => process.env[name]);
  Object.assign(process.env, {
    PIE_BUILD_OUTPUT_DIR: output,
    PIE_BUILD_PI_RUNTIME_SDK_PATH: path.resolve(output, '../../../../harness/pi/packages/coding-agent'),
    PIE_BUILD_PI_RUNTIME_IDENTITY: 'workspace-development',
    PIE_BUILD_DEVELOPMENT: '1',
  });
  try {
    const { build } = await import(pathToFileURL(resolveOwnerModule('vite')).href);
    await build({ configFile: path.join(repositoryRoot, 'application/hosts/vscode/vite.config.ts'), configLoader: 'runner', mode, logLevel: 'warn', build: { emptyOutDir: false, ...(rendererInput ? { rollupOptions: { input: rendererInput } } : {}) } });
  } finally {
    names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]);
  }
}
