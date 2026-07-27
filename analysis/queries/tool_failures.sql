-- Execution tool-failure trends by cause (the tool could not do its job).
-- Non-success results (verification failures / empty probes) are measured as
-- result issues, not failures — see tool_usage.sql for result_issue_count.
SELECT
  failure_kind,
  tool_name,
  SUM(count) AS failure_count,
  COUNT(DISTINCT run_id) AS affected_run_count,
  MIN(exit_code) FILTER (WHERE exit_code IS NOT NULL) AS example_exit_code,
  MIN(error_excerpt) FILTER (WHERE error_excerpt IS NOT NULL AND error_excerpt <> '') AS example_error_excerpt
FROM tool_failures
GROUP BY failure_kind, tool_name
ORDER BY failure_count DESC, affected_run_count DESC, failure_kind, tool_name;
