-- Compare V2 review quality and operational telemetry by model/thinking/treatment cell.
-- One accepted V2 review has total mass 1. Mixed author cells split that mass
-- equally; same-cell retries are deduplicated before the split. Both accepted
-- mixed-bucket and small-only reviewer profiles are included.
WITH v2_review_author_cells AS (
  SELECT DISTINCT
    review.review_id,
    COALESCE(r.model_family, r.model_id, '(unknown)') AS model_key,
    COALESCE(r.thinking_level, '(unspecified)') AS thinking_key,
    COALESCE(r.experiment_assignment, '(none)') AS experiment_key,
    review.quality_index_v1,
    review.criterion_coverage,
    review.external_blocker_rate
  FROM session_reviews_v2 review
  JOIN runs r ON r.session_id = review.session_id
  WHERE review.identity_fallback = FALSE
    AND review.blinding_applied = TRUE
    AND r.status <> 'open'
    AND r.identity_fallback = FALSE
    AND r.mixed_model_config = FALSE
    AND r.mixed_treatment_config = FALSE
),
v2_review_attribution AS (
  SELECT *, 1.0 / COUNT(*) OVER (PARTITION BY review_id) AS attribution_weight
  FROM v2_review_author_cells
),
v2_summary AS (
  SELECT
    model_key, thinking_key, experiment_key,
    ROUND(SUM(attribution_weight), 3) AS v2_review_count,
    ROUND(SUM(quality_index_v1 * attribution_weight) FILTER (WHERE quality_index_v1 IS NOT NULL)
      / NULLIF(SUM(attribution_weight) FILTER (WHERE quality_index_v1 IS NOT NULL), 0), 1) AS mean_quality_index_v1,
    ROUND(SUM(criterion_coverage * attribution_weight) FILTER (WHERE criterion_coverage IS NOT NULL)
      / NULLIF(SUM(attribution_weight) FILTER (WHERE criterion_coverage IS NOT NULL), 0), 3) AS criterion_coverage,
    ROUND(SUM(external_blocker_rate * attribution_weight) FILTER (WHERE external_blocker_rate IS NOT NULL)
      / NULLIF(SUM(attribution_weight) FILTER (WHERE external_blocker_rate IS NOT NULL), 0), 3) AS external_blocker_rate
  FROM v2_review_attribution
  GROUP BY 1, 2, 3
)
SELECT
  COALESCE(model_family, model_id, '(unknown)') AS model_id,
  COALESCE(thinking_level, '(unspecified)') AS thinking_level,
  COALESCE(experiment_assignment, '(none)') AS experiment_assignment,
  COUNT(*) AS run_count,
  COALESCE(MAX(v2.v2_review_count), 0) AS v2_review_count,
  MAX(v2.mean_quality_index_v1) AS mean_quality_index_v1,
  MAX(v2.criterion_coverage) AS v2_criterion_coverage,
  MAX(v2.external_blocker_rate) AS v2_external_blocker_rate,
  ROUND(AVG(busy_duration_ms), 0) AS average_busy_duration_ms,
  CAST(QUANTILE_CONT(busy_duration_ms, 0.5) AS BIGINT) AS median_busy_duration_ms,
  ROUND(AVG(tool_failure_count), 2) AS average_tool_failures,
  ROUND(AVG(total_estimated_cost_usd), 4) AS average_estimated_cost_usd,
  ROUND(SUM(total_estimated_cost_usd), 4) AS total_estimated_cost_usd,
  COUNT(*) FILTER (WHERE total_estimated_cost_usd IS NOT NULL) AS priced_run_count,
  ROUND(AVG(CASE WHEN verification_total_count > 0 THEN 1 ELSE 0 END), 3) AS verification_run_rate
FROM runs
LEFT JOIN v2_summary v2
  ON v2.model_key = COALESCE(runs.model_family, runs.model_id, '(unknown)')
  AND v2.thinking_key = COALESCE(runs.thinking_level, '(unspecified)')
  AND v2.experiment_key = COALESCE(runs.experiment_assignment, '(none)')
WHERE status <> 'open'
GROUP BY 1, 2, 3
ORDER BY run_count DESC, model_id, thinking_level, experiment_assignment;
