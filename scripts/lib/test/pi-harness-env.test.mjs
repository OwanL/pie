import assert from 'node:assert/strict';
import test from 'node:test';

import { withoutPiHarnessEnv } from '../pi-harness-env.mjs';

test('withoutPiHarnessEnv strips pi-harness state from test process environments', () => {
  const source = {
    PATH: 'tools',
    PI_CODING_AGENT_DIR: 'C:/real/pie',
    PI_CODING_AGENT_SESSION_DIR: 'C:/real/pie/data/outcomes/sessions',
    PI_CODING_AGENT_AUTH_DIR: 'C:/real/pie/auth',
    PI_CONFIG_DIR: 'C:/real/pie/config',
    PI_SDK_PATH: 'C:/real/pi-sdk',
    PIE_DATA_DIR: 'C:/real/pie/data',
    PIE_CACHE_DIR: 'C:/real/pie/data/cache',
    PIE_STORAGE_CUTOFF_AUTHORIZATION: 'ambient-authorization',
    PIE_DEVELOPMENT_PI_RUNTIME: 'C:/real/runtime',
    PIE_ALLOW_DEVELOPMENT_RUNTIME: '1',
    PIE_HOST_PROFILE: 'local-pi',
    PIE_HOST_COORDINATOR_PORT: '1997',
    PIE_ANALYTICS_HANDOFF_KEY: 'ambient-handoff-key',
    PIE_REVIEWS_DIR: 'C:/real/pie/data/outcomes/session-reviews',
    PIE_TRIGGERS_DIR: 'C:/real/pie/data/outcomes/deferred-triggers',
    PIE_SUBAGENT_MAX_TREE_SESSIONS: '100',
    PIE_SUBAGENT_PROVIDER_TOGGLES_BY_SESSION_JSON: '{"C:/real/session.jsonl":{"umans":false}}',
    PIE_AUTONOMOUS_MODE: '1',
    PIE_PROVIDER_TOGGLES_JSON: '{"ollama":false}',
    PIE_EXTENSION_TOGGLES_JSON: '{"skill-pruner":true}',
    PIE_HISTORY_COMPACTION_JSON: '{"enabled":true}',
    PIE_LIVE_PIPELINE_TRACE_KEY: 'trace-key',
    PIE_LIVE_PIPELINE_TRACE_RUN_ID: 'run-1',
    PIE_TRUSTED_SDK_ROOT: 'C:/real/sdk',
    PIE_EDITOR_VERSION: '1.90.0',
    PIE_SHELL: 'bash',
    PIE_BASH_DEFAULT_TIMEOUT: '120',
    PIE_ALLOW_IN_TREE_AUTH: '1',
  };

  assert.deepEqual(withoutPiHarnessEnv(source), {
    PATH: 'tools',
    PIE_EDITOR_VERSION: '1.90.0',
    PIE_SHELL: 'bash',
    PIE_BASH_DEFAULT_TIMEOUT: '120',
  });
  assert.equal(source.PIE_REVIEWS_DIR, 'C:/real/pie/data/outcomes/session-reviews');
});
