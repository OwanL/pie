-- Prepass cost & latency by code cohort. Surfaces the data points needed to
-- compare pruning-code versions: the locally-estimated prepass INPUT size
-- (always present, the primary cohort signal — it drops when the pruning
-- prompt/descriptions are compacted), the provider-reported token usage
-- (often NULL for github-copilot), and latency. Group by code_version to split
-- old-code (NULL, predates the field) vs new-code (git SHA) cohorts.
SELECT
  code_version,
  COUNT(*) AS prepass_count,
  ROUND(AVG(llm_latency_ms), 0) AS avg_latency_ms,
  ROUND(median(llm_latency_ms), 0) AS median_latency_ms,
  ROUND(AVG(prepass_input_estimate_tokens), 0) AS avg_input_estimate_tokens,
  ROUND(AVG(prepass_input_tokens), 0) AS avg_input_tokens_reported,
  ROUND(AVG(prepass_output_tokens), 0) AS avg_output_tokens_reported,
  ROUND(AVG(skill_tokens_saved + tool_tokens_saved), 0) AS avg_context_tokens_saved,
  MIN(started_day) AS cohort_first_day,
  MAX(started_day) AS cohort_last_day
FROM pruning_events
GROUP BY code_version
ORDER BY cohort_first_day;
