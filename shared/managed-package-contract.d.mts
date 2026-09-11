export interface ManagedPackageRequirement {
	readonly name: string;
	readonly version: string;
	readonly source: string;
	readonly requiredFiles: readonly string[];
	readonly cacheTargets: readonly string[];
}

export const MANAGED_PACKAGE_REQUIREMENTS: readonly ManagedPackageRequirement[];
export function managedPackageRoot(agentDir: string, packageName: string): string;
export function managedRequiredFileCandidates(root: string, relative: string): readonly string[];
export function resolveManagedCacheTargets(packageName: string, cacheDir: string | undefined): readonly string[] | null;
export function classifyManagedPackageSources(
	packageName: string,
	files: { readonly index?: string; readonly storage?: string; readonly agentDir?: string },
): "pristine" | "supported-patched" | "unsupported";
