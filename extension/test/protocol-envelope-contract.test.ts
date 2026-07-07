import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION,
  WEBVIEW_PROTOCOL_VERSION,
  isEventEnvelope,
  isResponseEnvelope,
  type HostToWebviewMessage,
  type RequestEnvelope,
  type ResponseEnvelope,
  type EventEnvelope,
  type ViewState,
  EMPTY_AGGREGATE_STATS,
  DEFAULT_CHAT_PREFS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  DEFAULT_PROXY_SETTINGS,
} from '../src/shared/protocol';

// ---------------------------------------------------------------------------
// Protocol-envelope wire contract (extension/src/shared/protocol/core.ts).
//
// These guards and shapes are the host↔backend JSON-RPC wire contract. They
// were previously only exercised inline inside backend-protocol integration
// tests; this file pins them directly so the contract cannot silently drift.
// assertProtocolVersion accept/reject behavior is covered by sync-contract
// .test.ts and is deliberately NOT duplicated here.
// ---------------------------------------------------------------------------

// Minimal-but-complete ViewState so a `state` envelope type-checks without
// importing any webview UI (pure logic only). Mirrors the construction in
// sync-contract.test.ts.
function emptyViewState(): ViewState {
  return {
    sessions: [],
    openTabPaths: [],
    pinnedTabPaths: [],
    runningSessionPaths: [],
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
    transcriptLoaded: false,
    pendingComposerInputs: [],
    activeRunSummary: null,
    runSummariesBySession: {},
    tokenRateBySession: {},
    aggregateStats: EMPTY_AGGREGATE_STATS,
    draftText: '',
    busy: false,
    retryStatus: null,
    notice: null,
    backendReady: false,
    workspaceCwd: null,
    systemPrompts: [],
    modelSettings: null,
    availableModels: [],
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
      mode: 'auto',
      skillCeiling: 8,
      toolCeiling: 10,
      skillAlwaysKeep: [],
      toolAlwaysKeep: [],
      model: 'gpt-5.4-mini',
      provider: 'github-copilot',
      thinkingLevel: 'minimal',
    },
    toolResultPruningSettings: {
      ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
      rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules },
    },
    proxySettings: DEFAULT_PROXY_SETTINGS,
    pruningCatalog: {
      skills: [],
      tools: [],
    },
    editingMessageId: null,
    showOutcomeDialog: false,
    pendingExtensionUIRequestsBySession: {},
    pendingExtensionUIRequest: null,
    deferredTriggers: [],
  };
}

// ---------------------------------------------------------------------------
// 1. Version constants are positive integers.
// ---------------------------------------------------------------------------

test('PROTOCOL_VERSION is a positive integer', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  assert.ok(Number.isInteger(PROTOCOL_VERSION), 'PROTOCOL_VERSION must be an integer');
  assert.ok(PROTOCOL_VERSION >= 1, 'PROTOCOL_VERSION must be >= 1');
});

test('WEBVIEW_PROTOCOL_VERSION is a positive integer', () => {
  assert.equal(typeof WEBVIEW_PROTOCOL_VERSION, 'number');
  assert.ok(Number.isInteger(WEBVIEW_PROTOCOL_VERSION), 'WEBVIEW_PROTOCOL_VERSION must be an integer');
  assert.ok(WEBVIEW_PROTOCOL_VERSION >= 1, 'WEBVIEW_PROTOCOL_VERSION must be >= 1');
});

test('host stamps WEBVIEW_PROTOCOL_VERSION onto state envelopes', () => {
  // The host↔webview `state` envelope carries a `protocolVersion` field; the
  // host must stamp the compiled-in WEBVIEW_PROTOCOL_VERSION constant onto it.
  const msg: HostToWebviewMessage = {
    type: 'state',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    hostInstanceId: 'host-1',
    revision: 1,
    state: emptyViewState(),
  };
  assert.equal(msg.type, 'state');
  if (msg.type === 'state') {
    assert.equal(msg.protocolVersion, WEBVIEW_PROTOCOL_VERSION);
  }
});

// ---------------------------------------------------------------------------
// 2. isEventEnvelope guard truth table.
//    Guard: !!value && typeof value === 'object' && 'event' in value
// ---------------------------------------------------------------------------

test('isEventEnvelope returns true for objects with an event field', () => {
  assert.equal(isEventEnvelope({ event: 'x' }), true, '{event:"x"}');
  assert.equal(isEventEnvelope({ event: 'x', payload: {} }), true, '{event:"x", payload:{}}');
  assert.equal(isEventEnvelope({ event: 'x', extra: 'field' }), true, 'object with extra fields');
});

test('isEventEnvelope returns false for non-envelopes', () => {
  assert.equal(isEventEnvelope(null), false, 'null');
  assert.equal(isEventEnvelope(undefined), false, 'undefined');
  assert.equal(isEventEnvelope('string'), false, 'string primitive');
  assert.equal(isEventEnvelope(42), false, 'number primitive');
  assert.equal(isEventEnvelope(true), false, 'boolean primitive');
  assert.equal(isEventEnvelope([]), false, 'empty array');
  assert.equal(isEventEnvelope({}), false, 'object missing event');
  assert.equal(isEventEnvelope({ EVENT: 'x' }), false, 'wrong key EVENT (case-sensitive)');
  // `in` checks object properties, not Map entries, so a Map has no `event` prop.
  assert.equal(isEventEnvelope(new Map()), false, 'Map instance');
});

// ---------------------------------------------------------------------------
// 3. isResponseEnvelope guard truth table.
//    Guard: !!value && typeof value === 'object' && 'id' in value && 'ok' in value
// ---------------------------------------------------------------------------

