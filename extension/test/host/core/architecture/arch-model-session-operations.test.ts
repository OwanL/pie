import assert from 'node:assert/strict';
import test from 'node:test';

import { initialArchState, reducer, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionOperationKind, SessionOperationSource } from '../../../../src/host/core/operation-types';
import type { SessionOpenedPayload, SessionSummary } from '../../../../src/shared/protocol';
import {
  DeterministicFakeClock,
  enumeratePermutations,
  fixedSeedShuffle,
  runDeterministicSchedule,
} from '../../../helpers/deterministic-model-scheduler';

const SESSION = '/sessions/model-harness.jsonl';
const BACKEND_GENERATION = 7;
const WORKER_GENERATION = 3;
const CURRENT_SOURCE: SessionOperationSource = {
  kind: 'renderer', rendererId: 'browser-1', rendererKind: 'browser', rendererGeneration: 4,
};
const STALE_SOURCE: SessionOperationSource = {
  kind: 'renderer', rendererId: 'browser-1', rendererKind: 'browser', rendererGeneration: 3,
};
const CAPABILITIES = {
  billableActivity: false, canContinue: false, canInterrupt: false, canCompact: true,
};

const summary: SessionSummary = {
  path: SESSION,
  sessionId: 'session-model',
  name: 'Model harness',
  cwd: '/workspace',
  modifiedAt: '2026-09-05T00:00:00.000Z',
  messageCount: 1,
};

function baseState(running = false): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [summary],
      openTabPaths: [SESSION],
      activeSessionPath: SESSION,
      runningSessionPaths: running ? [SESSION] : [],
      settlementGenerationBySession: {
        [SESSION]: { backendGeneration: BACKEND_GENERATION, workerGeneration: WORKER_GENERATION },
      },
      capabilitiesBySession: { [SESSION]: CAPABILITIES },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        [SESSION]: [{
          id: 'user-original', role: 'user', createdAt: '2026-09-05T00:00:00.000Z',
          markdown: 'original', status: 'completed',
        }],
      },
      sessionUsageBySession: { [SESSION]: { samples: [], branchId: 'branch-model' } },
    },
    settings: { ...initialArchState.settings, backendReady: true },
  };
}

function openedPayload(operationId: string): SessionOpenedPayload {
  return {
    session: summary,
    transcript: [],
    transcriptWindow: {
      totalCount: 0, loadedStart: 0, loadedEnd: 0,
      hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false,
    },
    busy: false,
    capabilities: CAPABILITIES,
    runtimeReady: false,
    selectionToken: `${operationId}:selection`,
    operationId,
    operationAttempt: 1,
    workerGeneration: WORKER_GENERATION,
  };
}

type Boundary = 'accept' | 'commit' | 'settle' | 'interrupt' | 'backend-restart' | 'renderer-reload' | 'worker-replacement';
type TimedEvents = (occurredAt: number) => Event[];

interface Scenario {
  readonly name: string;
  readonly kind: SessionOperationKind;
  readonly operationId: string;
  readonly command: Event;
  readonly initialState: ArchState;
  readonly accept: TimedEvents;
  readonly commit: TimedEvents;
  readonly settle: TimedEvents;
  readonly staleBackendEvent: Event;
  readonly generationEndedEvent?: Event;
  readonly localId?: string;
}

function commandEvent(cmd: Extract<Event, { kind: 'Command' }>['cmd']): Event {
  return { kind: 'Command', cmd };
}

function workerReplacementOpenedPayload(): SessionOpenedPayload {
  const { operationId: _operationId, operationAttempt: _operationAttempt, ...payload } = openedPayload('replacement');
  return {
    ...payload,
    selectionToken: 'worker-replacement',
    workerGeneration: WORKER_GENERATION + 1,
  };
}

function messageStarted(operationId: string): Event {
  return {
    kind: 'MessageStarted', sessionPath: SESSION, messageId: `${operationId}:assistant`,
    requestId: `${operationId}:request`, operationId, operationAttempt: 1, timestamp: 10,
  };
}

function agentSettled(operationId: string, workerGeneration = WORKER_GENERATION): Event {
  return {
    kind: 'AgentSettled', sessionPath: SESSION, operationId,
    requestId: `${operationId}:request`, operationAttempt: 1,
    backendGeneration: BACKEND_GENERATION, currentBackendGeneration: BACKEND_GENERATION,
    workerGeneration, capabilities: CAPABILITIES,
  };
}

