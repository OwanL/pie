import assert from 'node:assert/strict';
import test from 'node:test';

import { decidePromptSafetyTimerAction } from '../../../src/backend/request-handler';
import type { ProviderGateMetrics } from '../../../src/backend/provider-gate';

const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const CEILING = 2 * PROMPT_TIMEOUT_MS;

function metric(overrides: Partial<ProviderGateMetrics> = {}): ProviderGateMetrics {
  return {
    provider: 'openai',
    activeRequests: 0,
    queuedRequests: 0,
    maxConcurrentRequests: 2,
    afterburnSeconds: 0,
    paused: false,
    pausedUntilMs: 0,
    strikeCount: 0,
    ...overrides,
  };
}

test('decidePromptSafetyTimerAction DEFERS when the provider is saturated (queuedRequests>0) and elapsed < ceiling', () => {
  const decision = decidePromptSafetyTimerAction({
    elapsed: 5_000,
    ceiling: CEILING,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    provider: 'openai',
    metrics: [metric({ queuedRequests: 1 })],
  });
  assert.equal(decision.action, 'defer');
  assert.equal(decision.reason, '');
});

test('decidePromptSafetyTimerAction DEFERS when the provider is paused (circuit breaker) and elapsed < ceiling', () => {
  const decision = decidePromptSafetyTimerAction({
    elapsed: 5_000,
    ceiling: CEILING,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    provider: 'openai',
    metrics: [metric({ paused: true, pausedUntilMs: Date.now() + 60_000 })],
  });
  assert.equal(decision.action, 'defer');
  assert.equal(decision.reason, '');
});

test('decidePromptSafetyTimerAction FIRES when the provider has a free slot (not queued, not paused) — genuinely stuck', () => {
  const decision = decidePromptSafetyTimerAction({
    elapsed: 5_000,
    ceiling: CEILING,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    provider: 'openai',
    metrics: [metric({ queuedRequests: 0, paused: false })],
  });
  assert.equal(decision.action, 'fire');
  // Not saturated → the generic (non-ceiling) reason.
  assert.match(decision.reason, /Prompt timed out after \d+ms without reaching a commit point/);
  assert.ok(!/hard ceiling/.test(decision.reason));
});

test('decidePromptSafetyTimerAction FAIL-OPEN: fires when metrics are absent (accessor null — never hangs on a missing gate)', () => {
  const decision = decidePromptSafetyTimerAction({
    elapsed: 5_000,
    ceiling: CEILING,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    provider: 'openai',
    metrics: undefined,
  });
  assert.equal(decision.action, 'fire');
  assert.match(decision.reason, /without reaching a commit point/);
});

test('decidePromptSafetyTimerAction FAIL-OPEN: fires when the provider is undefined (unresolvable)', () => {
  const decision = decidePromptSafetyTimerAction({
    elapsed: 5_000,
    ceiling: CEILING,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    provider: undefined,
    metrics: [metric({ queuedRequests: 9, paused: true })],
  });
  assert.equal(decision.action, 'fire');
});

test('decidePromptSafetyTimerAction FAIL-OPEN: fires when no matching provider is present in the metrics', () => {
  const decision = decidePromptSafetyTimerAction({
    elapsed: 5_000,
    ceiling: CEILING,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    provider: 'anthropic',
    metrics: [metric({ provider: 'openai', queuedRequests: 9, paused: true })],
  });
  assert.equal(decision.action, 'fire');
});

test('decidePromptSafetyTimerAction FIRES past the hard ceiling even when the provider is still saturated (genuinely-stuck backstop)', () => {
  const decision = decidePromptSafetyTimerAction({
    elapsed: CEILING + 1,
    ceiling: CEILING,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    provider: 'openai',
    metrics: [metric({ queuedRequests: 1 })],
  });
  assert.equal(decision.action, 'fire');
  // Saturated but past ceiling → the hard-ceiling reason blaming the provider.
  assert.match(decision.reason, /hard ceiling/);
  assert.match(decision.reason, /openai/);
  assert.match(decision.reason, /saturated/);
});

test('decidePromptSafetyTimerAction FIRES past the hard ceiling with the paused reason when the provider is paused', () => {
  const decision = decidePromptSafetyTimerAction({
    elapsed: CEILING + 1,
    ceiling: CEILING,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    provider: 'openai',
    metrics: [metric({ paused: true, pausedUntilMs: Date.now() + 60_000 })],
  });
  assert.equal(decision.action, 'fire');
  assert.match(decision.reason, /hard ceiling/);
  assert.match(decision.reason, /paused/);
});

test('decidePromptSafetyTimerAction uses the injected promptTimeoutMs in the generic fire reason', () => {
  const decision = decidePromptSafetyTimerAction({
    elapsed: 1_000,
    ceiling: CEILING,
    promptTimeoutMs: 42_000,
    provider: 'openai',
    metrics: [metric({ queuedRequests: 0 })],
  });
  assert.equal(decision.action, 'fire');
  assert.match(decision.reason, /42000ms/);
});