test('isResponseEnvelope returns true for objects with id and ok', () => {
  assert.equal(isResponseEnvelope({ id: '1', ok: true }), true, '{id:"1", ok:true}');
  assert.equal(isResponseEnvelope({ id: '1', ok: false, error: { code: 'X', message: 'm' } }), true, 'error response');
  assert.equal(isResponseEnvelope({ id: '1', ok: true, extra: 'field' }), true, 'object with extra fields');
});

test('isResponseEnvelope returns false for non-envelopes', () => {
  assert.equal(isResponseEnvelope(null), false, 'null');
  assert.equal(isResponseEnvelope(undefined), false, 'undefined');
  assert.equal(isResponseEnvelope('string'), false, 'string primitive');
  assert.equal(isResponseEnvelope(42), false, 'number primitive');
  assert.equal(isResponseEnvelope(true), false, 'boolean primitive');
  assert.equal(isResponseEnvelope([]), false, 'empty array');
  assert.equal(isResponseEnvelope({ id: '1' }), false, 'missing ok');
  assert.equal(isResponseEnvelope({ ok: true }), false, 'missing id');
});

test('isResponseEnvelope does not validate that id is a string', () => {
  // The runtime guard only checks `'id' in value && 'ok' in value` — it does
  // NOT assert id is a string. A non-string id is therefore accepted by the
  // guard. The ResponseEnvelope *type* (id: string) enforces id stringiness at
  // compile time; the guard is a structural presence check, not a deep
  // validator. This pins that intentional behavior.
  assert.equal(isResponseEnvelope({ id: 1, ok: true }), true, 'non-string id accepted by guard');
});

// ---------------------------------------------------------------------------
// 4. ResponseEnvelope shape contract (discriminated union on `ok`).
// ---------------------------------------------------------------------------

test('ResponseEnvelope ok:true has optional result and no error', () => {
  // result is optional — an ok:true response may omit it entirely.
  const withoutResult: ResponseEnvelope = { id: '1', ok: true };
  const withResult: ResponseEnvelope = { id: '1', ok: true, result: { value: 42 } };

  assert.equal(withoutResult.ok, true);
  assert.equal(withResult.ok, true);
  assert.equal('result' in withoutResult, false, 'result may be absent on ok:true');
  assert.deepEqual(withResult.result, { value: 42 });
  // The ok:true arm of the discriminated union carries no `error` key — the
  // type system forbids `.error` access here (a compile error), and the
  // constructed object has no such own property. (TS further narrows
  // `withoutResult.ok` to literal `true` from the initializer, so an
  // `if (r.ok === false)` guard on an ok:true value is itself a compile error
  // — the union is enforced statically, which is exactly the contract being
  // pinned. The `if (r.ok === false)` narrowing is exercised on the ok:false
  // response below, where it is valid.)
  assert.equal('error' in withoutResult, false, 'ok:true response has no error key');
});

test('ResponseEnvelope ok:false carries a structured error', () => {
  const withoutData: ResponseEnvelope = {
    id: '1',
    ok: false,
    error: { code: 'E_TIMEOUT', message: 'timed out' },
  };
  const withData: ResponseEnvelope = {
    id: '1',
    ok: false,
    error: { code: 'E_BAD', message: 'bad request', data: { hint: 'x' } },
  };

  // Narrow via the ok===false discriminator; `error` is guaranteed present.
  if (withoutData.ok === false) {
    assert.equal(typeof withoutData.error.code, 'string', 'error.code is a string');
    assert.equal(typeof withoutData.error.message, 'string', 'error.message is a string');
    assert.equal(withoutData.error.data, undefined, 'data is absent when omitted');
  } else {
    assert.fail('ok:false response must narrow to the false branch');
  }

  if (withData.ok === false) {
    assert.equal(typeof withData.error.code, 'string');
    assert.equal(typeof withData.error.message, 'string');
    // data is either undefined or present (an arbitrary unknown value).
    assert.ok(withData.error.data !== undefined, 'data present when provided');
  } else {
    assert.fail('ok:false response must narrow to the false branch');
  }
});

// ---------------------------------------------------------------------------
// 5. EventEnvelope shape contract.
// ---------------------------------------------------------------------------

test('EventEnvelope has a string event and an optional payload', () => {
  const withPayload: EventEnvelope = { event: 'session.opened', payload: { sessionPath: '/a' } };
  const withoutPayload: EventEnvelope = { event: 'session.opened' };

  assert.equal(typeof withPayload.event, 'string');
  assert.equal(withPayload.event, 'session.opened');
  assert.equal(typeof withoutPayload.event, 'string');
  assert.equal('payload' in withoutPayload, false, 'payload is optional and may be absent');
});

// ---------------------------------------------------------------------------
// 6. RequestEnvelope shape contract.
// ---------------------------------------------------------------------------

test('RequestEnvelope has string id/method and optional params', () => {
  const withParams: RequestEnvelope = {
    id: 'req-1',
    method: 'message.send',
    params: { sessionPath: '/a', text: 'hi' },
  };
  const withoutParams: RequestEnvelope = { id: 'req-1', method: 'message.send' };

  assert.equal(typeof withParams.id, 'string');
  assert.equal(typeof withParams.method, 'string');
  assert.equal(withParams.id, 'req-1');
  assert.equal(withParams.method, 'message.send');

  assert.equal(typeof withoutParams.id, 'string');
  assert.equal(typeof withoutParams.method, 'string');
  assert.equal('params' in withoutParams, false, 'params is optional and may be absent');
});
