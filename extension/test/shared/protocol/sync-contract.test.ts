import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertProtocolVersion,
  DEFAULT_CHAT_PREFS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  PROTOCOL_VERSION,
  resolveChatPrefs,
  type ChatMessage,
  type ComposerInput,
  type ContextUsageChangedPayload,
  type HostToWebviewMessage,
  type LiveSubagentDetailAddress,
  type ModelInfo,
  type SessionAnalyticsFactors,
  type SessionOpenedPayload,
  type ToolFinishedPayload,
  type ViewState,
  type WebviewToHostMessage,
  EMPTY_AGGREGATE_STATS,
} from '../../../src/shared/protocol';

// ---------------------------------------------------------------------------
// Protocol contract: PROTOCOL_VERSION is a positive integer that the host and
// backend must agree on. Bumps require a coordinated change.
// ---------------------------------------------------------------------------

test('PROTOCOL_VERSION is a positive integer', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  assert.ok(Number.isInteger(PROTOCOL_VERSION));
  assert.ok(PROTOCOL_VERSION >= 1);
});

test('DEFAULT_CHAT_PREFS shape', () => {
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandReasoning, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandToolCalls, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandSubagentCalls, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.suppressCompletionNotifications, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.subagentAlwaysParentModel, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiMessageWidth, 'number');
  assert.equal(DEFAULT_CHAT_PREFS.uiMessageWidth, 88);
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiBackground, 'string');
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiForeground, 'string');
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiBorder, 'string');
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiCornerRadius, 'number');
  assert.equal(DEFAULT_CHAT_PREFS.uiCornerRadius, 8);
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiDensity, 'string');
  assert.equal(DEFAULT_CHAT_PREFS.uiDensity, 'comfortable');
  // Per-place font sizes default to the bundled sizes (13px) so an uncustomized
  // panel is unchanged; color overrides default to '' (use bundled defaults).
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiBaseFontSize, 'number');
  assert.equal(DEFAULT_CHAT_PREFS.uiBaseFontSize, 13);
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiComposerFontSize, 'number');
  assert.equal(DEFAULT_CHAT_PREFS.uiComposerFontSize, 13);
  assert.equal(typeof DEFAULT_CHAT_PREFS.composerInitialRows, 'number');
  assert.equal(DEFAULT_CHAT_PREFS.composerInitialRows, 1);
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiMutedColor, 'string');
  assert.equal(DEFAULT_CHAT_PREFS.uiMutedColor, '');
  assert.equal(typeof DEFAULT_CHAT_PREFS.uiLinkColor, 'string');
  assert.equal(DEFAULT_CHAT_PREFS.uiLinkColor, '');
  assert.equal(DEFAULT_CHAT_PREFS.uiPathParentDepth, 1);
});

test('resolveChatPrefs defaults and validates autonomous mode', () => {
  assert.equal(resolveChatPrefs().autonomousMode, false);
  assert.equal(resolveChatPrefs({ autonomousMode: true }).autonomousMode, true);
  assert.equal(resolveChatPrefs({ autonomousMode: 'yes' as never }).autonomousMode, false);
});

test('resolveChatPrefs preserves valid composer rows and defaults malformed stored values to one', () => {
  assert.equal(resolveChatPrefs({ composerInitialRows: 6 }).composerInitialRows, 6);
  for (const invalid of [0, 7, 1.5, Number.NaN, '3']) {
    assert.equal(
      resolveChatPrefs({ composerInitialRows: invalid as never }).composerInitialRows,
      1,
      `invalid stored composer row count ${String(invalid)} should use the default`,
    );
  }
});

test('resolveChatPrefs preserves valid path depth and defaults malformed stored values', () => {
  assert.equal(resolveChatPrefs({ uiPathParentDepth: 0 }).uiPathParentDepth, 0);
  assert.equal(resolveChatPrefs({ uiPathParentDepth: 8 }).uiPathParentDepth, 8);
  for (const invalid of [-1, 9, 1.5, Number.NaN, '2']) {
    assert.equal(resolveChatPrefs({ uiPathParentDepth: invalid as never }).uiPathParentDepth, 1);
  }
});

test('resolveChatPrefs backfills subagent auto-expand from legacy tool-call prefs', () => {
  assert.equal(resolveChatPrefs({ autoExpandToolCalls: true }).autoExpandSubagentCalls, true);
  assert.equal(
    resolveChatPrefs({ autoExpandToolCalls: true, autoExpandSubagentCalls: false }).autoExpandSubagentCalls,
    false,
  );
});

