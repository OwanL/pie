/**
 * Analytics-views barrel: the StatsService presentation/query façade plus the
 * canonical projection read types and the RunObserver port. All re-exports;
 * no logic. Legacy accounting/storage collaborators are owned by
 * `analytics/legacy/` modules and are not re-exported here.
 */
export { StatsService, type StatsStartupStageMetric } from './service';
export {
  NOOP_RUN_OBSERVER,
  type GetArchState,
  type DispatchArchEvent,
  type RunObserver,
  type StatsServicePort,
  type StatsServiceOptions,
  type CanonicalActivityProjection,
  type CanonicalActivityProjectionSnapshot,
  type CanonicalActivityStats,
  type CanonicalProjectionScope,
  type CanonicalToolFacetProjection,
  type CanonicalToolFacetProjectionSnapshot,
} from './types';
