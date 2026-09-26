import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
