export interface ClosureProvenance {
  lockSha256: string;
  modulesSha256: string;
  /** Exact process.versions.node, without a v prefix. */
  node: string;
  /** Exactly 10.34.4. */
  pnpm: string;
  platform: string;
  arch: string;
}
export interface ClosureNode {
  name: string; version: string; snapshot: string; placement: string; optional: boolean;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
}
export interface ClosureEdge { from: string; snapshot: string; placement: string; optional: boolean }
export interface ClosurePeer { from: string; name: string; snapshot: string; kind: 'peerDependencies' | 'dependencies'; requirement: string; optional: boolean; version: string; manifestSha256: string; placement?: string }
export interface ClosureReceipt {
  schemaVersion: 1;
  status: 'pristine-unqualified';
  ready: false;
  provenance: ClosureProvenance;
  nodes: ClosureNode[];
  edges: ClosureEdge[];
  peerRequirements: ClosurePeer[];
  skips: { from: string; snapshot: string; optional: true }[];
  pendingOptionalBuilds: { snapshot: string; placement: string }[];
  inventory: { path: string; size: number; sha256: string; mode: number }[];
  inventorySha256: string;
}
/** acquisitionRoot is the owned repository containing pnpm-lock.yaml and node_modules/.modules.yaml.
 * stagingParent must already exist, be private, and be disjoint from acquisitionRoot.
 * The receipt is evidence only, never preparation, readiness, or delivery authority.
 */
export function materializeManagedIntegrationClosure(options: {
  acquisitionRoot: string;
  stagingParent: string;
  provenance: ClosureProvenance;
}): Promise<Readonly<{ root: string; packages: Record<string, string>; receipt: ClosureReceipt }>>;
