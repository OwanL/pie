-- Compare prompt/tool/skill treatment mixes with sample counts.
SELECT
  COALESCE(prompt_family, '(none)') AS prompt_family,
  prompt_hash_prefix,
  tool_set_hash_prefix,
  skill_set_hash_prefix,
  COALESCE(experiment_assignment, '(none)') AS experiment_assignment,
  mixed_treatment_config,
  COUNT(*) AS run_count
FROM runs
WHERE status <> 'open'
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY run_count DESC, prompt_family, experiment_assignment;
