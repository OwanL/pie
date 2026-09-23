import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ArchState } from './reducer';
import { resolveBaselineRef, isTrackedByGit } from '../../shared/git-baseline';

/** Narrow host capability needed by the platform-neutral file-change core. */
export interface FileDiffPlatform {
  /** Workspace fallback used when a session and ArchState have no cwd. */
  getWorkspaceCwd(): string | undefined;
  /** Revert failures are intentionally non-fatal, matching the existing UI. */
  showWarning(message: string): void;
}

/** Core file-change operations consumed by the effect runner. */
export interface FileDiffServiceLike {
  revertFile(sessionPath: string, filePath: string): Promise<void>;
}

/** Read-only core surface needed by a changed-file viewer adapter. */
export interface FileDiffCoreLike {
  resolveFileChangePath(sessionPath: string, filePath: string): string;
  getFileChangeKind(
    sessionPath: string,
    filePath: string,
    resolvedPath: string,
  ): 'created' | 'modified' | 'deleted';
  resolveBaselineRef(resolvedPath: string): Promise<string>;
}

/** Viewer operations remain an adapter concern (VS Code, browser, etc.). */
export interface FileDiffViewerLike {
  openFileDiff(sessionPath: string, filePath: string): Promise<void>;
  openFileInEditor(sessionPath: string, filePath: string): Promise<void>;
}

const DEFAULT_PLATFORM: FileDiffPlatform = {
  getWorkspaceCwd: () => undefined,
  showWarning: () => undefined,
};

/**
 * Platform-neutral changed-file core. It owns ArchState path resolution and
 * file-change classification plus the git baseline/revert behavior. Rendering
 * a diff or opening an editor belongs to a host adapter, not this module.
 */
export class FileDiffService implements FileDiffServiceLike, FileDiffCoreLike {
  constructor(
    private readonly getArchState: () => ArchState,
    private readonly platform: FileDiffPlatform = DEFAULT_PLATFORM,
  ) {}

  resolveFileChangePath(sessionPath: string, filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    const archState = this.getArchState();
    const sessionCwd = archState.sessions.sessions.find(
      (session) => session.path === sessionPath,
    )?.cwd;
    const basePath =
      sessionCwd ||
      archState.sessions.workspaceCwd ||
      this.platform.getWorkspaceCwd();
    return basePath ? path.resolve(basePath, filePath) : filePath;
  }

  getFileChangeKind(
    sessionPath: string,
    filePath: string,
    resolvedPath: string,
  ): 'created' | 'modified' | 'deleted' {
    const archState = this.getArchState();
    const changes = archState.fileChanges.bySession[sessionPath] ?? [];
    const change = changes.find((entry) => {
      const entryPath = this.resolveFileChangePath(sessionPath, entry.path);
      return entry.path === filePath || entryPath === resolvedPath;
    });
    return change?.kind ?? 'modified';
  }

  /**
   * Resolve the git ref to diff a changed file against — the pre-change
   * baseline rather than a bare `HEAD`. Kept as a method for host callers and
   * the existing core contract; the implementation is shared with the other
   * changed-file surfaces.
   */
  async resolveBaselineRef(resolvedPath: string): Promise<string> {
    return resolveBaselineRef(resolvedPath);
  }

  async revertFile(sessionPath: string, filePath: string): Promise<void> {
    const resolvedPath = this.resolveFileChangePath(sessionPath, filePath);

    try {
      // Check whether the file is known to git (tracked or staged).
      const tracked = await isTrackedByGit(resolvedPath);

      if (tracked) {
        // Restore to last committed version.
        await new Promise<void>((resolve, reject) => {
          cp.execFile(
            'git',
            ['checkout', 'HEAD', '--', resolvedPath],
            { cwd: path.dirname(resolvedPath), timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
            (err) => (err ? reject(err) : resolve()),
          );
        });
      } else {
        // Untracked file created by the agent – delete it.
        await fs.unlink(resolvedPath);
      }
    } catch {
      // Last resort: if the file still exists, warn the user.
      const exists = await fs.access(resolvedPath).then(() => true, () => false);
      if (exists) {
        this.platform.showWarning(
          `Could not revert ${filePath}. The file may not be under source control.`,
        );
        return;
      }
      // File is already gone – treat as success and remove the entry.
    }
  }
}
