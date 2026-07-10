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
  if (!fileName) {
    return false;
  }

  // Any built asset or manifest change should trigger a webview reload.
  // Ignore sourcemaps, which churn on every build but do not affect runtime.
  return !fileName.endsWith('.map');
}

