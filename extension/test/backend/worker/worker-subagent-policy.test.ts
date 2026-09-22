import assert from 'node:assert/strict';
import test from 'node:test';

import type { SdkSessionEvent } from '../../../src/backend/sdk';
import type { SessionContext } from '../../../src/backend/server-types';
import {
  installAutonomousModeToolGuard,
  installMcpToolGuard,
  installSubagentPolicyToolGuard,
  installSystemPromptToolToggleGuard,
} from '../../../src/backend/system-prompts';
import {
  SUBAGENT_BUCKETS_ENV,
  SUBAGENT_PROVIDER_DEFAULTS_ENV,
  SUBAGENT_PROVIDER_TOGGLES_ENV,
} from '../../../src/shared/protocol';
import { WorkerRuntimeHost } from '../../../src/backend/worker-runtime-host';

interface WorkerRuntimeHostInternals {
  context?: SessionContext;
  subagentPolicyDisabled: boolean;
  autonomousMode: boolean;
  mcpEnabled: boolean;
  applyRuntimePrefs: (values: Record<string, unknown>) => void;
  handleSessionEvent: (context: SessionContext, event: SdkSessionEvent) => void;
  applySystemPromptToggles: (context: SessionContext, disabledEntries: readonly string[]) => Promise<void>;
}

interface SessionDoubleResult {
  appliedLog: string[][];
  activeNames: () => string[];
}

/** Session double recording every setActiveToolsByName application. Mirrors
 *  the SDK: unknown names are dropped from the applied set. */
function makeSessionDouble(initialActive: string[]): {
  session: Record<string, unknown>;
  appliedLog: string[][];
  activeNames: () => string[];
} {
  const appliedLog: string[][] = [];
  let active = [...initialActive];
  const registered = [...initialActive];
  const session = {
    getActiveToolNames: () => [...active],
    getAllTools: () => registered.map((name) => ({ name })),
    setActiveToolsByName: (names: string[]) => {
      active = names.filter((name) => registered.includes(name));
      appliedLog.push([...active]);
    },
    sessionManager: { getSessionId: () => 'session-1' },
  };
  return { session, appliedLog, activeNames: () => active };
}

function makeHostWithContext(
  sessionPath: string,
  initialActive: string[],
  options: { withToolGuards?: boolean } = {},
): {
  host: WorkerRuntimeHost;
  internals: WorkerRuntimeHostInternals;
  context: SessionContext;
  applied: () => string[][];
  activeNames: () => string[];
} {
  const server = {
    sendFrame: () => true,
    sendLiveSemanticFrame: () => true,
    sendDetailFrame: () => true,
    // WorkerLiveDetailStore registers its drain listener through this hook in
    // its constructor; the real server returns an unsubscribe function.
    onDetailDrain: () => () => undefined,
    failRuntime: () => undefined,
  } as never;
  const host = new WorkerRuntimeHost({
    server,
    owner: { coordinatorGeneration: 1, workerId: 'host-worker', workerGeneration: 1 },
    patchIdentity: { relativePath: 'dist/core/session-manager.js', patchVersion: 1, sha256: 'a'.repeat(64) },
  } as never);
  const double = makeSessionDouble(initialActive);
  const context = {
    runtime: {} as SessionContext['runtime'],
    session: double.session as unknown as SessionContext['session'],
    sessionPath,
    unsubscribe: () => undefined,
    busySeq: 0,
    systemPromptDisabledEntries: [] as string[],
    activeRequest: { id: 'request-1', messageIndex: 0, aborted: true },
  } as unknown as SessionContext;
  const internals = host as unknown as WorkerRuntimeHostInternals;
  internals.context = context;
  if (options.withToolGuards) installRuntimeToolGuards(host, context);
  return {
    host,
    internals,
    context,
    applied: () => double.appliedLog,
    activeNames: double.activeNames,
  };
}

/** Install the runtime tool-activation guard chain on the session double,
 *  mirroring bindSession's order: Tools prompt → autonomous → MCP → subagent
 *  policy. Only the prompt-toggle regression tests need the guards; the
 *  policy tests above drive host methods directly, and the turn_start test
 *  must be able to simulate registerTool auto-activation bypassing
 *  setActiveToolsByName. */
function installRuntimeToolGuards(host: WorkerRuntimeHost, context: SessionContext): void {
  const internals = host as unknown as WorkerRuntimeHostInternals;
  const session = context.session as unknown as {
    setActiveToolsByName?: (toolNames: string[]) => void;
  };
  installSystemPromptToolToggleGuard(
    session,
    () => (context as unknown as { systemPromptDisabledEntries?: string[] }).systemPromptDisabledEntries ?? [],
  );
  installAutonomousModeToolGuard(session, () => internals.autonomousMode);
  installMcpToolGuard(session, () => internals.mcpEnabled);
  installSubagentPolicyToolGuard(session, () => internals.subagentPolicyDisabled);
}

