import type { ClosureReceipt } from './materialize-closure.mjs';
export interface PreparedClosureReceipt extends Omit<ClosureReceipt, 'status'> {
  status: 'adapted-unqualified';
  /** Original acquisition evidence, with no private absolute source paths added. */
  sourceReceipt: ClosureReceipt;
  /** SHA-256 of JSON.stringify(sourceReceipt). */
  sourceReceiptSha256: string;
  sourceInventorySha256: string;
  disposition?: {
    name: 'omit-optional-canvas-3.2.3'; rationale: string;
    /** Descriptive supplied-policy qualification references, not durable proof IDs or artifact locations. */
    sourceEvidence: string[];
    omittedNodes: ClosureReceipt['nodes']; omittedEdges: ClosureReceipt['edges']; omittedFiles: ClosureReceipt['inventory'];
  };
  /** Original manifest bytes, bound to source inventory, only for named omission. */
  sourceManifests?: Record<string, string>;
  adaptations: { package: string; seam: string; path: string; beforeSha256: string; afterSha256: string }[];
}
export interface PreparedManagedClosure {
  root: string;
  packages: Record<string, string>;
  receipt: PreparedClosureReceipt;
}
/** Offline independent full-closure copy. Never executes packages or claims readiness. */
export function prepareManagedClosure(options: { sourceRoot: string; stagingParent: string; disposition?: 'omit-optional-canvas-3.2.3' }): Promise<Readonly<PreparedManagedClosure>>;
/** Read-only. Default rejects unqualified status; false permits evidence inspection only. */
export function verifyPreparedManagedClosure(root: string, options?: { requireReady?: boolean }): Promise<Readonly<PreparedManagedClosure>>;
