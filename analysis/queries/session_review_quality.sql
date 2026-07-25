-- V2-only review diagnostics joined to author runtime after blinded persistence.
-- quality_index_v1 is purely criterion-attainment based; coverage, blockers,
-- confidence, process, and disagreement remain separate columns.
-- Mixed model/thinking author cells split each review equally after retry deduplication.
WITH stable_author_sessions AS (
  SELECT DISTINCT
    session_id,
    COALESCE(model_family, model_id, '(unknown)') AS model_family,
    COALESCE(thinking_level, '(unspecified)') AS thinking_level
  FROM runs
  WHERE status <> 'open'
    AND identity_fallback = FALSE
    AND mixed_model_config = FALSE
    AND mixed_treatment_config = FALSE
),
review_author_cells AS (
  SELECT
    review.*,
    author.model_family,
    author.thinking_level
  FROM session_reviews_v2 review
  JOIN stable_author_sessions author USING (session_id)
  WHERE review.identity_fallback = FALSE
    AND review.blinding_applied = TRUE
),
review_authors AS (
  SELECT *, 1.0 / COUNT(*) OVER (PARTITION BY review_id) AS attribution_weight
  FROM review_author_cells
)
SELECT
  model_family,
  thinking_level,
  ROUND(SUM(attribution_weight), 3) AS v2_review_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE quality_index_v1 IS NOT NULL), 3) AS quality_index_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE quality_index_v1 IS NULL), 3) AS not_assessable_review_count,
  ROUND(SUM(quality_index_v1 * attribution_weight) FILTER (WHERE quality_index_v1 IS NOT NULL)
    / NULLIF(SUM(attribution_weight) FILTER (WHERE quality_index_v1 IS NOT NULL), 0), 1) AS mean_quality_index_v1,
  ROUND(SUM(criterion_coverage * attribution_weight) FILTER (WHERE criterion_coverage IS NOT NULL)
    / NULLIF(SUM(attribution_weight) FILTER (WHERE criterion_coverage IS NOT NULL), 0), 3) AS criterion_coverage,
  ROUND(SUM(external_blocker_rate * attribution_weight) FILTER (WHERE external_blocker_rate IS NOT NULL)
    / NULLIF(SUM(attribution_weight) FILTER (WHERE external_blocker_rate IS NOT NULL), 0), 3) AS external_blocker_rate,
  ROUND(SUM(attribution_weight) FILTER (WHERE delivered_overall = 'achieved'), 3) AS delivered_achieved_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE controllable_overall = 'achieved'), 3) AS controllable_achieved_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE confidence = 'low'), 3) AS low_confidence_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE material_disagreement), 3) AS material_disagreement_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE adjudicated), 3) AS adjudicated_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE diversity_achieved), 3) AS diversity_achieved_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE verification_discipline = 'underverified'), 3) AS underverified_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE scope_control IN ('minor_avoidable_drift', 'material_scope_drift')), 3) AS scope_drift_count,
  ROUND(SUM(attribution_weight) FILTER (WHERE final_claim_accuracy = 'overclaimed'), 3) AS overclaimed_count
FROM review_authors
GROUP BY 1, 2
ORDER BY v2_review_count DESC, model_family, thinking_level;
