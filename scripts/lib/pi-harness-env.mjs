/**
 * Environment sanitizer for test processes.
 *
 * The pi harness (VS Code extension host) exports its live state to child
 * processes through `PI_*`/`PIE_*` environment variables: the real
 * agent/session/auth directories, the reviews and deferred-trigger sidecars,
 * open-tab state, subagent routing toggles, and user config JSON. Test
 * processes that spawn the backend or host code inherit these and leak real
 * user state into fixtures — e.g. the session catalog picking up pending
 * review actions from the real reviews store, or the backend scanning the
 * real sessions directory. Strip known harness state so test processes start
 * from a clean slate; stable runtime settings such as `PIE_EDITOR_VERSION`
 * remain available, and tests that need a value set it explicitly in their
 * own child env.
 */
const PI_HARNESS_ENV_PREFIXES = ['PIE_SUBAGENT_'];

const PI_HARNESS_ENV_EXACT = new Set([
  'PI_CODING_AGENT_AUTH_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PIE_AUTONOMOUS_MODE',
  'PIE_EXTENSION_TOGGLES_JSON',
  'PIE_HISTORY_COMPACTION_JSON',
  'PIE_LIVE_PIPELINE_TRACE_KEY',
  'PIE_LIVE_PIPELINE_TRACE_RUN_ID',
  'PIE_OPEN_TABS',
  'PIE_PROVIDER_TOGGLES_JSON',
  'PIE_REVIEWS_DIR',
  'PIE_TRIGGERS_DIR',
  'PIE_TRUSTED_SDK_ROOT',
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
