/**
 * Narrow host-facing contracts for the changed-file core. Kept in application/lib
 * so shared host composition can depend on these ports without importing the
 * backend implementation that constructs them.
 */
export interface FileDiffCorePort {
  resolveFileChangePath(sessionPath: string, filePath: string): string;
  getFileChangeKind(
    sessionPath: string,
    filePath: string,
    resolvedPath: string,
  ): 'created' | 'modified' | 'deleted';
  resolveBaselineRef(resolvedPath: string): Promise<string>;
}

/** Host-specific presentation operations for a changed-file diff. */
export interface FileDiffViewerPort {
  openFileDiff(sessionPath: string, filePath: string): Promise<void>;
  openFileInEditor(sessionPath: string, filePath: string): Promise<void>;
}
