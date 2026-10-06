/**
 * Environment sanitizer for test processes.
 *
 * The pi harness (VS Code extension host) exports its live state to child
 * processes through `PI_*`/`PIE_*` environment variables: the real
 * agent/session/auth directories, retired-review and deferred-trigger sidecars,
 * subagent routing toggles, and user config JSON. Test
 * processes that spawn the backend or host code inherit these and leak real
 * user state into fixtures — e.g. the session catalog picking up pending
 * private-cleanup state from the real retired-review store, or the backend
 * scanning the real sessions directory. Strip known harness state so test processes start
 * from a clean slate; stable runtime settings such as `PIE_EDITOR_VERSION`
 * remain available, and tests that need a value set it explicitly in their
 * own child env.
 */
const PI_HARNESS_ENV_PREFIXES = ['PIE_SUBAGENT_', 'PIE_DEVELOPMENT_', 'PIE_HOST_'];

const PI_HARNESS_ENV_EXACT = new Set([
  'PI_CODING_AGENT_AUTH_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_CONFIG_DIR',
  'PI_NODE_PATH',
  'PI_SDK_PATH',
  'PIE_ALLOW_DEVELOPMENT_RUNTIME',
  'PIE_ALLOW_IN_TREE_AUTH',
  'PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK',
  'PIE_ANALYTICS_HANDOFF_KEY',
  'PIE_ANALYTICS_RESTART_NONCE',
  'PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH',
  'PIE_AUTONOMOUS_MODE',
  'PIE_EXTENSION_TOGGLES_JSON',
  'PIE_HISTORY_COMPACTION_JSON',
  'PIE_LIVE_PIPELINE_TRACE_KEY',
  'PIE_LIVE_PIPELINE_TRACE_RUN_ID',
  'PIE_PROVIDER_TOGGLES_JSON',
  'PIE_REVIEWS_DIR',
  'PIE_TRIGGERS_DIR',
  'PIE_TRUSTED_SDK_ROOT',
  'PIE_DATA_DIR',
  'PIE_CACHE_DIR',
  'PIE_STORAGE_CUTOFF_AUTHORIZATION',
]);

export function withoutPiHarnessEnv(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      PI_HARNESS_ENV_EXACT.has(normalized)
      || PI_HARNESS_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      delete env[key];
    }
  }
  return env;
}
