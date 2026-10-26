import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from 'vite';

export const INSTRUCTION_MANIFEST = 'bundled-resources.json';
const OUTPUT_ROOT = 'resources/agent-instructions';

export interface InstructionAsset {
  sourcePath: string;
  fileName: string;
  source: Buffer;
}

function relativeFile(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\')
      || value.split('/').some((part) => !part || part === '.' || part === '..'
        || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
      || /[:<>"|?*\u0000-\u001f]/u.test(value) || path.posix.isAbsolute(value)) {
    throw new Error(`Invalid instruction asset path: ${String(value)}`);
  }
  return value;
}

/** No selected file or intermediate directory may route through a link. */
function regularFile(root: string, relative: string): string {
  const parts = relative.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Instruction asset must be a regular file without links: ${relative}`);
    }
  }
  return current;
}

function skillEntries(directory: string, relative = 'skills'): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Linked instruction skill entry: ${child}`);
    if (entry.isDirectory()) return skillEntries(path.join(directory, entry.name), child);
    return entry.isFile() && entry.name === 'SKILL.md' ? [child] : [];
  });
}

/** Read-only selection shared by identity hashing and node asset emission.
 * The manifest, not directory copying, owns the exact shipped inventory. */
export function readInstructionAssets(root: string): { inputs: string[]; assets: InstructionAsset[] } {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Instruction resource root must be a directory without links.');
  }
  const manifestPath = regularFile(root, INSTRUCTION_MANIFEST);
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== 1
      || !('files' in manifest) || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Instruction manifest requires version 1 and a non-empty files array.');
  }
  const destinations = new Set<string>();
  const selectedSkills = new Set<string>();
  const assets = manifest.files.map((entry: unknown): InstructionAsset => {
    if (!entry || typeof entry !== 'object' || !('source' in entry) || !('destination' in entry)) {
      throw new Error('Instruction manifest entries require source and destination paths.');
    }
    const source = relativeFile(entry.source);
    const destination = relativeFile(entry.destination);
    const key = destination.toLowerCase();
    if (destinations.has(key) || [...destinations].some((existing) => existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`))) {
      throw new Error(`Duplicate or conflicting instruction destination: ${destination}`);
    }
    destinations.add(key);
    if (source.startsWith('skills/') && source.endsWith('/SKILL.md') && destination === source) selectedSkills.add(source);
    const sourcePath = regularFile(root, source);
    return { sourcePath, fileName: `${OUTPUT_ROOT}/${destination}`, source: fs.readFileSync(sourcePath) };
  });
  for (const skill of skillEntries(path.join(root, 'skills'))) {
    if (!selectedSkills.has(skill)) throw new Error(`Instruction manifest omits existing skill: ${skill}`);
  }
  return { inputs: [manifestPath, ...assets.map((asset) => asset.sourcePath)], assets };
}

/** Node graph only. Assets use the ordinary output inventory/generation hashes. */
export function createInstructionAssetsPlugin(root: string): Plugin {
  return {
    name: 'pie-instruction-assets',
    generateBundle() {
      for (const asset of readInstructionAssets(root).assets) {
        this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.source });
      }
    },
  };
}
