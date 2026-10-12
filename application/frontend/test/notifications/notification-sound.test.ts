import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostToWebviewMessage } from '../../../lib/protocol/index.js';
import { dispatchHostMessage } from '../../lib/hooks/use-host-sync';
import {
  playCompletionSound,
  playQuestionSound,
  warmupCompletionSoundContext,
} from '../../notifications/completion-sound';

type AudioContextState = 'running' | 'suspended' | 'closed';

class FakeAudioParam {
  readonly values: number[] = [];

  setValueAtTime(value: number): void {
    this.values.push(value);
  }

  exponentialRampToValueAtTime(value: number): void {
    this.values.push(value);
  }
}

class FakeOscillator {
  readonly frequency = new FakeAudioParam();
  type = '';
  started = false;
  stopped = false;

  connect(): void {}
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
}

class FakeGain {
  readonly gain = new FakeAudioParam();
  connect(): void {}
}

let documentFocusCalls = 0;

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'running';
  currentTime = 0;
  readonly destination = {};
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  resumeResult: Promise<void> = Promise.resolve();
  resumeCalls = 0;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    return this.resumeResult.then(() => {
      if (this.state === 'suspended') this.state = 'running';
    });
  }
}

function installAudioGlobals(
  initialState: AudioContextState = 'running',
  resumeResult: Promise<void> = Promise.resolve(),
) {
  const audioContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  FakeAudioContext.instances = [];
  documentFocusCalls = 0;
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: class extends FakeAudioContext {
      constructor() {
        super();
        this.state = initialState;
        this.resumeResult = resumeResult;
      }
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { hasFocus: () => { documentFocusCalls += 1; return true; } },
  });

  return () => {
    for (const context of FakeAudioContext.instances) context.state = 'closed';
    if (audioContextDescriptor) Object.defineProperty(globalThis, 'AudioContext', audioContextDescriptor);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  };
}

function dispatchSound(type: 'playCompletionSound' | 'playQuestionSound', volume: number): void {
  dispatchHostMessage(
    { type, volume } as HostToWebviewMessage,
    { compatibilityFailedRef: { current: false } } as Parameters<typeof dispatchHostMessage>[1],
  );
}

for (const [type, frequencies] of [
  ['playCompletionSound', [880, 1174.66]],
  ['playQuestionSound', [659.25, 523.25]],
] as const) {
  test(`${type} host message plays its chime at the configured volume while the document is focused`, () => {
    const restoreGlobals = installAudioGlobals();
    try {
      dispatchSound(type, 50);
      const context = FakeAudioContext.instances[0];
      assert.ok(context);
      assert.deepEqual(context.oscillators.map((oscillator) => oscillator.frequency.values[0]), frequencies);
      assert.equal(documentFocusCalls, 0, 'host sound dispatch does not consult document focus');
      assert.ok(context.gains[0].gain.values.includes(0.2), 'first tone uses 50% volume');
      assert.ok(context.gains[1].gain.values.includes(0.15), 'second tone uses 50% volume');
      assert.ok(context.oscillators.every((oscillator) => oscillator.started && oscillator.stopped));
    } finally {
      restoreGlobals();
    }
  });
}

test('warmup and both host notification sounds share one AudioContext', async () => {
  const restoreGlobals = installAudioGlobals('suspended');
  try {
    warmupCompletionSoundContext();
    const context = FakeAudioContext.instances[0];
    assert.ok(context);
    await Promise.resolve();
    dispatchSound('playCompletionSound', 50);
    dispatchSound('playQuestionSound', 50);
    assert.equal(FakeAudioContext.instances.length, 1);
    assert.equal(context.resumeCalls, 1);
    assert.deepEqual(context.oscillators.map((oscillator) => oscillator.frequency.values[0]), [880, 1174.66, 659.25, 523.25]);
  } finally {
    restoreGlobals();
  }
});

test('zero volume is silent and does not create an AudioContext', () => {
  const restoreGlobals = installAudioGlobals();
  try {
    playCompletionSound(0);
    playQuestionSound(0);
    dispatchSound('playCompletionSound', 0);
    dispatchSound('playQuestionSound', 0);
    assert.equal(FakeAudioContext.instances.length, 0);
  } finally {
    restoreGlobals();
  }
});

test('a suspended context resumes before playing either notification sound', async () => {
  const restoreGlobals = installAudioGlobals('suspended');
  try {
    dispatchSound('playQuestionSound', 50);
    const context = FakeAudioContext.instances[0];
    assert.ok(context);
    assert.equal(context.resumeCalls, 1);
    assert.equal(context.oscillators.length, 0);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(context.oscillators.map((oscillator) => oscillator.frequency.values[0]), [659.25, 523.25]);
  } finally {
    restoreGlobals();
  }
});

test('a rejected suspended-context resume is nonfatal', async () => {
  const restoreGlobals = installAudioGlobals(
    'suspended',
    Promise.reject(new Error('autoplay blocked')),
  );
  try {
    dispatchSound('playCompletionSound', 50);
    const context = FakeAudioContext.instances[0];
    assert.ok(context);
    await Promise.resolve();
    assert.equal(context.oscillators.length, 0);
  } finally {
    restoreGlobals();
  }
});
