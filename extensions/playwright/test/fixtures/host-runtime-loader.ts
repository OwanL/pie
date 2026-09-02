import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const hostEntry = path.join(repoRoot, 'extension', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'extensions', 'loader.js');
const { loadExtensions } = await import(pathToFileURL(hostEntry).href) as {
  loadExtensions(paths: string[], cwd: string): Promise<any>;
};
const loaded = await loadExtensions([path.join(repoRoot, 'extensions', 'playwright', 'index.ts')], repoRoot);
const registered = loaded.extensions.flatMap((extension: any) => [...extension.tools.values()])
  .find((entry: any) => entry.definition.name === 'playwright');
const schema = registered?.definition.parameters as any;
process.stdout.write(`${JSON.stringify({
  errors: loaded.errors,
  found: registered !== undefined,
  serializedLength: schema ? JSON.stringify(schema).length : 0,
  hasConst: schema ? JSON.stringify(schema).includes('"const"') : false,
  actionEnum: schema?.properties?.action?.enum,
  inputKinds: schema?.properties?.input?.anyOf?.map((member: any) => ({
    type: member.properties.kind.type,
    enumLength: member.properties.kind.enum.length,
  })),
})}\n`);
