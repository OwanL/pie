-- warm-bash performance headline: routing breakdown + auto-prune rewrite activity.
--
-- Routing counters (fast_path / warm / fallback) come from per-session summaries
-- (session-cumulative — warm-bash has no run-boundary signal, so these are
-- per-session totals summed across sessions). Auto-prune rewrite counts come
-- from point-in-time events (joinable to runs by sessionPathHash). Both tables
-- are empty when warm-bash has never run (fresh checkout / extension off), so
-- every aggregate uses COALESCE to surface zeros rather than NULL.
WITH routing AS (
  SELECT
    COALESCE(SUM(fast_path), 0) AS fast_path_calls,
    COALESCE(SUM(warm), 0) AS warm_calls,
    COALESCE(SUM(fallback), 0) AS fallback_calls,
    COUNT(*) AS summarized_sessions,
    COUNT(*) FILTER (WHERE auto_prune_enabled) AS auto_prune_enabled_sessions,
    COUNT(*) FILTER (WHERE fast_path_enabled) AS fast_path_enabled_sessions,
    COUNT(*) FILTER (WHERE gnu_grep) AS gnu_grep_sessions,
    COALESCE(SUM(warmup_failures), 0) AS warmup_failures
  FROM warm_bash_summaries
),
rewrites AS (
  SELECT
    COUNT(*) AS rewrite_count,
    COUNT(DISTINCT session_path_hash) AS sessions_with_rewrites
  FROM warm_bash_rewrites
)
SELECT
  r.fast_path_calls,
  r.warm_calls,
  r.fallback_calls,
  r.fast_path_calls + r.warm_calls + r.fallback_calls AS total_bash_calls,
  CASE WHEN (r.fast_path_calls + r.warm_calls + r.fallback_calls) > 0
       THEN ROUND(100.0 * r.fast_path_calls / (r.fast_path_calls + r.warm_calls + r.fallback_calls), 1)
       ELSE NULL END AS fast_path_pct,
  CASE WHEN (r.fast_path_calls + r.warm_calls + r.fallback_calls) > 0
       THEN ROUND(100.0 * r.warm_calls / (r.fast_path_calls + r.warm_calls + r.fallback_calls), 1)
       ELSE NULL END AS warm_pct,
  CASE WHEN (r.fast_path_calls + r.warm_calls + r.fallback_calls) > 0
       THEN ROUND(100.0 * r.fallback_calls / (r.fast_path_calls + r.warm_calls + r.fallback_calls), 1)
       ELSE NULL END AS fallback_pct,
  r.summarized_sessions,
  r.auto_prune_enabled_sessions,
  r.fast_path_enabled_sessions,
  r.gnu_grep_sessions,
  r.warmup_failures,
  rw.rewrite_count,
  rw.sessions_with_rewrites
FROM routing r, rewrites rw;
