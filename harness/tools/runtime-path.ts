import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type RuntimeOwner = 'computer-use' | 'playwright';
const entries = {
  'computer-use': 'harness/tools/computer-use/sidecar.mjs',
  playwright: 'harness/tools/playwright/sidecar.mjs',
} as const;

function packagedRuntime(moduleUrl: string): { root: string; codeOnly: true } | undefined {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  const root = path.join(directory, 'resources', 'tool-runtimes');
  const marker = path.join(root, 'manifest.json');
  if (existsSync(marker)) {
    const manifest = JSON.parse(readFileSync(marker, 'utf8'));
    if (manifest.version !== 1 || manifest.codeOnly !== true
      || manifest.entries?.['computer-use'] !== entries['computer-use']
      || manifest.entries?.playwright !== entries.playwright || !Array.isArray(manifest.files)) {
      throw new Error(`Invalid packaged tool runtime manifest: ${marker}`);
    }
    return { root, codeOnly: true };
  }
  if (existsSync(root) || existsSync(path.join(directory, 'resources', 'bundled-extensions.json'))) {
    throw new Error(`Packaged tool runtime manifest is missing: ${marker}`);
  }
  return undefined;
}

/** Select packaged code explicitly; never substitute checkout or working-directory assets. */
export function resolveToolRuntimeEntry(owner: RuntimeOwner, moduleUrl: string): string {
  const packaged = packagedRuntime(moduleUrl);
  const entry = packaged
    ? path.join(packaged.root, entries[owner])
    : fileURLToPath(new URL('./sidecar.mjs', moduleUrl));
  if (packaged && (!existsSync(entry) || !statSync(entry).isFile())) {
    throw new Error(`Packaged ${owner} sidecar asset is missing: ${entry}`);
  }
  return entry;
}

/** Code-only delivery deliberately does not prepare native/browser dependency owners. */
export function prepareToolRuntimeEntry(owner: RuntimeOwner, moduleUrl: string): string {
  const entry = resolveToolRuntimeEntry(owner, moduleUrl);
  if (packagedRuntime(moduleUrl)?.codeOnly) {
    throw new Error(`${owner} runtime preparation unavailable: this code-only packaged tool runtime has no prepared native dependency owner. No sidecar was started.`);
  }
  return entry;
}
