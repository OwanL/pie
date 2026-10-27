export interface NodeRuntimeTarget {
  platform: 'win32';
  arch: 'x64';
  /** Node's native modules ABI, not the Node version string. */
  nodeAbi: '137';
}

export interface NodeRuntimeInventoryEntry {
  relativePath: 'LICENSE' | 'node.exe';
  sizeBytes: number;
  sha256: string;
}

export interface NodeRuntimeProvenance {
  kind: 'local-toolchain';
  archiveUrl: string;
  archiveSha256: string;
}

/** Canonical identity input: all manifest fields except payloadIdentity. */
export interface NodeRuntimeManifestIdentityInput extends Record<string, unknown> {
  payloadIdentity?: never;
}

export interface NodeRuntimeManifest extends NodeRuntimeManifestIdentityInput {
  schemaVersion: 1;
  kind: 'node-runtime';
  nodeVersion: string;
  target: NodeRuntimeTarget;
  executable: 'node.exe';
  inventory: [NodeRuntimeInventoryEntry, NodeRuntimeInventoryEntry];
  provenance: NodeRuntimeProvenance;
  payloadIdentity: string;
}

export const NODE_RUNTIME_MANIFEST: 'manifest.json';
export const NODE_RUNTIME_SCHEMA_VERSION: 1;
export const NODE_RUNTIME_TARGET: Readonly<NodeRuntimeTarget>;

/** SHA-256 of recursively key-sorted JSON for the manifest fields excluding payloadIdentity. */
export function computeNodeRuntimePayloadIdentity(
  manifestWithoutIdentity: NodeRuntimeManifestIdentityInput,
): string;

/** Read and validate only manifest metadata; payload files are deliberately not traversed or hashed. */
export function readNodeRuntimeManifest(directory: string): Promise<NodeRuntimeManifest>;
