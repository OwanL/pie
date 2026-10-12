import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerConfigRevision } from '../../catalog/provider-config';
import { isProviderManagementRequest as request, isProviderManagementSnapshot as snapshot } from '../validation';
const draft = { originalId: null, id: 'local', enabled: false, api: 'openai-completions', baseUrl: '', credentialSource: 'default', environmentName: '', models: [] };
const state = { revision: 0, configRevision: null, loaded: false, providers: [], definitions: [], protocols: [] };
const producerRevision = providerConfigRevision('version: 1\nproviders: {}\n');
test('request ingress fails closed on unknown fields and illegal inputs', () => {
  for (const value of [null, [], {}, { type: 'unknown', operationId: 'op' }, { type: 'read', operationId: '' }, { type: 'read', operationId: 'op', token: 'secret' }]) assert.equal(request(value), false);
  const save = { type: 'save', operationId: 'op', expectedRevision: null, draft };
  assert.equal(request(save), true);
  for (const change of [{ expectedRevision: 'bad' }, { draft: { ...draft, apiKey: 'secret' } }, { draft: { ...draft, enabled: 1 } }, { draft: { ...draft, credentialSource: 'token' } }, { draft: { ...draft, models: [{ id: 'm', name: 'm', visible: 'unset', subagentEligible: 'unset', pricing: { kind: 'known', tiered: false, input: Infinity } }] } }]) assert.equal(request({ ...save, ...change }), false);
});
test('provider-config producer revisions are accepted in snapshots and private save/connect ingress', () => {
  assert.match(producerRevision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot({ ...state, configRevision: producerRevision }), true);
  assert.equal(snapshot(state), true);
  const save = { type: 'save', operationId: 'op', expectedRevision: producerRevision, draft };
  const connect = { type: 'connect', operationId: 'op', expectedRevision: producerRevision, draft, method: 'local' };
  for (const validRevision of [producerRevision, null]) {
    assert.equal(request({ ...save, expectedRevision: validRevision }), true);
    assert.equal(request({ ...connect, expectedRevision: validRevision }), true);
    assert.equal(snapshot({ ...state, configRevision: validRevision }), true);
  }
  for (const invalidRevision of [producerRevision.slice('sha256:'.length), 'sha512:' + 'a'.repeat(64), 'sha256:' + 'a'.repeat(63), 'sha256:' + 'A'.repeat(64)]) {
    assert.equal(request({ ...save, expectedRevision: invalidRevision }), false);
    assert.equal(request({ ...connect, expectedRevision: invalidRevision }), false);
    assert.equal(snapshot({ ...state, configRevision: invalidRevision }), false);
  }
});
test('credentials are accepted only in bounded private request fields', () => {
  const connect = { type: 'connect', operationId: 'op', expectedRevision: null, draft, method: 'api-key' };
  assert.equal(request(connect), true);
  assert.equal(request({ ...connect, apiKey: 'x'.repeat(32768) }), true);
  assert.equal(request({ ...connect, apiKey: 'x'.repeat(32769) }), false);
  assert.equal(request({ ...connect, method: 'oauth', apiKey: 'secret' }), false);
  assert.equal(request({ ...connect, token: 'secret' }), false);
  const response = { type: 'auth-response', operationId: 'op', targetOperationId: 'target', promptId: 'prompt', value: 'secret' };
  assert.equal(request(response), true);
  assert.equal(request({ ...response, value: 'x'.repeat(32769) }), false);
});
test('snapshot mutation and optional callback metadata match core contracts', () => {
  assert.equal(snapshot(state), true);
  assert.equal(snapshot({ ...state, mutation: { operationId: 'op', phase: 'saving' } }), true);
  for (const auth of [{ kind: 'browser', operationId: 'op', url: 'https://example.invalid' }, { kind: 'input', operationId: 'op', promptId: 'p', message: 'Code' }, { kind: 'input', operationId: 'op', promptId: 'p', message: 'Code', placeholder: '', allowEmpty: false }]) assert.equal(snapshot({ ...state, auth }), true);
  for (const change of [{ apiKey: 'secret' }, { credentials: { token: 'secret' } }, { mutation: { operationId: 'op', phase: 'done' } }, { auth: { kind: 'browser', operationId: 'op', url: '', token: 'secret' } }, { auth: { kind: 'input', operationId: 'op', promptId: 'p', message: '', allowEmpty: 'yes' } }]) assert.equal(snapshot({ ...state, ...change }), false);
});