test('assertProtocolVersion accepts matches and rejects mismatches', () => {
  assert.doesNotThrow(() => {
    assertProtocolVersion('backend.ready', PROTOCOL_VERSION);
  });

  assert.throws(() => {
    assertProtocolVersion('backend.ready', PROTOCOL_VERSION + 1);
  }, /protocol mismatch/i);

  assert.throws(() => {
    assertProtocolVersion('backend.ready', 'not-a-number');
  }, /valid integer protocolVersion/i);
});

test('ModelInfo carries explicit inputKinds capability metadata', () => {
  const model: ModelInfo = {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    reasoning: true,
    inputKinds: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  };

  assert.deepEqual(model.inputKinds, ['text', 'image']);
});

test('ChatMessage.userParts supports structured user image content', () => {
  const message: ChatMessage = {
    id: 'user-1',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Please inspect this screenshot',
    userParts: [
      { kind: 'text', text: 'Please inspect this screenshot' },
      {
        kind: 'image',
        mimeType: 'image/png',
        dataBase64: 'ZmFrZQ==',
        name: 'screenshot.png',
        width: 100,
        height: 50,
      },
    ],
    status: 'completed',
  };

  assert.equal(message.userParts?.[1]?.kind, 'image');
});

// ---------------------------------------------------------------------------
// Snapshot envelope contract: every state envelope carries hostInstanceId +
// per-renderer identity (rendererId/rendererGeneration) + revision. The
// webview uses these to detect host-side counter resets; cross-renderer
// revision comparison is never meaningful.
// ---------------------------------------------------------------------------

test('HostToWebviewMessage state envelope carries hostInstanceId and revision', () => {
  const msg: HostToWebviewMessage = {
    type: 'state',
    protocolVersion: 2,
    hostInstanceId: 'abc',
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    viewGeneration: 2,
    revision: 7,
    expectedTranscriptIdentity: 'identity-7',
    snapshotBytes: 0,
    state: {
      sessions: [],
      openTabPaths: [],
      pinnedTabPaths: [],
      pinnedTabGroups: [],
      runningSessionPaths: [],
      startingModelSessionPaths: [],
      compactingSessionPaths: [],
      lastCompactionBySession: {},
      unreadFinishedSessionPaths: [],
      activeSession: null,
      transcript: [],
      transcriptWindow: {
        totalCount: 0,
        loadedStart: 0,
        loadedEnd: 0,
        hasOlder: false,
        hasNewer: false,
        isPartial: false,
        hasUserMessages: false,
      },
      sessionUsage: {
        samples: [{
          sourceId: 'assistant:durable-1',
          kind: 'assistant',
          modelId: 'gpt-5.4',
          provider: 'openai-codex',
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1_100,
          reportedCostUsd: 0.01,
        }],
      },
      transcriptLoaded: false,
      pendingComposerInputs: [],
      activeRunSummary: null,
      runSummariesBySession: {},
      tokenRateBySession: {},
      aggregateStats: EMPTY_AGGREGATE_STATS,
      draftText: '',
      busy: false,
      retryStatus: null,
      liveTurnPhase: null,
      notice: null,
      backendReady: false,
      workspaceCwd: null,
      systemPrompts: [],
      modelSettings: null,
      availableModels: [],
  availableModelsStatus: 'authoritative',
      contextUsage: null,
      prefs: DEFAULT_CHAT_PREFS,
      availableExtensions: [],
      fileChanges: [],
      fileChangesExpanded: false,
      readFilePaths: [],
      pruningResult: null,
      prepassPhase: 'idle',
      prepassStartedAt: null,
      pruningSettings: {
        mode: 'auto' as const,
        skillCeiling: 8,
        toolCeiling: 10,
        skillAlwaysKeep: [],
        toolAlwaysKeep: [],
        model: 'gpt-5.4-mini',
        provider: 'github-copilot',
        thinkingLevel: 'minimal' as const,
      },
      toolResultPruningSettings: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules } },
      pruningCatalog: {
        skills: [],
        tools: [],
      },
      editingMessageId: null,
      pendingExtensionUIRequestsBySession: {},
      pendingExtensionUIRequest: null,
    },
  };
  assert.equal(msg.type, 'state');
  if (msg.type === 'state') {
    assert.equal(msg.hostInstanceId, 'abc');
    assert.equal(msg.rendererId, 'renderer-1', 'per-renderer identity is host-assigned');
    assert.equal(msg.rendererGeneration, 1, 'renderer reload/reconnect fence');
    assert.equal(msg.revision, 7);
    assert.deepEqual(msg.state.pendingComposerInputs, []);
    assert.equal(msg.state.activeRunSummary, null);
    assert.deepEqual(msg.state.runSummariesBySession, {});
    assert.equal(msg.state.sessionUsage?.samples[0]?.reportedCostUsd, 0.01);
  }
});

