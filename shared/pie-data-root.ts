/**
 * Typed API for the canonical OS-local runtime-data root resolver.
 * The implementation is shared with the JavaScript doctor via the adjacent
 * `pie-data-root-core.mjs`; all functions remain path-only and side-effect-free.
 */
import * as core from './pie-data-root-core.mjs';

export const PIE_DATA_DIR_ENV = core.PIE_DATA_DIR_ENV as 'PIE_DATA_DIR';
export const PIE_DATA_SUBDIRECTORIES = core.PIE_DATA_SUBDIRECTORIES as {
  readonly analytics: 'analytics';
  readonly sessions: 'sessions';
  readonly artifacts: 'artifacts';
  readonly state: 'state';
  readonly cache: 'cache';
};
export type PieDataSubdirectory = keyof typeof PIE_DATA_SUBDIRECTORIES;

export interface PieDataRootResolutionOptions {
  dataDir?: string;
  agentDir?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  localAppDataDir?: string;
  xdgDataHome?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}
export interface PieDataRootPaths {
  rootDir: string;
  analyticsDir: string;
  sessionsDir: string;
  artifactsDir: string;
  stateDir: string;
  cacheDir: string;
}

export const PieDataRootResolutionError = core.PieDataRootResolutionError;
export type PieDataRootResolutionError = core.PieDataRootResolutionError;

export function resolvePieDataRoot(options: PieDataRootResolutionOptions = {}): string {
  return core.resolvePieDataRoot(options);
}
export function resolvePieDataPaths(options: PieDataRootResolutionOptions = {}): PieDataRootPaths {
  return core.resolvePieDataPaths(options) as PieDataRootPaths;
}
export const resolvePieDataRootFromEnvironment = resolvePieDataRoot;
export const resolvePieDataRootPaths = resolvePieDataPaths;
export function resolvePieDataSubdirectory(
  rootDir: string,
  subdirectory: PieDataSubdirectory,
  platform: NodeJS.Platform = process.platform,
): string {
  return core.resolvePieDataSubdirectory(rootDir, subdirectory, platform);
}
