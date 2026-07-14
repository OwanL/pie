-- Canonical leaderboard dimension audit grouped by model family + thinking level.
-- The adjusted/regularized composite remains authoritative in scripts/leaderboard.ts. This audit
-- aligns its raw outcome dimensions and task-level rating coverage with the canonical task-group
-- rule: within each model/thinking group, one latest eligible user-scored run represents each task.
-- PreparedRunRow has no endedAt, so started_at defines chronology; equal timestamps use the
-- lexicographically greatest run_id. Missing telemetry on that representative stays missing.
WITH attributed AS (
  SELECT
    *,
    COALESCE(NULLIF(task_group_id, ''), run_id) AS task_key,
    COALESCE(model_family, model_id, '(unknown)') AS group_model_family,
    COALESCE(thinking_level, '(unspecified)') AS group_thinking_level,
    scored = TRUE AND satisfaction IS NOT NULL AND mixed_model_config = FALSE AND mixed_treatment_config = FALSE AND outcome_source = 'user' AS is_attributed_score,
    scored = TRUE AND satisfaction IS NOT NULL AND mixed_model_config = FALSE AND mixed_treatment_config = FALSE AND outcome_source = 'agent' AS is_supplemental_agent_outcome,
    scored = TRUE AND satisfaction IS NOT NULL AND mixed_model_config = TRUE AS is_mixed_model_exclusion,
    scored = TRUE AND satisfaction IS NOT NULL AND mixed_model_config = FALSE AND mixed_treatment_config = TRUE AS is_mixed_treatment_exclusion
  FROM runs
  WHERE status <> 'open'
),
terminal_scores AS (
  SELECT * EXCLUDE (terminal_order)
  FROM (
    SELECT
      *,
      ROW_NUMBER() OVER (
        PARTITION BY group_model_family, group_thinking_level, task_key
        ORDER BY started_at DESC NULLS LAST, run_id DESC
      ) AS terminal_order
    FROM attributed
    WHERE is_attributed_score
  )
  WHERE terminal_order = 1
),
provenance AS (
  SELECT
    group_model_family,
    group_thinking_level,
    COUNT(*) AS run_count,
    COUNT(*) FILTER (WHERE is_attributed_score) AS scored_run_count,
    COUNT(*) FILTER (WHERE is_mixed_model_exclusion) AS mixed_model_excluded_count,
    COUNT(*) FILTER (WHERE is_mixed_treatment_exclusion) AS mixed_treatment_excluded_count,
    COUNT(DISTINCT task_key) FILTER (WHERE mixed_model_config = FALSE AND mixed_treatment_config = FALSE) AS attributable_task_count,
    COUNT(*) FILTER (WHERE mixed_model_config = FALSE AND mixed_treatment_config = FALSE) AS attributable_run_count,
    COUNT(*) FILTER (WHERE is_attributed_score) AS user_outcome_count,
    COUNT(*) FILTER (WHERE is_supplemental_agent_outcome) AS agent_outcome_count,
    CAST(QUANTILE_CONT(busy_duration_ms, 0.5) AS BIGINT) AS median_duration_ms,
    ROUND(QUANTILE_CONT(token_efficiency, 0.5), 3) AS median_token_efficiency,
    ROUND(QUANTILE_CONT(total_estimated_cost_usd, 0.5), 4) AS median_cost_usd,
    COUNT(*) FILTER (WHERE subagent_call_count > 0) AS subagent_run_count,
    ROUND(AVG(CASE WHEN subagent_call_count > 0 THEN 1.0 ELSE 0.0 END), 3) AS subagent_usage_rate
  FROM attributed
  GROUP BY 1, 2
),
task_outcomes AS (
  SELECT
    group_model_family,
    group_thinking_level,
    COUNT(*) AS effective_task_count,
    ROUND(AVG(initial_user_message_chars), 1) AS avg_initial_user_message_chars,
    ROUND(AVG(satisfaction), 2) AS avg_satisfaction,
    ROUND(AVG(CASE resolution
      WHEN 'resolved' THEN 1.0
      WHEN 'partially_resolved' THEN 0.5
      ELSE 0.0
    END), 3) AS resolution_rate,
    -- Native file-churn display value: terminal-task mean edit revisit rate (lower is better).
    ROUND(AVG(edit_revisit_rate), 3) AS file_churn_rate,
    ROUND(AVG(CASE WHEN tool_failure_count = 0 THEN 1.0 ELSE 0.0 END), 3) AS tool_reliability_rate,
    ROUND(AVG(CASE
      WHEN verification_total_count > 0 AND verification_state = 'passing' THEN 1.0
      WHEN verification_total_count > 0 THEN 0.0
    END), 3) AS verification_pass_rate,
    COUNT(*) FILTER (WHERE resolution = 'resolved') AS resolved_count,
    COUNT(*) FILTER (WHERE resolution = 'partially_resolved') AS partially_resolved_count,
    COUNT(*) FILTER (WHERE resolution = 'unresolved') AS unresolved_count
  FROM terminal_scores
  GROUP BY 1, 2
)
SELECT
  provenance.group_model_family AS model_family,
  provenance.group_thinking_level AS thinking_level,
  provenance.run_count,
  provenance.scored_run_count,
  provenance.mixed_model_excluded_count,
  provenance.mixed_treatment_excluded_count,
  COALESCE(task_outcomes.effective_task_count, 0) AS effective_task_count,
  provenance.attributable_run_count,
  provenance.attributable_task_count,
  provenance.user_outcome_count,
  provenance.agent_outcome_count,
  ROUND(
    COALESCE(task_outcomes.effective_task_count, 0)::DOUBLE
      / NULLIF(provenance.attributable_task_count, 0),
    3
  ) AS scoring_coverage,
  task_outcomes.avg_initial_user_message_chars,
  task_outcomes.avg_satisfaction,
  task_outcomes.resolution_rate,
  task_outcomes.file_churn_rate,
  task_outcomes.tool_reliability_rate,
  task_outcomes.verification_pass_rate,
  provenance.median_duration_ms,
  provenance.median_token_efficiency,
  provenance.median_cost_usd,
  provenance.subagent_run_count,
  provenance.subagent_usage_rate,
  COALESCE(task_outcomes.resolved_count, 0) AS resolved_count,
  COALESCE(task_outcomes.partially_resolved_count, 0) AS partially_resolved_count,
  COALESCE(task_outcomes.unresolved_count, 0) AS unresolved_count
FROM provenance
LEFT JOIN task_outcomes USING (group_model_family, group_thinking_level)
ORDER BY scored_run_count DESC, model_family, thinking_level;
