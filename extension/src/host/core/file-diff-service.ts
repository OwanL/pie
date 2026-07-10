import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { ArchState } from './reducer';
import { resolveBaselineRef, isTrackedByGit } from '../../shared/git-baseline';

export const EMPTY_DIFF_SCHEME = 'pie-empty-diff';

export class EmptyDiffContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return '';
  }
}

export class FileDiffService {
  constructor(private readonly getArchState: () => ArchState) {}

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
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

  private toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
    return uri.with({
      scheme: 'git',
      query: JSON.stringify({ path: uri.fsPath, ref }),
    });
  }

  private toEmptyDiffUri(uri: vscode.Uri): vscode.Uri {
    return uri.with({
      scheme: EMPTY_DIFF_SCHEME,
      query: '',
      fragment: '',
    });
  }

  async openFileDiff(sessionPath: string, filePath: string): Promise<void> {
    const resolvedPath = this.resolveFileChangePath(sessionPath, filePath);
    const uri = vscode.Uri.file(resolvedPath);
    const kind = this.getFileChangeKind(sessionPath, filePath, resolvedPath);
    const emptyUri = this.toEmptyDiffUri(uri);
    // Diff baseline: NOT a bare `HEAD`. The changed-files panel is derived
    // from transcript tool calls, and pi agents commit their work after each
    // task — so for any committed file `HEAD` already contains the agent's
    // changes and a `HEAD`-vs-working-tree diff is empty (the "same file on
    // both sides" bug). `resolveBaselineRef` walks the file's git history to
    // the most recent commit whose content DIFFERS from the working tree —
    // the pre-change baseline — falling back to `HEAD` when none is found.
    const baselineRef =
      kind === 'created' ? 'HEAD' : await this.resolveBaselineRef(resolvedPath);
    const originalUri = kind === 'created' ? emptyUri : this.toGitUri(uri, baselineRef);
    const modifiedUri = kind === 'deleted' ? emptyUri : uri;

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        modifiedUri,
        `${path.basename(resolvedPath)} — agent changes`,
        { preview: true },
      );
    } catch {
      await vscode.commands.executeCommand('git.openChange', uri);
    }
  }

  /**
   * Resolve the git ref to diff a changed file against — the pre-change
   * baseline rather than a bare `HEAD`.
   *
   * Walks the file's git history (commits that touched it, newest first) and
   * returns the most recent commit whose content DIFFERS from the working
   * tree. For an uncommitted (dirty) change that is `HEAD` itself (current
   * behaviour preserved); for a change the agent has since committed it is the
   * commit just before the change — without this, `HEAD` already holds the
   * agent's edits and the diff is empty.
   *
   * Known limitation: if the agent made several commits to the same file
   * during a session and the working tree matches the latest of them, the
   * baseline is the commit before the LAST change, so the diff shows only
   * that final delta rather than the whole session's churn. Returns `'HEAD'`
   * (no regression) when the file is untracked, git is unavailable, or the
   * walk finds no differing commit.
   */
  /** Delegate to the shared pure-node baseline resolver (shared/git-baseline).
   *  Kept as a method so host callers + the existing test (svc.resolveBaselineRef)
   *  are unchanged after the extraction. */
  async resolveBaselineRef(resolvedPath: string): Promise<string> {
    return resolveBaselineRef(resolvedPath);
  }

  async openFileInEditor(sessionPath: string, filePath: string): Promise<void> {
    const resolvedPath = this.resolveFileChangePath(sessionPath, filePath);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolvedPath), { preview: false });
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
        void vscode.window.showWarningMessage(
          `Could not revert ${filePath}. The file may not be under source control.`,
        );
        return;
      }
      // File is already gone – treat as success and remove the entry.
    }
  }
}