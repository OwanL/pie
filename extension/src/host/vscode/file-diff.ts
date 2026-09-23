import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { isTrackedByGit } from '../../shared/git-baseline';
import type { FileDiffCoreLike, FileDiffViewerLike } from '../core/file-diff-service';

export const EMPTY_DIFF_SCHEME = 'pie-empty-diff';

export class EmptyDiffContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return '';
  }
}

/** VS Code viewer adapter for the platform-neutral changed-file core. */
export class VscodeFileDiffViewer implements FileDiffViewerLike {
  constructor(private readonly service: FileDiffCoreLike) {}

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
    const resolvedPath = this.service.resolveFileChangePath(sessionPath, filePath);
    const uri = vscode.Uri.file(resolvedPath);
    let kind = this.service.getFileChangeKind(sessionPath, filePath, resolvedPath);
    // A `created` kind is the derivation's best guess from the tool NAME
    // (write/create) — it cannot prove the file is new. Verify the claim
    // against git: a tracked file existed before the session, so an overwrite
    // is a modification, not a creation.
    if (kind === 'created' && await isTrackedByGit(resolvedPath)) {
      kind = 'modified';
    }
    const emptyUri = this.toEmptyDiffUri(uri);
    // Diff against the pre-change baseline, not a bare HEAD. Agents may have
    // committed their changes already, in which case HEAD contains the new
    // content and a HEAD-vs-working-tree diff is empty.
    const fileExists = await fs.access(resolvedPath).then(() => true, () => false);
    const baselineRef =
      kind === 'created' ? undefined : await this.service.resolveBaselineRef(resolvedPath);
    // HEAD is usable only when git still tracks the path. A non-HEAD ref came
    // from the file's history and therefore contains a usable snapshot.
    const hasGitBaseline = baselineRef !== undefined && (
      baselineRef !== 'HEAD' || await isTrackedByGit(resolvedPath)
    );

    if (!fileExists && !hasGitBaseline) {
      const reason = kind === 'deleted'
        ? 'No Git baseline is available for this deleted file.'
        : 'The file no longer exists on disk.';
      void vscode.window.showWarningMessage(
        `Cannot show agent changes for ${resolvedPath}. ${reason}`,
      );
      return;
    }

    if (!fileExists) {
      void vscode.window.showWarningMessage(
        `${resolvedPath} no longer exists on disk. Showing its last available Git version.`,
      );
    } else if (!hasGitBaseline && kind !== 'created') {
      void vscode.window.showWarningMessage(
        `No Git baseline is available for ${resolvedPath}. Showing the current file as newly created.`,
      );
    }

    const originalUri = hasGitBaseline
      ? this.toGitUri(uri, baselineRef)
      : emptyUri;
    const modifiedUri = fileExists ? uri : emptyUri;

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      modifiedUri,
      `${path.basename(resolvedPath)} — agent changes`,
      { preview: true },
    );
  }

  async openFileInEditor(sessionPath: string, filePath: string): Promise<void> {
    const resolvedPath = this.service.resolveFileChangePath(sessionPath, filePath);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolvedPath), { preview: false });
  }
}