function messageStatus(
  operationId: string,
  operationKind: Exclude<SessionOperationKind, `session.${string}` | 'backend.restart' | 'message.send'>,
  state: 'accepted' | 'committed' | 'aborted' | 'generation-ended',
  committed?: boolean,
): Extract<Event, { kind: 'MessageOperationStatus' }> {
  return {
    kind: 'MessageOperationStatus', operationId, operationKind, sessionPath: SESSION,
    backendGeneration: BACKEND_GENERATION, operationAttempt: 1, state,
    ...(committed === undefined ? {} : { committed }),
  };
}

function scenarios(): Scenario[] {
  const sendCommand = (operationId: string, queued: boolean): Event => commandEvent({
    kind: 'Send', corrId: `${operationId}:corr`, operationId, operationAttempt: 1,
    operationSource: CURRENT_SOURCE, backendGeneration: BACKEND_GENERATION,
    sessionPath: SESSION, text: queued ? 'queued' : 'send', inputs: [],
    composedText: queued ? 'queued' : 'send', localId: `${operationId}:local`,
    previousSummary: null, timestamp: 1,
  });
  const sendScenario = (name: string, operationId: string, queued: boolean): Scenario => ({
    name,
    kind: 'message.send',
    operationId,
    command: sendCommand(operationId, queued),
    initialState: baseState(queued),
    accept: () => [{
      kind: 'SendResult', corrId: `${operationId}:corr`, operationId, operationAttempt: 1,
      backendGeneration: BACKEND_GENERATION, sessionPath: SESSION, ok: true,
      requestId: queued ? undefined : `${operationId}:request`, queued,
    }],
    commit: () => queued
      ? [{ kind: 'QueuedDelivered', sessionPath: SESSION, text: 'queued', operationId, operationAttempt: 1, localId: `${operationId}:local` }]
      : [messageStarted(operationId)],
    settle: () => queued
      ? [{ kind: 'QueuedDelivered', sessionPath: SESSION, text: 'queued', operationId, operationAttempt: 1, localId: `${operationId}:local` }]
      : [agentSettled(operationId)],
    staleBackendEvent: {
      kind: 'SendOperationStatus', operationId, sessionPath: SESSION,
      backendGeneration: BACKEND_GENERATION - 1, operationAttempt: 1, state: 'committed',
    },
    generationEndedEvent: {
      kind: 'SendOperationStatus', operationId, sessionPath: SESSION,
      backendGeneration: BACKEND_GENERATION, operationAttempt: 1, state: 'generation-ended',
    },
    localId: `${operationId}:local`,
  });

  const continueId = 'model-continue';
  const editId = 'model-edit';
  const compactId = 'model-compact';
  const interruptId = 'model-interrupt';
  const openId = 'model-open';
  const closeId = 'model-close';
  const restartId = 'model-restart';

  return [
    sendScenario('send', 'model-send', false),
    sendScenario('queued send', 'model-queued-send', true),
    {
      name: 'continue', kind: 'message.continue', operationId: continueId, initialState: baseState(),
      command: commandEvent({
        kind: 'Continue', corrId: `${continueId}:corr`, operationId: continueId, operationAttempt: 1,
        operationSource: CURRENT_SOURCE, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
      }),
      accept: () => [{
        kind: 'ContinueResult', corrId: `${continueId}:corr`, operationId: continueId,
        operationAttempt: 1, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
        ok: true, requestId: `${continueId}:request`,
      }],
      commit: () => [messageStarted(continueId)],
      settle: () => [agentSettled(continueId)],
      staleBackendEvent: { ...messageStatus(continueId, 'message.continue', 'committed'), backendGeneration: BACKEND_GENERATION - 1 },
      generationEndedEvent: messageStatus(continueId, 'message.continue', 'generation-ended'),
    },
    {
      name: 'edit', kind: 'message.edit', operationId: editId, initialState: baseState(),
      command: commandEvent({
        kind: 'Edit', corrId: `${editId}:corr`, operationId: editId, operationAttempt: 1,
        operationSource: CURRENT_SOURCE, backendGeneration: BACKEND_GENERATION,
        sessionPath: SESSION, messageId: 'user-original', text: 'replacement', inputs: [],
        composedText: 'replacement', localId: `${editId}:local`, timestamp: 1,
      }),
      accept: () => [{
        kind: 'EditResult', corrId: `${editId}:corr`, operationId: editId, operationAttempt: 1,
        backendGeneration: BACKEND_GENERATION, sessionPath: SESSION, ok: true,
        committed: false, requestId: `${editId}:request`,
      }],
      commit: () => [messageStarted(editId)],
      settle: () => [agentSettled(editId)],
      staleBackendEvent: { ...messageStatus(editId, 'message.edit', 'committed'), backendGeneration: BACKEND_GENERATION - 1 },
      generationEndedEvent: messageStatus(editId, 'message.edit', 'generation-ended'),
      localId: `${editId}:local`,
    },
    {
      name: 'compact', kind: 'message.compact', operationId: compactId, initialState: baseState(),
      command: commandEvent({
        kind: 'Compact', corrId: `${compactId}:corr`, operationId: compactId, operationAttempt: 1,
        operationSource: CURRENT_SOURCE, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
      }),
      accept: () => [{
        kind: 'CompactResult', corrId: `${compactId}:corr`, operationId: compactId,
        operationAttempt: 1, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION, ok: true,
        requestId: `${compactId}:request`,
      }],
      commit: () => [{ kind: 'CompactionStarted', sessionPath: SESSION, operationId: compactId, operationAttempt: 1 }],
      settle: (occurredAt) => [{
        kind: 'CompactionEnded', sessionPath: SESSION, operationId: compactId, operationAttempt: 1,
        reason: 'manual', outcome: 'succeeded', occurredAt,
      }],
      staleBackendEvent: { ...messageStatus(compactId, 'message.compact', 'committed'), backendGeneration: BACKEND_GENERATION - 1 },
      generationEndedEvent: messageStatus(compactId, 'message.compact', 'generation-ended'),
    },
    {
      name: 'interrupt', kind: 'message.interrupt', operationId: interruptId, initialState: baseState(true),
      command: commandEvent({
        kind: 'Interrupt', corrId: `${interruptId}:corr`, operationId: interruptId, operationAttempt: 1,
        operationSource: CURRENT_SOURCE, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
      }),
      accept: () => [{
        kind: 'InterruptResult', corrId: `${interruptId}:corr`, operationId: interruptId,
        operationAttempt: 1, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
        ok: true, committed: false, settled: false,
      }],
      commit: () => [messageStatus(interruptId, 'message.interrupt', 'accepted', true)],
      settle: (occurredAt) => [{
        kind: 'InterruptResult', corrId: `${interruptId}:corr`, operationId: interruptId,
        operationAttempt: 1, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
        ok: true, committed: true, settled: true, occurredAt,
      }],
      staleBackendEvent: { ...messageStatus(interruptId, 'message.interrupt', 'committed'), backendGeneration: BACKEND_GENERATION - 1 },
      generationEndedEvent: messageStatus(interruptId, 'message.interrupt', 'generation-ended'),
    },
    {
      name: 'open', kind: 'session.open', operationId: openId, initialState: baseState(),
      command: commandEvent({
        kind: 'OpenSession', corrId: `${openId}:corr`, operationId: openId, operationAttempt: 1,
        operationSource: CURRENT_SOURCE, backendGeneration: BACKEND_GENERATION,
        sessionPath: SESSION, placeholderSummary: null, selectionToken: `${openId}:selection`,
      }),
      accept: () => [{
        kind: 'OpenSessionResult', corrId: `${openId}:corr`, operationId: openId,
        operationAttempt: 1, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
        ok: false, ambiguous: true, error: 'dropped acknowledgement',
      }],
      commit: () => [{
        kind: 'SessionOpened', sessionPath: SESSION, payload: openedPayload(openId),
        backendGeneration: BACKEND_GENERATION, modelWriteFence: 0,
        modelHydrationRevision: 0, catalogHydrationRevision: 0,
      }],
      settle: () => [{
        kind: 'OpenSessionResult', corrId: `${openId}:corr`, operationId: openId,
        operationAttempt: 1, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION, ok: true,
      }],
      staleBackendEvent: {
        kind: 'OpenSessionResult', corrId: `${openId}:corr`, operationId: openId,
        operationAttempt: 1, backendGeneration: BACKEND_GENERATION - 1, sessionPath: SESSION, ok: true,
      },
    },
    {
      name: 'close', kind: 'session.close', operationId: closeId, initialState: baseState(),
      command: commandEvent({
        kind: 'CloseSession', corrId: `${closeId}:corr`, operationId: closeId, operationAttempt: 1,
        operationSource: CURRENT_SOURCE, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
      }),
      accept: () => [{
        kind: 'PersistTabsResult', corrId: `${closeId}:corr`, operationId: closeId,
        backendGeneration: BACKEND_GENERATION, ok: true,
      }],
      commit: () => [{
        kind: 'CloseSessionResult', corrId: `${closeId}:corr`, operationId: closeId,
        backendGeneration: BACKEND_GENERATION, sessionPath: SESSION, ok: true,
      }],
      settle: () => [{
        kind: 'PersistTabsResult', corrId: `${closeId}:corr`, operationId: closeId,
        backendGeneration: BACKEND_GENERATION, ok: true,
      }],
      staleBackendEvent: {
        kind: 'PersistTabsResult', corrId: `${closeId}:corr`, operationId: closeId,
        backendGeneration: BACKEND_GENERATION - 1, ok: true,
      },
    },
    {
      name: 'backend restart', kind: 'backend.restart', operationId: restartId, initialState: baseState(),
      command: commandEvent({
        kind: 'RestartBackend', corrId: `${restartId}:corr`, operationId: restartId,
        operationSource: CURRENT_SOURCE, backendGeneration: BACKEND_GENERATION,
      }),
      accept: () => [{ kind: 'BackendRestartDrainCompleted', operationId: restartId, backendGeneration: BACKEND_GENERATION }],
      commit: () => [{ kind: 'BackendRestartOldGenerationDied', operationId: restartId, backendGeneration: BACKEND_GENERATION }],
      settle: () => [{
        kind: 'BackendRestartResult', corrId: `${restartId}:corr`, operationId: restartId,
        backendGeneration: BACKEND_GENERATION, replacementBackendGeneration: BACKEND_GENERATION + 1, ok: true,
      }],
      staleBackendEvent: {
        kind: 'BackendRestartDrainCompleted', operationId: restartId,
        backendGeneration: BACKEND_GENERATION - 1,
      },
    },
  ];
}

