-- Per-attempt retry timing for latency/friction inspection.
SELECT
  run_id,
  source_id,
  occurred_at,
  attempt,
  scheduled_delay_ms,
  measured_delay_ms,
  duration_ms,
  model_id,
  model_family,
  provider,
  thinking_level,
  experiment_assignment
FROM retry_timing
ORDER BY occurred_at DESC, attempt ASC;
