import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Populate `targetRoot` as a cheap clone of `sourceRoot`.
 *
 * Regular files become same-volume hardlinks (no data copy); `freshCopyRelativePaths`
 * are re-copied normally so tests can truncate/rewrite them without mutating the
 * source tree. Directory symlinks (junctions) are recreated rather than followed.
 * Both roots must be on the same volume for fs.link to succeed.
 */
export async function cloneTreeByHardlink(
  sourceRoot: string,
  targetRoot: string,
  freshCopyRelativePaths: Iterable<string> = [],
): Promise<void> {
  const fresh = new Set([...freshCopyRelativePaths].map((entry) => path.resolve(sourceRoot, entry)));

  const walk = async (sourceDir: string, targetDir: string, relativeDir: string): Promise<void> => {
    await fs.mkdir(targetDir, { recursive: true });
    for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isSymbolicLink()) {
        const linkTarget = await fs.readlink(sourcePath);
        const isDirectoryLink = (await fs.stat(sourcePath).catch(() => undefined))?.isDirectory() ?? false;
        await fs.symlink(linkTarget, targetPath, process.platform === 'win32' ? (isDirectoryLink ? 'junction' : 'file') : null);
      } else if (entry.isDirectory()) {
        await walk(sourcePath, targetPath, relativePath);
      } else if (fresh.has(path.resolve(sourcePath))) {
        await fs.copyFile(sourcePath, targetPath);
      } else {
        await fs.link(sourcePath, targetPath);
      }
    }
  };

  await walk(sourceRoot, targetRoot, '.');
}