import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
export async function withCatalogDirectory(run: (root: string, agentDir: string, sessionDir: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-catalog-test-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'canonical');
    await fs.mkdir(sessionDir, { recursive: true });
    await run(root, agentDir, sessionDir);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function writeSession(file: string, name?: string, timestamp = '2026-01-01T00:00:00.000Z'): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const entries: object[] = [
    { type: 'session', version: 3, id: path.basename(file), cwd: '/repo', timestamp },
    { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: 'Refactor the analytics pipeline now', timestamp: Date.parse(timestamp) } },
  ];
  if (name) entries.push({ type: 'session_info', id: 'name', parentId: 'user', name, timestamp });
  await fs.writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}
