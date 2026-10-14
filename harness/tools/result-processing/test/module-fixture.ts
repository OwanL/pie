import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownerDir = fileURLToPath(new URL('..', import.meta.url));

/** Load one ESM graph: native test:file's CJS wrappers cannot provide import.meta.dirname.
 * Keep config/logger exports shared with the adapter, including its lazy imports.
 * The output is invocation-private; source-relative runtime paths remain unchanged.
 */
export async function loadModuleFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pie-result-processing-modules-'));
  const outfile = path.join(dir, 'fixture.mjs');
  try {
    await build({
      stdin: {
        contents: `export * as config from './config.ts';\nexport * as logger from './logger.ts';\nexport * as adapter from '../../../extensions/tool-result-pruner/index.ts';`,
        resolveDir: ownerDir,
        sourcefile: 'result-processing-fixture.ts',
        loader: 'ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [{
        name: 'source-owned-import-meta',
        setup(build) {
          build.onLoad({ filter: /\.ts$/ }, ({ path: sourcePath }) => ({
            contents: readFileSync(sourcePath, 'utf8')
              .replaceAll('import.meta.dirname', JSON.stringify(path.dirname(sourcePath)))
              .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(sourcePath).href)),
            loader: 'ts',
          }));
        },
      }],
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
