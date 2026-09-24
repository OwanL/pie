export const PUBLISHED_GENERATIONS_DIR: string;
export const PUBLISHED_SELECTIONS_DIR: string;
export const RETAINED_RENDERER_GENERATIONS: number;

export function writeFileIfChanged(filePath: string, contents: string): Promise<boolean>;

export interface NodeBundleStatus {
  builtFiles: string[];
  installedFiles: string[];
  missingInstalled: string[];
  extraInstalled: string[];
  mismatched: string[];
  unreadableBuilt: string[];
  unreadableInstalled: string[];
  builtDirectoryError: string | null;
  installedDirectoryError: string | null;
  current: boolean;
}

export function compareNodeBundles(options: {
  builtOutDir: string;
  installedOutDir: string;
  readFile?: (filePath: string) => Promise<Uint8Array | string>;
}): Promise<NodeBundleStatus>;

export function formatNodeBundleStatus(options: {
  status: NodeBundleStatus;
  builtOutDir: string;
  installedOutDir: string;
}): string;

export function findCompatibleInstalledExtensionDir(
  extensionRoots: readonly string[],
  pkg: { publisher: string; name: string; version: string },
): Promise<string | null>;

export function verifyRendererGeneration(directory: string, expectedGeneration: string): Promise<void>;

export function resolvePublishedRendererGeneration(panelDir: string): Promise<{
  name: string | null;
  generation: string | null;
  generationDir: string;
}>;

export function publishRendererGeneration(options: {
  sourceDir: string;
  extensionDir: string;
  now?: number;
  pid?: number;
  beforeSelect?: (publication: { generation: string; generationDir: string }) => void | Promise<void>;
  warn?: (message: string) => void;
}): Promise<{ generation: string; generationDir: string; markerPath: string }>;

export function activateInstalledOutput(options: {
  sourceOutDir: string;
  extensionDir: string;
  verify: (directory: string) => Promise<void>;
}): Promise<void>;