const SUBAGENT_PREFS_FIELDS = {
  providerToggles: {},
  extensionToggles: {},
  subagentAlwaysParentModel: false,
  subagentMaxDepth: 3,
} as const;

const SUBAGENT_ENV_KEYS = [SUBAGENT_BUCKETS_ENV, SUBAGENT_PROVIDER_DEFAULTS_ENV, SUBAGENT_PROVIDER_TOGGLES_ENV] as const;

/** Mirrors the nesting-controls pattern: snapshot subagent pref env mirrors
 *  before the suite and restore them afterwards. The session-settings sidecar
 *  env vars are cleared so prompt-toggle persistence stays in-memory. */
test.before(() => {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of SUBAGENT_ENV_KEYS) snapshot[key] = process.env[key];
  for (const key of ['PIE_SESSION_SETTINGS_DIR', 'PIE_LEGACY_SESSION_SETTINGS_DIR']) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  test.after(() => {
    for (const key of SUBAGENT_ENV_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
    for (const key of ['PIE_SESSION_SETTINGS_DIR', 'PIE_LEGACY_SESSION_SETTINGS_DIR']) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key]!;
    }
  });
});

test('applyRuntimePrefs removes the subagent tool while every provider is unchecked', () => {
  const { internals, applied, activeNames } = makeHostWithContext(
    'C:/sessions/root.jsonl',
    ['read', 'subagent', 'bash'],
  );
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [{ model: 'openai/gpt-5', thinkingLevel: 'medium' }],
      frontier: [],
    },
    subagentProviderDefaults: { anthropic: false, openai: false },
    subagentProviderTogglesBySession: {},
  });

  assert.equal(internals.subagentPolicyDisabled, true);
  assert.deepEqual(applied(), [['read', 'bash']]);
  assert.equal(activeNames().includes('subagent'), false);
});

test('applyRuntimePrefs restores the subagent tool when a provider is re-enabled', () => {
  const { internals, applied, activeNames } = makeHostWithContext(
    'C:/sessions/root.jsonl',
    ['read', 'subagent', 'bash'],
  );
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [],
      frontier: [],
    },
    subagentProviderDefaults: { anthropic: false },
    subagentProviderTogglesBySession: {},
  });
  assert.equal(internals.subagentPolicyDisabled, true);
  assert.deepEqual(applied(), [['read', 'bash']]);

  // Re-enable: the registered-but-inactive subagent tool is restored.
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentProviderDefaults: { anthropic: true },
  });
  assert.equal(internals.subagentPolicyDisabled, false);
  assert.deepEqual(applied(), [['read', 'bash'], ['read', 'bash', 'subagent']]);
  assert.equal(activeNames().includes('subagent'), true);
});

test('unspecified surface (no buckets, no toggle entries) never removes the tool', () => {
  const { internals, applied } = makeHostWithContext(
    'C:/sessions/root.jsonl',
    ['read', 'subagent', 'bash'],
  );
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentBuckets: { small: [], medium: [], frontier: [] },
    subagentProviderDefaults: {},
    subagentProviderTogglesBySession: {},
  });
  assert.equal(internals.subagentPolicyDisabled, false);
  assert.deepEqual(applied(), []);
});

test('per-session overrides drive the policy for the hosted session only', () => {
  const { internals, applied, activeNames } = makeHostWithContext(
    'C:/sessions/root.jsonl',
    ['read', 'subagent', 'bash'],
  );
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [],
      frontier: [],
    },
    // Default disabled for every session; this session re-enables it.
    subagentProviderDefaults: { anthropic: false },
    subagentProviderTogglesBySession: { 'c:/sessions/root.jsonl': { anthropic: true } },
  });
  assert.equal(internals.subagentPolicyDisabled, false);
  assert.deepEqual(applied(), []);

  // The override flips to false → policy disables the tool. Matching tolerates
  // drive-letter/separator spelling differences.
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentProviderTogglesBySession: { 'c:/sessions/root.jsonl': { anthropic: false } },
  });
  assert.equal(internals.subagentPolicyDisabled, true);
  assert.deepEqual(applied(), [['read', 'bash']]);
  assert.equal(activeNames().includes('subagent'), false);
});

test('turn_start re-enforcement removes a registerTool auto-activated subagent tool', () => {
  const { internals, context, applied, activeNames } = makeHostWithContext(
    'C:/sessions/root.jsonl',
    ['read', 'subagent', 'bash'],
  );
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [],
      frontier: [],
    },
    subagentProviderDefaults: { anthropic: false },
    subagentProviderTogglesBySession: {},
  });
  assert.deepEqual(applied(), [['read', 'bash']]);

  // Simulate the adapter re-registering/re-activating its tools between turns.
  const session = context.session as unknown as {
    setActiveToolsByName: (names: string[]) => void;
    getActiveToolNames: () => string[];
  };
  session.setActiveToolsByName(['read', 'subagent', 'bash']);
  assert.equal(activeNames().includes('subagent'), true);

  internals.handleSessionEvent(context, { type: 'turn_start' } as SdkSessionEvent);
  assert.equal(activeNames().includes('subagent'), false);
});

