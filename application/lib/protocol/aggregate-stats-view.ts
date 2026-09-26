// Browser-safe application protocol adapter for renderer-side aggregate-stats
// presentation. The canonical analytics projection facts (types + empty
// constants) live in the analytics contracts owner; this adapter keeps one
// boundary shape for renderer consumers.
export * from '../../../analytics/contracts/aggregate-stats.js';