function rendererReloadReplay(scenario: Scenario): Event {
  assert.equal(scenario.command.kind, 'Command');
  return commandEvent({ ...scenario.command.cmd, operationSource: STALE_SOURCE } as Extract<Event, { kind: 'Command' }>['cmd']);
}

function externalInterruptEvents(scenario: Scenario, occurredAt: number): Event[] {
  if (scenario.kind === 'message.interrupt') return scenario.settle(occurredAt);
  const operationId = `${scenario.operationId}:external-interrupt`;
  const events: Event[] = [commandEvent({
    kind: 'Interrupt', corrId: `${operationId}:corr`, operationId, operationAttempt: 1,
    operationSource: { kind: 'host' }, backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
  }), {
    kind: 'InterruptResult', corrId: `${operationId}:corr`, operationId, operationAttempt: 1,
    backendGeneration: BACKEND_GENERATION, sessionPath: SESSION,
    ok: true, committed: true, settled: true, occurredAt,
  }];
  if (scenario.kind === 'message.send') {
    events.push({
      kind: 'SendOperationStatus', operationId: scenario.operationId, sessionPath: SESSION,
      backendGeneration: BACKEND_GENERATION, operationAttempt: 1, state: 'aborted',
    });
  } else if (scenario.kind.startsWith('message.')) {
    events.push(messageStatus(
      scenario.operationId,
      scenario.kind as Exclude<SessionOperationKind, `session.${string}` | 'backend.restart' | 'message.send'>,
      'aborted',
    ));
  }
  return events;
}

