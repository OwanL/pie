-- Run-level latency/friction rollup. Nulls mean the telemetry was not observed;
-- historical absence is not converted to zero coverage.
WITH queue AS (
  SELECT
    run_id,
    median(provider_queue_ms) FILTER (WHERE provider_queue_ms IS NOT NULL) AS median_provider_queue_ms,
    sum(provider_queue_attempt_count) FILTER (WHERE provider_queue_ms IS NOT NULL) AS provider_queue_attempt_count,
    count(*) FILTER (WHERE provider_queue_ms IS NOT NULL) AS provider_queue_turn_count
  FROM turn_throughput
  GROUP BY run_id
), retry AS (
  SELECT
    run_id,
    count(*) AS retry_timing_sample_count,
    median(scheduled_delay_ms) AS median_scheduled_retry_delay_ms,
    median(measured_delay_ms) FILTER (WHERE measured_delay_ms IS NOT NULL) AS median_measured_retry_delay_ms,
    median(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS median_retry_duration_ms
  FROM retry_timing
  GROUP BY run_id
)
SELECT
  r.run_id,
  r.started_at,
  r.model_id,
  r.model_family,
  r.skill_pruning_prepass_duration_ms,
  q.median_provider_queue_ms,
  q.provider_queue_attempt_count,
  q.provider_queue_turn_count,
  retry.retry_timing_sample_count,
  retry.median_scheduled_retry_delay_ms,
  retry.median_measured_retry_delay_ms,
  retry.median_retry_duration_ms,
  r.tool_duration_ms,
  r.critical_path_duration_ms,
  CASE
    WHEN r.critical_path_duration_ms IS NULL THEN NULL
    ELSE greatest(r.tool_duration_ms - r.critical_path_duration_ms, 0)
  END AS overlapping_tool_duration_ms
FROM runs r
LEFT JOIN queue q USING (run_id)
LEFT JOIN retry USING (run_id)
ORDER BY r.started_at DESC;