// --- Tools prompt entry × subagent provider policy interactions -------------
// Regression coverage for the reviewer-reported loss: with the guard chain
// installed (as bindSession does), disabling all providers prunes the
// subagent tool, then disabling the Tools prompt entry snapshots the already-
// pruned set. A policy restore issued while Tools is disabled stays filtered
// (Tools remains authoritative), and the Tools re-enable restore must both
// pass through the guard and re-apply the enabled policy over the snapshot.

test('all-unchecked → Tools off → provider on → Tools on restores the subagent tool', async () => {
  const { internals, context, applied, activeNames } = makeHostWithContext(
    'C:/sessions/root.jsonl',
    ['read', 'subagent', 'bash'],
    { withToolGuards: true },
  );
  // 1. Every provider unchecked → the subagent tool is pruned.
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [{ model: 'openai/gpt-5', thinkingLevel: 'medium' }],
      frontier: [],
    },
    subagentProviderDefaults: { anthropic: false, openai: false },
    subagentProviderTogglesBySession: {},
  });
  assert.equal(internals.subagentPolicyDisabled, true);
  assert.deepEqual(activeNames(), ['read', 'bash']);

  // 2. Tools prompt entry disabled → everything is pruned. The saved restore
  //    snapshot no longer contains the already-pruned subagent tool.
  await internals.applySystemPromptToggles(context, ['tools']);
  assert.deepEqual(activeNames(), []);

  // 3. A provider is re-enabled while Tools is still disabled: the policy
  //    field flips, but the restore stays filtered — Tools remains
  //    authoritative over the model-visible tool set.
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentProviderDefaults: { anthropic: true, openai: false },
  });
  assert.equal(internals.subagentPolicyDisabled, false);
  assert.deepEqual(activeNames(), []);
  // An extension-driven re-exposure is still coerced while Tools is disabled.
  (context.session as unknown as { setActiveToolsByName: (names: string[]) => void })
    .setActiveToolsByName(['read', 'subagent']);
  assert.deepEqual(activeNames(), []);

  // 4. Tools re-enabled: the saved tools are restored and the enabled policy
  //    is re-applied over them, bringing back the registered-but-inactive
  //    subagent tool.
  await internals.applySystemPromptToggles(context, []);
  assert.equal(internals.subagentPolicyDisabled, false);
  assert.deepEqual(applied().slice(-2), [['read', 'bash'], ['read', 'bash', 'subagent']]);
  assert.deepEqual(activeNames(), ['read', 'bash', 'subagent']);
});

test('Tools off → providers unchecked during the window → Tools on keeps the subagent pruned', async () => {
  const { internals, context, activeNames } = makeHostWithContext(
    'C:/sessions/root.jsonl',
    ['read', 'subagent', 'bash'],
    { withToolGuards: true },
  );
  // Tools disabled first: the saved snapshot still contains the subagent tool.
  await internals.applySystemPromptToggles(context, ['tools']);
  assert.deepEqual(activeNames(), []);

  // Every provider unchecked during the Tools-disabled window.
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [{ model: 'openai/gpt-5', thinkingLevel: 'medium' }],
      frontier: [],
    },
    subagentProviderDefaults: { anthropic: false, openai: false },
    subagentProviderTogglesBySession: {},
  });
  assert.equal(internals.subagentPolicyDisabled, true);
  assert.deepEqual(activeNames(), []);

  // Tools re-enabled: the restore passes through the subagent-policy guard,
  // which keeps the tool pruned even though the saved snapshot contained it.
  await internals.applySystemPromptToggles(context, []);
  assert.equal(internals.subagentPolicyDisabled, true);
  assert.deepEqual(activeNames(), ['read', 'bash']);
});

test('Tools prompt off/on round-trip restores the saved tool set and reapplies the policy', async () => {
  const { internals, context, applied, activeNames } = makeHostWithContext(
    'C:/sessions/root.jsonl',
    ['read', 'subagent', 'bash'],
    { withToolGuards: true },
  );
  // An empty surface is unspecified: the policy stays enabled.
  internals.applyRuntimePrefs({
    ...SUBAGENT_PREFS_FIELDS,
    subagentBuckets: { small: [], medium: [], frontier: [] },
    subagentProviderDefaults: {},
    subagentProviderTogglesBySession: {},
  });
  assert.equal(internals.subagentPolicyDisabled, false);

  await internals.applySystemPromptToggles(context, ['tools']);
  assert.deepEqual(activeNames(), []);
  await internals.applySystemPromptToggles(context, []);
  assert.deepEqual(applied(), [[], ['read', 'subagent', 'bash']]);
  assert.deepEqual(activeNames(), ['read', 'subagent', 'bash']);
});