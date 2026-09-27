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

export async function artifactDirectory(sessionPath: string, computerSessionId: string): Promise<string> {
  const canonical = await canonicalSessionPath(sessionPath);
  const base = sanitize(path.basename(canonical, path.extname(canonical)));
  const directory = path.join(path.dirname(canonical), 'computer-use', base, sanitize(computerSessionId));
  await mkdir(directory, { recursive: true });
  return directory;
}

/** Child runtimes have no persistent session path; keep their artifacts in a private OS-temp partition. */
export async function childArtifactDirectory(ownerId: string, computerSessionId: string): Promise<string> {
  const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 16);
  const sessionHash = createHash('sha256').update(computerSessionId).digest('hex').slice(0, 12);
  const directory = path.join(
    tmpdir(),
    'pie-computer-child-artifacts',
    `${sanitize(ownerId)}-${ownerHash}`,
    `${sanitize(computerSessionId)}-${sessionHash}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export { sanitize as sanitizeArtifactSegment };
