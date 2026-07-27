import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProviderHttpIncident,
  classifyProviderTransportIncident,
  providerIncidentCode,
} from '../../../src/backend/provider-incident';

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
  assert.equal(incident.retryAfterMs, 2_000);
  assert.match(incident.userMessage, /rate-limited this request \(HTTP 429\)/);
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