function backendRestartEvents(scenario: Scenario): Event[] {
  if (scenario.kind === 'backend.restart') {
    return [
      { kind: 'BackendRestartDrainCompleted', operationId: scenario.operationId, backendGeneration: BACKEND_GENERATION },
      { kind: 'BackendRestartOldGenerationDied', operationId: scenario.operationId, backendGeneration: BACKEND_GENERATION },
      {
        kind: 'BackendRestartResult', corrId: `${scenario.operationId}:corr`, operationId: scenario.operationId,
        backendGeneration: BACKEND_GENERATION, replacementBackendGeneration: BACKEND_GENERATION + 1, ok: true,
      },
    ];
  }
  const operationId = `${scenario.operationId}:external-restart`;
  return [
    commandEvent({
      kind: 'RestartBackend', corrId: `${operationId}:corr`, operationId,
      operationSource: { kind: 'host' }, backendGeneration: BACKEND_GENERATION,
    }),
    { kind: 'BackendRestartDrainCompleted', operationId, backendGeneration: BACKEND_GENERATION },
    { kind: 'BackendRestartOldGenerationDied', operationId, backendGeneration: BACKEND_GENERATION },
    {
      kind: 'BackendRestartResult', corrId: `${operationId}:corr`, operationId,
      backendGeneration: BACKEND_GENERATION, replacementBackendGeneration: BACKEND_GENERATION + 1, ok: true,
    },
    ...(scenario.generationEndedEvent ? [scenario.generationEndedEvent] : []),
  ];
}

