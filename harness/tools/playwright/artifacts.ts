import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/**
 * In-memory child sessions have no session JSONL path. Give each private owner
 * an OS-temp artifact partition rather than borrowing the parent's path; these
 * files remain available after child return for evidence and follow-up reads.
 */
export async function childArtifactDirectory(ownerId: string, playwrightSessionId: string): Promise<string> {
  const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 16);
  const idHash = createHash('sha256').update(playwrightSessionId).digest('hex').slice(0, 12);
  const directory = path.join(
    tmpdir(),
    'pie-playwright-child-artifacts',
    `${sanitize(ownerId)}-${ownerHash}`,
    `${sanitize(playwrightSessionId)}-${idHash}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export { sanitize as sanitizeArtifactSegment };