// ---------------------------------------------------------------------------
// busy-seq dedup contract: BusyChangedPayload may carry a `seq` counter that
// monotonically increases per session. The host drops events whose seq is
// less than or equal to the last accepted value to ignore re-orderings.
// ---------------------------------------------------------------------------

function acceptBusySeq(state: Map<string, number>, sessionPath: string, seq: number | undefined): boolean {
  if (typeof seq !== 'number') return true;
  const last = state.get(sessionPath) ?? 0;
  if (seq <= last) return false;
  state.set(sessionPath, seq);
  return true;
}

test('busy-seq dedup ignores out-of-order events but accepts unordered (no seq)', () => {
  const state = new Map<string, number>();
  assert.equal(acceptBusySeq(state, '/a', 1), true);
  assert.equal(acceptBusySeq(state, '/a', 2), true);
  // Stale event from an earlier dispatch arrives late.
  assert.equal(acceptBusySeq(state, '/a', 1), false);
  // Same seq is also dropped.
  assert.equal(acceptBusySeq(state, '/a', 2), false);
  // Higher seq accepted.
  assert.equal(acceptBusySeq(state, '/a', 3), true);
  // Different session has independent counter.
  assert.equal(acceptBusySeq(state, '/b', 1), true);
  // Missing seq is always accepted (backward-compat).
  assert.equal(acceptBusySeq(state, '/a', undefined), true);
});

test('ContextUsageChangedPayload carries nullable live usage per session', () => {
  const update: ContextUsageChangedPayload = {
    sessionPath: '/workspace/session.jsonl',
    contextUsage: { tokens: 1234, contextWindow: 200000, percent: 0.617 },
  };
  const cleared: ContextUsageChangedPayload = {
    sessionPath: '/workspace/session.jsonl',
    contextUsage: null,
  };

  assert.equal(update.contextUsage?.tokens, 1234);
  assert.equal(cleared.contextUsage, null);
});

test('SessionOpenedPayload can carry structured analytics factors', () => {
  const analyticsFactors: SessionAnalyticsFactors = {
    promptFamily: 'harness+customPrompt',
    promptHash: 'prompt-hash',
  promptCapturedAt: '2025-06-15T10:30:00.000Z',
    harnessPromptHash: 'harness-hash',
    customPromptHash: 'custom-hash',
    appendSystemPromptHash: null,
    promptGuidelineHashes: ['guideline-hash'],
    contextFiles: [{ path: '/workspace/context.md', hash: 'context-hash' }],
    selectedToolIds: ['read', 'bash'],
    toolSnippetHashes: [{ toolId: 'bash', hash: 'tool-snippet-hash' }],
    toolSetHash: 'tool-set-hash',
    skills: [{
      name: 'frontend-design',
      contentHash: 'skill-hash',
      sourceHash: 'skill-source-hash',
      disableModelInvocation: false,
      lastModifiedAt: null,
    }],
    skillSetHash: 'skill-set-hash',
    activeExtensions: ['subagent'],
  };

  const payload: SessionOpenedPayload = {
    session: {
      path: '/workspace/session.jsonl',
      name: 'Session',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    },
    transcript: [],
    transcriptWindow: {
      totalCount: 0,
      loadedStart: 0,
      loadedEnd: 0,
      hasOlder: false,
      hasNewer: false,
      isPartial: false,
      hasUserMessages: false,
    },
    busy: false,
    analyticsFactors,
  };

  assert.equal(payload.analyticsFactors?.promptHash, 'prompt-hash');
  assert.equal(payload.analyticsFactors?.selectedToolIds[0], 'read');
});


test('ToolFinishedPayload carries normalized failure status', () => {
  const payload: ToolFinishedPayload = {
    requestId: 'request-1',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'message-1',
    toolCallId: 'tool-1',
    result: { ok: false },
    status: 'failed',
  };

  assert.equal(payload.status, 'failed');
});

// ---------------------------------------------------------------------------
// Webview-to-host setPrefs envelope: prefs now live on the host (globalState)
// and changes flow as a typed RPC, replacing the old localStorage path.
// ---------------------------------------------------------------------------

