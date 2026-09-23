import { createHash } from 'node:crypto';
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

export async function artifactDirectory(sessionPath: string, playwrightSessionId: string): Promise<string> {
  const canonical = await canonicalSessionPath(sessionPath);
  const baseName = sanitize(path.basename(canonical, path.extname(canonical)));
  const baseHash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  const idHash = createHash('sha256').update(playwrightSessionId).digest('hex').slice(0, 12);
  const directory = path.join(path.dirname(canonical), 'playwright', `${baseName}-${baseHash}`, `${sanitize(playwrightSessionId)}-${idHash}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

export { sanitize as sanitizeArtifactSegment };
