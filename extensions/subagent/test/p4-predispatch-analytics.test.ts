import test from 'node:test';
import assert from 'node:assert/strict';

import { executeSingleTask } from '../src/single.js';
import { registerSubagentAnalyticsProviderHook } from '../src/analytics-provider-hook.js';
import {
  bindSubagentAnalyticsAttemptState,
  captureSubagentTerminalResult,
  readSubagentAnalyticsAttemptState,
} from '../src/analytics-capture.js';
import { subagentRuntime } from '../runner.js';
import type { AgentConfig } from '../agents.js';
import type { SelectionContext } from '../src/selection.js';
import type { AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import { createAnalyticsFactPacket } from '../../../shared/analytics/transport.js';
import type { SingleResult, SubagentDetails } from '../types.js';

function agent(): AgentConfig {
  return {
    name: 'scout',
    description: 'test',
    systemPrompt: '',
    source: 'user',
    filePath: 'scout.md',
    bucket: 'medium',
  };
}

function selection(models = [
  { provider: 'provider-a', id: 'model-a', input: ['text'] },
]): SelectionContext {
  return {
    modelConfig: [],
    disabledProviders: new Set(),
    allowedModelIds: undefined,
    bucketAssignments: {
      small: [],
      medium: models.map((model) => ({ model: model.id, thinkingLevel: 'high' as const })),
      frontier: [],
    },
    alwaysParentModel: false,
    nestedAllowedBuckets: { small: true, medium: true, frontier: true },
    registryModels: models,
    fallbackOnProviderFailure: true,
  };
}

function context(models = [
  { provider: 'provider-a', id: 'model-a', input: ['text'] },
]) {
  return {
    cwd: process.cwd(),
    model: { provider: 'parent', id: 'parent-model' },
    modelRegistry: {
      getAvailable: () => models,
      getAll: () => models,
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  };
}

function details(results: SingleResult[]): SubagentDetails {
  return { mode: 'single', agentScope: 'user', projectAgentsDir: null, results };
}

function result(options: {
  attemptId: string;
  exitCode?: number;
  stopReason?: SingleResult['stopReason'];
  provider?: string;
  model?: string;
  providerInvocations?: SingleResult['providerInvocations'];
  retryable?: boolean;
  failureClass?: SingleResult['failureClass'];
  replaySafety?: SingleResult['replaySafety'];
}): SingleResult {
  return {
    agent: 'scout',
    agentSource: 'user',
    task: 'capture',
    exitCode: options.exitCode ?? 0,
    messages: [],
    stderr: options.exitCode ? 'failed' : '',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 2, turns: 1 },
    startedAt: 100,
    completedAt: 200,
    attemptId: options.attemptId,
    stopReason: options.stopReason ?? 'completed',
    provider: options.provider,
    model: options.model,
    providerInvocations: options.providerInvocations,
    retryable: options.retryable,
    failureClass: options.failureClass,
    replaySafety: options.replaySafety,
  };
}

function analytics(facts: AnalyticsObservation[], detailsOut: unknown[] = []) {
  return {
    generationId: 'generation-predispatch',
    captureSubject: { kind: 'session' as const, rootSessionId: 'root-predispatch' },
    workspaceId: 'workspace-predispatch',
    sink: { submitDetail: (capture: unknown) => { detailsOut.push(capture); } },
    factSink: { submit: (observation: AnalyticsObservation) => { facts.push(observation); } },
    resolveParentToolEntityId: (toolCallId: string) => `canonical:${toolCallId}`,
  };
}

async function execute(options: {
  facts: AnalyticsObservation[];
  detailsOut?: unknown[];
  toolCallId: string;
  selection?: SelectionContext;
  models?: Array<{ provider: string; id: string; input: string[] }>;
  factSubmit?: (observation: AnalyticsObservation) => void | Promise<void>;
  runAttempt: NonNullable<NonNullable<Parameters<typeof executeSingleTask>[0]['_internal']>['runAttempt']>;
}) {
  const capture = analytics(options.facts, options.detailsOut);
  if (options.factSubmit) capture.factSink.submit = options.factSubmit;
  return executeSingleTask({
    params: { agent: 'scout', task: 'capture', bucket: 'medium' },
    ctx: context(options.models as never),
    agents: [agent()],
    runtimeCtx: { depth: 0, trail: [], budget: { sessions: 0 }, analyticsCapture: capture },
    makeDetails: details,
    onUpdate: () => undefined,
    signal: new AbortController().signal,
    selectionCtx: options.selection ?? selection(options.models as never),
    toolCallId: options.toolCallId,
    parentUiBridge: undefined,
    parentSessionId: 'root-predispatch',
    allToolNames: undefined,
    _internal: { runAttempt: options.runAttempt },
  });
}

test('one attempt observes every provider request before terminal settlements without waiting', async () => {
  const facts: AnalyticsObservation[] = [];
  const detailsOut: unknown[] = [];
  const neverSettles = new Promise<void>(() => undefined);
  let returned = false;
  const response = await execute({
    facts,
    detailsOut,
    toolCallId: 'tool-multi-turn',
    factSubmit: (observation) => {
      facts.push(observation);
      return neverSettles;
    },
    runAttempt: async (_resolved, attemptId, _onUpdate, onProviderDispatch) => {
      assert.ok(onProviderDispatch);
      onProviderDispatch({ provider: 'provider-a', model: 'model-a', thinkingLevel: 'high', observedAtMs: 110 });
      onProviderDispatch({ provider: 'provider-a', model: 'model-a', thinkingLevel: 'high', observedAtMs: 150 });
      returned = true;
      return result({
        attemptId,
        provider: 'provider-a',
        model: 'model-a',
        providerInvocations: [
          { invocationId: `${attemptId}:provider:1`, attemptId, provider: 'provider-a', model: 'model-a', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 }, startedAt: 110, completedAt: 140, outcome: 'success' },
          { invocationId: `${attemptId}:provider:2`, attemptId, provider: 'provider-a', model: 'model-a', usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.02 }, startedAt: 150, completedAt: 190, outcome: 'success' },
        ],
      });
    },
  });

  assert.equal(returned, true, 'an unresolved sink promise never gates the attempt');
  assert.equal(detailsOut.length, 1);
  assert.deepEqual(facts.map((fact) => fact.sourceSequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(facts.map((fact) => fact.observationKind), [
    'begin', 'begin', 'begin', 'providerSettlement', 'providerSettlement', 'end',
  ]);
  const providerFacts = facts.filter((fact) => fact.entityKind === 'providerCall');
  assert.equal(new Set(providerFacts.map((fact) => fact.entityKey)).size, 2);
  assert.ok(providerFacts.every((fact) => fact.scope.parentToolCallId === 'canonical:tool-multi-turn'));
  const terminal = response.details.results[0]!;
  assert.deepEqual(terminal.analyticsCaptureReceipt?.predispatch, {
    factStatus: 'submitted',
    providerRequestCount: 2,
    providerRequestIds: [
      `${terminal.attemptId}:provider:1`,
      `${terminal.attemptId}:provider:2`,
    ],
    lastSubmittedSequence: 3,
    internalRetryCoverage: 'unknown',
  });
  assert.equal(terminal.analyticsCaptureReceipt?.lastSubmittedSequence, 6);
  assert.notEqual((facts.at(-1)!.fields as { captureIncomplete?: boolean }).captureIncomplete, true);

  const replayFacts: AnalyticsObservation[] = [];
  assert.equal(captureSubagentTerminalResult(
    terminal,
    analytics(replayFacts),
    'tool-multi-turn',
  ), 'submitted');
  assert.deepEqual(replayFacts.map((fact) => fact.sourceSequence), [4, 5, 6]);
  assert.deepEqual(
    replayFacts.map((fact) => fact.sourceKey),
    facts.slice(3).map((fact) => fact.sourceKey),
    'terminal replay reuses settlements/end and never emits duplicate begin/dispatch facts',
  );
});

test('absent optional provider fields remain valid across the strict transport codec', async () => {
  const facts: AnalyticsObservation[] = [];
  const response = await execute({
    facts,
    toolCallId: 'tool-optional-provider-fields',
    factSubmit: (observation) => {
      createAnalyticsFactPacket(observation);
      facts.push(observation);
    },
    runAttempt: async (_resolved, attemptId, _onUpdate, onProviderDispatch) => {
      onProviderDispatch!({ observedAtMs: 110 });
      return result({
        attemptId,
        providerInvocations: [{
          invocationId: `${attemptId}:provider:1`,
          attemptId,
          startedAt: 110,
          completedAt: 140,
          outcome: 'success',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
        }],
      });
    },
  });

  assert.notEqual(response.isError, true);
  assert.deepEqual(facts.map((fact) => fact.observationKind), [
    'begin', 'begin', 'providerSettlement', 'end',
  ]);
  assert.equal(facts.some((fact) => Object.values(fact).includes(undefined)), false);
  assert.equal(facts.some((fact) => Object.values(fact.fields).includes(undefined)), false);
});

test('rejected predispatch capture never gates work or becomes a terminal submission', async () => {
  const facts: AnalyticsObservation[] = [];
  let attemptCompleted = false;
  const response = await execute({
    facts,
    toolCallId: 'tool-rejected',
    factSubmit: () => { throw new Error('Bearer should-not-survive'); },
    runAttempt: async (_resolved, attemptId, _onUpdate, onProviderDispatch) => {
      onProviderDispatch!({ provider: 'provider-a', model: 'model-a', observedAtMs: 110 });
      attemptCompleted = true;
      return result({ attemptId, provider: 'provider-a', model: 'model-a' });
    },
  });
  const terminal = response.details.results[0]!;
  assert.equal(attemptCompleted, true);
  assert.equal(facts.length, 0);
  assert.equal(terminal.analyticsCaptureStatus, 'submitted', 'rich detail remains independent');
  assert.equal(terminal.analyticsCaptureReceipt?.factStatus, 'rejected');
  assert.equal(terminal.analyticsCaptureReceipt?.predispatch?.factStatus, 'rejected');
  assert.match(terminal.analyticsCaptureError ?? '', /\[redacted\]/);
  assert.doesNotMatch(terminal.analyticsCaptureError ?? '', /should-not-survive/);
});

test('post-dispatch abort retains unknown evidence and never fabricates a settlement', async () => {
  const facts: AnalyticsObservation[] = [];
  const response = await execute({
    facts,
    toolCallId: 'tool-abort',
    runAttempt: async (_resolved, attemptId, _onUpdate, onProviderDispatch) => {
      onProviderDispatch!({ provider: 'provider-a', model: 'model-a', observedAtMs: 110 });
      return result({ attemptId, exitCode: 1, stopReason: 'aborted', provider: 'provider-a', model: 'model-a', providerInvocations: [] });
    },
  });
  assert.deepEqual(facts.map((fact) => fact.observationKind), ['begin', 'begin', 'end']);
  assert.equal(facts.some((fact) => fact.observationKind === 'providerSettlement'), false);
  const end = facts.at(-1)!;
  assert.equal((end.fields as { outcome?: string }).outcome, 'aborted');
  assert.equal((end.fields as { captureIncomplete?: boolean }).captureIncomplete, true);
  assert.equal(response.details.results[0]!.analyticsCaptureReceipt?.predispatch?.providerRequestCount, 1);
});

test('pre-dispatch cancellation records no provider request or settlement', async () => {
  const facts: AnalyticsObservation[] = [];
  const response = await execute({
    facts,
    toolCallId: 'tool-cancel-before-dispatch',
    runAttempt: async (_resolved, attemptId) => result({
      attemptId,
      exitCode: 1,
      stopReason: 'aborted',
      providerInvocations: [],
    }),
  });
  assert.deepEqual(facts.map((fact) => [fact.entityKind, fact.observationKind]), [
    ['execution', 'begin'],
    ['execution', 'end'],
  ]);
  assert.equal(response.details.results[0]!.analyticsCaptureReceipt?.predispatch, undefined);
  assert.equal((facts.at(-1)!.fields as { captureIncomplete?: boolean }).captureIncomplete, true);
});

test('provider throw after dispatch remains an explicit gap without a settlement', async () => {
  const facts: AnalyticsObservation[] = [];
  const response = await execute({
    facts,
    toolCallId: 'tool-provider-throw',
    runAttempt: async (_resolved, _attemptId, _onUpdate, onProviderDispatch) => {
      onProviderDispatch!({ provider: 'provider-a', model: 'model-a', observedAtMs: 110 });
      throw new Error('provider failed before response');
    },
  });
  assert.equal(response.isError, true);
  assert.deepEqual(facts.map((fact) => fact.observationKind), ['begin', 'begin', 'end']);
  assert.equal(facts.some((fact) => fact.observationKind === 'providerSettlement'), false);
  assert.equal((facts.at(-1)!.fields as { captureIncomplete?: boolean }).captureIncomplete, true);
});

test('provider failover keeps attempts, provider entities, and terminal delivery distinct', async () => {
  const facts: AnalyticsObservation[] = [];
  const detailsOut: unknown[] = [];
  const models = [
    { provider: 'provider-a', id: 'model-a', input: ['text'] },
    { provider: 'provider-b', id: 'model-b', input: ['text'] },
  ];
  let ordinal = 0;
  const response = await execute({
    facts,
    detailsOut,
    models,
    selection: selection(models),
    toolCallId: 'tool-failover',
    runAttempt: async (resolved, attemptId, _onUpdate, onProviderDispatch) => {
      ordinal++;
      const model = resolved.modelOverride!;
      const provider = models.find((candidate) => candidate.id === model)!.provider;
      onProviderDispatch!({ provider, model, thinkingLevel: 'high', observedAtMs: ordinal * 100 });
      const invocation = { invocationId: `${attemptId}:provider:1`, attemptId, provider, model, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 }, startedAt: ordinal * 100, completedAt: ordinal * 100 + 50, outcome: ordinal === 1 ? 'failure' as const : 'success' as const };
      return result({
        attemptId,
        exitCode: ordinal === 1 ? 1 : 0,
        stopReason: ordinal === 1 ? 'error' : 'completed',
        provider,
        model,
        providerInvocations: [invocation],
        retryable: ordinal === 1,
        failureClass: ordinal === 1 ? 'timeout' : undefined,
        replaySafety: ordinal === 1 ? 'safe' : undefined,
      });
    },
  });
  assert.equal(ordinal, 2);
  assert.equal(detailsOut.length, 2);
  const executionBegins = facts.filter((fact) => fact.entityKind === 'execution' && fact.observationKind === 'begin');
  const providerBegins = facts.filter((fact) => fact.entityKind === 'providerCall' && fact.observationKind === 'begin');
  const settlements = facts.filter((fact) => fact.observationKind === 'providerSettlement');
  assert.equal(executionBegins.length, 2);
  assert.equal(providerBegins.length, 2);
  assert.equal(settlements.length, 2);
  assert.equal(new Set(executionBegins.map((fact) => fact.stableOriginId)).size, 2);
  assert.equal(new Set(providerBegins.map((fact) => fact.entityKey)).size, 2);
  assert.equal(new Set(facts.map((fact) => fact.sourceKey)).size, facts.length);
  assert.equal(response.details.results[0]!.attemptRecords?.length, 2);
});