test('WebviewToHostMessage.setPrefs accepts partial pref updates', () => {
  const msg: WebviewToHostMessage = {
    type: 'setPrefs',
    prefs: {
      autoExpandReasoning: true,
      autoExpandSubagentCalls: true,
      suppressCompletionNotifications: true,
    },
  };
  assert.equal(msg.type, 'setPrefs');
  if (msg.type === 'setPrefs') {
    assert.equal(msg.prefs.autoExpandReasoning, true);
    assert.equal(msg.prefs.autoExpandSubagentCalls, true);
    assert.equal(msg.prefs.suppressCompletionNotifications, true);
  }
});

test('WebviewToHostMessage.setModel can target an explicit session path', () => {
  const msg: WebviewToHostMessage = {
    type: 'setModel',
    sessionPath: '/workspace/session.jsonl',
    defaultModel: 'claude-sonnet-4-5',
    defaultThinkingLevel: 'medium',
  };
  assert.equal(msg.type, 'setModel');
  if (msg.type === 'setModel') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.defaultModel, 'claude-sonnet-4-5');
    assert.equal(msg.defaultThinkingLevel, 'medium');
  }
});

test('WebviewToHostMessage.addComposerInput accepts a raw input without an id', () => {
  const input: ComposerInput = {
    id: 'input-1',
    kind: 'filesystemPathRef',
    path: '/workspace/a.ts',
    name: 'a.ts',
    source: 'picker',
  };

  const msg: WebviewToHostMessage = {
    type: 'addComposerInput',
    sessionPath: '/workspace/session.jsonl',
    input: {
      kind: input.kind,
      path: input.path,
      name: input.name,
      source: input.source,
    },
  };

  assert.equal(msg.type, 'addComposerInput');
  if (msg.type === 'addComposerInput') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.ok(!('id' in msg.input));
    assert.equal(msg.input.kind, 'filesystemPathRef');
  }
});

test('WebviewToHostMessage.removeComposerInput targets an assigned input id', () => {
  const msg: WebviewToHostMessage = {
    type: 'removeComposerInput',
    sessionPath: '/workspace/session.jsonl',
    inputId: 'input-1',
  };

  assert.equal(msg.type, 'removeComposerInput');
  if (msg.type === 'removeComposerInput') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.inputId, 'input-1');
  }
});

test('WebviewToHostMessage.send carries an explicit sessionPath', () => {
  const msg: WebviewToHostMessage = {
    type: 'send',
    sessionPath: '/workspace/session.jsonl',
    text: 'hello',
  };
  assert.equal(msg.type, 'send');
  if (msg.type === 'send') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.text, 'hello');
  }
});

test('HostToWebviewMessage.sendRejected carries the text draft payload and optional composer inputs', () => {
  // Minimal shape: sendRejected can be constructed with only the text draft
  // payload (a text-only send rejection carries no inputs).
  const msg: HostToWebviewMessage = {
    type: 'sendRejected',
    sessionPath: '/workspace/a.ts',
    text: 'hello',
  };
  assert.equal(msg.type, 'sendRejected');
  if (msg.type === 'sendRejected') {
    assert.equal(msg.sessionPath, '/workspace/a.ts');
    assert.equal(msg.text, 'hello');
    // Brief C: inputs is optional — absent for a text-only rejection.
    assert.equal(msg.inputs, undefined);
  }

  // Full shape: a send rejection carrying pasted/dropped attachments so the
  // webview can restore them to the composer (no data loss on rollback).
  const withInputs: HostToWebviewMessage = {
    type: 'sendRejected',
    sessionPath: '/workspace/a.ts',
    text: 'hello',
    inputs: [{ id: 'in1', kind: 'filesystemPathRef', path: '/f', name: 'f', source: 'picker' }],
  };
  if (withInputs.type === 'sendRejected') {
    assert.equal(withInputs.inputs?.length, 1);
    assert.equal(withInputs.inputs?.[0]?.id, 'in1');
  }
});