function boundaryEvents(scenario: Scenario, boundary: Boundary, occurredAt: number): Event[] {
  switch (boundary) {
    case 'accept': return scenario.accept(occurredAt);
    case 'commit': return scenario.commit(occurredAt);
    case 'settle': return scenario.settle(occurredAt);
    case 'interrupt': return externalInterruptEvents(scenario, occurredAt);
    case 'backend-restart': return backendRestartEvents(scenario);
    case 'renderer-reload': return [rendererReloadReplay(scenario)];
    case 'worker-replacement': return [{
      kind: 'SessionOpened', sessionPath: SESSION, payload: workerReplacementOpenedPayload(),
      backendGeneration: BACKEND_GENERATION, modelWriteFence: 0,
      modelHydrationRevision: 0, catalogHydrationRevision: 0,
    }, agentSettled(scenario.operationId, WORKER_GENERATION)];
  }
}

const MUTATION_EFFECT_BY_KIND: Readonly<Record<SessionOperationKind, string>> = {
  'session.create': 'CreateSession',
  'session.duplicate': 'DuplicateSession',
  'session.open': 'OpenSession',
  'session.close': 'CloseSession',
  'backend.restart': 'RestartBackend',
  'message.send': 'SendRpc',
  'message.edit': 'EditRpc',
  'message.interrupt': 'InterruptRpc',
  'message.continue': 'ContinueRpc',
  'message.compact': 'CompactRpc',
};

function mutationEffectsForScenario(result: ReturnType<typeof reducer>, scenario: Scenario): number {
  return result.effects.filter((effect) =>
    effect.kind === MUTATION_EFFECT_BY_KIND[scenario.kind]
      && 'operationId' in effect
      && effect.operationId === scenario.operationId,
  ).length;
}

function assertTerminalSemantics(scenario: Scenario, schedule: readonly Boundary[], state: ArchState): void {
  const operation = state.operations[scenario.operationId]!;
  const terminal = operation.terminal!;
  const expectedReasons = {
    settled: ['durable-commit-observed'],
    cancelled: ['queue-cleared', 'interrupted-before-commit'],
    superseded: ['superseded-before-commit'],
    failed: ['definitive-rejection', 'backend-generation-ended', 'execution-failed'],
  } as const;
  assert.ok(
    (expectedReasons[terminal.outcome] as readonly string[]).includes(terminal.reason),
    `${scenario.name}/${schedule.join('>')}: terminal outcome/reason contradiction`,
  );
  if (terminal.outcome === 'settled') assert.equal(operation.commit, 'committed');
  if (terminal.outcome === 'cancelled' || terminal.outcome === 'superseded') {
    assert.equal(operation.commit, 'not-committed');
  }
}

