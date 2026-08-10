import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateLoadTranscriptPage,
  validateMessageSend,
  validateRuntimePrefsSet,
  validateSessionCreate,
  validateSessionOpen,
  validateSettingsSet,
} from '../../../src/backend/rpc';
import { THINKING_LEVELS } from '../../../src/shared/thinking-level';

test('validateMessageSend requires an explicit sessionPath', () => {
  assert.throws(
    () => validateMessageSend({ text: 'hello' }),
    /sessionPath/,
  );
});

test('validateMessageSend accepts image-only sends with structured inputs', () => {
  assert.deepEqual(
    validateMessageSend({
      sessionPath: '/workspace/session.jsonl',
      text: '',
      inputs: [{
        id: 'input-1',
        kind: 'imageBlob',
        mimeType: 'image/png',
        name: 'diagram.png',
        sizeBytes: 1024,
        dataBase64: 'ZmFrZQ==',
        source: 'paste',
      }],
    }),
    {
      sessionPath: '/workspace/session.jsonl',
      text: '',
      localId: undefined,
      inputs: [{
        id: 'input-1',
        kind: 'imageBlob',
        mimeType: 'image/png',
        name: 'diagram.png',
        sizeBytes: 1024,
        dataBase64: 'ZmFrZQ==',
        source: 'paste',
        width: undefined,
        height: undefined,
      }],
    },
  );
});

test('validateMessageSend rejects empty text when there are no inputs', () => {
  assert.throws(
    () => validateMessageSend({ sessionPath: '/workspace/session.jsonl', text: '   ', inputs: [] }),
    /non-empty text or at least one input/,
  );
});

test('validateMessageSend rejects unsupported fileBlob inputs', () => {
  assert.throws(
    () => validateMessageSend({
      sessionPath: '/workspace/session.jsonl',
      text: '',
      inputs: [{
        id: 'input-1',
        kind: 'fileBlob',
        mimeType: 'application/pdf',
        name: 'spec.pdf',
        sizeBytes: 2048,
        dataBase64: 'ZmFrZQ==',
        source: 'drop',
      }],
    }),
    /not supported yet/,
  );
});

test('validateSessionCreate accepts an optional selection token', () => {
  assert.deepEqual(
    validateSessionCreate({ cwd: '/workspace', selectionToken: 'selection:1' }),
    { cwd: '/workspace', selectionToken: 'selection:1' },
  );
});

test('validateSessionOpen accepts an optional selection token', () => {
  assert.deepEqual(
    validateSessionOpen({ sessionPath: '/workspace/session.jsonl', selectionToken: 'selection:2' }),
    { sessionPath: '/workspace/session.jsonl', selectionToken: 'selection:2', transcript: undefined },
  );
});

test('validateSessionOpen accepts an optional transcript mode', () => {
  assert.equal(
    validateSessionOpen({ sessionPath: '/s.jsonl', transcript: 'skip' }).transcript,
    'skip',
  );
  assert.equal(
    validateSessionOpen({ sessionPath: '/s.jsonl', transcript: 'tail' }).transcript,
    'tail',
  );
  assert.throws(
    () => validateSessionOpen({ sessionPath: '/s.jsonl', transcript: 'bogus' }),
    /transcript must be 'tail' or 'skip'/,
  );
});

test('validateLoadTranscriptPage accepts direction and loaded range', () => {
  assert.deepEqual(
    validateLoadTranscriptPage({
      sessionPath: '/workspace/session.jsonl',
      direction: 'older',
      loadedStart: 40,
      loadedEnd: 120,
    }),
    {
      sessionPath: '/workspace/session.jsonl',
      direction: 'older',
      loadedStart: 40,
      loadedEnd: 120,
    },
  );
});

test('validateLoadTranscriptPage rejects invalid direction values', () => {
  assert.throws(
    () => validateLoadTranscriptPage({ sessionPath: '/workspace/session.jsonl', direction: 'backward' }),
    /direction must be one of older, newer, latest/,
  );
});

test('validateSettingsSet accepts an optional sessionPath', () => {
  assert.deepEqual(
    validateSettingsSet({
      sessionPath: '/workspace/session.jsonl',
      defaultModel: 'claude-sonnet-4-5',
      defaultThinkingLevel: 'high',
    }),
    {
      sessionPath: '/workspace/session.jsonl',
      defaultModel: 'claude-sonnet-4-5',
      defaultThinkingLevel: 'high',
    },
  );
});

