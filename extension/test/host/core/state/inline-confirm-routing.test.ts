/**
 * Source-aware confirmation seam tests (browser server plan §9): a BROWSER
 * source confirms inline in the INITIATING renderer (never the VS Code
 * modal); decline/disconnect cancel; a VS Code source keeps the native modal.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { EffectRunner } from '../../../../src/host/core/effect-runner';
import type { Effect } from '../../../../src/host/core/effects';
import type { RendererCommandContext } from '../../../../src/shared/protocol';
import { makeEffectRunnerDeps } from '../../../helpers/effect-runner-deps';

const BROWSER_SOURCE: RendererCommandContext = { rendererId: 'renderer-1', kind: 'browser', rendererGeneration: 1 };

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface ConfirmHarness {
  runner: EffectRunner;
  events: Array<{ kind: string }>;
  calls: Array<Record<string, unknown>>;
  inlineRequests: Array<Record<string, unknown>>;
  resolveNext: (confirmed: boolean) => void;
  revertCalls: Array<{ sessionPath: string; filePath: string }>;
}

function createHarness(): ConfirmHarness {
  const { deps, events, calls } = makeEffectRunnerDeps();
  const inlineRequests: Array<Record<string, unknown>> = [];
  const revertCalls: Array<{ sessionPath: string; filePath: string }> = [];
  let resolveNext: (confirmed: boolean) => void = () => undefined;
  deps.inlineConfirm = (request) => {
    inlineRequests.push(request as unknown as Record<string, unknown>);
    return new Promise<boolean>((resolve) => {
      resolveNext = resolve;
    });
  };
  deps.fileDiffService = {
    ...deps.fileDiffService,
    revertFile: async (sessionPath: string, filePath: string) => {
      revertCalls.push({ sessionPath, filePath });
    },
  } as typeof deps.fileDiffService;
  const runner = new EffectRunner(deps);
  // The method reads the closure variable at CALL time: an object-literal
  // property would capture the initial no-op value, not the live binding.
  return {
    runner,
    events,
    calls,
    inlineRequests,
    revertCalls,
    resolveNext: (confirmed: boolean) => resolveNext(confirmed),
  };
}

test('ShowModelSwitchConfirm from a browser source confirms inline in the initiating renderer', async () => {
  const harness = createHarness();
  const { runner, events, calls, inlineRequests } = harness;
  runner.run({
    kind: 'ShowModelSwitchConfirm',
    corrId: 'c1',
    sessionPath: '/session/a',
    modelSettings: { defaultModel: 'm', defaultProvider: 'p', defaultThinkingLevel: 'high' },
    message: 'Switch model?',
    confirmChoice: 'Switch Model',
    source: BROWSER_SOURCE,
  } as Effect);
  await settle();

  assert.equal(inlineRequests.length, 1);
  assert.equal(inlineRequests[0]?.rendererId, 'renderer-1');
  assert.equal(inlineRequests[0]?.kind, 'model-switch');
  assert.equal(inlineRequests[0]?.sessionPath, '/session/a');
  assert.equal(inlineRequests[0]?.confirmChoice, 'Switch Model');
  assert.equal(calls.filter((call) => call.kind === 'showWarningModal').length, 0, 'the VS Code modal is never invoked for a browser source');

  harness.resolveNext(true);
  await settle();
  assert.deepEqual(events.filter((event) => event.kind === 'ModelSwitchConfirmResult'), [
    { kind: 'ModelSwitchConfirmResult', corrId: 'c1', confirmed: true },
  ]);
});

test('ShowModelSwitchConfirm from a browser source: decline dispatches confirmed:false', async () => {
  const harness = createHarness();
  const { runner, events } = harness;
  runner.run({
    kind: 'ShowModelSwitchConfirm',
    corrId: 'c2',
    sessionPath: '/session/a',
    modelSettings: { defaultModel: 'm', defaultProvider: 'p', defaultThinkingLevel: 'high' },
    message: 'Switch model?',
    confirmChoice: 'Switch Model',
    source: BROWSER_SOURCE,
  } as Effect);
  await settle();
  harness.resolveNext(false);
  await settle();
  assert.deepEqual(events.filter((event) => event.kind === 'ModelSwitchConfirmResult'), [
    { kind: 'ModelSwitchConfirmResult', corrId: 'c2', confirmed: false },
  ]);
});

test('ShowModelSwitchConfirm from a VS Code source keeps the native modal', async () => {
  const { runner, events, calls, inlineRequests } = createHarness();
  runner.run({
    kind: 'ShowModelSwitchConfirm',
    corrId: 'c3',
    sessionPath: '/session/a',
    modelSettings: { defaultModel: 'm', defaultProvider: 'p', defaultThinkingLevel: 'high' },
    message: 'Switch model?',
    confirmChoice: 'Switch Model',
  } as Effect);
  await settle();

  assert.equal(inlineRequests.length, 0, 'no inline confirm for a VS Code source');
  assert.equal(calls.filter((call) => call.kind === 'showWarningModal').length, 1, 'the native modal is used');
  assert.deepEqual(events.filter((event) => event.kind === 'ModelSwitchConfirmResult'), [
    { kind: 'ModelSwitchConfirmResult', corrId: 'c3', confirmed: false },
  ]);
});

test('FileRevert from a browser source: confirm reverts; cancel never touches the file', async () => {
  const harness = createHarness();
  const { runner, events, inlineRequests, revertCalls } = harness;
  runner.run({
    kind: 'FileRevert',
    corrId: 'c4',
    sessionPath: '/session/a',
    filePath: '/tmp/file.ts',
    source: BROWSER_SOURCE,
  } as Effect);
  await settle();

  assert.equal(inlineRequests.length, 1);
  assert.equal(inlineRequests[0]?.kind, 'destructive-revert');
  assert.equal(inlineRequests[0]?.rendererId, 'renderer-1');

  harness.resolveNext(true);
  await settle();
  assert.deepEqual(revertCalls, [{ sessionPath: '/session/a', filePath: '/tmp/file.ts' }]);
  assert.deepEqual(events.filter((event) => event.kind === 'FileRevertResult'), [
    { kind: 'FileRevertResult', corrId: 'c4', sessionPath: '/session/a', ok: true },
  ]);

  const cancelled = createHarness();
  cancelled.runner.run({
    kind: 'FileRevert',
    corrId: 'c5',
    sessionPath: '/session/a',
    filePath: '/tmp/file.ts',
    source: BROWSER_SOURCE,
  } as Effect);
  await settle();
  cancelled.resolveNext(false);
  await settle();
  assert.equal(cancelled.revertCalls.length, 0, 'a cancelled confirm never reverts');
  assert.deepEqual(cancelled.events.filter((event) => event.kind === 'FileRevertResult'), [
    { kind: 'FileRevertResult', corrId: 'c5', sessionPath: '/session/a', ok: false, error: 'cancelled' },
  ]);
});