test('detail.subscribe/unsubscribe/fetchPages carry the required renderer owner identity', () => {
  // `viewGeneration` and `detailKey` are REQUIRED (not the optional wrapper
  // field): the host records the exact renderer owner before forwarding any
  // stream content. The webview mints nothing — the host returns the
  // subscription ID inside `detail.start`.
  const subscribe: WebviewToHostMessage = {
    type: 'detail.subscribe',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    address: {
      sessionPath: '/workspace/session.jsonl',
      turnId: 'turn-1',
      rootToolCallId: 'tool-1',
      rootAttemptId: 'attempt-1',
      lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
    },
    cursor: { revision: 3, pageIndex: 0 },
  };
  assert.equal(subscribe.type, 'detail.subscribe');
  if (subscribe.type === 'detail.subscribe') {
    assert.equal(subscribe.viewGeneration, 7);
    assert.equal(subscribe.detailKey, 'subagent:msg-1:tool-1');
    assert.equal(subscribe.address.rootToolCallId, 'tool-1');
    assert.deepEqual(subscribe.cursor, { revision: 3, pageIndex: 0 });
  }

  const unsubscribe: WebviewToHostMessage = {
    type: 'detail.unsubscribe',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    reason: 'collapse',
  };
  assert.equal(unsubscribe.type, 'detail.unsubscribe');
  if (unsubscribe.type === 'detail.unsubscribe') {
    assert.equal(unsubscribe.reason, 'collapse');
  }

  const fetchPages: WebviewToHostMessage = {
    type: 'detail.fetchPages',
    viewGeneration: 7,
    detailKey: 'subagent:msg-1:tool-1',
    ref: { baselineRevision: 5, pageIndex: 3, pageCount: 8 },
  };
  assert.equal(fetchPages.type, 'detail.fetchPages');
  if (fetchPages.type === 'detail.fetchPages') {
    assert.deepEqual(fetchPages.ref, { baselineRevision: 5, pageIndex: 3, pageCount: 8 });
  }
});

test('HostToWebviewMessage detail stream variants carry the full HostDetailRoute', () => {
  // The six stream variants are the ONLY stream content: every message
  // carries the full route so a stale or cross-key message can never be
  // applied to the wrong expanded subtree. Pages/deltas never enter
  // `ViewState`; they cross only as these imperatives.
  const route = {
    hostInstanceId: 'host-instance-1',
    hostGeneration: 0,
    viewGeneration: 7,
    backendGeneration: 3,
    coordinatorGeneration: 1,
    workerId: 'worker-1',
    workerGeneration: 1,
    detailKey: 'subagent:msg-1:tool-1',
    subscriptionId: 'subscription-1',
  };

  const start: HostToWebviewMessage = {
    type: 'detail.start',
    ...route,
    address: {
      sessionPath: '/workspace/session.jsonl',
      turnId: 'turn-1',
      rootToolCallId: 'tool-1',
      rootAttemptId: 'attempt-1',
      lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
    },
    source: 'live',
    baselineRevision: 1,
    pageCount: 1,
    totalBytes: 4,
  };
  assert.equal(start.type, 'detail.start');
  if (start.type === 'detail.start') {
    assert.equal(start.source, 'live');
    assert.equal(start.subscriptionId, 'subscription-1');
    assert.equal(start.backendGeneration, 3);
  }

  const page: HostToWebviewMessage = {
    type: 'detail.page',
    ...route,
    ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 },
    payload: {
      kind: 'json-segment', encoding: 'utf8-json', segmentId: 'segment-1', semanticPath: [],
      startByte: 0, endByte: 4, totalBytes: 4, startCodePoint: 0, endCodePoint: 4, totalCodePoints: 4,
      text: 'null',
    },
    payloadBytes: 4,
    checksum: 'c'.repeat(64),
  };
  assert.equal(page.type, 'detail.page');
  if (page.type === 'detail.page') {
    assert.equal(page.ref.pageIndex, 0);
    assert.equal(page.workerGeneration, 1);
  }

  const delta: HostToWebviewMessage = {
    type: 'detail.delta',
    ...route,
    baseRevision: 1,
    revision: 2,
    operations: [{ op: 'set', path: ['exitCode'], value: 0 }],
  };
  assert.equal(delta.type, 'detail.delta');
  if (delta.type === 'detail.delta') {
    assert.deepEqual(delta.operations, [{ op: 'set', path: ['exitCode'], value: 0 }]);
  }

  const rebase: HostToWebviewMessage = { type: 'detail.rebase', ...route, currentRevision: 4, reason: 'gap' };
  assert.equal(rebase.type, 'detail.rebase');
  if (rebase.type === 'detail.rebase') {
    assert.equal(rebase.reason, 'gap');
    assert.equal(rebase.currentRevision, 4);
  }

  const terminal: HostToWebviewMessage = {
    type: 'detail.terminal',
    ...route,
    revision: 5,
    durableRef: {
      sessionPath: '/workspace/session.jsonl',
      messageId: 'msg-1',
      key: 'durable:tool:msg-1:tool-1',
      kind: 'tool-result',
      source: 'durable',
      sizeBytes: 1024,
      summary: 'exit code 0',
      available: true,
    },
  };
  assert.equal(terminal.type, 'detail.terminal');
  if (terminal.type === 'detail.terminal') {
    assert.equal(terminal.durableRef.key, 'durable:tool:msg-1:tool-1');
    assert.equal(terminal.revision, 5);
  }

  const error: HostToWebviewMessage = {
    type: 'detail.error',
    ...route,
    code: 'NOT_FOUND',
    message: 'The subagent detail is no longer addressable.',
    retryable: false,
  };
  assert.equal(error.type, 'detail.error');
  if (error.type === 'detail.error') {
    assert.equal(error.retryable, false);
    assert.equal(error.subscriptionId, 'subscription-1');
  }
});

