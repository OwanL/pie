/** Copies supplied trees only; caller owns fully materialized dependency closure. */
export function prepareManagedPackages(options: {
  inputs: Readonly<Record<string, string>>;
  stagingParent: string;
}): Promise<{ root: string; packages: Record<string, string> }>;
/** Read-only; rejects incomplete adaptations, unsupported seams, and invalid trees. */
export function verifyPreparedManagedPackage(root: string, name: string, options?: {
  /** Explicit owned closure root only; never searches ancestors. */
  nodeModulesRoot?: string;
}): Promise<void>;
