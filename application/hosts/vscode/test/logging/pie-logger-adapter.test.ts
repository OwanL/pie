import assert from 'node:assert/strict';
import { Module } from 'node:module';
import test from 'node:test';

import {
  appendPieLog,
  getPieLogPath,
  initPieLogger,
  setLogLevel,
  setPieLoggerOutputAdapter,
} from '../../../../../lib/structured-logging/pie-logger';

interface FakeLogChannel {
  logLevel: number;
  calls: Array<{ level: string; line: string }>;
}

function fakeLogChannel(logLevel = 3): FakeLogChannel & Record<string, unknown> {
  const calls: FakeLogChannel['calls'] = [];
  return {
    name: 'test',
    logLevel,
    calls,
    appendLine: (line: string) => calls.push({ level: 'appendLine', line }),
    show: (preserveFocus: boolean) => calls.push({ level: 'show', line: String(preserveFocus) }),
    trace: (line: string) => calls.push({ level: 'trace', line }),
    debug: (line: string) => calls.push({ level: 'debug', line }),
    info: (line: string) => calls.push({ level: 'info', line }),
    warn: (line: string) => calls.push({ level: 'warn', line }),
    error: (line: string) => calls.push({ level: 'error', line }),
  };
}

test.after(() => setPieLoggerOutputAdapter(undefined));

test('VS Code output adapter filters before serialization, bounds bursts, isolates backend logs, and shows diagnostics', async () => {
  initPieLogger({ devMode: false });
  setLogLevel('error');
  const main = fakeLogChannel();
  const backend = fakeLogChannel(2);
  const vscodeMock = { window: { createOutputChannel: () => main } };
  const nodeModule = Module as unknown as { _load(request: string, ...rest: unknown[]): unknown };
  const originalLoad = nodeModule._load.bind(nodeModule);
  nodeModule._load = (request: string, ...rest: unknown[]) => request === 'vscode'
    ? vscodeMock
    : originalLoad(request, ...rest);
  let showPieLogs: ((preserveFocus?: boolean) => void) | undefined;
  let setPieLogChannelsForTesting: (
    main?: import('vscode').LogOutputChannel,
    backend?: import('vscode').LogOutputChannel,
  ) => void;
  try {
    ({ showPieLogs, setPieLogChannelsForTesting } = await import('../../logging/pie-logger-adapter'));
  } finally {
    nodeModule._load = originalLoad;
  }
  setPieLogChannelsForTesting(
    main as unknown as import('vscode').LogOutputChannel,
    backend as unknown as import('vscode').LogOutputChannel,
  );

  let payloadReads = 0;
  const payload = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() { payloadReads += 1; return 'diagnostic'; },
  });
  assert.doesNotThrow(() => appendPieLog('debug', 'channel-test', 'filtered', payload));
  assert.equal(payloadReads, 0, 'native Info should filter Debug before serialization');

  main.logLevel = 2;
  for (let index = 0; index < 100; index += 1) {
    appendPieLog('debug', 'channel-test', `entry-${index}`, payload);
  }
  assert.equal(main.calls.filter((call) => call.level === 'debug').length, 40);
  assert.equal(payloadReads, 40, 'rate-limited channel-only entries must not be serialized');

  appendPieLog('debug', 'backend-stderr', 'backend diagnostic');
  assert.equal(backend.calls.filter((call) => call.level === 'debug').length, 1);
  assert.equal(main.calls.some((call) => call.line.includes('backend diagnostic')), false);

  for (let index = 0; index < 3; index += 1) {
    appendPieLog('warn', 'channel-test', `warning-${index}`);
  }
  assert.equal(main.calls.filter((call) => call.level === 'warn').length, 3, 'warnings must bypass burst protection');
  showPieLogs?.(true);
  assert.ok(main.calls.some((call) => call.level === 'appendLine' && call.line.includes(getPieLogPath())));
  assert.ok(main.calls.some((call) => call.level === 'show' && call.line === 'true'));
  setPieLoggerOutputAdapter(undefined);
});
