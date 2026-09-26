/**
 * Analytics-legacy billable-accounting package entry. The original
 * extension/src/host/billable-accounting/index.ts barrel was a re-export of
 * ./service; the implementation moved here and the barrel identity is
 * preserved at the analytics owner (B6). Direct-module imports are
 * preferred; this entry is a temporary removal batch (B8) shim.
 */
export { BillableAccounting, type BillableAccountingDeps } from './service';
