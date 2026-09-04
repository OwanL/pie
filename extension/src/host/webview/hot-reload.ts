import * as path from 'node:path';

export const DEFAULT_WEBVIEW_VIEW_NAME = 'panel';

export function getWebviewAssetDir(
  extensionPath: string,
  viewName = DEFAULT_WEBVIEW_VIEW_NAME,
): string {
  return path.join(extensionPath, 'out', 'webview', viewName);
}

export function isHotReloadAssetFileName(
  fileName: string | null | undefined,
  _viewName = DEFAULT_WEBVIEW_VIEW_NAME,
): boolean {
  if (!fileName || fileName.endsWith('.map')) return false;

  const normalized = fileName.replaceAll('\\', '/');
  const generationRoot = '/pie-generations';
  if (normalized.endsWith(generationRoot)) return false;
  const generationSegment = `${generationRoot}/`;
  const generationIndex = normalized.indexOf(generationSegment);
  if (generationIndex < 0) {
    // Packaged/explicitly activated flat assets retain the legacy behavior.
    return true;
  }

  // Immutable generation files are copied and verified before selection.
  // Reload only for the atomic selection marker, never for intermediate copy
  // events or retention cleanup.
  const relative = normalized.slice(generationIndex + generationSegment.length);
  return relative.startsWith('selections/')
    && relative.endsWith('.json')
    && !relative.split('/').at(-1)?.startsWith('.pie-staging-');
}

