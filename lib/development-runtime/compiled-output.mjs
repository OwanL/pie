import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Compilation evidence binds every emitted byte, not just source inputs or
 * entry-file existence. This is evidence for mutable build output, not an
 * immutable artifact or development snapshot store. */
export async function fingerprintCompiledPiOutputs(workspaceRoot, { runtimeRoot } = {}) {
  const hash = createHash('sha256');
  for (const packageName of ['tui', 'ai', 'agent', 'coding-agent']) {
    const runtimeNames = { tui: 'pi-tui', ai: 'pi-ai', agent: 'pi-agent-core', 'coding-agent': 'pi-coding-agent' };
    const directory = runtimeRoot
      ? path.join(runtimeRoot, 'node_modules/@earendil-works', runtimeNames[packageName], 'dist')
      : path.join(workspaceRoot, 'packages', packageName, 'dist');
    async function visit(current, relative = '') {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Compiled Pi output is not an ordinary directory: ${current}`);
      for (const name of (await readdir(current)).sort()) {
        const file = path.join(current, name);
        const relativeFile = `${relative}${name}`;
        const entry = await lstat(file);
        if (entry.isSymbolicLink()) throw new Error(`Compiled Pi output contains a link: ${file}`);
        if (entry.isDirectory()) await visit(file, `${relativeFile}/`);
        else {
          if (!entry.isFile()) throw new Error(`Compiled Pi output contains a non-file: ${file}`);
          hash.update(`${packageName}/${relativeFile}\0`).update(await readFile(file)).update('\0');
        }
      }
    }
    await visit(directory);
  }
  return hash.digest('hex');
}
