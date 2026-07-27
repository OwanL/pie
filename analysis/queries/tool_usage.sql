-- Compare tool usage and failure rates. These are correlations, not causal claims.
SELECT
  tu.tool_name,
  SUM(tu.call_count) AS call_count,
  SUM(tu.failure_count) AS failure_count,
  SUM(tu.execution_failure_count) AS execution_failure_count,
  SUM(tu.verification_project_failure_count) AS verification_project_failure_count,
  SUM(tu.probe_failure_count) AS probe_failure_count,
  SUM(tu.result_issue_count) AS result_issue_count,
  COUNT(DISTINCT tu.run_id) AS affected_run_count
FROM tool_usage tu
GROUP BY tu.tool_name
ORDER BY call_count DESC, tool_name;