test('webview behavior contract: collapsed cards never subscribe; expansion subscribes once; collapse unsubscribes', () => {
  // STATE_CONTRACT § Ordinary state transport: a collapsed subagent card
  // renders only its bounded compact preview and sends NO detail.subscribe;
  // expansion sends exactly one subscribe carrying the current
  // viewGeneration/detailKey/address; collapse — including during the close
  // animation — immediately unsubscribes. This is the webview-side half of
  // the Phase 5 contract (the host half is covered by the detail stream
  // route tests above).
  const {
    clearDetailSubscriptionStore,
    closeDetailSubscription,
    openDetailSubscription,
    setDetailStoreContext,
  } = require('../../../src/webview/panel/transcript/detail-subscription-store') as typeof import('../../../src/webview/panel/transcript/detail-subscription-store');
  clearDetailSubscriptionStore();
  const posts: WebviewToHostMessage[] = [];
  setDetailStoreContext({ hostInstanceId: 'h1', viewGeneration: 9, postMessage: (message) => posts.push(message) });

  const address: LiveSubagentDetailAddress = {
    sessionPath: '/workspace/session.jsonl',
    turnId: 'turn-1',
    rootToolCallId: 'tool-1',
    rootAttemptId: 'attempt-1',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
  };

  // Collapsed: nothing posted.
  assert.equal(posts.length, 0, 'collapsed state is subscription-free');

  // Expansion: exactly one subscribe with the current generation + key + address.
  openDetailSubscription({ detailKey: 'subagent:msg-1:tool-1', address });
  openDetailSubscription({ detailKey: 'subagent:msg-1:tool-1', address });
  assert.equal(posts.length, 1, 're-expansion of the same owner is idempotent');
  const subscribe = posts[0];
  assert.equal(subscribe.type, 'detail.subscribe');
  if (subscribe.type === 'detail.subscribe') {
    assert.equal(subscribe.viewGeneration, 9);
    assert.equal(subscribe.detailKey, 'subagent:msg-1:tool-1');
    assert.equal(subscribe.address.rootToolCallId, 'tool-1');
  }

  // Collapse: immediate unsubscribe (also during the close animation).
  closeDetailSubscription('subagent:msg-1:tool-1', 'collapse');
  assert.equal(posts.length, 2);
  const unsubscribe = posts[1];
  assert.equal(unsubscribe.type, 'detail.unsubscribe');
  if (unsubscribe.type === 'detail.unsubscribe') {
    assert.equal(unsubscribe.viewGeneration, 9);
    assert.equal(unsubscribe.reason, 'collapse');
  }
  closeDetailSubscription('subagent:msg-1:tool-1', 'unmount');
  assert.equal(posts.length, 2, 'unmount after collapse does not double-post');
});

test('changed-files peek/hover overlay is webview-local, not host state', () => {
  // STATE_CONTRACT § Webview-Local State: the changed-files rail's transient
  // peek/hover overlay is webview-local (analogous to contextMenu) and must
  // not cross the host↔webview boundary. Only the durable pin
  // (ViewState.fileChangesExpanded) is host state. This type-level assertion
  // fails to compile if a peek field is ever promoted into ViewState — the
  // signal to update STATE_CONTRACT and reconsider the boundary.
  type PeekField = Extract<keyof ViewState, `fileChangesPeek${string}`>;
  const isWebviewLocal: [PeekField] extends [never] ? true : false = true;
  assert.equal(isWebviewLocal, true);
});
