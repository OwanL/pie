import {
  resolveFilePathWithFallback,
  type FilePathResolverAdapter,
  type OpenFileRequest,
} from '../../lib/image-preview.js';

// Preserve the existing VS Code import surface for host adapters and consumers.
export {
  readImagePreviewWithFallback,
  resolveFilePathWithFallback,
  type FilePathResolution,
  type FilePathResolverAdapter,
  type ImagePreviewAdapter,
  type OpenFileRequest,
} from '../../lib/image-preview.js';

export interface OpenFileAdapter extends FilePathResolverAdapter {
  chooseFile(files: readonly string[], workingDirectory: string, basename: string): Promise<string | undefined>;
  open(filePath: string): Promise<void>;
  showError(message: string): void;
}

/**
 * Open the exact renderer-resolved path first. Only a missing exact path paired
 * with an original bare filename may search, and that search stays rooted at
 * the renderer-captured session cwd. Ambiguous references retain the chooser.
 */
export async function openFileWithFallback(request: OpenFileRequest, adapter: OpenFileAdapter): Promise<void> {
  const reference = request.reference?.trim();
  try {
    const resolution = await resolveFilePathWithFallback(request, adapter);
    if (resolution.status === 'found') {
      await adapter.open(resolution.path);
      return;
    }
    if (resolution.status === 'ambiguous') {
      const selected = await adapter.chooseFile(resolution.matches, resolution.searchRoot, resolution.basename);
      if (selected !== undefined) await adapter.open(selected);
      return;
    }

    const name = reference || request.path;
    const scope = resolution.searchRoot !== undefined ? ` under ${resolution.searchRoot}` : '';
    adapter.showError(`Could not find file "${name}"${scope}.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    adapter.showError(`Could not open file "${reference || request.path}": ${detail}`);
    throw error;
  }
}
