export interface OwnerRequireOptions {
  layout?: 'current' | 'planned';
  repositoryRoot?: string;
  dependencyOwnerRoot?: string;
}

/** Create a Node resolver anchored to the selected application dependency owner. */
export function createOwnerRequire(options?: OwnerRequireOptions): NodeJS.Require;

export interface SdkResolutionOptions extends OwnerRequireOptions {
  sdkPath?: string;
}

/** Resolve identity-sensitive modules from the SDK, other modules from the owner. */
export function resolveOwnerModule(specifier: string, options?: SdkResolutionOptions): string;

/** Resolve a public SDK package or subpath from the selected SDK graph. */
export function resolveSdkModule(specifier: string, options?: SdkResolutionOptions): string;
