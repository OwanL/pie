import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const PUBLISHED_GENERATIONS_DIR = 'pie-generations';
export const PUBLISHED_SELECTIONS_DIR = 'selections';

const BUILD_ID_PATTERN = /^[0-9a-f]{20}$/u;

interface SelectionRecord {
  generation?: unknown;
}

interface PublishedManifestChunk {
  file?: unknown;
  isEntry?: unknown;
  css?: unknown;
  assets?: unknown;
  imports?: unknown;
  dynamicImports?: unknown;
}

/**
 * Resolve the newest complete append-only renderer publication. A malformed,
 * torn, or prematurely visible selection is skipped so the prior generation
 * remains loadable. Packaged/activated flat assets are the baseline fallback.
 */
export async function resolvePublishedWebviewDir(panelDir: string): Promise<string> {
  const publicationRoot = path.join(panelDir, PUBLISHED_GENERATIONS_DIR);
  const selectionsDir = path.join(publicationRoot, PUBLISHED_SELECTIONS_DIR);
  let selectionNames: string[];
  try {
    selectionNames = (await fs.readdir(selectionsDir))
      .filter((name) => name.endsWith('.json') && !name.startsWith('.pie-staging-'))
      .sort()
      .reverse();
  } catch {
    return panelDir;
  }

  for (const selectionName of selectionNames) {
    try {
      const selection = JSON.parse(
        await fs.readFile(path.join(selectionsDir, selectionName), 'utf8'),
      ) as SelectionRecord;
      if (typeof selection.generation !== 'string' || !BUILD_ID_PATTERN.test(selection.generation)) continue;
      const generationDir = path.join(publicationRoot, selection.generation);
      const [buildId, manifestText] = await Promise.all([
        fs.readFile(path.join(generationDir, 'pie-build-id.txt'), 'utf8'),
        fs.readFile(path.join(generationDir, '.vite', 'manifest.json'), 'utf8'),
      ]);
      if (buildId.trim() !== selection.generation) continue;
      const manifest = JSON.parse(manifestText) as Record<string, PublishedManifestChunk>;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
      const references: string[] = [];
      let entryCount = 0;
      for (const [chunkName, chunk] of Object.entries(manifest)) {
        if (!chunk || typeof chunk !== 'object' || typeof chunk.file !== 'string' || chunk.file.length === 0) {
          throw new Error(`Invalid renderer manifest chunk: ${chunkName}`);
        }
        if (chunk.isEntry === true) entryCount += 1;
        references.push(chunk.file);
        for (const values of [chunk.css ?? [], chunk.assets ?? []]) {
          if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
            throw new Error(`Invalid renderer manifest file list: ${chunkName}`);
          }
          references.push(...values as string[]);
        }
        for (const values of [chunk.imports ?? [], chunk.dynamicImports ?? []]) {
          if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !manifest[value])) {
            throw new Error(`Invalid renderer manifest import: ${chunkName}`);
          }
        }
      }
      if (entryCount !== 1) throw new Error('Renderer manifest must contain exactly one entry chunk.');
      const base = `${path.resolve(generationDir)}${path.sep}`;
      await Promise.all(references.map((relativePath) => {
        const absolute = path.resolve(generationDir, relativePath);
        if (!absolute.startsWith(base)) throw new Error('Renderer manifest path escapes its generation.');
        return fs.access(absolute);
      }));
      for (const relativePath of references.filter((value) => value.endsWith('.js'))) {
        const source = await fs.readFile(path.resolve(generationDir, relativePath), 'utf8');
        const workerPattern = /["']\/assets\/([A-Za-z0-9_-]+-worker-[A-Za-z0-9_-]+\.js)["']/gu;
        for (const match of source.matchAll(workerPattern)) {
          await fs.access(path.join(generationDir, 'assets', match[1]));
        }
      }
      return generationDir;
    } catch {
      // Try the previous immutable selection.
    }
  }
  return panelDir;
}
