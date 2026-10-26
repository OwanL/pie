export const BUNDLED_MANAGED_ROOT_RELATIVE_PATH: 'resources/managed-integrations';
export const BUNDLED_MANAGED_INVENTORY_RELATIVE_PATH: 'resources/managed-integrations/manifest.json';
export interface BundledManagedTarget { platform: string; arch: string; nodeAbi: string }
export interface BundledManagedBindings {
  runtimeIdentity: string;
  closureInventorySha256: string;
  qualificationRecipeSha256: string;
  target: BundledManagedTarget;
}
export interface BundledManagedInventory extends BundledManagedBindings {
  schemaVersion: 1;
  packages: { name: string; version: string; entry: string }[];
}
/** Shape validation only, not qualification. Only build/delivery may emit after external verification. */
export function createBundledManagedInventory(bindings: BundledManagedBindings): BundledManagedInventory;
export function readBundledManagedResources(moduleDir: string, options?: {
  expectedRuntimeIdentity?: string;
  target?: BundledManagedTarget;
}): {
  root: string;
  nodeModulesRoot: string;
  manifest: BundledManagedInventory;
  packages: { name: string; version: string; extensionPath: string; packageRoot: string }[];
} | undefined;