function verifySchedule(scenario: Scenario, schedule: readonly Boundary[], scheduleIndex: number): void {
  const ingress = reducer(scenario.initialState, scenario.command);
  let state = ingress.state;
  let originalMutationEffects = mutationEffectsForScenario(ingress, scenario);
  const started = state.operations[scenario.operationId];
  assert.ok(started, `${scenario.name}: command must register its operation`);
  assert.deepEqual(started.source, CURRENT_SOURCE);

  const staleBackend = reducer(state, scenario.staleBackendEvent);
  assert.equal(staleBackend.state, state, `${scenario.name}: stale backend generation must be excluded`);
  const staleWorker = reducer(state, agentSettled(scenario.operationId, WORKER_GENERATION - 1));
  assert.equal(staleWorker.state, state, `${scenario.name}: stale worker generation must be excluded`);

  let terminalJson: string | undefined;
  let terminalBoundary: Boundary | undefined;
  let terminalTransitions = 0;
  const clock = new DeterministicFakeClock(1_000_000 + scheduleIndex * 100);
  runDeterministicSchedule(clock, schedule, (boundary, occurredAt) => {
    for (const event of boundaryEvents(scenario, boundary, occurredAt)) {
      const result = reducer(state, event);
      const emittedMutations = mutationEffectsForScenario(result, scenario);
      if (boundary === 'renderer-reload') {
        assert.equal(emittedMutations, 0, `${scenario.name}/${schedule.join('>')}: stale renderer replay emitted a duplicate mutation`);
      }
      originalMutationEffects += emittedMutations;
      state = result.state;
      const operation = state.operations[scenario.operationId];
      assert.ok(operation, `${scenario.name}/${schedule.join('>')}: operation lineage disappeared`);
      assert.deepEqual(
        operation.source,
        CURRENT_SOURCE,
        `${scenario.name}/${schedule.join('>')}: renderer reload changed operation ownership`,
      );
      if (scenario.localId) {
        const matchingRows = (state.transcript.bySession[SESSION] ?? [])
          .filter((message) => message.id === scenario.localId);
        assert.ok(matchingRows.length <= 1, `${scenario.name}: renderer replay duplicated the optimistic row`);
      }
      if (!operation.terminal) continue;
      const currentTerminal = JSON.stringify(operation.terminal);
      if (terminalJson === undefined) {
        terminalJson = currentTerminal;
        terminalBoundary = boundary;
        terminalTransitions += 1;
      } else {
        assert.equal(
          currentTerminal,
          terminalJson,
          `${scenario.name}/${schedule.join('>')}: terminal outcome changed after settlement`,
        );
      }
      assert.equal(operation.phase, 'settled');
    }
  });

  assert.equal(clock.pendingTimerCount(), 0);
  assert.equal(originalMutationEffects, 1, `${scenario.name}/${schedule.join('>')}: backend mutation effect must be emitted once`);
  assert.equal(terminalTransitions, 1, `${scenario.name}/${schedule.join('>')}: expected exactly one terminal transition`);
  assert.ok(state.operations[scenario.operationId]?.terminal, `${scenario.name}: schedule did not terminalize operation`);
  assertTerminalSemantics(scenario, schedule, state);
  const terminal = state.operations[scenario.operationId]!.terminal!;
  assert.notEqual(terminalBoundary, 'renderer-reload');
  assert.notEqual(terminalBoundary, 'worker-replacement');
  if (terminalBoundary === 'backend-restart') {
    assert.equal(terminal.outcome, scenario.kind === 'backend.restart' ? 'settled' : 'failed');
    assert.equal(terminal.reason, scenario.kind === 'backend.restart'
      ? 'durable-commit-observed'
      : 'backend-generation-ended');
  } else if (terminalBoundary === 'interrupt') {
    assert.equal(terminal.outcome, scenario.kind === 'message.interrupt' ? 'settled' : 'cancelled');
  } else {
    assert.equal(terminal.outcome, 'settled', `${scenario.name}: ${terminalBoundary} must settle successfully`);
  }
}

test('shared fake clock exposes deterministic now, cancellation, nesting, and FIFO timers', () => {
  const clock = new DeterministicFakeClock(100);
  const observed: Array<[string, number]> = [];
  const cancelled = clock.setTimeout(() => observed.push(['cancelled', clock.now()]), 5);
  clock.clearTimeout(cancelled);
  clock.setTimeout(() => {
    observed.push(['first', clock.now()]);
    clock.setTimeout(() => observed.push(['nested', clock.now()]), 2);
  }, 10);
  clock.setTimeout(() => observed.push(['same-time', clock.now()]), 10);

  clock.advanceBy(12);

  assert.equal(clock.now(), 112);
  assert.deepEqual(observed, [['first', 110], ['same-time', 110], ['nested', 112]]);
  assert.equal(clock.pendingTimerCount(), 0);
});

test('model harness enumerates and fixed-seed randomizes lifecycle boundary interleavings', () => {
  const boundaries: readonly Boundary[] = [
    'accept', 'commit', 'settle', 'interrupt', 'backend-restart', 'renderer-reload',
  ];
  const enumerated = enumeratePermutations(boundaries);
  assert.equal(enumerated.length, 720);
  assert.deepEqual(
    fixedSeedShuffle(boundaries, 0x51a7e),
    fixedSeedShuffle(boundaries, 0x51a7e),
    'fixed seed must reproduce the same randomized schedule',
  );

  for (const [scenarioIndex, scenario] of scenarios().entries()) {
    for (const [scheduleIndex, schedule] of enumerated.entries()) {
      verifySchedule(scenario, schedule, scheduleIndex);
    }
    const randomizedBoundaries: readonly Boundary[] = [...boundaries, 'worker-replacement'];
    for (let round = 0; round < 24; round += 1) {
      const randomized = fixedSeedShuffle(randomizedBoundaries, 0x51a7e + scenarioIndex * 101 + round);
      verifySchedule(scenario, randomized, enumerated.length + round);
    }
  }
});
