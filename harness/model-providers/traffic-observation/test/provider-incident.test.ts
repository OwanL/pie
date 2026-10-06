import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProviderHttpIncident,
  classifyProviderTransportIncident,
  providerIncidentCode,
  observeProviderIncidents,
  publishProviderIncident,
} from '../provider-incident.js';

test('classifies Copilot quota 429 with the provider reset instead of a generic connection error', () => {
  const occurredAt = Date.parse('2026-07-27T21:58:12.000Z');
  const incident = classifyProviderHttpIncident({
    sessionId: 'session-1',
    requestId: 'request-1',
    providerHost: 'api.business.githubcopilot.com',
    status: 429,
    headers: new Headers({
      'retry-after': '352908',
      'x-ratelimit-exceeded': 'quota_exceeded',
      'x-ratelimit-quota-exceeded-retry-after': '352908',
    }),
    body: 'quota exceeded\n',
    occurredAt,
  });

  assert.equal(incident.kind, 'quota_exhausted');
  assert.equal(providerIncidentCode(incident.kind), 'PROVIDER_QUOTA_EXHAUSTED');
  assert.equal(incident.retryAfterMs, 352_908_000);
  assert.equal(new Date(incident.retryAt!).toISOString(), '2026-08-01T00:00:00.000Z');
  assert.match(incident.userMessage, /GitHub Copilot quota is exhausted/);
  assert.match(incident.userMessage, /2026-08-01T00:00:00\.000Z/);
  assert.match(incident.detail, /response=quota exceeded/);
});

test('distinguishes a transient HTTP 429 from exhausted quota', () => {
  const incident = classifyProviderHttpIncident({
    sessionId: 'session-1',
    providerHost: 'api.openai.com',
    status: 429,
    headers: new Headers({ 'retry-after': '2' }),
    body: '{"error":{"message":"rate limit reached"}}',
    occurredAt: 1_000,
  });

  assert.equal(incident.kind, 'rate_limited');
  assert.equal(providerIncidentCode(incident.kind), 'PROVIDER_RATE_LIMITED');
  assert.equal(incident.retryAfterMs, 2_000);
  assert.match(incident.userMessage, /rate-limited this request \(HTTP 429\)/);
});

test('incident publication ignores unaddressed incidents and isolates failing observers until unsubscribe', () => {
  const incident = classifyProviderHttpIncident({
    sessionId: 'session-1', providerHost: 'api.anthropic.com', status: 503, headers: new Headers(),
  });
  const received: unknown[] = [];
  const unsubscribeFailure = observeProviderIncidents(() => { throw new Error('observer failed'); });
  const unsubscribe = observeProviderIncidents((value) => received.push(value));
  try {
    publishProviderIncident({ ...incident, sessionId: '' });
    assert.deepEqual(received, []);
    assert.doesNotThrow(() => publishProviderIncident(incident));
    assert.deepEqual(received, [incident]);
    unsubscribe();
    publishProviderIncident(incident);
    assert.deepEqual(received, [incident]);
  } finally {
    unsubscribe();
    unsubscribeFailure();
  }
});

test('ordinary HTTP errors retain correlation and bounded diagnostics without inventing retry metadata', () => {
  const incident = classifyProviderHttpIncident({
    sessionId: 'session-1', requestId: 'request-2', providerHost: 'api.anthropic.com',
    status: 503, headers: new Headers({ 'retry-after': 'invalid' }),
    body: `  unavailable\n ${'x'.repeat(3_000)}`, occurredAt: 1_000,
  });
  assert.equal(incident.kind, 'http_error');
  assert.equal(providerIncidentCode(incident.kind), 'PROVIDER_HTTP_ERROR');
  assert.equal(incident.requestId, 'request-2');
  assert.equal(incident.userMessage, 'Anthropic rejected this request (HTTP 503).');
  assert.equal('retryAt' in incident, false);
  assert.equal('retryAfterMs' in incident, false);
  assert.equal(incident.detail.split('response=')[1].length, 2_048);
  assert.match(incident.detail, /response=unavailable x/);
});

test('non-timeout transport failures preserve request identity and provider fallback', () => {
  const incident = classifyProviderTransportIncident({
    sessionId: 'session-1', requestId: 'request-3', providerHost: '',
    error: new Error('connection reset'), occurredAt: 1_000,
  });
  assert.equal(incident.kind, 'transport_error');
  assert.equal(providerIncidentCode(incident.kind), 'PROVIDER_TRANSPORT_ERROR');
  assert.equal(incident.requestId, 'request-3');
  assert.equal(incident.occurredAt, 1_000);
  assert.equal(incident.userMessage, 'The provider connection failed before a response was received.');
  assert.equal(incident.detail, 'provider=; error=connection reset');
});

test('surfaces header stalls as provider timeouts', () => {
  const error = Object.assign(
    new Error('No response headers within 30000ms'),
    { name: 'ProviderGateHeaderTimeoutError' },
  );
  const incident = classifyProviderTransportIncident({
    sessionId: 'session-1',
    providerHost: 'api.code.umans.ai',
    error,
    occurredAt: 1_000,
  });

  assert.equal(incident.kind, 'transport_timeout');
  assert.equal(providerIncidentCode(incident.kind), 'PROVIDER_TRANSPORT_TIMEOUT');
  assert.match(incident.userMessage, /Umans did not return response headers/);
});
