import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

function sanitize(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return cleaned || 'session';
}

export async function canonicalSessionPath(sessionPath: string): Promise<string> {
  const absolute = path.resolve(sessionPath);
  try { return await realpath(absolute); } catch { return absolute; }
}

export async function artifactDirectory(sessionPath: string, computerSessionId: string): Promise<string> {
  const canonical = await canonicalSessionPath(sessionPath);
  const base = sanitize(path.basename(canonical, path.extname(canonical)));
  const directory = path.join(path.dirname(canonical), 'computer-use', base, sanitize(computerSessionId));
  await mkdir(directory, { recursive: true });
  return directory;
}

export { sanitize as sanitizeArtifactSegment };
