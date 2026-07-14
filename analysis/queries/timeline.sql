-- Track run volume and outcomes over time, broken down by model.
-- Excludes open (in-progress) runs so daily aggregates reflect finalized work.
SELECT
  started_day AS bucket_start,
  COALESCE(model_family, model_id, '(unknown)') AS model_id,
  COUNT(*) AS run_count,
  COUNT(*) FILTER (WHERE satisfaction IS NOT NULL) AS scored_run_count,
  ROUND(AVG(satisfaction), 2) AS average_satisfaction,
  COUNT(*) FILTER (WHERE verification_total_count > 0) AS verification_run_count,
  SUM(tool_failure_count) AS tool_failure_count,
  ROUND(SUM(total_estimated_cost_usd), 4) AS total_estimated_cost_usd,
  COUNT(*) FILTER (WHERE total_estimated_cost_usd IS NOT NULL) AS priced_run_count,
  ROUND(AVG(busy_duration_ms), 0) AS average_busy_duration_ms
FROM runs
WHERE status <> 'open'
GROUP BY 1, 2
ORDER BY bucket_start, model_id;