test('validateRuntimePrefsSet accepts provider and extension toggles', () => {
  assert.deepEqual(
    validateRuntimePrefsSet({
      providerToggles: {
        ollama: false,
        'github-copilot': true,
      },
      extensionToggles: {
        'skill-pruner': false,
      },
    }),
    {
      providerToggles: {
        ollama: false,
        'github-copilot': true,
      },
      extensionToggles: {
        'skill-pruner': false,
      },
      autonomousMode: undefined,
      subagentAlwaysParentModel: undefined,
      subagentRouteAroundSaturatedProviders: undefined,
      subagentFallbackOnProviderFailure: undefined,
      subagentMaxDepth: undefined,
      subagentMaxTreeSessions: undefined,
      subagentMaxInflight: undefined,
      bashWarmPoolSize: undefined,
      bashFastPath: undefined,
      bashShellPath: undefined,
      bashWarmupTimeoutMs: undefined,
      bashDefaultTimeout: undefined,
      subagentBuckets: undefined,
      subagentNestedAllowedBuckets: undefined,
      subagentDropTools: undefined,
      providerConcurrency: undefined,
    },
  );
});

test('validateRuntimePrefsSet defaults missing toggle maps to empty', () => {
  assert.deepEqual(validateRuntimePrefsSet({}), { providerToggles: {}, extensionToggles: {}, autonomousMode: undefined, subagentAlwaysParentModel: undefined, subagentRouteAroundSaturatedProviders: undefined, subagentFallbackOnProviderFailure: undefined, subagentMaxDepth: undefined, subagentMaxTreeSessions: undefined, subagentMaxInflight: undefined, bashWarmPoolSize: undefined, bashFastPath: undefined, bashShellPath: undefined, bashWarmupTimeoutMs: undefined, bashDefaultTimeout: undefined, subagentBuckets: undefined, subagentNestedAllowedBuckets: undefined, subagentDropTools: undefined, providerConcurrency: undefined });
});

test('validateRuntimePrefsSet accepts all seven exact subagent thinking levels', () => {
  assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const assignments = THINKING_LEVELS.map((thinkingLevel, index) => ({
    model: `provider/model-${index}`,
    thinkingLevel,
  }));
  const result = validateRuntimePrefsSet({ subagentBuckets: { small: assignments } });
  assert.deepEqual(result.subagentBuckets, { small: assignments, medium: [], frontier: [] });
});

test('validateRuntimePrefsSet allows partial subagentBuckets and drops missing keys to empty', () => {
  assert.deepEqual(
    validateRuntimePrefsSet({ subagentBuckets: { medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }] } }),
    {
      providerToggles: {},
      extensionToggles: {},
      autonomousMode: undefined,
      subagentAlwaysParentModel: undefined,
      subagentRouteAroundSaturatedProviders: undefined,
      subagentFallbackOnProviderFailure: undefined,
      subagentMaxDepth: undefined,
      subagentMaxTreeSessions: undefined,
      subagentMaxInflight: undefined,
      bashWarmPoolSize: undefined,
      bashFastPath: undefined,
      bashShellPath: undefined,
      bashWarmupTimeoutMs: undefined,
      bashDefaultTimeout: undefined,
      subagentBuckets: {
        small: [],
        medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }],
        frontier: [],
      },
      subagentNestedAllowedBuckets: undefined,
      subagentDropTools: undefined,
      providerConcurrency: undefined,
    },
  );
});

test('validateRuntimePrefsSet rejects string-only bucket entries', () => {
  assert.throws(
    () => validateRuntimePrefsSet({ subagentBuckets: { small: ['provider/model'] } }),
    /subagentBuckets\.small entries must be objects with model and thinkingLevel/,
  );
});

test('validateRuntimePrefsSet rejects non-object subagentBuckets', () => {
  assert.throws(
    () => validateRuntimePrefsSet({ subagentBuckets: 'nope' }),
    /subagentBuckets must be an object/,
  );
});

