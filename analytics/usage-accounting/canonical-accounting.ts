import * as path from 'node:path';
import { BillableAccounting, type BillableAccountingDeps } from '../legacy/billable-accounting/service';
import { workspaceHash } from '../legacy/stats-service/helpers';

/** Reuse invocation adaptation without admitting legacy persistence. */
export function createCanonicalAccounting(
  deps: Omit<BillableAccountingDeps, 'getStorageDir' | 'markDerivedExportDirty'>
    & { canonicalCapture: NonNullable<BillableAccountingDeps['canonicalCapture']> },
): BillableAccounting {
  return new BillableAccounting({
    ...deps,
    getStorageDir: () => { throw new Error('Canonical accounting cannot resolve legacy persistence.'); },
    markDerivedExportDirty: () => { throw new Error('Canonical accounting cannot dirty a legacy export.'); },
  });
}

/** Path-only compatibility selectors for explicit privacy cleanup. Never
 * instantiate a run store merely to locate retired auxiliary logs. Kept in
 * parity with RunAnalyticsStorage.getGlobalSideChannelStorageDirs(). */
export function legacyPrivacyStorageDirs(options: {
  dataOutcomesRootPath: string;
  legacyUsageDataRootPath?: string;
  workspaceId: string;
  legacyWorkspaceIds?: readonly string[];
}): string[] {
  const hashes = [...new Set([options.workspaceId, ...(options.legacyWorkspaceIds ?? [])])].map(workspaceHash);
  const roots = [
    ...(options.legacyUsageDataRootPath ? [
      path.join(options.legacyUsageDataRootPath, 'runs'),
      path.join(options.legacyUsageDataRootPath, 'usage-data'),
      path.join(options.legacyUsageDataRootPath, 'data', 'outcomes'),
    ] : []),
    path.join(options.dataOutcomesRootPath, 'runs'),
    path.join(options.dataOutcomesRootPath, 'usage-data'),
    options.dataOutcomesRootPath,
  ];
  return [...new Set([
    path.join(options.dataOutcomesRootPath, hashes[0]!),
    ...roots.flatMap((root) => hashes.map((hash) => path.join(root, hash))),
  ])];
}