test('registered SDK hook is context-scoped and preserves nested capture subject and parent identity', () => {
  let handler: ((event: unknown, context: { model?: { provider?: string; id?: string } }) => void) | undefined;
  const fakePi = {
    registerFlag: () => undefined,
    registerTool: () => undefined,
    getFlag: () => false,
    getThinkingLevel: () => 'medium',
    on: (event: string, candidate: typeof handler) => {
      if (event === 'before_provider_request') handler = candidate;
    },
  };
  registerSubagentAnalyticsProviderHook(fakePi as never);
  assert.ok(handler);

  const outsideFacts: AnalyticsObservation[] = [];
  handler!({ type: 'before_provider_request' }, { model: { provider: 'outside', id: 'outside' } });
  assert.equal(outsideFacts.length, 0, 'root/no-context provider requests are no-ops');

  const nestedFacts: AnalyticsObservation[] = [];
  const runtimeContext = {
    depth: 2,
    trail: ['parent', 'child'],
    analyticsCapture: analytics(nestedFacts),
  };
  bindSubagentAnalyticsAttemptState(runtimeContext, {
    childId: 'nested-child',
    attemptId: 'nested-attempt',
    parentToolCallId: 'nested-parent-tool',
    startedAtMs: 10,
  });
  subagentRuntime.run(runtimeContext, () => {
    handler!({ type: 'before_provider_request' }, { model: { provider: 'nested-provider', id: 'nested-model' } });
  });
  assert.equal(nestedFacts.length, 2);
  assert.ok(nestedFacts.every((fact) => fact.captureSubject.kind === 'session'));
  assert.ok(nestedFacts.every((fact) => fact.scope.rootSessionId === 'root-predispatch'));
  assert.ok(nestedFacts.every((fact) => fact.scope.parentToolCallId === 'canonical:nested-parent-tool'));
  const state = readSubagentAnalyticsAttemptState(runtimeContext)!;
  assert.equal(state.providerRequests[0]?.provider, 'nested-provider');
  assert.equal(state.providerRequests[0]?.model, 'nested-model');
  assert.equal(state.providerRequests[0]?.thinkingLevel, 'medium');
});