test('validateRuntimePrefsSet accepts a subagentNestedAllowedBuckets patch', () => {
  assert.deepEqual(
    validateRuntimePrefsSet({
      subagentNestedAllowedBuckets: { small: true, medium: false, frontier: false },
    }),
    {
      providerToggles: {},
      extensionToggles: {},
      autonomousMode: undefined,
      subagentAlwaysParentModel: undefined,
      subagentRouteAroundSaturatedProviders: undefined,
      subagentFallbackOnProviderFailure: undefined,
      subagentMaxDepth: undefined,
      subagentMaxTreeSessions: undefined,
      subagentMaxInflight: undefined,
      bashWarmPoolSize: undefined,
      bashFastPath: undefined,
      bashShellPath: undefined,
      bashWarmupTimeoutMs: undefined,
      bashDefaultTimeout: undefined,
      subagentBuckets: undefined,
      subagentNestedAllowedBuckets: { small: true, medium: false, frontier: false },
      subagentDropTools: undefined,
      providerConcurrency: undefined,
    },
  );
});

test('validateRuntimePrefsSet allows partial subagentNestedAllowedBuckets and defaults missing keys to true', () => {
  assert.deepEqual(
    validateRuntimePrefsSet({ subagentNestedAllowedBuckets: { frontier: false } }),
    {
      providerToggles: {},
      extensionToggles: {},
      autonomousMode: undefined,
      subagentAlwaysParentModel: undefined,
      subagentRouteAroundSaturatedProviders: undefined,
      subagentFallbackOnProviderFailure: undefined,
      subagentMaxDepth: undefined,
      subagentMaxTreeSessions: undefined,
      subagentMaxInflight: undefined,
      bashWarmPoolSize: undefined,
      bashFastPath: undefined,
      bashShellPath: undefined,
      bashWarmupTimeoutMs: undefined,
      bashDefaultTimeout: undefined,
      subagentBuckets: undefined,
      subagentNestedAllowedBuckets: { small: true, medium: true, frontier: false },
      subagentDropTools: undefined,
      providerConcurrency: undefined,
    },
  );
});

test('validateRuntimePrefsSet rejects non-boolean values in subagentNestedAllowedBuckets', () => {
  assert.throws(
    () => validateRuntimePrefsSet({ subagentNestedAllowedBuckets: { frontier: 'no' } }),
    /subagentNestedAllowedBuckets\.frontier must be a boolean/,
  );
});

test('validateRuntimePrefsSet rejects non-object subagentNestedAllowedBuckets', () => {
  assert.throws(
    () => validateRuntimePrefsSet({ subagentNestedAllowedBuckets: 'nope' }),
    /subagentNestedAllowedBuckets must be an object/,
  );
});

test('validateRuntimePrefsSet accepts a subagentDropTools string array', () => {
  assert.deepEqual(
    validateRuntimePrefsSet({ subagentDropTools: ['ask_user', 'web_search'] }),
    {
      providerToggles: {},
      extensionToggles: {},
      autonomousMode: undefined,
      subagentAlwaysParentModel: undefined,
      subagentRouteAroundSaturatedProviders: undefined,
      subagentFallbackOnProviderFailure: undefined,
      subagentMaxDepth: undefined,
      subagentMaxTreeSessions: undefined,
      subagentMaxInflight: undefined,
      bashWarmPoolSize: undefined,
      bashFastPath: undefined,
      bashShellPath: undefined,
      bashWarmupTimeoutMs: undefined,
      bashDefaultTimeout: undefined,
      subagentBuckets: undefined,
      subagentNestedAllowedBuckets: undefined,
      subagentDropTools: ['ask_user', 'web_search'],
      providerConcurrency: undefined,
    },
  );
});

test('validateRuntimePrefsSet rejects non-string entries in subagentDropTools', () => {
  assert.throws(
    () => validateRuntimePrefsSet({ subagentDropTools: ['ok', 5] }),
    /subagentDropTools must be an array of strings/,
  );
});

test('validateRuntimePrefsSet rejects non-array subagentDropTools', () => {
  assert.throws(
    () => validateRuntimePrefsSet({ subagentDropTools: 'nope' }),
    /subagentDropTools must be an array of strings/,
  );
});

test('validateRuntimePrefsSet rejects non-boolean provider toggle values', () => {
  assert.throws(
    () => validateRuntimePrefsSet({ providerToggles: { ollama: 'off' } }),
    /providerToggles\.ollama must be a boolean/,
  );
});

test('validateRuntimePrefsSet rejects non-boolean extension toggle values', () => {
  assert.throws(
    () => validateRuntimePrefsSet({ extensionToggles: { 'skill-pruner': 'off' } }),
    /extensionToggles\['?skill-pruner'?\] must be a boolean/,
  );
});
