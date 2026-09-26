-- Relate verification activity to run volume. Failure attribution is run-level, not per-kind.
WITH verification_groups AS (
  SELECT
    r.run_id,
    COALESCE(v.kind, 'none') AS verification_kind,
    CASE
      WHEN v.count IS NULL OR v.count <= 0 THEN '0'
      WHEN v.count = 1 THEN '1'
      WHEN v.count <= 3 THEN '2-3'
      ELSE '4+'
    END AS count_bucket,
    r.verification_state
  FROM runs r
  LEFT JOIN verification_usage v
    ON v.run_id = r.run_id
)
SELECT
  verification_kind,
  count_bucket,
  verification_state,
  COUNT(DISTINCT run_id) AS run_count
FROM verification_groups
GROUP BY 1, 2, 3
ORDER BY verification_kind, count_bucket, verification_state;
