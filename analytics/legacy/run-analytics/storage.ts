import * as path from 'node:path';

export interface AnalyticsUriLike {
  scheme: string;
  fsPath?: string;
  toString(skipEncoding?: boolean): string;
}

export interface AnalyticsWorkspaceFolderLike {
  uri: AnalyticsUriLike;
}

export interface BuildWorkspaceAnalyticsIdOptions {
  workspaceFolders?: readonly AnalyticsWorkspaceFolderLike[];
  workspaceFile?: AnalyticsUriLike | null;
  noWorkspaceId: string;
  platform?: NodeJS.Platform;
}

export function getDataOutcomesRootPath(
  configuredRoot: string | undefined | null,
  globalStoragePath: string,
): string {
  const analyticsDir = process.env.PIE_ANALYTICS_DIR?.trim();
  if (analyticsDir) {
    return path.resolve(analyticsDir);
  }
  const trimmedRoot = configuredRoot?.trim();
  return trimmedRoot
    ? path.join(trimmedRoot, 'data', 'outcomes')
    : path.join(globalStoragePath, 'data', 'outcomes');
}

export function getDefaultRunAnalyticsExportPath(
  configuredRoot: string | undefined | null,
  globalStoragePath: string,
  workspaceRoot: string,
): string {
  const trimmedRoot = configuredRoot?.trim();
  if (trimmedRoot) {
    return path.join(trimmedRoot, 'analysis', 'data', 'exports', 'run-analytics-export.json');
  }

  const workspaceLabel = path.basename(workspaceRoot) || 'workspace';
  return path.join(globalStoragePath, 'exports', workspaceLabel, 'run-analytics-export.json');
}

export function buildWorkspaceAnalyticsId(options: BuildWorkspaceAnalyticsIdOptions): string {
  const platform = options.platform ?? process.platform;
  const folderKeys = (options.workspaceFolders ?? [])
    .map((folder) => toAnalyticsUriKey(folder.uri, platform))
    .sort((left, right) => left.localeCompare(right));

  if (folderKeys.length > 0) {
    return JSON.stringify({ folders: folderKeys });
  }

  if (options.workspaceFile) {
    return JSON.stringify({ workspaceFile: toAnalyticsUriKey(options.workspaceFile, platform) });
  }

  const noWorkspaceId = options.noWorkspaceId.trim() || 'default';
  return JSON.stringify({ noWorkspaceId });
}

function toAnalyticsUriKey(uri: AnalyticsUriLike, platform: NodeJS.Platform): string {
  if (uri.scheme === 'file' && typeof uri.fsPath === 'string' && uri.fsPath.length > 0) {
    return `file:${normalizeFileSystemPathForKey(uri.fsPath, platform)}`;
  }

  const raw = uri.toString(true);
  const separatorIndex = raw.indexOf(':');
  if (separatorIndex <= 0) {
    return raw;
  }

  return `${raw.slice(0, separatorIndex).toLowerCase()}${raw.slice(separatorIndex)}`;
}

function normalizeFileSystemPathForKey(fileSystemPath: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let normalized = pathApi.normalize(fileSystemPath);

  if (!pathApi.isAbsolute(normalized)) {
    normalized = pathApi.resolve(normalized);
  }

  normalized = normalized.replace(/\\/g, '/');
  if (platform === 'win32') {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}
