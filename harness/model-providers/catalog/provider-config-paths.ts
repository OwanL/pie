import path from 'node:path';
import { stat, realpath } from 'node:fs/promises';

import {
  resolvePieDataPaths,
  type PieDataRootResolutionOptions,
} from '../../../lib/data-root/pie-data-root';

export interface ProviderConfigPathResolutionOptions extends PieDataRootResolutionOptions {
  /** Absolute directory override for a private development/test profile. */
  configDir?: string;
}

export interface ProviderConfigPaths {
  configDir: string;
  configFile: string;
  modelCacheDir: string;
}

/** Reject Git trees before opening configuration, cache, or credentials.
 * Only exact ancestor .git entries are inspected; no Git commands or tree walks.
 * Existing ancestor realpaths also prevent symlinked directories bypassing the boundary.
 */
export async function assertProviderManagementPathsOutsideGit(paths: ProviderConfigPaths): Promise<void> {
  const checked = new Set<string>();
  const checkAncestors = async (start: string): Promise<void> => {
    let current = start;
    while (!checked.has(current)) {
      checked.add(current);
      try {
        await stat(path.join(current, '.git'));
        throw new Error('Provider management paths must be outside Git trees.');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  for (const value of [paths.configDir, paths.configFile, paths.modelCacheDir]) {
    if (!path.isAbsolute(value) || value.includes('\u0000')) throw new Error('Provider management paths must be absolute and contain no NUL bytes.');
    let current = path.resolve(value);
    await checkAncestors(current);
    // Resolve the nearest existing ancestor, even when the destination is not created yet.
    while (true) {
      try {
        await checkAncestors(await realpath(current));
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }
}

/** Resolve provider configuration and model-catalog cache locations without I/O. */
export function resolveProviderConfigPaths(
  options: ProviderConfigPathResolutionOptions = {},
): ProviderConfigPaths {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let configDir: string;

  if (options.configDir !== undefined) {
    const configured = options.configDir.trim();
    if (!configured || !pathApi.isAbsolute(configured)) {
      throw new Error('Provider configDir must be a non-empty absolute path.');
    }
    if (configured.includes('\u0000')) throw new Error('Provider configDir contains a NUL byte.');
    configDir = pathApi.normalize(configured);
  } else {
    if (platform !== 'win32') {
      throw new Error('Provider configuration defaults are only defined for Windows; provide an absolute configDir.');
    }
    const env = options.environment ?? process.env;
    const localAppData = (options.localAppDataDir ?? env.LOCALAPPDATA)?.trim();
    if (!localAppData || !pathApi.isAbsolute(localAppData)) {
      throw new Error('LOCALAPPDATA must be a non-empty absolute path to resolve the default provider config directory.');
    }
    if (localAppData.includes('\u0000')) throw new Error('LOCALAPPDATA contains a NUL byte.');
    configDir = pathApi.join(pathApi.normalize(localAppData), 'pie', 'config');
  }

  const dataPaths = resolvePieDataPaths(options);
  return {
    configDir,
    configFile: pathApi.join(configDir, 'providers.yaml'),
    modelCacheDir: pathApi.join(dataPaths.cacheDir, 'provider-models'),
  };
}
