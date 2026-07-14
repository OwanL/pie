import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findMatchingRequest, selectFixedPromptRequest } from '../../../src/webview/panel/hooks/ask-user-context';
import type { ExtensionUIRequestPayload } from '../../../src/shared/protocol';

/** Helper to build a 'select' request. */
function selectReq(
  overrides: Partial<Pick<ExtensionUIRequestPayload, 'id' | 'subagentCallId' | 'toolCallId'>> & {
    id?: string;
  } = {},
): ExtensionUIRequestPayload {
  return {
    id: overrides.id ?? 'req-1',
    sessionPath: '/test-session',
    method: 'select',
    title: 'Choose',
    options: ['a', 'b'],
    ...overrides,
  };
}

/** Helper to build a 'confirm' request. */
function confirmReq(id = 'req-c'): ExtensionUIRequestPayload {
  return {
    id,
    sessionPath: '/test-session',
    method: 'confirm',
    title: 'Confirm?',
    message: 'Are you sure?',
  };
}

/** Helper to build an 'input' request. */
function inputReq(id = 'req-i'): ExtensionUIRequestPayload {
  return {
    id,
    sessionPath: '/test-session',
    method: 'input',
    title: 'Enter value',
  };
}

describe('selectFixedPromptRequest', () => {
  it('keeps a concurrent unmounted question actionable when an older sibling is mounted inline', () => {
    const pending = {
      first: selectReq({ id: 'first', subagentCallId: 'sub-1', toolCallId: 'sub-1' }),
      second: selectReq({ id: 'second', subagentCallId: 'sub-2', toolCallId: 'sub-2' }),
    };
    assert.equal(selectFixedPromptRequest(pending, { first: 1 })?.id, 'second');
    assert.equal(selectFixedPromptRequest(pending, { first: 1, second: 1 }), null);
  });

  it('prioritizes a request without an inline owner', () => {
    const pending = {
      inline: selectReq({ id: 'inline', subagentCallId: 'sub-1' }),
      fixed: selectReq({ id: 'fixed' }),
    };
    assert.equal(selectFixedPromptRequest(pending, {})?.id, 'fixed');
  });
});

describe('findMatchingRequest', () => {
  it('matches first select request without subagentCallId when subagentCallId is undefined (main agent)', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1' }),
      'req-2': selectReq({ id: 'req-2', subagentCallId: 'call_abc' }),
    };
    const result = findMatchingRequest(pending, undefined);
    assert.ok(result);
    assert.equal(result.id, 'req-1');
    assert.equal(result.subagentCallId, undefined);
  });

  it('matches subagent exact subagentCallId', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1' }),
      'req-2': selectReq({ id: 'req-2', subagentCallId: 'call_abc' }),
    };
    const result = findMatchingRequest(pending, 'call_abc');
    assert.ok(result);
    assert.equal(result.id, 'req-2');
    assert.equal(result.subagentCallId, 'call_abc');
  });

  it('matches parallel subagent prefix-style subagentCallId', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1', subagentCallId: 'call_abc:0' }),
    };
    const result = findMatchingRequest(pending, 'call_abc:0');
    assert.ok(result);
    assert.equal(result.id, 'req-1');
    assert.equal(result.subagentCallId, 'call_abc:0');
  });

  it('returns null when no request has matching subagentCallId', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1', subagentCallId: 'call_other' }),
    };
    const result = findMatchingRequest(pending, 'call_abc');
    assert.equal(result, null);
  });

  it('matches confirm request for main-agent context', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-c': confirmReq(),
      'req-s': selectReq({ id: 'req-s', subagentCallId: 'call_abc' }),
    };
    const result = findMatchingRequest(pending, undefined);
    assert.ok(result);
    assert.equal(result!.method, 'confirm');
    assert.equal(result!.id, 'req-c');
  });

  it('matches input request for subagent context', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-i': inputReq(),
      'req-sub': {
        ...inputReq('req-sub'),
        subagentCallId: 'call_abc',
      },
    };
    const result = findMatchingRequest(pending, 'call_abc');
    assert.ok(result);
    assert.equal(result!.method, 'input');
    assert.equal(result!.id, 'req-sub');
  });

  it('returns null when pending requests is empty', () => {
    const result = findMatchingRequest({}, undefined);
    assert.equal(result, null);
  });

  it('matches main-agent request by toolCallId', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1', toolCallId: 'call_abc' }),
      'req-2': selectReq({ id: 'req-2', toolCallId: 'call_def' }),
    };
    const result = findMatchingRequest(pending, 'call_def');
    assert.ok(result);
    assert.equal(result.id, 'req-2');
    assert.equal(result.toolCallId, 'call_def');
    assert.equal(result.subagentCallId, undefined);
  });

  it('matches subagent request by toolCallId when subagentCallId is also present', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1', toolCallId: 'call_abc', subagentCallId: 'call_xyz' }),
    };
    const resultByToolCallId = findMatchingRequest(pending, 'call_abc');
    assert.equal(resultByToolCallId?.id, 'req-1');
    const resultBySubagentCallId = findMatchingRequest(pending, 'call_xyz');
    assert.equal(resultBySubagentCallId?.id, 'req-1');
  });

  it('does not return a toolCallId-owned request when callerId is undefined (legacy main agent)', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1', toolCallId: 'call_abc' }),
      'req-2': selectReq({ id: 'req-2' }),
    };
    const result = findMatchingRequest(pending, undefined);
    assert.ok(result);
    assert.equal(result.id, 'req-2');
  });

  it('returns the first matching request when multiple legacy main-agent candidates exist', () => {
    // Object.values order: insertion order for string keys in modern JS engines
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-a': selectReq({ id: 'req-a' }),
      'req-b': selectReq({ id: 'req-b' }),
    };
    const result = findMatchingRequest(pending, undefined);
    assert.ok(result);
    assert.equal(result!.id, 'req-a');
  });
});
