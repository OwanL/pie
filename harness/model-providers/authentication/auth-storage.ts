import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Walk up from a file path looking for a `.git` directory. Returns true if the
 * file resides inside a Git working tree.
 */
export async function isInsideGitWorkTree(filePath: string): Promise<boolean> {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.parse(dir).root;
  while (true) {
    try {
      const stat = await fs.stat(path.join(dir, '.git'));
      if (stat.isDirectory() || stat.isFile()) {
        return true;
      }
    } catch {
      // .git not found at this level — continue walking up.
    }
    if (dir === root) {
      break;
    }
    dir = path.dirname(dir);
  }
  return false;
}

/**
 * Returns the platform-standard directory for pie credentials.
 * - Windows: %LOCALAPPDATA%\pie
 * - macOS/Linux: ~/.config/pie
 */
export function getDefaultAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      return path.join(localAppData, 'pie');
    }
  }
  const home = env.HOME ?? env.USERPROFILE ?? '';
  return path.join(home, '.config', 'pie');
}

/**
 * Ensures a directory exists, creating it (and parents) if needed.
 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * If `source` exists and `dest` does not, copy source to dest and remove the
 * original. Returns true if a migration occurred.
 */
export async function migrateAuthFile(source: string, dest: string): Promise<boolean> {
  try {
    await fs.access(source);
  } catch {
    return false; // source doesn't exist — nothing to migrate
  }
  try {
    await fs.access(dest);
    return false; // dest already exists — don't overwrite
  } catch {
    // dest doesn't exist — proceed with migration
  }
  await ensureDir(path.dirname(dest));
  await fs.copyFile(source, dest);
  // Verify copy matches before removing original
  const [srcBuf, dstBuf] = await Promise.all([fs.readFile(source), fs.readFile(dest)]);
  if (srcBuf.equals(dstBuf)) {
    await fs.unlink(source);
    return true;
  }
  return false;
}

export async function ensureAuthPathDirectory(authPath: string): Promise<void> {
  await ensureDir(path.dirname(authPath));
}
