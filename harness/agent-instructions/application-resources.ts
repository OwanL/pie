import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundledManagedResources } from '../../lib/managed-packages/bundled-resources.mjs';
import { BUNDLED_EXTENSIONS, bundledExtensionsForContext } from '../tools/catalog/bundled-extensions.js';
import type { ToolContext } from '../tools/catalog/index.js';
import { getInstructionResourcePaths, type InstructionResourceRootOptions } from './resource-roots.js';

export const BUNDLED_EXTENSION_INVENTORY_RELATIVE_PATH = 'resources/bundled-extensions.json';
export interface BundledExtensionInventory {
  version: 1;
  extensions: { id: string; entry: string }[];
}

/** Emitter contract: single curated authority, no runtime source-tree discovery. */
export function createBundledExtensionInventory(): BundledExtensionInventory {
  return { version: 1, extensions: BUNDLED_EXTENSIONS.map(entry => ({ id: entry.id, entry: entry.outputFile })) };
}

export interface ApplicationResourceOptions extends InstructionResourceRootOptions {
  agentDir: string;
  cwd: string;
  context: ToolContext;
  expectedRuntimeIdentity?: string;
}

function runtimeDirectory(options: InstructionResourceRootOptions): string {
  return path.resolve(options.moduleDir ?? (typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url))));
}

function validateInventory(moduleDir: string): boolean {
  const marker = path.join(moduleDir, BUNDLED_EXTENSION_INVENTORY_RELATIVE_PATH);
  let text: string;
  try {
    text = fs.readFileSync(marker, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Cannot read bundled extension inventory: ${marker}`, { cause: error });
  }
  try {
    const inventory = JSON.parse(text) as BundledExtensionInventory;
    if (inventory?.version !== 1 || !Array.isArray(inventory.extensions) || inventory.extensions.length !== BUNDLED_EXTENSIONS.length) {
      throw new Error('Unexpected bundled extension inventory version or count');
    }
    const seen = new Set<string>();
    for (const item of inventory.extensions) {
      const expected = BUNDLED_EXTENSIONS.find(entry => entry.id === item?.id);
      if (!expected || item.entry !== expected.outputFile || seen.has(item.id)) throw new Error('Unexpected or duplicate bundled extension entry');
      seen.add(item.id);
      if (!fs.statSync(path.join(moduleDir, expected.outputFile)).isFile()) throw new Error(`Missing bundled extension file: ${expected.outputFile}`);
    }
  } catch (error) {
    throw new Error(`Invalid bundled extension payload: ${marker}`, { cause: error });
  }
  return true;
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, path.resolve(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Native discovery/filtering owns eligibility. This policy only supplies explicit
 * roots and stable ordering before name deduplication, without directory rescans.
 */
export function getApplicationResourceLoaderOptions(options: ApplicationResourceOptions) {
  const moduleDir = runtimeDirectory(options);
  const bundledSkills = getInstructionResourcePaths(options).skillsDir;
  const installed = validateInventory(moduleDir);
  const managed = readBundledManagedResources(moduleDir, { expectedRuntimeIdentity: options.expectedRuntimeIdentity });
  if (managed && !installed) throw new Error('Bundled managed resources require a valid bundled extension inventory');
  return {
    defaultExtensions: [...(installed ? bundledExtensionsForContext(options.context).map(entry => ({
      path: path.join(moduleDir, entry.outputFile),
      legacyPaths: entry.legacyPaths.map(legacy => path.resolve(options.agentDir, legacy)),
    })) : []), ...(managed?.packages.map(entry => ({
      path: entry.extensionPath,
      legacyPaths: [
        path.resolve(options.agentDir, 'npm', 'node_modules', entry.name),
        path.resolve(options.agentDir, 'npm', 'node_modules', entry.name, 'index.ts'),
      ],
      legacyPackageSources: [`npm:${entry.name}`],
    })) ?? [])],
    additionalUserSkillPaths: [path.resolve(options.agentDir, 'harness', 'agent-instructions', 'skills'), bundledSkills],
    additionalProjectSkillPaths: [path.resolve(options.cwd, 'skills')],
    skillPathPriority: (entry: Readonly<{ path: string; sourceInfo: Readonly<{ scope: string }> }>): number =>
      entry.sourceInfo.scope === 'project' ? 0 : isWithin(bundledSkills, entry.path) ? 2 : 1,
  };
}
