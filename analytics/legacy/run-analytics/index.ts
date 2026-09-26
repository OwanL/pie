/**
 * Analytics-legacy run-analytics package entry. The original
 * extension/src/host/run-analytics/index.ts barrel re-exported the types,
 * coercion, recency, and harness-identity modules; the implementations moved
 * here and the barrel identity is preserved at this owner (B6). Direct
 * module imports are preferred; this entry is a temporary removal batch
 * (B8) shim.
 */
export * from './types';
export * from './coercion';
export * from './recency';
export * from './harness-identity';
