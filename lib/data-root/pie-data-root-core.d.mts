export const PIE_DATA_DIR_ENV: 'PIE_DATA_DIR';
export const PIE_DATA_SUBDIRECTORIES: {
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
export class PieDataRootResolutionError extends Error {
  readonly code: 'PIE_DATA_ROOT_UNRESOLVED';
  constructor(message: string);
}
export function resolvePieDataRoot(options?: PieDataRootResolutionOptions): string;
export function resolvePieDataPaths(options?: PieDataRootResolutionOptions): PieDataRootPaths;
export const resolvePieDataRootFromEnvironment: typeof resolvePieDataRoot;
export const resolvePieDataRootPaths: typeof resolvePieDataPaths;
export function resolvePieDataSubdirectory(rootDir: string, subdirectory: PieDataSubdirectory, platform?: NodeJS.Platform): string;
