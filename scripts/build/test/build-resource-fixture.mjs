import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_RUNTIME_FILES } from '../tool-runtime-assets.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export function installBuildResources(repo) {
  const write = (relative, content) => {
    const file = path.join(repo, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  // Copy the real config's resource/helper closure, but use tiny core entries.
  for (const file of [
    'scripts/build/bundled-extension-verification.mjs',
    'scripts/build/tool-runtime-assets.mjs',
    'scripts/build/bundled-extension-assets.ts',
    'scripts/build/instruction-assets.ts',
    'harness/tools/catalog/bundled-extensions.ts',
    'harness/tools/catalog/index.ts',
    'harness/tools/catalog/tool-names.ts',
    'harness/agent-instructions/application-resources.ts',
    'harness/agent-instructions/resource-roots.ts',
    'lib/managed-packages/bundled-resources.mjs',
    'lib/managed-packages/managed-package-contract.mjs',
    ...TOOL_RUNTIME_FILES,
  ]) write(file, readFileSync(path.join(repositoryRoot, file)));
  const catalog = readFileSync(path.join(repositoryRoot, 'harness/tools/catalog/bundled-extensions.ts'), 'utf8');
  for (const [, id] of catalog.matchAll(/^  entry\('([^']+)'/gm)) {
    write(`extensions/${id}/index.ts`, 'export const fixtureExtension = true;\n');
  }
  write('harness/agent-instructions/bundled-resources.json', JSON.stringify({
    version: 1, files: [{ source: 'SYSTEM.md', destination: 'SYSTEM.md' }],
  }));
  write('harness/agent-instructions/SYSTEM.md', 'Fixture instructions.\n');
}
