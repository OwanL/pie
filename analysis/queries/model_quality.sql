-- Compare model and thinking-level performance while surfacing sample sizes.
SELECT
  COALESCE(model_id, '(unknown)') AS model_id,
  COALESCE(thinking_level, '(unspecified)') AS thinking_level,
  COALESCE(experiment_assignment, '(none)') AS experiment_assignment,
  COUNT(*) AS run_count,
  COUNT(*) FILTER (WHERE scored = TRUE AND satisfaction IS NOT NULL) AS scored_run_count,
  ROUND(AVG(satisfaction), 2) AS average_satisfaction,
  ROUND(AVG(busy_duration_ms), 0) AS average_busy_duration_ms,
  CAST(QUANTILE_CONT(busy_duration_ms, 0.5) AS BIGINT) AS median_busy_duration_ms,
  ROUND(AVG(tool_failure_count), 2) AS average_tool_failures,
  ROUND(AVG(total_estimated_cost_usd), 4) AS average_estimated_cost_usd,
  ROUND(SUM(total_estimated_cost_usd), 4) AS total_estimated_cost_usd,
  COUNT(*) FILTER (WHERE total_estimated_cost_usd IS NOT NULL) AS priced_run_count,
  ROUND(AVG(CASE WHEN verification_total_count > 0 THEN 1 ELSE 0 END), 3) AS verification_run_rate,
  COUNT(*) FILTER (WHERE resolution = 'resolved') AS resolved_count,
  COUNT(*) FILTER (WHERE resolution = 'partially_resolved') AS partially_resolved_count,
  COUNT(*) FILTER (WHERE resolution = 'unresolved') AS unresolved_count
FROM runs
WHERE status <> 'open'
GROUP BY 1, 2, 3
ORDER BY run_count DESC, model_id, thinking_level, experiment_assignment;
