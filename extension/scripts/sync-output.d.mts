export function isActiveDirectoryLockError(
  error: unknown,
  platform?: NodeJS.Platform,
): boolean;

export function mirrorDirectoryInPlace(
  sourceDir: string,
  destinationDir: string,
): Promise<void>;

export function syncActiveDestinationInPlace(options: {
  staging: string;
  dest: string;
  backup: string;
  verify: (directory: string) => Promise<void>;
  warn?: (message: string) => void;
}): Promise<void>;
