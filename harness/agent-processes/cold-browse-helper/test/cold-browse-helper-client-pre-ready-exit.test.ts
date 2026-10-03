import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ColdBrowseHelperClient } from '../cold-browse-helper-client';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';

function createControlledHelperChild(): any {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.frames = [] as Array<Record<string, unknown>>;
  let buffered = '';
  child.stdin.on('data', (chunk: Buffer | string) => {
    buffered += chunk.toString();
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
      buffered = buffered.slice(newline + 1);
      child.frames.push(frame);
      child.emit('frame', frame);
    }
  });
  child.waitForFrame = (kind: string): Promise<Record<string, unknown>> => {
    const existing = child.frames.find((frame: Record<string, unknown>) => frame.kind === kind);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const listener = (frame: Record<string, unknown>) => {
        if (frame.kind !== kind) return;
        child.off('frame', listener);
        resolve(frame);
      };
      child.on('frame', listener);
    });
  };
  child.confirmExit = (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  child.kill = () => {
    child.killCalls += 1;
    setImmediate(() => child.confirmExit(null, 'SIGTERM'));
    return true;
  };
  return child;
}

test('disposing during startup rejects readiness when the child exits before ready', async () => {
  const child = createControlledHelperChild();
  const helper = new ColdBrowseHelperClient({
    entryPath: path.join(process.cwd(), 'harness', 'agent-processes', 'cold-browse-helper', 'test', 'fixtures', 'cold-browse-helper-client-fixture.mjs'),
    sdkPath: process.cwd(),
    sdkRuntime: createSyntheticSourceTestSdkRuntime(process.cwd()),
    startupCwd: process.cwd(),
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
    spawnProcess: (() => child) as any,
  });
  const warming = helper.warm();
  void warming.catch(() => undefined);
  let disposal: Promise<void> | undefined;
  let readinessDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await child.waitForFrame('initialize');
    disposal = helper.dispose();
    await child.waitForFrame('shutdown');

    child.confirmExit(1);
    await disposal;
    await assert.rejects(
      Promise.race([
        warming,
        new Promise<never>((_resolve, reject) => {
          readinessDeadline = setTimeout(() => reject(new Error('Readiness did not settle after confirmed child exit.')), 100);
        }),
      ]),
      /exited before readiness during shutdown/u,
    );
    assert.equal(child.killCalls, 0, 'confirmed exit during shutdown must not trigger an unnecessary kill');
  } finally {
    clearTimeout(readinessDeadline);
    if (child.exitCode === null && child.signalCode === null) child.confirmExit();
    await (disposal ?? helper.dispose()).catch(() => undefined);
  }
});
